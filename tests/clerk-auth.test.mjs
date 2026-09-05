import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  CLERK_PAGE_AUTH_FAILURE_CODES,
  CLERK_TICKET_TTL_SECONDS,
  CLERK_TICKET_EXCHANGE_FAILURE_STAGES,
  isPermittedClerkMutation,
  provisionalClerkBootstrapTouchSessionId,
  OneShotClerkPageAuthenticator
} from "../lib/clerk-auth.mjs";
import {
  bootstrapClerkAuthentication,
  CLERK_DOMAINS_ENDPOINT,
  CLERK_SIGN_IN_TOKEN_ENDPOINT
} from "../supervisor/clerk-bootstrap.mjs";
import { CLERK_PAGE_FUNCTIONS } from "../supervisor/browser-broker.mjs";

const deadlineSoon = () => new Date(Date.now() + 1_000).toISOString();
const frontendOrigin = "https://clerk.example.test";
const matchingDomains = () => Response.json({ data: [{ frontend_api_url: frontendOrigin }], total_count: 1 });

function pageClerk({
  userId = "user_expected",
  signInStatus = null,
  signInResource = null,
  create = async () => ({ createdSessionId: "sess_expected" }),
  setActive = async () => {},
  getToken = async () => "token_confirmed"
} = {}) {
  return {
    loaded: true,
    user: { id: userId },
    client: { signIn: signInResource ?? { create, status: signInStatus } },
    setActive,
    session: { id: "sess_expected", getToken }
  };
}

async function callPageClerkStart(Clerk, now = () => 0) {
  const href = "https://app.example.test/auth";
  const start = runInNewContext(`(${CLERK_PAGE_FUNCTIONS.start})`, {
    Clerk,
    location: { href },
    Date: { now },
    setTimeout: (callback) => callback()
  });
  const exchange = await start("ticket_private", "user_expected", href);
  if (exchange?.failure_stage) return JSON.parse(JSON.stringify(exchange));
  const activate = runInNewContext(`(${CLERK_PAGE_FUNCTIONS.activate})`, { Clerk });
  return JSON.parse(JSON.stringify(await activate(exchange.created_session_id, "user_expected")));
}

test("page-side Clerk readiness waits without receiving authentication material", async () => {
  let now = 0;
  const context = {
    Date: { now: () => now },
    setTimeout(callback) {
      now += 25;
      context.Clerk = pageClerk();
      callback();
    }
  };
  const ready = runInNewContext(`(${CLERK_PAGE_FUNCTIONS.ready})`, context);

  assert.equal(await ready(100), true);
  assert.doesNotMatch(CLERK_PAGE_FUNCTIONS.ready, /ticket|expectedUser|signIn\.create/);

  const unavailable = runInNewContext(`(${CLERK_PAGE_FUNCTIONS.ready})`, {
    Date: { now: (() => { let value = 0; return () => value += 25; })() },
    setTimeout: (callback) => callback()
  });
  assert.equal(await unavailable(50), false);
});

test("post-auth page readiness rejects loading, busy, and animated documents", () => {
  const evaluate = (document) => runInNewContext(`(${CLERK_PAGE_FUNCTIONS.postAuthReady})`, { document })();
  const stable = {
    readyState: "complete",
    querySelector: () => null,
    getAnimations: () => []
  };
  assert.equal(evaluate(stable), true);
  assert.equal(evaluate({ ...stable, readyState: "interactive" }), false);
  assert.equal(evaluate({ ...stable, querySelector: () => ({}) }), false);
  assert.equal(evaluate({ ...stable, getAnimations: () => [{ playState: "running" }] }), false);
  assert.equal(evaluate({ ...stable, getAnimations: () => [{ playState: "pending" }] }), false);
});

test("page-side Clerk start returns only its fixed diagnostic stages", async () => {
  const privateDetail = "private-provider-detail ticket_private user_expected";
  let unavailableNow = -6_000;
  const cases = [
    ["sdk_unavailable", undefined, () => { unavailableNow += 6_000; return unavailableNow; }],
    ["precondition_failed", pageClerk({ userId: "user_other" })],
    ["ticket_exchange_transport_or_runtime_clean", pageClerk({ create: async () => { throw new Error(privateDetail); } })],
    ["session_missing", pageClerk({ create: async () => ({ provider_error: privateDetail }) })],
    ["activation_failed", pageClerk({ setActive: async () => { throw new Error(privateDetail); } })],
    ["token_confirmation_failed", pageClerk({ getToken: async () => { throw new Error(privateDetail); } })]
  ];
  for (const [failureStage, clerk, now] of cases) {
    const result = await callPageClerkStart(clerk, now);
    assert.deepEqual(result, { failure_stage: failureStage });
    assert.doesNotMatch(JSON.stringify(result), /private-provider-detail|ticket_private|user_expected/);
  }

  assert.deepEqual(await callPageClerkStart(pageClerk()), {
    user_id: "user_expected",
    session_id: "sess_expected",
    token_present: true
  });
});

const plantedAuthSecrets = [
  "ticket_planted_never_retain",
  "user_planted_never_retain",
  "sess_planted_never_retain",
  "provider-message-never-retain",
  "provider-meta-never-retain",
  "trace_never_retain"
];

function plantedClerkError(status) {
  const error = new Error(plantedAuthSecrets[3]);
  if (status !== undefined) error.status = status;
  error.clerkError = true;
  error.clerkTraceId = plantedAuthSecrets[5];
  error.errors = [{
    code: "provider_code_never_retain",
    message: plantedAuthSecrets[3],
    longMessage: plantedAuthSecrets[0],
    meta: {
      sessionId: plantedAuthSecrets[2],
      identifiers: [plantedAuthSecrets[1]],
      private: plantedAuthSecrets[4]
    }
  }];
  return error;
}

for (const [state, signInStatus] of [["clean", null], ["existing", "needs_identifier"]]) {
  for (const [status, bucket] of [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [409, "conflict"],
    [422, "rejected"],
    [418, "rejected"],
    [429, "rate_limited"],
    [503, "provider_5xx"],
    [undefined, "transport_or_runtime"]
  ]) {
    test(`page-side Clerk reports only fixed ${bucket} / ${state} ticket diagnostics`, async () => {
      let calls = 0;
      const result = await callPageClerkStart(pageClerk({
        signInStatus,
        create: async (params) => {
          calls += 1;
          assert.equal(params.strategy, "ticket");
          assert.equal(params.ticket, "ticket_private");
          throw plantedClerkError(status);
        }
      }));
      assert.equal(calls, 1);
      assert.deepEqual(result, {
        failure_stage: CLERK_TICKET_EXCHANGE_FAILURE_STAGES[state][bucket]
      });
      for (const secret of plantedAuthSecrets) {
        assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
      }
    });
  }
}

test("unknown ticket errors and throwing state or status getters stay generic and leak nothing", async () => {
  let calls = 0;
  const cases = [
    pageClerk({
      signInResource: {
        create: async () => { calls += 1; },
        get status() { throw new Error(plantedAuthSecrets.join(" ")); }
      }
    }),
    pageClerk({
      signInStatus: "provider_private_unknown_state",
      create: async () => { calls += 1; }
    }),
    pageClerk({
      create: async () => {
        calls += 1;
        throw Object.defineProperty({}, "status", {
          get() { throw new Error(plantedAuthSecrets.join(" ")); }
        });
      }
    }),
    pageClerk({
      create: async () => {
        calls += 1;
        throw { status: "provider_private_unknown_status", private: plantedAuthSecrets };
      }
    }),
    pageClerk({
      create: async () => {
        calls += 1;
        throw plantedAuthSecrets.join(" ");
      }
    })
  ];
  for (const clerk of cases) {
    const result = await callPageClerkStart(clerk);
    assert.deepEqual(result, { failure_stage: "ticket_exchange_failed" });
    for (const secret of plantedAuthSecrets) {
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    }
  }
  assert.equal(calls, 3);
});

test("the mounted sign-in resource stays read-only until the one ticket exchange", async () => {
  let calls = 0;
  const clerk = pageClerk({
    create: async () => {
      calls += 1;
      return { createdSessionId: "sess_expected" };
    }
  });
  const mountedSignIn = clerk.client.signIn;
  assert.equal(mountedSignIn.status, null);
  assert.equal(calls, 0);

  const ready = runInNewContext(`(${CLERK_PAGE_FUNCTIONS.ready})`, { Clerk: clerk, Date, setTimeout });
  assert.equal(await ready(100), true);
  assert.equal(calls, 0);
  assert.deepEqual(await callPageClerkStart(clerk), {
    user_id: "user_expected",
    session_id: "sess_expected",
    token_present: true
  });
  assert.equal(calls, 1);
});

test("page authentication exposes the created session only between exchange and activation", async () => {
  const phases = [];
  const clerk = pageClerk({
    create: async () => {
      phases.push("exchange");
      return { createdSessionId: "sess_expected" };
    },
    setActive: async ({ session }) => phases.push(`activate:${session}`),
    getToken: async () => {
      phases.push("token");
      return "token_confirmed";
    }
  });
  const href = "https://app.example.test/auth";
  const start = runInNewContext(`(${CLERK_PAGE_FUNCTIONS.start})`, { Clerk: clerk, location: { href } });
  const exchange = JSON.parse(JSON.stringify(await start("ticket_private", "user_expected", href)));
  assert.deepEqual(exchange, { created_session_id: "sess_expected" });
  assert.deepEqual(phases, ["exchange"]);
  const activate = runInNewContext(`(${CLERK_PAGE_FUNCTIONS.activate})`, { Clerk: clerk });
  assert.deepEqual(JSON.parse(JSON.stringify(await activate(exchange.created_session_id, "user_expected"))), {
    user_id: "user_expected",
    session_id: "sess_expected",
    token_present: true
  });
  assert.deepEqual(phases, ["exchange", "activate:sess_expected", "token"]);
});

test("supervisor mints exactly one 60-second ticket and returns no auth material", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-clerk-auth-"));
  const secret = "sk_live_never-retain-this-secret";
  const ticket = "one-use-ticket-never-retain-this";
  const returnedUrl = `https://clerk.example.test/sign-in?ticket=${ticket}`;
  const environment = { CLERK_SECRET_KEY: secret };
  const calls = [];
  let browserCalls = 0;
  const browser = {
    call: async (payload, caller) => {
      browserCalls += 1;
      assert.equal(caller, "supervisor");
      assert.deepEqual(payload, {
        method: "authenticate_clerk_ticket",
        ticket,
        expected_user_id: "user_expected"
      });
      return {
        ok: true,
        authenticated: true,
        current_context_auth_methods_locked: true,
        persistent_clerk_network_filter: true,
        outcome_confirmed_after_timeout: false,
        active_session_id: "sess_run_created"
      };
    }
  };
  try {
    const result = await bootstrapClerkAuthentication({
      browser,
      expectedUserId: "user_expected",
      expectedFrontendOrigin: frontendOrigin,
      workingDayDeadline: deadlineSoon(),
      environment,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
        if (String(url).includes("/v1/sessions?")) return Response.json([]);
        if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_run_created", token: ticket, url: returnedUrl });
        if (String(url).endsWith("/v1/sessions/sess_run_created/revoke")) return Response.json({ id: "sess_run_created" });
        return Response.json({}, { status: 404 });
      }
    });
    const cleanup = await result.cleanup();
    assert.equal(calls.length, 4);
    assert.equal(browserCalls, 1);
    assert.equal(calls[0].url, CLERK_DOMAINS_ENDPOINT);
    assert.match(calls[1].url, /^https:\/\/api\.clerk\.com\/v1\/sessions\?/);
    assert.equal(calls[2].url, CLERK_SIGN_IN_TOKEN_ENDPOINT);
    assert.equal(calls[2].init.method, "POST");
    assert.equal(calls[2].init.redirect, "error");
    assert.equal(calls[2].init.headers.Authorization, `Bearer ${secret}`);
    assert.equal(calls[2].init.body, JSON.stringify({ user_id: "user_expected", expires_in_seconds: CLERK_TICKET_TTL_SECONDS }));
    assert.equal(calls[3].url, "https://api.clerk.com/v1/sessions/sess_run_created/revoke");
    assert.deepEqual(cleanup, {
      cleanup_complete: true,
      session_reconciled: true,
      run_session_revoked: true,
      unused_sign_in_token_revoked: false
    });
    assert.equal(CLERK_TICKET_TTL_SECONDS, 60);
    assert.equal("CLERK_SECRET_KEY" in environment, false);
    assert.deepEqual(await readdir(root), []);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(result), /one-use-ticket|clerk\.example|user_expected|sess_run_created|sit_run_created/);
    assert.doesNotMatch(JSON.stringify(cleanup), /sess_run_created|sit_run_created/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor redacts provider, network, ticket, and browser failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-clerk-redaction-"));
  const secrets = ["sk_live_secret-value", "ticket_secret-value", "user_expected"];
  try {
    for (const failure of [
      () => { throw new Error(`network ${secrets.join(" ")}`); },
      () => Response.json({ errors: [{ message: secrets.join(" ") }] }, { status: 401 })
    ]) {
      const environment = { CLERK_SECRET_KEY: secrets[0] };
      const error = await bootstrapClerkAuthentication({ browser: { call: async () => assert.fail("browser must not run") }, expectedUserId: "user_expected", expectedFrontendOrigin: frontendOrigin, workingDayDeadline: deadlineSoon(), environment, fetchImpl: failure }).catch((caught) => caught);
      assert(error instanceof Error);
      for (const secret of secrets) assert.doesNotMatch(error.message, new RegExp(secret));
      assert.equal("CLERK_SECRET_KEY" in environment, false);
    }
    const environment = { CLERK_SECRET_KEY: secrets[0] };
    const error = await bootstrapClerkAuthentication({
      browser: { call: async () => { throw new Error(`browser leaked ${secrets.join(" ")}`); } },
      expectedUserId: "user_expected",
      expectedFrontendOrigin: frontendOrigin,
      workingDayDeadline: deadlineSoon(),
      environment,
      fetchImpl: async (url) => {
        if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
        if (String(url).includes("/v1/sessions?")) return Response.json([]);
        if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_redacted", token: secrets[1] });
        return Response.json({ id: "sit_redacted" });
      }
    }).catch((caught) => caught);
    for (const secret of secrets) assert.doesNotMatch(error.message, new RegExp(secret));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, fetchImpl] of [
  ["fetch", (_url, init) => { assert.equal(init.signal.aborted, false); return new Promise(() => {}); }],
  ["body", async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })]
]) {
  test(`a nonsettling Clerk ${label} cannot outlive the owner deadline`, async () => {
    const environment = { CLERK_SECRET_KEY: "sk_live_bounded-secret" };
    const started = Date.now();
    const error = await bootstrapClerkAuthentication({
      browser: { call: async () => assert.fail("browser must not run") },
      expectedUserId: "user_expected",
      expectedFrontendOrigin: frontendOrigin,
      workingDayDeadline: new Date(Date.now() + 25).toISOString(),
      environment,
      fetchImpl
    }).catch((caught) => caught);
    assert(error instanceof Error);
    assert(Date.now() - started < 500);
    assert.equal("CLERK_SECRET_KEY" in environment, false);
  });
}

for (const [label, state] of [
  ["wrong user", { user_id: "user_other", session_id: "sess_expected", token_present: true }],
  ["missing session", { user_id: "user_expected", session_id: null, token_present: true }],
  ["missing token", { user_id: "user_expected", session_id: "sess_expected", token_present: false }]
]) {
  test(`page authentication fails closed for ${label} and locks methods`, async () => {
    let starts = 0;
    let locks = 0;
    const auth = new OneShotClerkPageAuthenticator({
      start: async () => { starts += 1; return state; },
      inspect: async () => assert.fail("non-timeout failure must not inspect"),
      lock: async () => { locks += 1; }
    });
    const result = await auth.authenticate({ ticket: "ticket_valid", expectedUserId: "user_expected" });
    assert.equal(result.ok, false);
    assert.equal(result.refusal.code, "clerk_auth_failed");
    assert.equal(starts, 1);
    assert.equal(locks, 1);
    assert.equal((await auth.authenticate({ ticket: "ticket_second", expectedUserId: "user_expected" })).refusal.code, "clerk_auth_locked");
    assert.equal(starts, 1);
  });
}

for (const [failureStage, failureCode] of Object.entries(CLERK_PAGE_AUTH_FAILURE_CODES)) {
  test(`page failure stage ${failureStage} maps to only ${failureCode} and cannot retry`, async () => {
    let starts = 0;
    let locks = 0;
    const auth = new OneShotClerkPageAuthenticator({
      start: async () => {
        starts += 1;
        return {
          failure_stage: failureStage,
          provider_error: plantedAuthSecrets,
          errors: [{ message: plantedAuthSecrets[3], meta: plantedAuthSecrets[4] }],
          clerkTraceId: plantedAuthSecrets[5]
        };
      },
      inspect: async () => assert.fail("a fixed failure must not inspect"),
      lock: async () => { locks += 1; }
    });
    const result = await auth.authenticate({ ticket: "ticket_valid", expectedUserId: "user_expected" });
    assert.equal(result.refusal.code, failureCode);
    for (const secret of plantedAuthSecrets) {
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    }
    assert.equal((await auth.authenticate({ ticket: "ticket_retry", expectedUserId: "user_expected" })).refusal.code, "clerk_auth_locked");
    assert.equal(starts, 1);
    assert.equal(locks, 1);
  });
}

for (const [label, start] of [
  ["unknown stage", async () => ({ failure_stage: "private-provider-detail" })],
  ["prototype-named stage", async () => ({ failure_stage: "toString" })],
  ["thrown detail", async () => { throw new Error("private-provider-detail"); }]
]) {
  test(`${label} collapses to clerk_auth_failed, locks once, and cannot retry`, async () => {
    let locks = 0;
    const auth = new OneShotClerkPageAuthenticator({
      start,
      inspect: async () => assert.fail("an unknown failure must not inspect"),
      lock: async () => { locks += 1; }
    });
    const result = await auth.authenticate({ ticket: "ticket_valid", expectedUserId: "user_expected" });
    assert.equal(result.refusal.code, "clerk_auth_failed");
    assert.doesNotMatch(JSON.stringify(result), /private-provider-detail/);
    assert.equal((await auth.authenticate({ ticket: "ticket_retry", expectedUserId: "user_expected" })).refusal.code, "clerk_auth_locked");
    assert.equal(locks, 1);
  });
}

test("a lock failure stays generic and the lock is never retried", async () => {
  let locks = 0;
  const auth = new OneShotClerkPageAuthenticator({
    start: async () => ({ failure_stage: "sdk_unavailable" }),
    inspect: async () => assert.fail("a fixed failure must not inspect"),
    lock: async () => { locks += 1; throw new Error("private-lock-detail"); }
  });
  const result = await auth.authenticate({ ticket: "ticket_valid", expectedUserId: "user_expected" });
  assert.equal(result.refusal.code, "clerk_auth_failed");
  assert.equal((await auth.authenticate({ ticket: "ticket_retry", expectedUserId: "user_expected" })).refusal.code, "clerk_auth_locked");
  assert.equal(locks, 1);
});

test("an ambiguous timeout inspects once, never retries, and still locks methods", async () => {
  let starts = 0;
  let inspections = 0;
  let locks = 0;
  const auth = new OneShotClerkPageAuthenticator({
    start: async () => { starts += 1; return new Promise(() => {}); },
    inspect: async () => { inspections += 1; return { user_id: "user_expected", session_id: "sess_expected", token_present: true }; },
    lock: async () => { locks += 1; },
    timeoutMs: 5
  });
  const result = await auth.authenticate({ ticket: "ticket_valid", expectedUserId: "user_expected" });
  assert.equal(result.ok, true);
  assert.equal(result.outcome_confirmed_after_timeout, true);
  assert.equal(starts, 1);
  assert.equal(inspections, 1);
  assert.equal(locks, 1);
});

test("an unresponsive browser auth handoff triggers terminal browser teardown", async () => {
  const environment = { CLERK_SECRET_KEY: "sk_live_handoff-secret" };
  let stops = 0;
  const started = Date.now();
  const error = await bootstrapClerkAuthentication({
    browser: {
      call: async () => new Promise(() => {}),
      stop: async () => {
        stops += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    expectedUserId: "user_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: new Date(Date.now() + 25).toISOString(),
    environment,
    fetchImpl: async (url) => {
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      if (String(url).includes("/v1/sessions?")) return Response.json([]);
      if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_timeout", token: "ticket_valid" });
      return Response.json({ id: "sit_timeout" });
    }
  }).catch((caught) => caught);
  assert(error instanceof Error);
  assert.equal(stops, 1);
  assert(Date.now() - started >= 40);
  assert(Date.now() - started < 500);
  assert.equal("CLERK_SECRET_KEY" in environment, false);
});

test("only sign-in bootstrap and exact bound-session activation/active transports are allowed", () => {
  const base = { frontendApiOrigin: "https://clerk.example.test", method: "POST" };
  assert.equal(isPermittedClerkMutation({ ...base, phase: "bootstrap", rawUrl: "https://clerk.example.test/v1/client/sign_ins?__clerk_js_version=5" }), true);
  assert.equal(isPermittedClerkMutation({ ...base, phase: "bootstrap", rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/touch" }), false);
  assert.equal(isPermittedClerkMutation({ ...base, phase: "activating", activeSessionId: "sess_expected", rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/touch" }), true);
  assert.equal(isPermittedClerkMutation({ ...base, phase: "activating", activeSessionId: "sess_expected", rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/tokens" }), true);
  assert.equal(isPermittedClerkMutation({ ...base, phase: "bootstrap", rawUrl: "https://clerk.example.test/v1/client/sign_ups" }), false);
  assert.equal(isPermittedClerkMutation({ ...base, phase: "bootstrap", rawUrl: "https://other.example.test/v1/client/sign_ins" }), false);
  assert.equal(isPermittedClerkMutation({ ...base, phase: "active", activeSessionId: "sess_expected", rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/tokens" }), true);
  assert.equal(isPermittedClerkMutation({ ...base, phase: "active", activeSessionId: "sess_expected", rawUrl: "https://clerk.example.test/v1/client/sessions/sess_other/tokens" }), false);
  assert.equal(isPermittedClerkMutation({ ...base, phase: "active", activeSessionId: "sess_expected", rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/touch" }), true);
  for (const rawUrl of [
    "https://clerk.example.test/v1/client/sessions/sess_other/touch",
    "https://clerk.example.test/v1/client/sessions/sess_expected/touch/",
    "https://clerk.example.test/v1/client/sessions/sess_expected/end",
    "https://clerk.example.test/v1/client/sessions/sess_expected/remove",
    "https://clerk.example.test/v1/client/sign_ups",
    "https://user@clerk.example.test/v1/client/sessions/sess_expected/touch",
    "https://clerk.example.test/v1/client/sessions/sess_expected/touch#fragment",
    "https://other.example.test/v1/client/sessions/sess_expected/touch"
  ]) assert.equal(isPermittedClerkMutation({ ...base, phase: "active", activeSessionId: "sess_expected", rawUrl }), false);
  assert.equal(isPermittedClerkMutation({ ...base, method: "DELETE", phase: "active", activeSessionId: "sess_expected", rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/touch" }), false);
});

test("only an exact Clerk bootstrap touch path yields a provisional session id", () => {
  const policy = { frontendApiOrigin: "https://clerk.example.test", method: "POST", phase: "bootstrap" };
  assert.equal(provisionalClerkBootstrapTouchSessionId({ ...policy, rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/touch?__clerk_js_version=5" }), "sess_expected");
  for (const rawUrl of [
    "https://clerk.example.test/v1/client/sessions/sess_expected/touch/",
    "https://clerk.example.test/v1/client/sessions/sess_expected/tokens",
    "https://clerk.example.test/v1/client/sessions/x/touch",
    "https://other.example.test/v1/client/sessions/sess_expected/touch",
    "https://clerk.example.test/v1/client/sessions/sess_expected/touch#fragment"
  ]) assert.equal(provisionalClerkBootstrapTouchSessionId({ ...policy, rawUrl }), null);
  assert.equal(provisionalClerkBootstrapTouchSessionId({ ...policy, method: "DELETE", rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/touch" }), null);
  assert.equal(provisionalClerkBootstrapTouchSessionId({ ...policy, phase: "active", rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/touch" }), null);
});

test("a page-context reset cannot broaden the persistent Clerk network filter", () => {
  const policy = {
    frontendApiOrigin: "https://clerk.example.test",
    method: "POST",
    phase: "active",
    activeSessionId: "sess_expected"
  };
  for (const _pageContext of ["authenticated-page", "new-document-context", "reloaded-context"]) {
    assert.equal(isPermittedClerkMutation({ ...policy, rawUrl: "https://clerk.example.test/v1/client/sign_ins" }), false);
    assert.equal(isPermittedClerkMutation({ ...policy, rawUrl: "https://clerk.example.test/v1/client/sign_ups" }), false);
    assert.equal(isPermittedClerkMutation({ ...policy, rawUrl: "https://clerk.example.test/v1/client/sessions/sess_other/tokens" }), false);
    assert.equal(isPermittedClerkMutation({ ...policy, rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/tokens" }), true);
    assert.equal(isPermittedClerkMutation({ ...policy, rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/touch" }), true);
    assert.equal(isPermittedClerkMutation({ ...policy, rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/tokens/template" }), true);
    assert.equal(isPermittedClerkMutation({ ...policy, rawUrl: "https://clerk.example.test/v1/client/sessions/sess_expected/tokens/template/unapproved-tail" }), false);
  }
});
