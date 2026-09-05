import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CLERK_PAGE_AUTH_FAILURE_CODES } from "../lib/clerk-auth.mjs";
import {
  bootstrapClerkAuthentication,
  CLERK_DOMAINS_ENDPOINT,
  CLERK_MINT_OUTCOME_UNKNOWN_CODE,
  CLERK_SIGN_IN_TOKEN_ENDPOINT
} from "../supervisor/clerk-bootstrap.mjs";

const deadlineSoon = () => new Date(Date.now() + 2_000).toISOString();
const frontendOrigin = "https://clerk.example.test";
const matchingDomains = () => Response.json({ data: [{ frontend_api_url: frontendOrigin }], total_count: 1 });

function sessionListUrl(url) {
  return String(url).startsWith("https://api.clerk.com/v1/sessions?");
}

function validBrowser(response = {}) {
  return {
    call: async (_request, caller) => {
      assert.equal(caller, "supervisor");
      return {
        ok: true,
        authenticated: true,
        current_context_auth_methods_locked: true,
        persistent_clerk_network_filter: true,
        outcome_confirmed_after_timeout: false,
        active_session_id: "sess_run_new",
        ...response
      };
    }
  };
}

for (const [reportedCode, expectedCode] of [
  ...Object.values(CLERK_PAGE_AUTH_FAILURE_CODES).map((code) => [code, code]),
  ["clerk_auth_landing_unconfirmed", "clerk_auth_landing_unconfirmed"],
  ["private_provider_code", "clerk_auth_failed"]
]) {
  test(`bootstrap exposes only the allowlisted authentication code for ${reportedCode}`, async () => {
    const privateDetail = "private provider response user_expected ticket_private";
    const error = await bootstrapClerkAuthentication({
      browser: {
        call: async () => ({ ok: false, refusal: { code: reportedCode, message: privateDetail } })
      },
      expectedUserId: "user_expected",
      expectedFrontendOrigin: frontendOrigin,
      workingDayDeadline: deadlineSoon(),
      environment: { CLERK_SECRET_KEY: "sk_test_private" },
      deferFailureCleanup: true,
      fetchImpl: async (url) => {
        if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
        if (sessionListUrl(url)) return Response.json([]);
        if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_private", token: "ticket_private" });
        return Response.json({});
      }
    }).catch((caught) => caught);

    assert(error instanceof Error);
    assert.equal(error.calibration_failure_code, expectedCode);
    assert.doesNotMatch(error.message, /private provider response|user_expected|ticket_private|sk_test_private/);
    await error.cleanup({ browserStopped: true });
  });
}

test("successful cleanup revokes only the run-created session and is idempotent", async () => {
  const calls = [];
  const result = await bootstrapClerkAuthentication({
    browser: validBrowser(),
    expectedUserId: "user_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: deadlineSoon(),
    environment: { CLERK_SECRET_KEY: "sk_test_private" },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      if (sessionListUrl(url)) return Response.json([{ id: "sess_preexisting" }]);
      if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_run_new", token: "ticket_private" });
      if (String(url).endsWith("/v1/sessions/sess_run_new/revoke")) return Response.json({ id: "sess_run_new" });
      return Response.json({}, { status: 404 });
    }
  });

  const firstCall = result.cleanup();
  const concurrentCall = result.cleanup();
  assert.equal(firstCall, concurrentCall);
  const [first, second] = await Promise.all([firstCall, concurrentCall]);
  assert.deepEqual(first, second);
  assert.equal(first.cleanup_complete, true);
  const revokeUrls = calls.filter(({ url }) => url.endsWith("/revoke")).map(({ url }) => url);
  assert.deepEqual(revokeUrls, ["https://api.clerk.com/v1/sessions/sess_run_new/revoke"]);
  assert.equal(revokeUrls.some((url) => url.includes("sess_preexisting")), false);
  for (const { init } of calls) {
    assert.equal(init.redirect, "error");
    assert(init.signal instanceof AbortSignal);
  }
});

test("a known sign-in token with malformed ticket bytes is revoked before failing", async () => {
  const calls = [];
  const error = await bootstrapClerkAuthentication({
    browser: { call: async () => assert.fail("browser must not run") },
    expectedUserId: "user_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: deadlineSoon(),
    environment: { CLERK_SECRET_KEY: "sk_test_private" },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      if (sessionListUrl(url)) return Response.json([]);
      if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_malformed", token: "bad" });
      if (String(url).endsWith("/v1/sign_in_tokens/sit_malformed/revoke")) return Response.json({ id: "sit_malformed" });
      return Response.json({}, { status: 404 });
    }
  }).catch((caught) => caught);

  assert(error instanceof Error);
  assert.equal(error.message, "Clerk authentication preparation failed");
  assert.equal(error.calibration_failure_code, CLERK_MINT_OUTCOME_UNKNOWN_CODE);
  assert.deepEqual(error.cleanup, {
    cleanup_complete: true,
    session_reconciled: true,
    run_session_revoked: false,
    unused_sign_in_token_revoked: true
  });
  assert.deepEqual(
    calls.filter(({ url }) => url.endsWith("/revoke")).map(({ url }) => url),
    ["https://api.clerk.com/v1/sign_in_tokens/sit_malformed/revoke"]
  );
  assert.doesNotMatch(JSON.stringify(error.cleanup), /sit_malformed|user_expected|sk_test_private/);
});

test("session inventory follows pages but refuses to mint beyond its fixed bound", async () => {
  const calls = [];
  const environment = { CLERK_SECRET_KEY: "sk_test_private" };
  const error = await bootstrapClerkAuthentication({
    browser: { call: async () => assert.fail("browser must not run") },
    expectedUserId: "user_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: deadlineSoon(),
    environment,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      assert.equal(init.method, "GET");
      return Response.json(Array.from({ length: 100 }, (_, index) => ({ id: `sess_page_${calls.length}_${index}` })));
    }
  }).catch((caught) => caught);
  assert(error instanceof Error);
  assert.equal(error.message, "Clerk authentication preparation failed");
  assert.equal(error.calibration_failure_code, "clerk_auth_preparation_failed");
  assert.equal(calls.length, 11);
  assert.equal(calls.some(({ url }) => url === CLERK_SIGN_IN_TOKEN_ENDPOINT), false);
  assert.equal("CLERK_SECRET_KEY" in environment, false);
});

test("ambiguous authentication revokes the unique new session even when its ticket was already consumed", async () => {
  let inventory = 0;
  const calls = [];
  const error = await bootstrapClerkAuthentication({
    browser: { call: async () => { throw new Error("browser private failure"); }, stop: async () => {} },
    expectedUserId: "user_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: deadlineSoon(),
    environment: { CLERK_SECRET_KEY: "sk_test_private" },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      if (sessionListUrl(url)) {
        inventory += 1;
        return Response.json(inventory === 1
          ? [{ id: "sess_preexisting" }]
          : [{ id: "sess_preexisting" }, { id: "sess_unique_new" }]);
      }
      if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_unconfirmed", token: "ticket_private" });
      if (String(url).endsWith("/v1/sign_in_tokens/sit_unconfirmed/revoke")) {
        return Response.json({ errors: [{ message: "already consumed private provider detail" }] }, { status: 400 });
      }
      return Response.json({});
    }
  }).catch((caught) => caught);

  assert(error instanceof Error);
  assert.equal(error.calibration_failure_code, "clerk_auth_outcome_unknown");
  assert.deepEqual(error.cleanup, {
    cleanup_complete: true,
    session_reconciled: true,
    run_session_revoked: true,
    unused_sign_in_token_revoked: false
  });
  assert.deepEqual(
    calls.filter(({ url }) => url.endsWith("/revoke")).map(({ url }) => url),
    [
      "https://api.clerk.com/v1/sessions/sess_unique_new/revoke",
      "https://api.clerk.com/v1/sign_in_tokens/sit_unconfirmed/revoke"
    ]
  );
  assert.doesNotMatch(JSON.stringify(error.cleanup), /sess_|sit_|ticket|user_expected|sk_test/);
  assert.doesNotMatch(error.message, /browser private|sess_|sit_|ticket|user_expected|sk_test/);
});

test("an unconfirmed auth landing reconciles and revokes the created session as ambiguous", async () => {
  let inventory = 0;
  const calls = [];
  const error = await bootstrapClerkAuthentication({
    browser: {
      call: async () => ({
        ok: false,
        refusal: { code: "clerk_auth_landing_unconfirmed", message: "private landing detail" }
      }),
      stop: async () => {}
    },
    expectedUserId: "user_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: deadlineSoon(),
    environment: { CLERK_SECRET_KEY: "sk_test_private" },
    fetchImpl: async (url) => {
      const href = String(url);
      calls.push(href);
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      if (sessionListUrl(url)) {
        inventory += 1;
        return Response.json(inventory === 1
          ? [{ id: "sess_preexisting" }]
          : [{ id: "sess_preexisting" }, { id: "sess_created_during_auth" }]);
      }
      if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_consumed", token: "ticket_private" });
      if (href.endsWith("/v1/sign_in_tokens/sit_consumed/revoke")) return Response.json({}, { status: 400 });
      return Response.json({});
    }
  }).catch((caught) => caught);

  assert(error instanceof Error);
  assert.equal(error.calibration_failure_code, "clerk_auth_landing_unconfirmed");
  assert.deepEqual(error.cleanup, {
    cleanup_complete: true,
    session_reconciled: true,
    run_session_revoked: true,
    unused_sign_in_token_revoked: false
  });
  assert.equal(calls.some((url) => url.endsWith("/v1/sessions/sess_created_during_auth/revoke")), true);
  assert.doesNotMatch(JSON.stringify(error.cleanup), /sess_|sit_|ticket|private/);
});

test("a timed-out browser is fully stopped before the after-session inventory", async () => {
  let inventory = 0;
  let lateSessionExists = false;
  const order = [];
  const calls = [];
  const error = await bootstrapClerkAuthentication({
    browser: {
      call: async () => { throw new Error("ambiguous"); },
      stop: async () => {
        order.push("stop-start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        lateSessionExists = true;
        order.push("stop-complete");
      }
    },
    expectedUserId: "user_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: deadlineSoon(),
    environment: { CLERK_SECRET_KEY: "sk_test_private" },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      if (sessionListUrl(url)) {
        inventory += 1;
        if (inventory === 2) order.push("after-inventory");
        return Response.json(lateSessionExists ? [{ id: "sess_late_new" }] : []);
      }
      if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_late", token: "ticket_private" });
      return Response.json({});
    }
  }).catch((caught) => caught);

  assert(error instanceof Error);
  assert.deepEqual(order, ["stop-start", "stop-complete", "after-inventory"]);
  assert.equal(error.cleanup.cleanup_complete, true);
  assert.deepEqual(
    calls.filter(({ url }) => url.endsWith("/revoke")).map(({ url }) => url),
    [
      "https://api.clerk.com/v1/sessions/sess_late_new/revoke",
      "https://api.clerk.com/v1/sign_in_tokens/sit_late/revoke"
    ]
  );
});

test("multiple new sessions are never guessed or revoked", async () => {
  let inventory = 0;
  const calls = [];
  const error = await bootstrapClerkAuthentication({
    browser: { call: async () => { throw new Error("unknown"); }, stop: async () => {} },
    expectedUserId: "user_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: deadlineSoon(),
    environment: { CLERK_SECRET_KEY: "sk_test_private" },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      if (sessionListUrl(url)) {
        inventory += 1;
        return Response.json(inventory === 1
          ? [{ id: "sess_preexisting" }]
          : [{ id: "sess_preexisting" }, { id: "sess_new_one" }, { id: "sess_new_two" }]);
      }
      if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_unconfirmed", token: "ticket_private" });
      return Response.json({});
    }
  }).catch((caught) => caught);

  assert(error instanceof Error);
  assert.equal(error.cleanup.cleanup_complete, false);
  assert.equal(error.cleanup.session_reconciled, false);
  assert.equal(error.cleanup.run_session_revoked, false);
  assert.equal(error.cleanup.unused_sign_in_token_revoked, true);
  assert.deepEqual(
    calls.filter(({ url }) => url.endsWith("/revoke")).map(({ url }) => url),
    ["https://api.clerk.com/v1/sign_in_tokens/sit_unconfirmed/revoke"]
  );
});

test("an unconsumed ticket is revoked even when no session appeared", async () => {
  const calls = [];
  const error = await bootstrapClerkAuthentication({
    browser: { call: async () => { throw new Error("unknown"); }, stop: async () => {} },
    expectedUserId: "user_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: deadlineSoon(),
    environment: { CLERK_SECRET_KEY: "sk_test_private" },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      if (sessionListUrl(url)) return Response.json([{ id: "sess_preexisting" }]);
      if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_unused", token: "ticket_private" });
      return Response.json({});
    }
  }).catch((caught) => caught);
  assert(error instanceof Error);
  assert.equal(error.cleanup.cleanup_complete, false);
  assert.equal(error.cleanup.session_reconciled, false);
  assert.equal(error.cleanup.run_session_revoked, false);
  assert.equal(error.cleanup.unused_sign_in_token_revoked, true);
  assert.deepEqual(
    calls.filter(({ url }) => url.endsWith("/revoke")).map(({ url }) => url),
    ["https://api.clerk.com/v1/sign_in_tokens/sit_unused/revoke"]
  );
});

test("the supervisor-only active session id is absent from retained-safe results", async () => {
  const sensitive = ["sess_run_new", "sit_run_new", "ticket_private", "user_expected", "sk_test_private"];
  const result = await bootstrapClerkAuthentication({
    browser: validBrowser(),
    expectedUserId: "user_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: deadlineSoon(),
    environment: { CLERK_SECRET_KEY: "sk_test_private" },
    fetchImpl: async (url) => {
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      if (sessionListUrl(url)) return Response.json([]);
      if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_run_new", token: "ticket_private" });
      return Response.json({ id: "sess_run_new" });
    }
  });
  const serializedResult = JSON.stringify(result);
  const serializedCleanup = JSON.stringify(await result.cleanup());
  for (const value of sensitive) {
    assert.doesNotMatch(serializedResult, new RegExp(value));
    assert.doesNotMatch(serializedCleanup, new RegExp(value));
  }
});

test("the browser exposes the cleanup session id only behind its supervisor auth method", async () => {
  const source = await readFile(new URL("../supervisor/browser-broker.mjs", import.meta.url), "utf8");
  const authStart = source.indexOf("async authenticateClerkTicket");
  const authEnd = source.indexOf("inspectObservedControl");
  const authMethod = source.slice(authStart, authEnd);
  assert.doesNotMatch(`${source.slice(0, authStart)}${source.slice(authEnd)}`, /active_session_id/);
  assert.match(authMethod, /active_session_id: result\.active_session_id/);
  const executeStart = source.indexOf("async execute");
  const dispatch = source.slice(executeStart, source.indexOf("async shutdown", executeStart));
  assert.match(dispatch, /request\.method === "authenticate_clerk_ticket"[\s\S]+caller !== "supervisor"[\s\S]+return this\.authenticateClerkTicket/);
});
