import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapClerkAuthentication,
  CLERK_DOMAINS_ENDPOINT,
  CLERK_SIGN_IN_TOKEN_ENDPOINT,
  provisionDisposableClerkIdentity
} from "../supervisor/clerk-bootstrap.mjs";

const frontendOrigin = "https://frontend.example.test";
const secret = "sk_test_private_instance_secret";
const marker = "flowmap_cal_33333333333333333333333333333333";
const username = "flowmap_33333333333333333333333333333333";

const domains = (rows, totalCount = rows.length) => Response.json({ data: rows, total_count: totalCount });
const matchingDomains = () => domains([
  { id: "domain_private_match", frontend_api_url: frontendOrigin },
  { id: "domain_private_other", frontend_api_url: "https://other.example.test" }
]);

test("a matching Clerk instance is checked before recovery or disposable-user creation", async () => {
  const events = [];
  const environment = { CLERK_SECRET_KEY: secret };
  const lifecycle = await provisionDisposableClerkIdentity({
    environment,
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: new Date(Date.now() + 1_000).toISOString(),
    markerFactory: () => { events.push("marker"); return marker; },
    onRecoveryMaterial: async () => { events.push("recovery"); },
    fetchImpl: async (rawUrl, init = {}) => {
      const url = String(rawUrl);
      if (url === CLERK_DOMAINS_ENDPOINT) {
        events.push("domain-get");
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "error");
        assert(init.signal instanceof AbortSignal);
        assert.equal(init.headers.Authorization, `Bearer ${secret}`);
        return matchingDomains();
      }
      if (init.method === "GET" && new URL(url).pathname === "/v1/users") {
        events.push("user-list");
        return Response.json({ data: [], total_count: 0 });
      }
      if (init.method === "POST" && new URL(url).pathname === "/v1/users") {
        events.push("user-create");
        const body = JSON.parse(init.body);
        assert.equal(body.username, username);
        assert.equal("email_address" in body || "email_addresses" in body, false);
        assert.equal("phone_number" in body || "phone_numbers" in body, false);
        assert.equal("password" in body, false);
        return Response.json({ id: "user_private_created", external_id: marker, username });
      }
      if (init.method === "DELETE") {
        events.push("user-delete");
        return Response.json({ deleted: true });
      }
      throw new Error("unexpected fixture request");
    }
  });

  assert.equal("CLERK_SECRET_KEY" in environment, false);
  assert.deepEqual(events, ["domain-get", "marker", "recovery", "user-list", "user-create", "recovery"]);
  const cleanup = await lifecycle.cleanup({ browserStopped: true });
  assert.equal(cleanup.cleanup_complete, true);
  assert.deepEqual(events, ["domain-get", "marker", "recovery", "user-list", "user-create", "recovery", "user-delete"]);
});

for (const [label, expectedOrigin, reply] of [
  ["mismatch", frontendOrigin, () => domains([{ id: "domain_private", frontend_api_url: "https://other.example.test" }])],
  ["HTTP failure", frontendOrigin, () => Response.json({ private_body: "provider-private-body" }, { status: 401 })],
  ["timeout", frontendOrigin, () => new Promise(() => {})],
  ["malformed response", frontendOrigin, () => Response.json({ data: "provider-private-body", total_count: 1 })],
  ["incomplete response", frontendOrigin, () => domains([{ id: "domain_private", frontend_api_url: frontendOrigin }], 2)],
  ["non-HTTPS origin", frontendOrigin, () => domains([{ id: "domain_private", frontend_api_url: "http://frontend.example.test" }])],
  ["path spoof", frontendOrigin, () => domains([{ id: "domain_private", frontend_api_url: `${frontendOrigin}/v1/client` }])],
  ["query spoof", frontendOrigin, () => domains([{ id: "domain_private", frontend_api_url: `${frontendOrigin}?instance=other` }])],
  ["host spoof", frontendOrigin, () => domains([{ id: "domain_private", frontend_api_url: "https://frontend.example.test.attacker.test" }])],
  ["missing match", frontendOrigin, () => domains([])],
  ["missing expected origin", undefined, () => assert.fail("invalid policy must fail before a request")]
]) {
  test(`disposable provisioning rejects Clerk instance ${label} without identity side effects`, async () => {
    const calls = [];
    let recoveryCalls = 0;
    let markerCalls = 0;
    const environment = { CLERK_SECRET_KEY: secret };
    const error = await provisionDisposableClerkIdentity({
      environment,
      expectedFrontendOrigin: expectedOrigin,
      workingDayDeadline: new Date(Date.now() + 25).toISOString(),
      markerFactory: () => { markerCalls += 1; return marker; },
      onRecoveryMaterial: async () => { recoveryCalls += 1; },
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method });
        return reply();
      }
    }).catch((caught) => caught);

    assert(error instanceof Error);
    assert.equal(error.calibration_failure_code, "clerk_auth_policy_mismatch");
    assert.equal(error.message, "Clerk authentication policy mismatch");
    assert.equal(error.cleanup.cleanup_complete, true);
    assert.equal(recoveryCalls, 0);
    assert.equal(markerCalls, 0);
    assert.equal(calls.some(({ method }) => method === "POST" || method === "DELETE"), false);
    if (expectedOrigin === undefined) assert.deepEqual(calls, []);
    else assert.deepEqual(calls.map(({ url, method }) => [url, method]), [[CLERK_DOMAINS_ENDPOINT, "GET"]]);
    assert.equal("CLERK_SECRET_KEY" in environment, false);
    assert.doesNotMatch(
      `${error.message} ${error.calibration_failure_code} ${JSON.stringify(error)}`,
      /private_instance_secret|provider-private-body|domain_private|frontend\.example|other\.example|attacker/
    );
  });
}

test("production bootstrap gates the instance before session inventory and ticket mint", async () => {
  const calls = [];
  let browserCalls = 0;
  const result = await bootstrapClerkAuthentication({
    browser: {
      call: async () => {
        browserCalls += 1;
        return {
          ok: true,
          authenticated: true,
          current_context_auth_methods_locked: true,
          persistent_clerk_network_filter: true,
          outcome_confirmed_after_timeout: false,
          active_session_id: "sess_private_new"
        };
      }
    },
    expectedUserId: "user_private_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: new Date(Date.now() + 1_000).toISOString(),
    environment: { CLERK_SECRET_KEY: secret },
    fetchImpl: async (rawUrl, init = {}) => {
      const url = String(rawUrl);
      calls.push({ url, method: init.method });
      if (url === CLERK_DOMAINS_ENDPOINT) return matchingDomains();
      if (url.startsWith("https://api.clerk.com/v1/sessions?")) return Response.json([]);
      if (url === CLERK_SIGN_IN_TOKEN_ENDPOINT) return Response.json({ id: "sit_private", token: "ticket_private" });
      if (url.endsWith("/v1/sessions/sess_private_new/revoke")) return Response.json({});
      throw new Error("unexpected fixture request");
    }
  });

  assert.equal(browserCalls, 1);
  assert.equal(calls[0].url, CLERK_DOMAINS_ENDPOINT);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].url.startsWith("https://api.clerk.com/v1/sessions?"), true);
  assert.equal(calls[2].url, CLERK_SIGN_IN_TOKEN_ENDPOINT);
  assert.equal((await result.cleanup()).cleanup_complete, true);
});

test("production bootstrap rejects a mismatched instance before any session or ticket operation", async () => {
  const calls = [];
  let browserCalls = 0;
  const error = await bootstrapClerkAuthentication({
    browser: { call: async () => { browserCalls += 1; } },
    expectedUserId: "user_private_expected",
    expectedFrontendOrigin: frontendOrigin,
    workingDayDeadline: new Date(Date.now() + 1_000).toISOString(),
    environment: { CLERK_SECRET_KEY: secret },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method });
      return domains([{ id: "domain_private", frontend_api_url: "https://other.example.test" }]);
    }
  }).catch((caught) => caught);

  assert(error instanceof Error);
  assert.equal(error.calibration_failure_code, "clerk_auth_policy_mismatch");
  assert.equal(error.cleanup.cleanup_complete, true);
  assert.equal(browserCalls, 0);
  assert.deepEqual(calls, [{ url: CLERK_DOMAINS_ENDPOINT, method: "GET" }]);
  assert.doesNotMatch(JSON.stringify(error), /private|frontend\.example|other\.example|domain_/);
});

test("production bootstrap requires the frozen frontend origin before making a request", async () => {
  let fetchCalls = 0;
  const environment = { CLERK_SECRET_KEY: secret };
  const error = await bootstrapClerkAuthentication({
    browser: { call: async () => assert.fail("browser must not run") },
    expectedUserId: "user_private_expected",
    workingDayDeadline: new Date(Date.now() + 1_000).toISOString(),
    environment,
    fetchImpl: async () => { fetchCalls += 1; }
  }).catch((caught) => caught);

  assert(error instanceof Error);
  assert.equal(error.calibration_failure_code, "clerk_auth_policy_mismatch");
  assert.equal(error.cleanup.cleanup_complete, true);
  assert.equal(fetchCalls, 0);
  assert.equal("CLERK_SECRET_KEY" in environment, false);
  assert.doesNotMatch(JSON.stringify(error), /private_instance_secret|user_private_expected/);
});
