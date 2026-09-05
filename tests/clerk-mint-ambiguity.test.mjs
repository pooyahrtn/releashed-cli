import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapClerkAuthentication,
  CLERK_DOMAINS_ENDPOINT,
  CLERK_MINT_OUTCOME_UNKNOWN_CODE,
  CLERK_SIGN_IN_TOKEN_ENDPOINT,
  provisionDisposableClerkIdentity
} from "../supervisor/clerk-bootstrap.mjs";

const deadlineSoon = (milliseconds = 1_000) => new Date(Date.now() + milliseconds).toISOString();
const frontendOrigin = "https://clerk.example.test";
const matchingDomains = () => Response.json({ data: [{ frontend_api_url: frontendOrigin }], total_count: 1 });

function fakeTiming() {
  let monotonic = 100;
  let wall = 1_000;
  return {
    timing: {
      monotonicNow: () => monotonic,
      wallNow: () => wall,
      wait: async () => {}
    },
    advanceMonotonic: (milliseconds) => { monotonic += milliseconds; },
    advanceWall: (milliseconds) => { wall += milliseconds; },
    advanceBoth: (milliseconds) => { monotonic += milliseconds; wall += milliseconds; }
  };
}

async function ambiguousMint({
  mintResponse,
  deadlineMs = 1_000,
  timing = fakeTiming(),
  sessionResponse = () => [],
  revokeFails = false
}) {
  const calls = [];
  let browserCalls = 0;
  let inventories = 0;
  const environment = { CLERK_SECRET_KEY: "sk_test_private-never-output" };
  const error = await bootstrapClerkAuthentication({
    browser: { call: async () => { browserCalls += 1; } },
    expectedUserId: "user_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: deadlineSoon(deadlineMs),
    environment,
    deferFailureCleanup: true,
    timing: timing.timing,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      if (String(url).includes("/v1/sessions?")) {
        const rows = sessionResponse(inventories);
        inventories += 1;
        if (rows instanceof Error) throw rows;
        return Response.json(rows);
      }
      if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return mintResponse(timing);
      if (String(url).endsWith("/revoke")) {
        if (typeof revokeFails === "function" ? revokeFails(String(url)) : revokeFails) {
          throw new Error("private revoke failure");
        }
        return Response.json({ ok: true });
      }
      return Response.json({}, { status: 404 });
    }
  }).catch((caught) => caught);
  return { browserCalls, calls, environment, error, timing };
}

function assertOneMintAndNoBrowser(run) {
  assert(run.error instanceof Error);
  assert.equal(run.error.code, CLERK_MINT_OUTCOME_UNKNOWN_CODE);
  assert.equal(run.error.calibration_failure_code, CLERK_MINT_OUTCOME_UNKNOWN_CODE);
  assert.equal(run.error.message, "Clerk authentication preparation failed");
  assert.equal(run.browserCalls, 0);
  assert.equal(run.calls.filter(({ url, method }) => url === CLERK_SIGN_IN_TOKEN_ENDPOINT && method === "POST").length, 1);
  assert.equal("CLERK_SECRET_KEY" in run.environment, false);
  assert.doesNotMatch(`${run.error.message} ${run.error.code} ${JSON.stringify(run.error)}`, /private-never-output|user_expected|ticket_private|sit_/);
}

test("the expiry quarantine starts only when a late mint failure becomes observable", async () => {
  const timing = fakeTiming();
  const run = await ambiguousMint({
    timing,
    mintResponse: async (clock) => ({
      ok: true,
      status: 200,
      json: async () => {
        clock.advanceBoth(3_000);
        throw new Error("late private parse failure");
      }
    })
  });
  assertOneMintAndNoBrowser(run);

  timing.advanceBoth(59_000);
  const dispatchPlusSixtyTwoSeconds = await run.error.cleanup();
  assert.equal(dispatchPlusSixtyTwoSeconds.cleanup_complete, false);
  assert.equal(dispatchPlusSixtyTwoSeconds.sign_in_token_expired, false);

  timing.advanceBoth(3_000);
  const fullQuarantine = await run.error.cleanup();
  assert.equal(fullQuarantine.cleanup_complete, true);
  assert.equal(fullQuarantine.sign_in_token_expired, true);
});

for (const [label, mintResponse] of [
  ["fetch timeout", () => new Promise(() => {})],
  ["body timeout", async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })]
]) {
  test(`${label} after the one mint dispatch retains expiry cleanup custody`, async () => {
    const run = await ambiguousMint({ mintResponse, deadlineMs: 100 });
    assertOneMintAndNoBrowser(run);
    assert.equal(typeof run.error.cleanup, "function");

    const beforeExpiry = await run.error.cleanup();
    assert.equal(beforeExpiry.cleanup_complete, false);
    assert.equal(beforeExpiry.sign_in_token_expired, false);
    assert.equal(beforeExpiry.sign_in_token_unusable_by_identity_deletion, false);

    run.timing.advanceMonotonic(63_000);
    assert.equal((await run.error.cleanup()).cleanup_complete, false, "wall time must also prove expiry");
    run.timing.advanceWall(63_000);
    const expired = await run.error.cleanup();
    assert.equal(expired.cleanup_complete, true);
    assert.equal(expired.sign_in_token_expired, true);
    assert.equal(expired.sign_in_token_unusable_by_identity_deletion, false);
  });
}

for (const [label, mintResponse] of [
  ["malformed JSON", async () => ({ ok: true, status: 200, json: async () => { throw new Error("private body"); } })],
  ["missing id", () => Response.json({ token: "ticket_private" })],
  ["invalid id", () => Response.json({ id: "not valid", token: "ticket_private" })],
  ["missing id and token", () => Response.json({})]
]) {
  test(`${label} is an unknown mint outcome that a disposable identity deletion can settle`, async () => {
    const run = await ambiguousMint({ mintResponse });
    assertOneMintAndNoBrowser(run);
    assert.equal((await run.error.cleanup()).cleanup_complete, false);
    const deleted = await run.error.cleanup({ identityDeleted: true });
    assert.equal(deleted.cleanup_complete, true);
    assert.equal(deleted.sign_in_token_expired, false);
    assert.equal(deleted.sign_in_token_unusable_by_identity_deletion, true);
  });
}

for (const [label, body] of [
  ["missing token", { id: "sit_known_missing" }],
  ["invalid token", { id: "sit_known_invalid", token: "bad" }]
]) {
  test(`${label} with a known id retains exactly one revocation`, async () => {
    const run = await ambiguousMint({ mintResponse: () => Response.json(body) });
    assertOneMintAndNoBrowser(run);
    assert.equal(typeof run.error.cleanup, "function");
    const cleanup = await run.error.cleanup();
    assert.equal(cleanup.cleanup_complete, true);
    assert.equal(cleanup.unused_sign_in_token_revoked, true);
    assert.equal(run.calls.filter(({ url }) => url.endsWith(`/v1/sign_in_tokens/${body.id}/revoke`)).length, 1);
    assert.doesNotMatch(JSON.stringify(cleanup), new RegExp(body.id));
  });
}

test("a known token keeps private custody after one revoke failure and succeeds on retry", async () => {
  let revokeAttempts = 0;
  const run = await ambiguousMint({
    mintResponse: () => Response.json({ id: "sit_known_retry", token: "bad" }),
    revokeFails: () => {
      revokeAttempts += 1;
      return revokeAttempts === 1;
    }
  });
  assertOneMintAndNoBrowser(run);
  assert.equal((await run.error.cleanup()).cleanup_complete, false);
  const cleanup = await run.error.cleanup();
  assert.equal(cleanup.cleanup_complete, true);
  assert.equal(cleanup.unused_sign_in_token_revoked, true);
  assert.equal(revokeAttempts, 2);
  assert.doesNotMatch(JSON.stringify(cleanup), /sit_|user_expected|private/);
});

test("one new session after unknown-token expiry stays incomplete and is never revoked", async () => {
  const timing = fakeTiming();
  const run = await ambiguousMint({
    timing,
    mintResponse: () => Response.json({ token: "ticket_private" }),
    sessionResponse: (inventory) => inventory === 0
      ? [{ id: "sess_preexisting" }]
      : [{ id: "sess_preexisting" }, { id: "sess_quarantine_new" }]
  });
  assertOneMintAndNoBrowser(run);
  timing.advanceBoth(63_000);
  const cleanup = await run.error.cleanup();
  assert.equal(cleanup.cleanup_complete, false);
  assert.equal(cleanup.session_reconciled, false);
  assert.equal(cleanup.run_session_revoked, false);
  assert.equal(cleanup.sign_in_token_expired, true);
  assert.equal(run.calls.filter(({ url, method }) => url.includes("/v1/sessions/") && method === "POST").length, 0);
  assert.doesNotMatch(JSON.stringify(cleanup), /sess_|user_expected|private/);
});

for (const [label, sessionResponse] of [
  [
    "multiple new sessions",
    (inventory) => inventory === 0 ? [] : [{ id: "sess_new_one" }, { id: "sess_new_two" }]
  ],
  ["failed post-expiry inventory", (inventory) => inventory === 0 ? [] : new Error("private inventory failure")]
]) {
  test(`${label} keeps unknown-mint cleanup incomplete`, async () => {
    const timing = fakeTiming();
    const run = await ambiguousMint({
      timing,
      mintResponse: () => Response.json({ token: "ticket_private" }),
      sessionResponse
    });
    assertOneMintAndNoBrowser(run);
    timing.advanceBoth(63_000);
    const cleanup = await run.error.cleanup();
    assert.equal(cleanup.cleanup_complete, false);
    assert.equal(cleanup.session_reconciled, false);
    assert.equal(cleanup.sign_in_token_expired, true);
    assert.equal(run.calls.filter(({ url, method }) => url.includes("/v1/sessions/") && method === "POST").length, 0);
    assert.doesNotMatch(`${run.error.message} ${JSON.stringify(cleanup)}`, /sess_|user_expected|private/);
  });
}

for (const [label, sessionResponse] of [
  ["inventory failure", (inventory) => inventory === 0 ? [] : inventory === 1 ? new Error("private inventory failure") : []],
  ["new session disappears", (inventory) => inventory === 0 ? [] : inventory === 1 ? [{ id: "sess_concurrent_login" }] : []]
]) {
  test(`unknown-id cleanup retains custody after ${label} and succeeds when a later inventory is clean`, async () => {
    const timing = fakeTiming();
    const run = await ambiguousMint({
      timing,
      mintResponse: () => Response.json({ token: "ticket_private" }),
      sessionResponse
    });
    assertOneMintAndNoBrowser(run);
    timing.advanceBoth(63_000);
    assert.equal((await run.error.cleanup()).cleanup_complete, false);
    const cleanup = await run.error.cleanup();
    assert.equal(cleanup.cleanup_complete, true);
    assert.equal(cleanup.session_reconciled, true);
    assert.equal(cleanup.run_session_revoked, false);
    assert.equal(run.calls.filter(({ url, method }) => url.includes("/v1/sessions/") && method === "POST").length, 0);
    assert.doesNotMatch(JSON.stringify(cleanup), /sess_|user_expected|private/);
  });
}

async function disposableMintFailure(mintBody) {
  const events = [];
  const marker = "flowmap_cal_22222222222222222222222222222222";
  const username = "flowmap_22222222222222222222222222222222";
  const lifecycle = await provisionDisposableClerkIdentity({
    environment: { CLERK_SECRET_KEY: "sk_test_disposable-private" },
    expectedFrontendOrigin: frontendOrigin,
    markerFactory: () => marker,
    fetchImpl: async (rawUrl, init = {}) => {
      const url = new URL(rawUrl);
      if (url.href === CLERK_DOMAINS_ENDPOINT) {
        events.push("domain-get");
        return matchingDomains();
      }
      if (init.method === "GET" && url.pathname === "/v1/users") {
        events.push("user-list");
        return Response.json({ data: [], total_count: 0 });
      }
      if (init.method === "POST" && url.pathname === "/v1/users") {
        events.push("user-create");
        const body = JSON.parse(init.body);
        assert.deepEqual(Object.keys(body).sort(), [
          "external_id",
          "first_name",
          "last_name",
          "skip_password_requirement",
          "username"
        ]);
        assert.equal(body.external_id, marker);
        assert.equal(body.username, username);
        return Response.json({ id: "user_disposable", external_id: marker, username });
      }
      if (init.method === "GET" && url.pathname === "/v1/sessions") {
        events.push("session-list");
        return Response.json([]);
      }
      if (init.method === "POST" && url.pathname === "/v1/sign_in_tokens") {
        events.push("token-mint");
        return Response.json(mintBody);
      }
      if (init.method === "POST" && url.pathname.endsWith("/revoke")) {
        events.push("token-revoke");
        return Response.json({ ok: true });
      }
      if (init.method === "DELETE" && url.pathname === "/v1/users/user_disposable") {
        events.push("user-delete");
        return Response.json({ deleted: true });
      }
      throw new Error("unexpected fixture request");
    }
  });
  const error = await lifecycle.authenticate({
    browser: { call: async () => assert.fail("browser must not receive an unusable ticket") }
  }).catch((caught) => caught);
  const cleanup = await lifecycle.cleanup({ browserStopped: true });
  assert.doesNotMatch(`${JSON.stringify(cleanup)} ${JSON.stringify(error)}`, new RegExp(username));
  return { cleanup, error, events };
}

test("disposable identity deletion settles an unknown-id mint without waiting for expiry", async () => {
  const run = await disposableMintFailure({ token: "ticket_private" });
  assert.equal(run.error.code, CLERK_MINT_OUTCOME_UNKNOWN_CODE);
  assert.deepEqual(run.events, ["domain-get", "user-list", "user-create", "domain-get", "session-list", "token-mint", "user-delete"]);
  assert.deepEqual(run.cleanup, {
    cleanup_complete: true,
    sessions_revoked_or_absent: true,
    sign_in_token_unusable: true,
    synthetic_identity_deleted: true
  });
});

test("a disposable mint with a known id revokes the token before deleting the identity", async () => {
  const run = await disposableMintFailure({ id: "sit_known_disposable", token: "bad" });
  assert.equal(run.error.code, CLERK_MINT_OUTCOME_UNKNOWN_CODE);
  assert.deepEqual(run.events, ["domain-get", "user-list", "user-create", "domain-get", "session-list", "token-mint", "token-revoke", "user-delete"]);
  assert.equal(run.cleanup.cleanup_complete, true);
  assert.equal(run.cleanup.sign_in_token_unusable, true);
  assert.equal(run.cleanup.synthetic_identity_deleted, true);
});
