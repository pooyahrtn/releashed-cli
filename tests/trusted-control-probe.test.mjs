import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BROWSER_STARTUP_BUDGET_MS, CDP_COMMAND_TIMEOUT_MS } from "../lib/browser-runtime-limits.mjs";
import { CLERK_PAGE_AUTH_FAILURE_CODES } from "../lib/clerk-auth.mjs";
import { filesBelow, freshCapState, sha256Text, writeExclusiveJson } from "../lib/scaffold.mjs";
import {
  runTrustedControlProbe,
  sanitizeObservedUrl,
  sanitizeVisibleText,
  writeRecoveryRecord
} from "../scripts/trusted-control-probe.mjs";
import {
  BrowserBroker,
  CdpConnection,
  CALIBRATION_PAGE_FUNCTIONS,
  CLERK_PAGE_FUNCTIONS,
  calibrationGuardSource,
  evaluateCalibrationRestoration,
  hashAccessibilityTree
} from "../supervisor/browser-broker.mjs";
import { BrokerProcess } from "../supervisor/browser-broker-process.mjs";
import { CLERK_DOMAINS_ENDPOINT, provisionDisposableClerkIdentity } from "../supervisor/clerk-bootstrap.mjs";

const secret = "sk_test_probe_secret_never_output";
const userId = "user_synthetic_never_output";
const profileCanary = "/private/profile/path-never-output";
const targetOrigin = "https://target.example.test";
const startHash = "a".repeat(64);
const openHash = "b".repeat(64);

function observation(hash, name, nearby) {
  return {
    url: `${targetOrigin}/today`,
    observation_sha256: hash,
    roles: [
      { role: "heading", accessibility_name: nearby[0] },
      { role: "button", accessibility_name: name }
    ],
    buttons: [{ role: "button", accessible_name: name, nearby_visible_text: nearby }],
    screenshot: { path: `runs/calibration/screenshots/${hash[0]}.png`, sha256: hash }
  };
}

const startObservation = observation(startHash, "Open help", ["Practice safely"]);
const openObservation = observation(openHash, "Close help", ["Help is open"]);

function selection(action, observationValue, name, nearby) {
  return `${JSON.stringify({
    action,
    observation_sha256: observationValue.observation_sha256,
    role: "button",
    accessible_name: name,
    nearby_visible_text: nearby
  })}\n`;
}

function fixture({ browserStops = true, cleanupComplete = true, proofSafe = true } = {}) {
  const calls = [];
  const lifecycle = {
    userId,
    async authenticate() {
      calls.push("clerk-authenticate");
      return { authenticated: true };
    },
    async cleanup({ browserStopped }) {
      calls.push(`clerk-cleanup-${browserStopped}`);
      return {
        cleanup_complete: cleanupComplete,
        sessions_revoked_or_absent: cleanupComplete,
        sign_in_token_unusable: cleanupComplete,
        synthetic_identity_deleted: cleanupComplete
      };
    }
  };
  const browser = {
    ready: Promise.resolve().then(() => calls.push("browser-ready")),
    async call(payload) {
      calls.push(`browser-${payload.method}`);
      if (payload.method === "navigate") return { ok: true };
      if (payload.method === "calibration_observe_start") return { ok: true, observation: startObservation };
      if (payload.method === "calibration_open") return { ok: true, observation: openObservation };
      if (payload.method === "calibration_reverse") {
        return {
          ok: true,
          proof: {
            safe: proofSafe,
            open_state_observed: true,
            exact_reverse_control_used: true,
            reversal_attempted: true,
            exact_raw_url_restore: proofSafe,
            exact_semantic_restore: proofSafe,
            storage_unchanged: true,
            durable_storage_absent: true,
            request_observed: false,
            all_requests_blocked_before_dispatch: true,
            transport_attempt_observed: false
          }
        };
      }
      throw new Error("unexpected browser call");
    },
    async stop() {
      calls.push("browser-stop");
      if (!browserStops) throw new Error("simulated unconfirmed stop");
    }
  };
  return {
    calls,
    provisionIdentity: async ({ environment, expectedFrontendOrigin, onRecoveryMaterial }) => {
      assert.equal(environment.CLERK_SECRET_KEY, secret);
      assert.equal(expectedFrontendOrigin, "https://clerk.example.test");
      delete environment.CLERK_SECRET_KEY;
      calls.push("clerk-create");
      await onRecoveryMaterial({ user_id: userId });
      return lifecycle;
    },
    createBrowser: () => browser
  };
}

async function runFixture({ input, harness = fixture(), timeoutMs = 30 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "control-probe-test-"));
  const output = [];
  const environment = { CLERK_SECRET_KEY: secret };
  try {
    const result = await runTrustedControlProbe({
      environment,
      input: input ?? Readable.from([
        selection("probe", startObservation, "Open help", ["Practice safely"]),
        selection("reverse", openObservation, "Close help", ["Help is open"])
      ]),
      output: { write: (chunk) => output.push(String(chunk)) },
      selectionTimeoutMs: timeoutMs,
      runtimeParent: join(root, "runtime"),
      runParent: join(root, "runs"),
      policy: {
        targetOrigin,
        initialUrl: `${targetOrigin}/`,
        clerkFrontendOrigin: "https://clerk.example.test",
        allowedRequestOrigins: [targetOrigin, "https://clerk.example.test"],
        allowedNavigationOrigins: [targetOrigin],
        suppressedOrigins: []
      },
      dependencies: {
        provisionIdentity: harness.provisionIdentity,
        createBrowser: harness.createBrowser,
        writeRecoveryRecord: harness.writeRecoveryRecord ?? writeRecoveryRecord
      }
    });
    return {
      result,
      root,
      output: output.join(""),
      rows: output.join("").trim().split("\n").filter(Boolean).map(JSON.parse),
      calls: harness.calls,
      environment
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("one identity and one browser session prove a distinct close control, then clean up before the row", async () => {
  const run = await runFixture();
  try {
    assert.equal(run.rows.length, 3);
    assert.equal(run.rows[0].kind, "authenticated-start");
    assert.equal(run.rows[1].kind, "open-state");
    assert.equal(run.rows[2].status, "registry-row-ready");
    assert.deepEqual(run.rows[2].registry_row.visible_control, {
      url: `${targetOrigin}/today`,
      role: "button",
      accessible_name: "Open help",
      required_visible_text: ["Practice safely"]
    });
    assert.equal(run.calls.filter((call) => call === "clerk-create").length, 1);
    assert.equal(run.calls.filter((call) => call === "clerk-authenticate").length, 1);
    assert.ok(run.calls.indexOf("browser-stop") < run.calls.indexOf("clerk-cleanup-true"));
    assert.equal(run.rows[2].cleanup.cleanup_complete, true);
    assert.equal(run.rows[2].failure, null);
    assert.equal(run.result.exit_code, 0);
    assert.equal("CLERK_SECRET_KEY" in run.environment, false);
    const [runName] = await readdir(join(run.root, "runs"));
    const retained = await readFile(join(run.root, "runs", runName, "calibration-result.json"), "utf8");
    assert.equal(retained, `${JSON.stringify(run.rows.at(-1))}\n`);
    assert.deepEqual(JSON.parse(retained), run.rows.at(-1));
    for (const forbidden of [secret, userId, profileCanary, "Authorization"])
      assert.doesNotMatch(retained, new RegExp(forbidden));
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

for (const [label, input, state] of [
  ["abort", Readable.from(["abort\n"]), "abort"],
  ["EOF", Readable.from([]), "eof"],
  ["timeout", new PassThrough(), "timeout"]
]) {
  test(`${label} cleans up without probing`, async () => {
    const run = await runFixture({ input, timeoutMs: 5 });
    try {
      assert.equal(run.result.selection_state, state);
      assert.equal(run.rows.at(-1).status, "aborted");
      assert.equal(run.rows.at(-1).cleanup.cleanup_complete, true);
      assert.equal(run.calls.includes("browser-calibration_open"), false);
      assert.ok(run.calls.indexOf("browser-stop") < run.calls.indexOf("clerk-cleanup-true"));
    } finally {
      await rm(run.root, { recursive: true, force: true });
    }
  });
}

test("unconfirmed browser termination retains exact private recovery and profile, skips Clerk cleanup, and exits nonzero", async () => {
  const run = await runFixture({ input: Readable.from(["abort\n"]), harness: fixture({ browserStops: false }) });
  try {
    assert.equal(run.rows.at(-1).status, "blocked-cleanup-unknown");
    assert.equal(run.rows.at(-1).cleanup.browser_closed, false);
    assert.equal(run.rows.at(-1).cleanup.profile_removed, false);
    assert.equal(run.rows.at(-1).cleanup.recovery_material_retained, true);
    assert.equal(run.result.exit_code, 1);
    assert.equal(run.calls.some((call) => call.startsWith("clerk-cleanup")), false);
    const runtimeEntries = await readdir(join(run.root, "runtime"));
    assert.equal(runtimeEntries.length, 1);
    const runtimeDirectory = join(run.root, "runtime", runtimeEntries[0]);
    await stat(join(runtimeDirectory, "profile"));
    const recovery = await readFile(join(runtimeDirectory, "recovery.json"), "utf8");
    assert.match(recovery, new RegExp(userId));
    for (const forbidden of [secret, userId, profileCanary, runtimeDirectory, "recovery.json"])
      assert.doesNotMatch(run.output, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("abort is not success when provider cleanup is incomplete", async () => {
  const run = await runFixture({ input: Readable.from(["abort\n"]), harness: fixture({ cleanupComplete: false }) });
  try {
    assert.equal(run.rows.at(-1).status, "blocked-cleanup-unknown");
    assert.equal(run.result.exit_code, 1);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

const recoveryMarker = "flowmap_cal_11111111111111111111111111111111";
const recoveryUsername = "flowmap_11111111111111111111111111111111";

function clerkUserResponse(id, externalId = recoveryMarker, username = recoveryUsername) {
  return { id, external_id: externalId, username };
}

async function ambiguousCreateFixture({ outcome = "timeout", createdResponse = null, lookupRows = [], deleteFails = false, deleteFailureCount = 0, recoveryFails = false, recoveryFailsAfter = null, recoveryLookupFails = false }) {
  const events = [];
  const recovery = [];
  let lookups = 0;
  let deleteAttempts = 0;
  const error = await provisionDisposableClerkIdentity({
    environment: { CLERK_SECRET_KEY: secret },
    expectedFrontendOrigin: "https://clerk.example.test",
    markerFactory: () => recoveryMarker,
    onRecoveryMaterial: async (value) => {
      events.push("recovery");
      if (recoveryFails || (recoveryFailsAfter !== null && recovery.length >= recoveryFailsAfter)) throw new Error("simulated recovery fsync failure");
      recovery.push(structuredClone(value));
    },
    fetchImpl: async (rawUrl, init = {}) => {
      const url = new URL(rawUrl);
      if (url.href === CLERK_DOMAINS_ENDPOINT) {
        return Response.json({ data: [{ frontend_api_url: "https://clerk.example.test" }], total_count: 1 });
      }
      if (init.method === "GET" && url.pathname === "/v1/users") {
        events.push("lookup");
        lookups += 1;
        // The Clerk API models this as an exploded array: repeated
        // `external_id=value` parameters, not PHP-style `external_id[]=value`.
        // Keep this fixture strict so a provider-contract regression fails here.
        assert.equal(url.searchParams.get("external_id[]"), null);
        assert.deepEqual(url.searchParams.getAll("external_id"), [recoveryMarker]);
        if (lookups > 1 && recoveryLookupFails) throw new Error("simulated recovery lookup failure");
        const rows = lookups === 1 ? [] : lookupRows;
        return Response.json({ data: rows, total_count: rows.length });
      }
      if (init.method === "POST" && url.pathname === "/v1/users") {
        events.push("create");
        const body = JSON.parse(init.body);
        assert.deepEqual(Object.keys(body).sort(), [
          "external_id",
          "first_name",
          "last_name",
          "skip_password_requirement",
          "username"
        ]);
        assert.equal(body.external_id, recoveryMarker);
        assert.equal(body.username, recoveryUsername);
        assert.match(body.username, /^[a-z0-9_]{8,64}$/);
        if (createdResponse !== null) return Response.json(createdResponse);
        if (outcome === "timeout") throw new Error("simulated timeout after server-side create");
        if (outcome === "malformed") return Response.json({ external_id: recoveryMarker, username: recoveryUsername });
        return Response.json(clerkUserResponse("user_created_fixture"));
      }
      if (init.method === "DELETE" && url.pathname.startsWith("/v1/users/")) {
        events.push("delete");
        deleteAttempts += 1;
        if (deleteFails || deleteAttempts <= deleteFailureCount) throw new Error("simulated delete failure");
        return Response.json({ deleted: true });
      }
      throw new Error("unexpected Clerk fixture request");
    }
  }).then(() => null, (caught) => caught);
  return { error, events, recovery };
}

test("server-side create plus timeout is found by exact private marker and deleted", async () => {
  const run = await ambiguousCreateFixture({ lookupRows: [clerkUserResponse("user_recovered_fixture")] });
  assert.deepEqual(run.events, ["recovery", "lookup", "create", "lookup", "delete"]);
  assert.deepEqual(run.recovery, [{ state: "creation-pending", external_id: recoveryMarker, user_id: null }]);
  assert.equal(run.error?.cleanup?.cleanup_complete, true);
  assert.equal(run.error?.cleanup?.synthetic_identity_deleted, true);
});

test("malformed create response uses the same exact-marker recovery deletion", async () => {
  const run = await ambiguousCreateFixture({ outcome: "malformed", lookupRows: [clerkUserResponse("user_recovered_fixture")] });
  assert.deepEqual(run.events, ["recovery", "lookup", "create", "lookup", "delete"]);
  assert.equal(run.error?.cleanup?.cleanup_complete, true);
  assert.equal(run.error?.cleanup?.synthetic_identity_deleted, true);
});

for (const [label, createdResponse] of [
  ["a mismatched marker", clerkUserResponse("user_created_fixture", "flowmap_cal_other_marker")],
  ["a missing marker", { id: "user_created_fixture", username: recoveryUsername }],
  ["a mismatched username", clerkUserResponse("user_created_fixture", recoveryMarker, "flowmap_22222222222222222222222222222222")],
  ["a missing username", { id: "user_created_fixture", external_id: recoveryMarker }]
]) {
  test(`a valid created id with ${label} is deleted directly before any marker fallback`, async () => {
    const run = await ambiguousCreateFixture({ createdResponse });
    assert.deepEqual(run.events, ["recovery", "lookup", "create", "recovery", "delete"]);
    assert.deepEqual(run.recovery, [
      { state: "creation-pending", external_id: recoveryMarker, user_id: null },
      { state: "identity-bound", external_id: recoveryMarker, user_id: "user_created_fixture" }
    ]);
    assert.equal(run.error?.cleanup?.cleanup_complete, true);
    assert.equal(run.error?.cleanup?.synthetic_identity_deleted, true);
  });

  test(`a valid created id with ${label} is retained when direct cleanup fails`, async () => {
    const run = await ambiguousCreateFixture({ createdResponse, deleteFails: true });
    assert.deepEqual(run.events, ["recovery", "lookup", "create", "recovery", "delete"]);
    assert.deepEqual(run.recovery, [
      { state: "creation-pending", external_id: recoveryMarker, user_id: null },
      { state: "identity-bound", external_id: recoveryMarker, user_id: "user_created_fixture" }
    ]);
    assert.equal(run.error?.cleanup?.cleanup_complete, false);
    assert.equal(run.error?.cleanup?.synthetic_identity_deleted, false);
  });

  test(`a valid created id with ${label} keeps a private cleanup handle when retention fails`, async () => {
    const run = await ambiguousCreateFixture({ createdResponse, deleteFails: true, recoveryFailsAfter: 1 });
    assert.deepEqual(run.events, ["recovery", "lookup", "create", "recovery", "delete"]);
    assert.deepEqual(run.recovery, [{ state: "creation-pending", external_id: recoveryMarker, user_id: null }]);
    assert.equal(run.error?.cleanup?.cleanup_complete, false);
    assert.equal(typeof run.error?.cleanup_handle, "function");
    assert.doesNotMatch(JSON.stringify(run.error), /user_created_fixture|sk_test_probe_secret/);
  });

  test(`a valid created id with ${label} can be cleaned up through the private handle`, async () => {
    const run = await ambiguousCreateFixture({ createdResponse, deleteFailureCount: 1, recoveryFailsAfter: 1 });
    const cleanup = await run.error.cleanup_handle();
    assert.deepEqual(run.events, ["recovery", "lookup", "create", "recovery", "delete", "delete"]);
    assert.equal(cleanup.cleanup_complete, true);
    assert.equal(cleanup.synthetic_identity_deleted, true);
  });
}

for (const [label, lookupRows, deleteFails, expectedEvents] of [
  ["lookup zero", [], false, ["recovery", "lookup", "create", "lookup"]],
  ["lookup multiple", [clerkUserResponse("user_fixture_1"), clerkUserResponse("user_fixture_2")], false, ["recovery", "lookup", "create", "lookup"]],
  ["delete failure", [clerkUserResponse("user_fixture_1")], true, ["recovery", "lookup", "create", "lookup", "delete"]]
]) {
  test(`ambiguous create ${label} keeps recovery and reports incomplete cleanup`, async () => {
    const run = await ambiguousCreateFixture({ lookupRows, deleteFails });
    assert.deepEqual(run.events, expectedEvents);
    assert.equal(run.error?.cleanup?.cleanup_complete, false);
    assert.equal(run.error?.cleanup?.synthetic_identity_deleted, false);
  });
}

test("ambiguous create lookup failure keeps recovery and reports incomplete cleanup", async () => {
  const run = await ambiguousCreateFixture({ recoveryLookupFails: true });
  assert.deepEqual(run.events, ["recovery", "lookup", "create", "lookup"]);
  assert.equal(run.error?.cleanup?.cleanup_complete, false);
  assert.equal(run.error?.cleanup?.synthetic_identity_deleted, false);
});

test("normal create durably binds the returned user to the same marker before browser use", async () => {
  const recovery = [];
  const events = [];
  const lifecycle = await provisionDisposableClerkIdentity({
    environment: { CLERK_SECRET_KEY: secret },
    expectedFrontendOrigin: "https://clerk.example.test",
    markerFactory: () => recoveryMarker,
    onRecoveryMaterial: async (value) => { events.push("recovery"); recovery.push(structuredClone(value)); },
    fetchImpl: async (rawUrl, init = {}) => {
      const url = new URL(rawUrl);
      if (url.href === CLERK_DOMAINS_ENDPOINT) {
        return Response.json({ data: [{ frontend_api_url: "https://clerk.example.test" }], total_count: 1 });
      }
      if (init.method === "GET") { events.push("lookup"); return Response.json({ data: [], total_count: 0 }); }
      if (init.method === "POST") { events.push("create"); return Response.json(clerkUserResponse("user_created_fixture")); }
      if (init.method === "DELETE") { events.push("delete"); return Response.json({ deleted: true }); }
      throw new Error(`unexpected fixture request ${url.pathname}`);
    }
  });
  assert.deepEqual(recovery, [
    { state: "creation-pending", external_id: recoveryMarker, user_id: null },
    { state: "identity-bound", external_id: recoveryMarker, user_id: "user_created_fixture" }
  ]);
  assert.equal(JSON.stringify(recovery).includes(recoveryUsername), false);
  const cleanup = await lifecycle.cleanup({ browserStopped: true });
  assert.equal(cleanup.cleanup_complete, true);
  assert.deepEqual(events, ["recovery", "lookup", "create", "recovery", "delete"]);
});

test("recovery-record failure occurs before any Clerk request", async () => {
  const run = await ambiguousCreateFixture({ recoveryFails: true });
  assert.deepEqual(run.events, ["recovery"]);
  assert.equal(run.error?.cleanup?.cleanup_complete, true);
});

test("trusted probe invokes a private cleanup handle when identity retention fails", async () => {
  const harness = fixture();
  harness.provisionIdentity = async () => {
    const error = new Error("private provisioning failure");
    error.cleanup = { cleanup_complete: false, sessions_revoked_or_absent: false, sign_in_token_unusable: false, synthetic_identity_deleted: false };
    Object.defineProperty(error, "cleanup_handle", {
      value: async () => {
        harness.calls.push("private-cleanup-handle");
        return { cleanup_complete: true, sessions_revoked_or_absent: true, sign_in_token_unusable: true, synthetic_identity_deleted: true };
      }
    });
    throw error;
  };
  const run = await runFixture({ input: Readable.from([]), harness });
  try {
    assert.equal(run.calls.includes("private-cleanup-handle"), true);
    assert.equal(run.calls.includes("browser-start"), false);
    assert.equal(run.rows.at(-1).status, "blocked-unknown");
    assert.equal(run.rows.at(-1).cleanup.cleanup_complete, true);
    assert.deepEqual(run.rows.at(-1).failure, { stage: "identity-provisioning", code: "operation_failed" });
    assert.equal(run.result.exit_code, 1);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

for (const code of [
  ...Object.values(CLERK_PAGE_AUTH_FAILURE_CODES),
  "clerk_auth_landing_unconfirmed",
  "clerk_auth_post_auth_readiness_unconfirmed",
  "clerk_auth_state_invalid",
  "clerk_sign_in_token_mint_outcome_unknown"
]) {
  test(`trusted probe exposes only the fixed Clerk failure code ${code}`, async () => {
    const planted = [
      "ticket_calibration_never_retain",
      "user_calibration_never_retain",
      "sess_calibration_never_retain",
      "provider-calibration-message-never-retain",
      "provider-calibration-meta-never-retain",
      "trace_calibration_never_retain"
    ];
    const harness = fixture();
    harness.provisionIdentity = async () => ({
      async authenticate() {
        const error = new Error(planted.join(" "));
        error.provider = {
          errors: [{ message: planted[3], meta: { sessionId: planted[2], userId: planted[1], private: planted[4] } }],
          ticket: planted[0],
          clerkTraceId: planted[5]
        };
        Object.defineProperty(error, "calibration_failure_code", { value: code });
        throw error;
      },
      async cleanup() {
        return { cleanup_complete: true, sessions_revoked_or_absent: true, sign_in_token_unusable: true, synthetic_identity_deleted: true };
      }
    });
    const run = await runFixture({ input: Readable.from([]), harness });
    try {
      assert.deepEqual(run.rows.at(-1).failure, { stage: "clerk-authentication", code });
      const retainedPaths = await filesBelow(run.root);
      const retained = [
        run.output,
        ...(await Promise.all(retainedPaths.map((path) => readFile(path, "utf8"))))
      ].join("\n");
      for (const secretValue of planted) {
        assert.doesNotMatch(retained, new RegExp(secretValue));
      }
    } finally {
      await rm(run.root, { recursive: true, force: true });
    }
  });
}

test("trusted probe collapses a non-allowlisted authentication code", async () => {
  const harness = fixture();
  harness.provisionIdentity = async () => ({
    async authenticate() {
      const error = new Error("private provider detail");
      Object.defineProperty(error, "calibration_failure_code", { value: "private_provider_code" });
      throw error;
    },
    async cleanup() {
      return { cleanup_complete: true, sessions_revoked_or_absent: true, sign_in_token_unusable: true, synthetic_identity_deleted: true };
    }
  });
  const run = await runFixture({ input: Readable.from([]), harness });
  try {
    assert.deepEqual(run.rows.at(-1).failure, { stage: "clerk-authentication", code: "operation_failed" });
    assert.doesNotMatch(run.output, /private provider detail|private_provider_code/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("calibration binds its authenticated baseline to the retained landing route", async () => {
  const landingUrl = `${targetOrigin}/today`;
  const landingIdentity = {
    exactUrl: landingUrl,
    entryId: 1,
    entryIndex: 0,
    frameId: "frame-fixture",
    loaderId: "loader-fixture",
    sequence: 3,
    logicalSequence: 3
  };
  const broker = new BrowserBroker({
    run_directory: "/unused",
    profile_directory: "/unused",
    initial_url: `${targetOrigin}/`,
    allowed_request_origins: [targetOrigin, "https://clerk.example.test"],
    allowed_navigation_origins: [targetOrigin],
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" },
    calibration_probe: { mode: "trusted-reversible-control-v1" }
  });
  const order = [];
  broker.initialLandingIdentity = landingIdentity;
  broker.authLandingNavigationSequence = landingIdentity.sequence;
  broker.authLandingUrlSha256 = sha256Text(landingUrl);
  broker.loadState = async () => ({ abort: null, working_day_deadline: new Date(Date.now() + 1_000).toISOString() });
  broker.privateNavigationSnapshot = async () => { order.push("validate-landing"); return landingIdentity; };
  broker.calibrationObservation = async () => { order.push("capture"); return startObservation; };
  broker.calibrationPrivateState = async () => ({ raw_url_sha256: sha256Text(landingUrl), authenticated_landing_intact: true });
  assert.equal((await broker.calibrationObserveStart()).ok, true);
  assert.deepEqual(order, ["validate-landing", "capture"]);

  const changed = new BrowserBroker({
    run_directory: "/unused",
    profile_directory: "/unused",
    initial_url: `${targetOrigin}/`,
    allowed_request_origins: [targetOrigin, "https://clerk.example.test"],
    allowed_navigation_origins: [targetOrigin],
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" },
    calibration_probe: { mode: "trusted-reversible-control-v1" }
  });
  changed.initialLandingIdentity = landingIdentity;
  changed.authLandingNavigationSequence = landingIdentity.sequence;
  changed.authLandingUrlSha256 = sha256Text(landingUrl);
  changed.loadState = async () => ({ abort: null, working_day_deadline: new Date(Date.now() + 1_000).toISOString() });
  changed.privateNavigationSnapshot = async () => ({ ...landingIdentity, exactUrl: `${targetOrigin}/another` });
  changed.calibrationObservation = async () => assert.fail("calibration must not capture before validating the landing");
  changed.calibrationPrivateState = async () => ({ raw_url_sha256: sha256Text(`${targetOrigin}/another`), authenticated_landing_intact: false });
  assert.equal((await changed.calibrationObserveStart()).refusal.code, "calibration_start_url_changed");
});

function persistentIdentityCleanupFailureHarness({ fallbackFails = false } = {}) {
  const calls = [];
  let recoveryWrites = 0;
  let deleteAttempts = 0;
  return {
    calls,
    writeRecoveryRecord: async (path, value, options) => {
      recoveryWrites += 1;
      if (path.endsWith("recovery-fallback.json") && fallbackFails) throw new Error("fallback recovery fsync failure");
      if (recoveryWrites === 2) throw new Error("primary recovery fsync failure");
      return writeRecoveryRecord(path, value, options);
    },
    provisionIdentity: (options) => provisionDisposableClerkIdentity({
      ...options,
      markerFactory: () => recoveryMarker,
      fetchImpl: async (rawUrl, init = {}) => {
        const url = new URL(rawUrl);
        if (url.href === CLERK_DOMAINS_ENDPOINT) {
          return Response.json({ data: [{ frontend_api_url: "https://clerk.example.test" }], total_count: 1 });
        }
        if (init.method === "GET" && url.pathname === "/v1/users") {
          assert.equal(url.searchParams.get("external_id[]"), null);
          assert.deepEqual(url.searchParams.getAll("external_id"), [recoveryMarker]);
          return Response.json({ data: [], total_count: 0 });
        }
        if (init.method === "POST" && url.pathname === "/v1/users") {
          const body = JSON.parse(init.body);
          assert.equal(body.username, recoveryUsername);
          return Response.json({ id: "user_created_fixture", external_id: recoveryMarker });
        }
        if (init.method === "DELETE" && url.pathname.startsWith("/v1/users/")) {
          deleteAttempts += 1;
          calls.push(`delete-${deleteAttempts}`);
          throw new Error("persistent exact-id delete failure");
        }
        throw new Error("unexpected Clerk fixture request");
      }
    }),
    createBrowser: () => {
      calls.push("browser-start");
      throw new Error("browser must not start");
    }
  };
}

test("persistent exact-id cleanup failure writes private fallback custody and never starts a browser", async () => {
  const run = await runFixture({ input: Readable.from([]), harness: persistentIdentityCleanupFailureHarness() });
  try {
    assert.equal(run.calls.includes("browser-start"), false);
    assert.deepEqual(run.calls, ["delete-1", "delete-2"]);
    assert.equal(run.rows.at(-1).status, "blocked-cleanup-unknown");
    assert.equal(run.rows.at(-1).cleanup.cleanup_complete, false);
    assert.equal(run.rows.at(-1).cleanup.recovery_material_retained, true);
    assert.equal(run.output.includes(recoveryMarker), false);
    assert.equal(run.output.includes(recoveryUsername), false);
    assert.equal(run.output.includes("user_created_fixture"), false);
    assert.equal(run.output.includes("recovery-fallback.json"), false);
    const runtimeEntries = await readdir(join(run.root, "runtime"));
    assert.equal(runtimeEntries.length, 1);
    const runtimeDirectory = join(run.root, "runtime", runtimeEntries[0]);
    const fallbackPath = join(runtimeDirectory, "recovery-fallback.json");
    assert.equal((await stat(fallbackPath)).mode & 0o777, 0o600);
    const fallback = JSON.parse(await readFile(fallbackPath, "utf8"));
    const { run_directory: runDirectory, ...fallbackWithoutRunDirectory } = fallback;
    assert.deepEqual(fallbackWithoutRunDirectory, {
      schema_version: 1,
      state: "identity-bound",
      external_id: recoveryMarker,
      user_id: "user_created_fixture",
      recovery_reason: "primary-recovery-write-failed",
      profile_directory: join(runtimeDirectory, "profile"),
      browser_config_path: join(runtimeDirectory, "browser-config.json")
    });
    assert.equal(JSON.stringify(fallback).includes(recoveryUsername), false);
    const runEntries = await readdir(join(run.root, "runs"));
    assert.equal(runEntries.length, 1);
    assert.equal(runDirectory, join(run.root, "runs", runEntries[0]));
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("fallback custody write failure stays honest and retains the runtime", async () => {
  const run = await runFixture({ input: Readable.from([]), harness: persistentIdentityCleanupFailureHarness({ fallbackFails: true }) });
  try {
    assert.equal(run.calls.includes("browser-start"), false);
    assert.equal(run.rows.at(-1).cleanup.cleanup_complete, false);
    assert.equal(run.rows.at(-1).cleanup.recovery_material_retained, false);
    const runtimeEntries = await readdir(join(run.root, "runtime"));
    assert.equal(runtimeEntries.length, 1);
    assert.equal((await readdir(join(run.root, "runtime", runtimeEntries[0]))).includes("recovery-fallback.json"), false);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("recovery records are exclusively created mode 0600 and durably replaceable", async () => {
  const root = await mkdtemp(join(tmpdir(), "control-probe-recovery-"));
  const path = join(root, "recovery.json");
  try {
    await writeRecoveryRecord(path, { state: "creation-pending", external_id: recoveryMarker }, { exclusive: true });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(() => writeRecoveryRecord(path, { state: "collision" }, { exclusive: true }), { code: "EEXIST" });
    await writeRecoveryRecord(path, { state: "identity-bound", user_id: "user_fixture" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { state: "identity-bound", user_id: "user_fixture" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, recoveredRows, expectedCleanup, expectedStatus] of [
  ["successful recovery deletion", [clerkUserResponse("user_recovered_fixture")], true, "blocked-unknown"],
  ["unresolved zero lookup", [], false, "blocked-cleanup-unknown"]
]) {
  test(`${label} never starts a browser and never prints recovery material`, async () => {
    const calls = [];
    let lookups = 0;
    const harness = {
      calls,
      createBrowser: () => { calls.push("browser-start"); throw new Error("browser must not start"); },
      provisionIdentity: (options) => provisionDisposableClerkIdentity({
        ...options,
        markerFactory: () => recoveryMarker,
        fetchImpl: async (rawUrl, init = {}) => {
          if (String(rawUrl) === CLERK_DOMAINS_ENDPOINT) {
            return Response.json({ data: [{ frontend_api_url: "https://clerk.example.test" }], total_count: 1 });
          }
          if (init.method === "GET") {
            lookups += 1;
            const rows = lookups === 1 ? [] : recoveredRows;
            return Response.json({ data: rows, total_count: rows.length });
          }
          if (init.method === "POST") throw new Error("ambiguous create after server dispatch");
          if (init.method === "DELETE") return Response.json({ deleted: true });
          throw new Error("unexpected fixture request");
        }
      })
    };
    const run = await runFixture({ input: Readable.from([]), harness });
    try {
      assert.equal(run.calls.includes("browser-start"), false);
      assert.equal(run.result.exit_code, 1);
      assert.equal(run.rows.at(-1).status, expectedStatus);
      assert.equal(run.rows.at(-1).cleanup.cleanup_complete, expectedCleanup);
      for (const forbidden of [recoveryMarker, "user_recovered_fixture", "recovery.json", run.root]) assert.equal(run.output.includes(forbidden), false);
      const runtimeEntries = await readdir(join(run.root, "runtime"));
      assert.equal(runtimeEntries.length, expectedCleanup ? 0 : 1);
      if (!expectedCleanup) {
        const retained = await readFile(join(run.root, "runtime", runtimeEntries[0], "recovery.json"), "utf8");
        assert.match(retained, new RegExp(recoveryMarker));
      }
    } finally {
      await rm(run.root, { recursive: true, force: true });
    }
  });
}

test("raw URL query/hash and full AX properties participate in restoration proof", () => {
  const baseNodes = [{
    ignored: false,
    role: { type: "role", value: "button" },
    name: { type: "computedString", value: "Menu" },
    properties: [{ name: "pressed", value: { type: "tristate", value: false } }]
  }];
  const stuckNodes = structuredClone(baseNodes);
  stuckNodes[0].properties[0].value.value = true;
  assert.notEqual(hashAccessibilityTree(baseNodes), hashAccessibilityTree(stuckNodes));
  const baseline = {
    raw_url_sha256: "1".repeat(64),
    accessibility_sha256: hashAccessibilityTree(baseNodes),
    storage_sha256: "2".repeat(64),
    durable_storage_absent: true,
    storage_certain: true
  };
  const open = { ...baseline, accessibility_sha256: "3".repeat(64) };
  assert.equal(evaluateCalibrationRestoration({ baseline, open, final: { ...baseline, accessibility_sha256: hashAccessibilityTree(stuckNodes) }, guard: {} }).safe, false);
  assert.equal(evaluateCalibrationRestoration({ baseline, open, final: { ...baseline, raw_url_sha256: "4".repeat(64) }, guard: {} }).safe, false);
  assert.equal(evaluateCalibrationRestoration({ baseline, open, final: baseline, guard: {} }).safe, true);
});

test("durable storage, any request, or any guarded transport attempt blocks registry readiness", () => {
  const baseline = { raw_url_sha256: "1".repeat(64), accessibility_sha256: "2".repeat(64), storage_sha256: "3".repeat(64), durable_storage_absent: true, storage_certain: true };
  const open = { ...baseline, accessibility_sha256: "4".repeat(64) };
  for (const variant of [
    { final: { ...baseline, durable_storage_absent: false }, guard: {} },
    { final: { ...baseline, storage_certain: false }, guard: {} },
    { final: baseline, guard: { request_attempted: true } },
    { final: baseline, guard: { transport_attempted: true } },
    { final: baseline, guard: { storage_mutation_attempted: true } }
  ]) assert.equal(evaluateCalibrationRestoration({ baseline, open, ...variant }).safe, false);
});

test("calibration request interception aborts before dispatch and records only a coarse attempt", async () => {
  const sent = [];
  const broker = new BrowserBroker({
    run_directory: "/not-used",
    profile_directory: "/not-used",
    allowed_request_origins: [targetOrigin],
    allowed_navigation_origins: [targetOrigin],
    calibration_probe: { mode: "trusted-reversible-control-v1" }
  });
  broker.cdp = { send: async (method, params) => sent.push({ method, params }) };
  broker.calibrationNetworkActive = true;
  broker.calibrationGuard = {};
  await broker.handlePausedRequest({
    sessionId: "page",
    params: { requestId: "request-private", request: { url: `${targetOrigin}/api?private=yes`, method: "GET" }, resourceType: "Fetch" }
  });
  assert.deepEqual(sent, [{ method: "Fetch.failRequest", params: { requestId: "request-private", errorReason: "BlockedByClient" } }]);
  assert.deepEqual(broker.calibrationGuard, { request_attempted: true, all_requests_blocked_before_dispatch: true });
});

test("all injected browser snippets compile and guards cover every non-Fetch transport", () => {
  for (const source of [...Object.values(CLERK_PAGE_FUNCTIONS), ...Object.values(CALIBRATION_PAGE_FUNCTIONS)])
    assert.doesNotThrow(() => Function(`return (${source});`)());
  const source = calibrationGuardSource({ calibration: true, allowFixtureServiceWorker: false });
  assert.doesNotThrow(() => Function(source));
  for (const transport of ["WebSocket", "EventSource", "Worker", "SharedWorker", "RTCPeerConnection", "WebTransport", "sendBeacon", "serviceWorker"])
    assert.match(source, new RegExp(transport));
});

test("the shared real Chromium broker proves a same-control toggle without screenshot byte equality", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">
      <h1>Practice safely</h1><button autofocus aria-expanded="false" onclick="
        const open=this.getAttribute('aria-expanded')==='true';
        this.setAttribute('aria-expanded',String(!open));
        document.querySelector('p').hidden=open;
      ">Open help</button><p hidden>Help is open</p>`);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), "control-probe-browser-"));
  const runDirectory = join(root, "run");
  const profileDirectory = join(root, "profile");
  const capPath = join(root, "cap.json");
  const configPath = join(root, "config.json");
  await mkdir(runDirectory);
  await mkdir(profileDirectory);
  const deadline = Date.now() + 15_000;
  await writeExclusiveJson(capPath, freshCapState({
    browser_active_seconds: 15,
    browser_operations_total: 4,
    browser_operations_per_rolling_minute: 4,
    browser_requests_total: 10,
    browser_requests_per_rolling_minute: 10,
    listed_one_way_actions_total: 0,
    app_side_cost_cap_eur: 0,
    model_cost_cap_eur: 0,
    combined_actual_plus_reserved_cap_eur: 0
  }, new Date(deadline).toISOString(), "fixture"));
  await writeExclusiveJson(configPath, {
    run_id: "fixture",
    run_directory: runDirectory,
    startup_log_path: join(root, "startup.jsonl"),
    profile_directory: profileDirectory,
    cap_state_path: capPath,
    operation_deadline_ms: deadline,
    initial_url: `${origin}/`,
    allowed_navigation_origins: [origin],
    allowed_request_origins: [origin],
    suppressed_request_origins: [],
    effect_registry: {},
    reversible_action_registry: {},
    app_cost_ledger: { allowed_one_way_classes: [] },
    calibration_probe: { mode: "trusted-reversible-control-v1", public_run_path: "runs/fixture" }
  });
  const browser = new BrokerProcess(fileURLToPath(new URL("../supervisor/browser-broker.mjs", import.meta.url)), configPath, deadline);
  try {
    await browser.ready;
    assert.equal((await browser.call({ method: "navigate", action_class: "Observe", url: `${origin}/` })).ok, true);
    const start = await browser.call({ method: "calibration_observe_start" });
    assert.doesNotMatch(JSON.stringify(start), /raw_url|lastEvidenceRaw/);
    const candidate = start.observation.buttons.find((button) => button.accessible_name === "Open help");
    assert(candidate);
    const opened = await browser.call({ method: "calibration_open", selection: {
      action: "probe",
      observation_sha256: start.observation.observation_sha256,
      ...candidate
    } });
    const reverse = opened.observation.buttons.find((button) => button.accessible_name === "Open help");
    assert(reverse);
    const reversed = await browser.call({ method: "calibration_reverse", selection: {
      action: "reverse",
      observation_sha256: opened.observation.observation_sha256,
      ...reverse
    } });
    assert.equal(reversed.proof.safe, true, JSON.stringify(reversed.proof));
    assert.equal(reversed.proof.exact_raw_url_restore, true);
    assert.equal(reversed.proof.exact_semantic_restore, true);
    assert.equal("exact_visual_restore" in reversed.proof, false);
    assert.deepEqual(requests, ["GET /"]);
  } finally {
    await browser.stop().catch(() => {});
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

test("silent CDP calls time out and socket close/error reject every pending call", async () => {
  class FakeSocket extends EventTarget {
    send() {}
    close() { this.dispatchEvent(new Event("close")); }
  }
  const silent = new CdpConnection(new FakeSocket(), { commandTimeoutMs: 10, absoluteDeadlineMs: Date.now() + 100 });
  await assert.rejects(() => silent.send("Runtime.evaluate"), /deadline/);

  for (const eventName of ["close", "error"]) {
    const socket = new FakeSocket();
    const cdp = new CdpConnection(socket, { commandTimeoutMs: 1000, absoluteDeadlineMs: Date.now() + 1000 });
    const one = cdp.send("One");
    const two = cdp.send("Two");
    socket.dispatchEvent(new Event(eventName));
    await assert.rejects(() => one, /closed|failed/);
    await assert.rejects(() => two, /closed|failed/);
  }
});

test("startup CDP commands get one larger bounded budget before operational limits resume", async () => {
  class DelayedSocket extends EventTarget {
    send(raw) {
      const message = JSON.parse(raw);
      setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ id: message.id, result: { ok: true } })
      })), 20);
    }
    close() { this.dispatchEvent(new Event("close")); }
  }

  assert.equal(BROWSER_STARTUP_BUDGET_MS, 30_000);
  assert.ok(BROWSER_STARTUP_BUDGET_MS > CDP_COMMAND_TIMEOUT_MS);
  const cdp = new CdpConnection(new DelayedSocket(), {
    commandTimeoutMs: 500,
    absoluteDeadlineMs: Date.now() + 2_000
  });
  assert.deepEqual(await cdp.send("Startup.configure"), { ok: true });
  cdp.setLimits({ commandTimeoutMs: 5, absoluteDeadlineMs: Date.now() + 2_000 });
  await assert.rejects(() => cdp.send("Runtime.evaluate"), /deadline/);
  cdp.close();
});

test("retained output is closed and sanitizers remove identifiers, emails, URL secrets, and raw text", async () => {
  const run = await runFixture();
  try {
    assert.deepEqual(Object.keys(run.rows[0]).sort(), ["kind", "observation", "schema_version", "selection", "status"]);
    assert.deepEqual(Object.keys(run.rows[2]).sort(), ["cleanup", "failure", "kind", "probe", "registry_row", "schema_version", "status", "unknown_outcome_blocks_registry"]);
    for (const forbidden of [secret, userId, profileCanary, "Authorization", "localStorage", "sessionStorage"])
      assert.doesNotMatch(run.output, new RegExp(forbidden));
    assert.equal(sanitizeVisibleText(`Contact person@example.test ${userId} raw-text`, ["raw-text"]), "Contact [redacted-email] [redacted-id] [redacted]");
    assert.equal(sanitizeObservedUrl(`${targetOrigin}/users/${userId}?token=private#secret`), `${targetOrigin}/users/:redacted`);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});
