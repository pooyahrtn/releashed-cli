import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { preflightTargetRuntime } from "../lib/target-runtime.mjs";
import { prepareTargetRun } from "../scripts/prepare-target-run.mjs";
import { BrowserBroker } from "../supervisor/browser-broker.mjs";
import { RUN_ID, privateJson, targetRuntimeFixture } from "./target-runtime-fixture.mjs";

const BOUNDED_ROW = {
  id: "bounded-onboarding",
  action_matrix_row: "Bounded own-account onboarding progress",
  maximum_count: 20,
  worst_case_eur_per_action: 0,
  maximum_reserved_eur: 0,
  allowed_effects: "bound-route onboarding progress only",
  reservation_rule: "reserve zero and settle zero per bound-route action",
};

async function writeSessionFile(path, session) {
  const body = `${JSON.stringify(session)}\n`;
  await writeFile(path, body, { mode: 0o600 });
  await chmod(path, 0o600);
  return createHash("sha256").update(body).digest("hex");
}

function liveSession() {
  return {
    schema_version: 1,
    cookies: [
      {
        name: "session_token",
        value: "opaque",
        domain: "app.example.test",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ],
    origin_storage: [
      { origin: "https://app.example.test", local_storage: { auth_token: "opaque" } },
    ],
  };
}

// This is the "bring your own session" third entry mode's schema/config contract: a run
// prepared with --saved-session carries a private path+hash binding instead of clerk_auth,
// and any tamper to the bytes behind that binding is caught before a browser ever starts.
test("a saved-session bounded run omits clerk_auth, binds the private session file, and fails closed if it is tampered with after preparation", async () => {
  const fixture = await targetRuntimeFixture("https://app.example.test");
  try {
    const ledgerPath = join(fixture.ownerDirectory, "action-and-app-cost-ledger.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.allowed_one_way_classes.push(BOUNDED_ROW);
    await privateJson(ledgerPath, ledger);

    // Bring-your-own-session never reads the account's Clerk identity, same as anonymous.
    const accountPath = join(fixture.ownerDirectory, "account.json");
    await privateJson(accountPath, { status: "pass" });

    const manifestPath = join(fixture.runDirectory, "input-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.owner_input_hashes["action-and-app-cost-ledger.json"] = createHash("sha256")
      .update(await readFile(ledgerPath))
      .digest("hex");
    manifest.owner_input_hashes["account.json"] = createHash("sha256")
      .update(await readFile(accountPath))
      .digest("hex");
    await privateJson(manifestPath, manifest);

    const sessionPath = join(fixture.root, "captured-session.json");
    await writeSessionFile(sessionPath, liveSession());

    await prepareTargetRun({
      repository: fixture.repository,
      ownerDirectory: fixture.ownerDirectory,
      runId: RUN_ID,
      mode: "source-blind-bounded-onboarding-v1",
      savedSessionPath: sessionPath,
    });
    const config = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal(Object.hasOwn(config, "clerk_auth"), false);
    assert.equal(config.saved_session.path, sessionPath);
    assert.match(config.saved_session.sha256, /^[0-9a-f]{64}$/);

    const verified = await preflightTargetRuntime({
      repository: fixture.repository,
      configPath: fixture.configPath,
    });
    assert.equal(verified.clerkUserId, null);
    assert.equal(Object.hasOwn(verified, "clerkIdentity"), false);
    assert.equal(verified.boundedOnboarding, true);

    // A tamper to the private file after preparation must be caught, not silently reused.
    await writeSessionFile(sessionPath, { ...liveSession(), cookies: [] });
    await assert.rejects(
      () =>
        preflightTargetRuntime({ repository: fixture.repository, configPath: fixture.configPath }),
      /changed after preparation/,
    );
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// This is the run-time half: the trusted browser broker (never the explorer sandbox) reads
// the raw file and seeds cookies/storage before exploration starts, and refuses to proceed
// on a session whose captured cookies have already expired -- the fail-closed path required
// so a stale saved session can never quietly produce a map that claims to be authenticated.
test("loadSavedSession seeds live cookies and per-origin storage, but fails closed on an all-expired session", async () => {
  const fixture = await targetRuntimeFixture("https://app.example.test");
  try {
    const livePath = join(fixture.root, "live-session.json");
    const liveSha256 = await writeSessionFile(livePath, liveSession());
    const liveBroker = new BrowserBroker({ saved_session: { path: livePath, sha256: liveSha256 } });
    const calls = [];
    liveBroker.cdp = {
      send: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    };
    liveBroker.pageSessionId = "page-session-1";

    await liveBroker.loadSavedSession();

    const setCookies = calls.find((call) => call.method === "Network.setCookies");
    assert.ok(setCookies, "Network.setCookies must be called");
    assert.equal(setCookies.params.cookies[0].name, "session_token");
    assert.equal(setCookies.params.cookies[0].domain, "app.example.test");
    const seedScript = calls.find(
      (call) => call.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    assert.ok(seedScript, "a per-origin storage seed script must be registered");
    assert.match(seedScript.params.source, /https:\/\/app\.example\.test/);
    assert.match(seedScript.params.source, /auth_token/);

    const expiredPath = join(fixture.root, "expired-session.json");
    const expiredSha256 = await writeSessionFile(expiredPath, {
      schema_version: 1,
      cookies: [
        {
          name: "session_token",
          value: "opaque",
          domain: "app.example.test",
          path: "/",
          expires: Math.floor(Date.now() / 1000) - 3600,
        },
      ],
    });
    const expiredBroker = new BrowserBroker({
      saved_session: { path: expiredPath, sha256: expiredSha256 },
    });
    expiredBroker.cdp = { send: async () => ({}) };
    expiredBroker.pageSessionId = "page-session-2";
    await assert.rejects(() => expiredBroker.loadSavedSession(), /saved_session_expired/);

    // A hash mismatch (the private file changed underneath the bound config) also fails closed.
    const mismatchedBroker = new BrowserBroker({
      saved_session: { path: livePath, sha256: "0".repeat(64) },
    });
    mismatchedBroker.cdp = { send: async () => ({}) };
    await assert.rejects(() => mismatchedBroker.loadSavedSession(), /saved_session_hash_mismatch/);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(fixture.root, { recursive: true, force: true });
  }
});
