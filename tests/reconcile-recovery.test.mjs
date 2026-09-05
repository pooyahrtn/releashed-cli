import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runRecoveryReconciliation } from "../scripts/reconcile-recovery.mjs";
import {
  CLERK_DOMAINS_ENDPOINT,
  CLERK_SIGN_IN_TOKEN_ENDPOINT,
  provisionDisposableClerkIdentity,
  reconcileDisposableClerkRecovery
} from "../supervisor/clerk-bootstrap.mjs";

const secret = "sk_test_recovery_secret_never_output";
const clerkOrigin = "https://clerk.example.test";
const marker = `flowmap_cal_${"a".repeat(32)}`;
const username = `flowmap_${"a".repeat(32)}`;
const otherMarker = `flowmap_cal_${"b".repeat(32)}`;
const userId = "user_recovery_fixture";
const otherUserId = "user_other_fixture";

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function recovery(state = "identity-bound") {
  return {
    state,
    external_id: marker,
    user_id: state === "identity-bound" ? userId : null
  };
}

function providerHarness({
  exactInitial = { id: userId, external_id: marker },
  exactRemaining = null,
  markerInitial = [],
  markerRemaining = [],
  deleteOk = true,
  matchingInstance = true
} = {}) {
  let exactLookups = 0;
  let markerLookups = 0;
  let deletes = 0;
  const fetchImpl = async (raw, init = {}) => {
    const url = new URL(raw);
    const method = init.method ?? "GET";
    if (raw === CLERK_DOMAINS_ENDPOINT) {
      const origin = matchingInstance ? clerkOrigin : "https://different-clerk.example.test";
      return response(200, { total_count: 1, data: [{ frontend_api_url: origin }] });
    }
    if (url.pathname === "/v1/users" && method === "GET") {
      const users = markerLookups++ === 0 ? markerInitial : markerRemaining;
      return response(200, {
        total_count: users.length,
        data: users.map((id) => ({ id, external_id: marker }))
      });
    }
    if (url.pathname === `/v1/users/${userId}` && method === "GET") {
      const user = exactLookups++ === 0 ? exactInitial : exactRemaining;
      return user === null ? response(404, {}) : response(200, user);
    }
    if (url.pathname.startsWith("/v1/users/") && method === "DELETE") {
      deletes += 1;
      return response(deleteOk ? 200 : 500, {});
    }
    throw new Error("unexpected provider request");
  };
  return {
    fetchImpl,
    exactLookups: () => exactLookups,
    markerLookups: () => markerLookups,
    deletes: () => deletes
  };
}

async function reconcileProvider(options = {}) {
  const harness = providerHarness(options);
  const environment = { CLERK_SECRET_KEY: secret };
  let result;
  let error;
  try {
    result = await reconcileDisposableClerkRecovery({
      recovery: options.recovery ?? recovery(),
      expectedFrontendOrigin: clerkOrigin,
      environment,
      fetchImpl: harness.fetchImpl,
      workingDayDeadline: new Date(Date.now() + 20_000).toISOString()
    });
  } catch (caught) {
    error = caught;
  }
  return { harness, environment, result, error };
}

test("an identity-bound recovery requires exact-id absence or exact id-and-marker deletion", async () => {
  for (const [label, exactInitial, expectedDeletes] of [
    ["already absent", null, 0],
    ["exactly present", { id: userId, external_id: marker }, 1]
  ]) {
    await test(label, async () => {
      const run = await reconcileProvider({ exactInitial, exactRemaining: null });
      assert.deepEqual(run.result, { cleanup_complete: true });
      assert.equal(run.harness.deletes(), expectedDeletes);
      assert.equal(run.harness.exactLookups(), expectedDeletes + 1);
      assert.equal(run.harness.markerLookups(), 0);
      assert.equal("CLERK_SECRET_KEY" in run.environment, false);
      assert.doesNotMatch(JSON.stringify(run.result), new RegExp(`${secret}|${marker}|${userId}`));
    });
  }
});

test("mismatched, failed-delete, failed-confirmation, and wrong-instance recovery stays unresolved", async () => {
  const cases = [
    ["id mismatch", { exactInitial: { id: otherUserId, external_id: marker } }],
    ["marker mismatch", { exactInitial: { id: userId, external_id: otherMarker } }],
    ["delete failure", { deleteOk: false }],
    ["confirmation failure", { exactRemaining: { id: userId, external_id: marker } }],
    ["instance mismatch", { matchingInstance: false }]
  ];
  for (const [label, options] of cases) {
    await test(label, async () => {
      const run = await reconcileProvider(options);
      assert.equal(run.result, undefined);
      assert.match(run.error?.message ?? "", /did not complete/);
      assert.equal("CLERK_SECRET_KEY" in run.environment, false);
      assert.doesNotMatch(`${run.error?.message} ${run.error?.stack}`, new RegExp(`${secret}|${marker}|${userId}|${otherUserId}`));
    });
  }
});

test("a creation-pending marker is absent or uniquely deleted, but multiple matches fail", async () => {
  for (const [initialUsers, complete, deletes] of [[[], true, 0], [[userId], true, 1], [[userId, otherUserId], false, 0]]) {
    const run = await reconcileProvider({
      recovery: recovery("creation-pending"),
      markerInitial: initialUsers,
      markerRemaining: []
    });
    assert.equal(run.result?.cleanup_complete === true, complete);
    assert.equal(run.harness.deletes(), deletes);
    assert.equal(run.harness.exactLookups(), 0);
  }
});

function lifecycleFetch({ deleteOk = true } = {}) {
  let userLookups = 0;
  return async (raw, init = {}) => {
    const url = new URL(raw);
    const method = init.method ?? "GET";
    if (raw === CLERK_DOMAINS_ENDPOINT) {
      return response(200, { total_count: 1, data: [{ frontend_api_url: clerkOrigin }] });
    }
    if (url.pathname === "/v1/users" && method === "GET") {
      userLookups += 1;
      return response(200, { total_count: 0, data: [] });
    }
    if (url.pathname === "/v1/users" && method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.username, username);
      return response(200, { id: userId, external_id: marker, username });
    }
    if (url.pathname === "/v1/sessions" && method === "GET") {
      return response(200, { total_count: 0, data: [] });
    }
    if (raw === CLERK_SIGN_IN_TOKEN_ENDPOINT && method === "POST") {
      return response(200, { id: "sit_recovery_fixture", token: "ticket_recovery_fixture" });
    }
    if (url.pathname === "/v1/sign_in_tokens/sit_recovery_fixture/revoke" && method === "POST") {
      return response(200, {});
    }
    if (url.pathname === `/v1/users/${userId}` && method === "DELETE") {
      return response(deleteOk ? 200 : 500, {});
    }
    throw new Error("unexpected lifecycle request");
  };
}

async function failedTicketLifecycle(deleteOk) {
  const environment = { CLERK_SECRET_KEY: secret };
  const lifecycle = await provisionDisposableClerkIdentity({
    environment,
    expectedFrontendOrigin: clerkOrigin,
    markerFactory: () => marker,
    fetchImpl: lifecycleFetch({ deleteOk }),
    onRecoveryMaterial: async () => {}
  });
  await assert.rejects(() => lifecycle.authenticate({
    browser: {
      async call() {
        return { ok: false, refusal: { code: "clerk_auth_ticket_exchange_failed" } };
      }
    }
  }), /refused/);
  return lifecycle.cleanup({ browserStopped: true });
}

test("confirmed identity deletion is terminal proof even when failed-auth reconciliation was conservative", async () => {
  assert.deepEqual(await failedTicketLifecycle(true), {
    cleanup_complete: true,
    sessions_revoked_or_absent: true,
    sign_in_token_unusable: true,
    synthetic_identity_deleted: true
  });
  const incomplete = await failedTicketLifecycle(false);
  assert.equal(incomplete.cleanup_complete, false);
  assert.equal(incomplete.synthetic_identity_deleted, false);
});

async function writePrivate(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
}

async function custodyFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-map-recovery-test-")));
  const runtimeRoot = join(root, ".runtime");
  const runsRoot = join(root, "runs");
  const runtimeDirectory = join(runtimeRoot, "safe-control-probe-AbCd12");
  const runDirectory = join(runsRoot, "safe-control-probe-20260904003653-7f40fc91");
  const recoveryPath = join(runtimeDirectory, "recovery.json");
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const value = {
    schema_version: 1,
    state: "identity-bound",
    external_id: marker,
    user_id: userId,
    profile_directory: join(runtimeDirectory, "profile"),
    browser_config_path: join(runtimeDirectory, "browser-config.json"),
    run_directory: runDirectory
  };
  await writePrivate(recoveryPath, value);
  return { root, runtimeDirectory, runDirectory, recoveryPath, value };
}

async function runFile(fixture, overrides = {}) {
  const chunks = [];
  const environment = { CLERK_SECRET_KEY: secret };
  const calls = [];
  const providerReconcile = overrides.providerReconcile ?? (async ({ recovery: value, expectedFrontendOrigin, environment: privateEnvironment }) => {
    calls.push("provider");
    assert.equal(value.external_id, marker);
    assert.equal(expectedFrontendOrigin, clerkOrigin);
    assert.equal(privateEnvironment.CLERK_SECRET_KEY, secret);
    delete privateEnvironment.CLERK_SECRET_KEY;
    return { cleanup_complete: true };
  });
  let result;
  let error;
  try {
    result = await runRecoveryReconciliation({
      recoveryPath: fixture.recoveryPath,
      repositoryRoot: fixture.root,
      environment,
      output: { write: (chunk) => chunks.push(String(chunk)) },
      now: overrides.now ?? (() => Date.now()),
      dependencies: {
        expectedFrontendOrigin: async () => clerkOrigin,
        providerReconcile,
        afterReceipt: overrides.afterReceipt,
        afterReceiptTempOpen: overrides.afterReceiptTempOpen,
        afterReceiptTempSync: overrides.afterReceiptTempSync,
        afterReceiptRename: overrides.afterReceiptRename,
        afterRecoveryAnchored: overrides.afterRecoveryAnchored,
        afterCustodyFileRemoval: overrides.afterCustodyFileRemoval
      }
    });
  } catch (caught) {
    error = caught;
  }
  return { result, error, output: chunks.join(""), calls, environment };
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

test("exact-file reconciliation publishes a sanitized receipt and removes only its custody directory", async () => {
  const fixture = await custodyFixture();
  try {
    const run = await runFile(fixture);
    assert.equal(run.result?.cleanup_complete, true);
    assert.equal(await exists(fixture.runtimeDirectory), false);
    assert.equal(await exists(fixture.runDirectory), true);
    const receiptPath = join(fixture.runDirectory, "cleanup-reconciliation.json");
    const receipt = await readFile(receiptPath, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(receipt)).sort(), ["kind", "reason", "reconciled_at", "recovery_sha256", "schema_version", "status"]);
    assert.equal((await lstat(receiptPath)).mode & 0o777, 0o600);
    assert.equal("CLERK_SECRET_KEY" in run.environment, false);
    for (const forbidden of [secret, marker, userId, fixture.root, fixture.recoveryPath]) {
      assert.doesNotMatch(`${run.output}${receipt}`, new RegExp(forbidden));
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a crash after receipt publication is safely idempotent", async () => {
  const fixture = await custodyFixture();
  try {
    const first = await runFile(fixture, { afterReceipt: async () => { throw new Error("simulated crash"); } });
    assert.match(first.error?.message ?? "", /did not complete/);
    assert.equal(await exists(fixture.recoveryPath), true);
    assert.equal(await exists(join(fixture.runDirectory, "cleanup-reconciliation.json")), true);
    const second = await runFile(fixture);
    assert.equal(second.result?.cleanup_complete, true);
    assert.equal(await exists(fixture.runtimeDirectory), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("provider ambiguity leaves recovery untouched and publishes no receipt", async () => {
  const fixture = await custodyFixture();
  try {
    const run = await runFile(fixture, { providerReconcile: async () => { throw new Error("private provider detail"); } });
    assert.match(run.error?.message ?? "", /did not complete/);
    assert.equal(await exists(fixture.recoveryPath), true);
    assert.equal(await exists(join(fixture.runDirectory, "cleanup-reconciliation.json")), false);
    assert.equal("CLERK_SECRET_KEY" in run.environment, false);
    assert.doesNotMatch(`${run.error?.message}${run.output}`, /private provider detail|sk_test|flowmap_cal|user_/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an empty marker search cannot hide a live exact id whose marker mismatches", async () => {
  const fixture = await custodyFixture();
  const provider = providerHarness({
    exactInitial: { id: userId, external_id: otherMarker },
    markerInitial: []
  });
  try {
    const run = await runFile(fixture, {
      providerReconcile: (options) => reconcileDisposableClerkRecovery({
        ...options,
        fetchImpl: provider.fetchImpl
      })
    });
    assert.match(run.error?.message ?? "", /did not complete/);
    assert.equal(provider.exactLookups(), 1);
    assert.equal(provider.markerLookups(), 0);
    assert.equal(provider.deletes(), 0);
    assert.equal(await exists(fixture.recoveryPath), true);
    assert.equal(await exists(fixture.runtimeDirectory), true);
    assert.equal(await exists(join(fixture.runDirectory, "cleanup-reconciliation.json")), false);
    assert.equal("CLERK_SECRET_KEY" in run.environment, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("receipt publication resumes after interruption at each atomic boundary", async () => {
  const cases = [
    ["temporary file open", "afterReceiptTempOpen", true, false],
    ["temporary file fsync", "afterReceiptTempSync", true, false],
    ["atomic rename", "afterReceiptRename", false, true]
  ];
  for (const [label, hook, pendingExpected, finalExpected] of cases) {
    await test(label, async () => {
      const fixture = await custodyFixture();
      try {
        const first = await runFile(fixture, { [hook]: async () => { throw new Error("simulated crash"); } });
        assert.match(first.error?.message ?? "", /did not complete/);
        assert.equal(await exists(fixture.recoveryPath), true);
        const pendingPath = join(fixture.runDirectory, "cleanup-reconciliation.json.pending");
        const receiptPath = join(fixture.runDirectory, "cleanup-reconciliation.json");
        assert.equal(await exists(pendingPath), pendingExpected);
        assert.equal(await exists(receiptPath), finalExpected);
        const retained = [first.output];
        for (const path of [pendingPath, receiptPath]) {
          if (await exists(path)) retained.push(await readFile(path, "utf8"));
        }
        for (const forbidden of [secret, marker, userId, fixture.root, fixture.recoveryPath]) {
          assert.doesNotMatch(retained.join("\n"), new RegExp(forbidden));
        }
        const second = await runFile(fixture);
        assert.equal(second.result?.cleanup_complete, true);
        assert.equal(await exists(fixture.runtimeDirectory), false);
        assert.equal(await exists(pendingPath), false);
        assert.equal(await exists(receiptPath), true);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("custody cleanup resumes from its private anchor after the original recovery name is gone", async () => {
  const fixture = await custodyFixture();
  try {
    await writePrivate(join(fixture.runtimeDirectory, "browser-config.json"), { private: true });
    const first = await runFile(fixture, {
      afterRecoveryAnchored: async () => { throw new Error("simulated crash"); }
    });
    assert.match(first.error?.message ?? "", /did not complete/);
    assert.equal(await exists(fixture.recoveryPath), false);
    assert.equal(await exists(join(fixture.runtimeDirectory, "reconciliation-anchor.json")), true);
    assert.deepEqual((await readdir(fixture.runtimeDirectory)).sort(), ["browser-config.json", "reconciliation-anchor.json"]);

    const second = await runFile(fixture);
    assert.equal(second.result?.cleanup_complete, true);
    assert.equal(await exists(fixture.runtimeDirectory), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("custody cleanup resumes after one allowed file is durably removed", async () => {
  const fixture = await custodyFixture();
  try {
    await writePrivate(join(fixture.runtimeDirectory, "browser-config.json"), { private: true });
    await writePrivate(join(fixture.runtimeDirectory, "cap-state.json"), { private: true });
    let interrupted = false;
    const first = await runFile(fixture, {
      afterCustodyFileRemoval: async () => {
        if (!interrupted) {
          interrupted = true;
          throw new Error("simulated crash");
        }
      }
    });
    assert.match(first.error?.message ?? "", /did not complete/);
    assert.deepEqual((await readdir(fixture.runtimeDirectory)).sort(), ["cap-state.json", "reconciliation-anchor.json"]);
    const second = await runFile(fixture);
    assert.equal(second.result?.cleanup_complete, true);
    assert.equal(await exists(fixture.runtimeDirectory), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("symlink, loose mode, schema drift, path escape, live profile, and unknown custody content fail before provider", async () => {
  const cases = [
    ["symlink", async (fixture) => {
      const outside = join(fixture.root, "outside.json");
      await writePrivate(outside, fixture.value);
      await rm(fixture.recoveryPath);
      await symlink(outside, fixture.recoveryPath);
    }],
    ["loose mode", async (fixture) => chmod(fixture.recoveryPath, 0o644)],
    ["schema drift", async (fixture) => {
      await writeFile(fixture.recoveryPath, `${JSON.stringify({ ...fixture.value, extra: true })}\n`);
    }],
    ["path escape", async (fixture) => {
      await writeFile(fixture.recoveryPath, `${JSON.stringify({ ...fixture.value, run_directory: join(fixture.root, "elsewhere") })}\n`);
    }],
    ["live profile", async (fixture) => mkdir(fixture.value.profile_directory)],
    ["unknown custody content", async (fixture) => writePrivate(join(fixture.runtimeDirectory, "unknown.json"), {})]
  ];
  for (const [label, mutate] of cases) {
    await test(label, async () => {
      const fixture = await custodyFixture();
      try {
        await mutate(fixture);
        const run = await runFile(fixture);
        assert.match(run.error?.message ?? "", /did not complete/);
        assert.equal(run.calls.length, 0);
        assert.equal(await exists(fixture.runtimeDirectory), true);
        assert.equal(await exists(join(fixture.runDirectory, "cleanup-reconciliation.json")), false);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("an invalid pre-existing receipt blocks custody removal", async () => {
  const fixture = await custodyFixture();
  try {
    await writePrivate(join(fixture.runDirectory, "cleanup-reconciliation.json"), { status: "forged" });
    const run = await runFile(fixture);
    assert.match(run.error?.message ?? "", /did not complete/);
    assert.equal(run.calls.length, 0);
    assert.equal(await exists(fixture.recoveryPath), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
