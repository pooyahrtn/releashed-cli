import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { isPermittedClerkMutation } from "../lib/clerk-auth.mjs";
import { CDP_COMMAND_TIMEOUT_MS, INITIAL_TOP_FRAME_LOAD_TIMEOUT_MS } from "../lib/browser-runtime-limits.mjs";
import { freshCapState, sha256Text, writeExclusiveJson } from "../lib/scaffold.mjs";
import {
  BrowserBroker,
  CLERK_PAGE_FUNCTIONS,
  hashAccessibilityTree,
  waitForDevToolsPort
} from "../supervisor/browser-broker.mjs";
import { BrokerProcess } from "../supervisor/browser-broker-process.mjs";

const origin = "https://app.example.test";
const landingUrl = `${origin}/today`;
const authUrl = `${origin}/sign-in?next=%2Ftoday`;
const signInFor = (next) => `${origin}/sign-in?next=${encodeURIComponent(next)}`;
const landingEntry = { id: 41, url: landingUrl };
const priorEntry = { id: 40, url: `${origin}/` };

function locationState({
  url,
  id,
  index,
  entries,
  sequence,
  logicalSequence = sequence,
  loaderId = "loader-fixture",
  frameId = "frame-fixture",
  navigationType = null
}) {
  return {
    sequence,
    logicalSequence,
    loaderId,
    frameId,
    navigationType,
    history: { currentIndex: index, entries: entries ?? [{ id, url }] }
  };
}

const landingState = (sequence = 10) => locationState({
  url: landingUrl,
  id: landingEntry.id,
  index: 1,
  entries: [priorEntry, landingEntry],
  sequence
});

const pushedTransit = ({ url = authUrl, ...overrides } = {}) => locationState({
  url,
  id: 42,
  index: 2,
  entries: [priorEntry, landingEntry, { id: 42, url }],
  sequence: 11,
  navigationType: "historyApi",
  ...overrides
});

const replacedTransit = ({ url = authUrl, ...overrides } = {}) => locationState({
  url,
  id: landingEntry.id,
  index: 1,
  entries: [priorEntry, { id: landingEntry.id, url }],
  sequence: 11,
  navigationType: "historyApi",
  ...overrides
});

test("physical navigation keeps every production notification while logical navigation coalesces exact duplicates", () => {
  const broker = new BrowserBroker({
    run_directory: "/unused",
    profile_directory: "/unused",
    initial_url: `${origin}/`,
    allowed_request_origins: [origin, "https://clerk.example.test"],
    allowed_navigation_origins: [origin],
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" }
  });
  broker.initialNavigationConsumed = true;
  broker.onCdpEvent({
    method: "Page.frameNavigated",
    params: { frame: { id: "frame-fixture", loaderId: "loader-fixture", url: landingUrl } }
  });
  broker.onCdpEvent({
    method: "Page.navigatedWithinDocument",
    params: { frameId: "frame-fixture", url: landingUrl, navigationType: "historyApi" }
  });
  broker.onCdpEvent({
    method: "Page.navigatedWithinDocument",
    params: { frameId: "frame-fixture", url: authUrl, navigationType: "historyApi" }
  });
  broker.onCdpEvent({
    method: "Page.navigatedWithinDocument",
    params: { frameId: "frame-fixture", url: authUrl, navigationType: "historyApi" }
  });
  broker.onCdpEvent({
    method: "Page.navigatedWithinDocument",
    params: { frameId: "child-frame", url: `${origin}/child`, navigationType: "historyApi" }
  });
  assert.equal(broker.navigationSequence, 4);
  assert.equal(broker.logicalNavigationSequence, 2);
  assert.equal(broker.topFrameLoaderId, "loader-fixture");
  assert.deepEqual(broker.lastTopNavigation, { kind: "same-document", navigationType: "historyApi", sequence: 4 });
  assert.deepEqual(broker.lastLogicalTopNavigation, { kind: "same-document", navigationType: "historyApi", sequence: 2 });
  assert.equal(broker.initialLandingEventCandidate.sameUrlHistoryApiNotifications, 1);
  assert.equal(broker.currentUrl, landingUrl);
  assert.doesNotMatch(JSON.stringify({
    lastTopNavigation: broker.lastTopNavigation,
    lastLogicalTopNavigation: broker.lastLogicalTopNavigation,
    lastTopLogicalLocation: broker.lastTopLogicalLocation
  }), /sign-in|next=|%2Ftoday/);
});

test("DevTools discovery waits through partial handoff-file reads", async () => {
  const reads = ["", "432", "43210\n/devtools/browser/fixture\n"];
  const port = await waitForDevToolsPort("/unused/DevToolsActivePort", {
    retryDelayMs: 0,
    attempts: reads.length,
    readFileImpl: async () => reads.shift()
  });

  assert.equal(port, 43_210);
  assert.equal(reads.length, 0);
});

test("DevTools discovery uses the bounded startup deadline instead of the old fixed retry count", async () => {
  let reads = 0;
  const port = await waitForDevToolsPort("/unused/DevToolsActivePort", {
    retryDelayMs: 0,
    deadlineMs: Date.now() + 1_000,
    readFileImpl: async () => {
      reads += 1;
      return reads === 101 ? "43210\n/devtools/browser/fixture\n" : "";
    }
  });

  assert.equal(port, 43_210);
  assert.equal(reads, 101);
});

function transitBroker(states, { deadlineMs = 1_000, authenticate = null, realAuthenticator = false, bounded = false } = {}) {
  const broker = new BrowserBroker({
    run_directory: "/unused",
    profile_directory: "/unused",
    initial_url: `${origin}/`,
    allowed_request_origins: [origin, "https://clerk.example.test"],
    allowed_navigation_origins: [origin],
    operation_deadline_ms: Date.now() + deadlineMs,
    ...(bounded ? { runtime_mode: "source-blind-bounded-onboarding-v1" } : {}),
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" }
  });
  broker.initialNavigationConsumed = true;
  broker.initialLandingIdentity = Object.freeze({
    exactUrl: landingUrl,
    entryId: landingEntry.id,
    entryIndex: 1,
    frameId: "frame-fixture",
    loaderId: "loader-fixture",
    sequence: 10
  });
  broker.initialNavigationPredecessor = {
    exactUrl: priorEntry.url,
    entryId: priorEntry.id,
    entryIndex: 0,
    entryCount: 1,
    predecessorId: null,
    predecessorUrl: null,
    twoBackId: null,
    twoBackUrl: null,
    frameId: "frame-before",
    loaderId: "loader-before",
    sequence: 9,
    logicalSequence: 9
  };
  broker.initialLandingEventCandidate = {
    exactUrl: landingUrl,
    frameId: "frame-fixture",
    loaderId: "loader-fixture",
    sequence: 10,
    sameUrlHistoryApiNotifications: 0
  };
  broker.lastEvidenceRawUrlSha256 = sha256Text(landingUrl);
  broker.lastEvidence = { url: `${origin}/today` };
  broker.loadState = async () => bounded
    ? readyCapState()
    : {
        abort: null,
        working_day_deadline: new Date(Date.now() + deadlineMs).toISOString()
      };
  if (bounded) broker.boundedCapsValid = () => true;
  broker.waitForClerkReadiness = async () => true;
  const queue = [...states];
  let latest = queue[0];
  broker.cdp = {
    async send(method) {
      assert.equal(method, "Page.getNavigationHistory");
      latest = queue.length > 0 ? queue.shift() : latest;
      broker.navigationSequence = latest.sequence;
      broker.logicalNavigationSequence = latest.logicalSequence;
      broker.topFrameId = latest.frameId;
      broker.topFrameLoaderId = latest.loaderId;
      if (latest.navigationType) {
        broker.lastTopNavigation = {
          kind: "same-document",
          navigationType: latest.navigationType,
          sequence: latest.sequence
        };
        broker.lastLogicalTopNavigation = {
          kind: "same-document",
          navigationType: latest.navigationType,
          sequence: latest.logicalSequence
        };
      }
      return latest.history;
    }
  };
  let authCalls = 0;
  let lockCalls = 0;
  if (!realAuthenticator) broker.clerkAuthenticator = {
    async authenticate(input) {
      authCalls += 1;
      assert.equal(input.expectedCurrentHref, states[0].history.entries[states[0].history.currentIndex].url);
      const result = authenticate ? await authenticate(input) : {
        ok: true,
        authenticated: true,
        outcome_confirmed_after_timeout: false,
        active_session_id: "sess_fixture"
      };
      if (result.ok) broker.activeClerkSessionId = result.active_session_id;
      return result;
    },
    async lockMethods() {
      lockCalls += 1;
      return true;
    }
  };
  return { broker, authCalls: () => authCalls, lockCalls: () => lockCalls };
}

test("bounded authentication freezes the exact pre-ticket Clerk transit for route binding", async () => {
  const transit = replacedTransit();
  const { broker } = transitBroker([transit, transit], { bounded: true });
  const result = await broker.authenticateClerkTicket({ ticket: "ticket_fixture", expected_user_id: "user_fixture" });
  assert.equal(result.ok, true);
  assert.equal(broker.boundedPostAuthStartPending, true);
  assert.equal(broker.boundedPostAuthHandoff.kind, "transit");
  assert.equal(broker.boundedPostAuthHandoff.navigation.exactUrl, authUrl);
  assert.equal(broker.boundedExpectedClerkUserId, "user_fixture");
  assert.equal(Object.isFrozen(broker.boundedPostAuthHandoff), true);
  assert.equal(Object.isFrozen(broker.boundedPostAuthHandoff.navigation), true);
});

for (const [label, states, expectedSequence] of [
  ["direct retained landing", [landingState(), landingState(), landingState(), landingState()], 10],
  ["one pushState auth transit and exact return", [pushedTransit(), pushedTransit(), landingState(12), landingState(12)], 12],
  ["one replaceState transit with the observed two-entry /sign-in?next=%2Ftoday history and exact return", [replacedTransit(), replacedTransit(), landingState(12), landingState(12)], 12]
]) {
  test(`${label} is admitted without retaining the auth route`, async () => {
    if (label.includes("replaceState")) assert.equal(states[0].history.entries.length, 2);
    const { broker, authCalls } = transitBroker(states);
    const result = await broker.authenticateClerkTicket({ ticket: "ticket_fixture", expected_user_id: "user_fixture" });
    assert.equal(result.ok, true);
    assert.equal(authCalls(), 1);
    assert.equal(broker.authLandingNavigationSequence, expectedSequence);
    assert.equal(broker.authLandingUrlSha256, sha256Text(landingUrl));
    assert.notEqual(broker.authLandingUrlSha256, sha256Text(authUrl));
    assert.equal(broker.firstPostAuthCapturePending, true);
    assert.doesNotMatch(JSON.stringify({ result, broker }), /sign-in|next=|%2Ftoday/);
  });
}

test("duplicate same-URL post-auth landing notification keeps the logical return exact", async () => {
  const auth = replacedTransit({ sequence: 14, logicalSequence: 11 });
  const duplicateAuth = { ...auth, sequence: 15 };
  const firstLanding = locationState({
    url: landingUrl,
    id: landingEntry.id,
    index: 1,
    entries: [priorEntry, landingEntry],
    sequence: 16,
    logicalSequence: 12
  });
  const duplicateLanding = { ...firstLanding, sequence: 17 };
  const { broker, authCalls } = transitBroker([auth, duplicateAuth, firstLanding, duplicateLanding]);
  const result = await broker.authenticateClerkTicket({ ticket: "ticket_fixture", expected_user_id: "user_fixture" });
  assert.equal(result.ok, true);
  assert.equal(authCalls(), 1);
  assert.equal(broker.authLandingNavigationSequence, 12);
  assert.equal(broker.firstPostAuthCapturePending, true);
  assert.doesNotMatch(JSON.stringify(result), /sign-in|next=|%2Ftoday|ticket_fixture|user_fixture/);
});

for (const [label, url] of [
  ["trailing path", `${origin}/sign-in/?next=%2Ftoday`],
  ["nested path", `${origin}/account/sign-in?next=%2Ftoday`],
  ["case-changed path", `${origin}/Sign-In?next=%2Ftoday`],
  ["missing query", `${origin}/sign-in`],
  ["missing next", `${origin}/sign-in?other=%2Ftoday`],
  ["empty next", `${origin}/sign-in?next=`],
  ["duplicate next", `${origin}/sign-in?next=%2Ftoday&next=%2Ftoday`],
  ["extra query pair", `${origin}/sign-in?next=%2Ftoday&other=1`],
  ["protocol-relative next", signInFor("//other.example.test/today")],
  ["absolute same-origin next", signInFor(`${origin}/today`)],
  ["absolute cross-origin next", signInFor("https://other.example.test/today")],
  ["cross-origin userinfo next", signInFor("https://app.example.test@other.example.test/today")],
  ["auth-loop next", signInFor("/sign-in")],
  ["next query mismatch", signInFor("/today?extra=1")],
  ["next hash mismatch", signInFor("/today#extra")],
  ["next path mismatch", signInFor("/today/")],
  ["host suffix spoof", `https://app.example.test.other.example/sign-in?next=%2Ftoday`],
  ["host prefix spoof", `https://other-app.example.test/sign-in?next=%2Ftoday`],
  ["port spoof", `https://app.example.test:444/sign-in?next=%2Ftoday`],
  ["userinfo spoof", `https://user@app.example.test/sign-in?next=%2Ftoday`],
  ["password spoof", `https://user:password@app.example.test/sign-in?next=%2Ftoday`],
  ["empty auth URL hash", `${origin}/sign-in?next=%2Ftoday#`],
  ["auth URL hash", `${origin}/sign-in?next=%2Ftoday#private`]
]) {
  test(`${label} is outside the exact Clerk transit contract`, async () => {
    const { broker, authCalls } = transitBroker([pushedTransit({ url })]);
    const result = await broker.authenticateClerkTicket({ ticket: "ticket_fixture", expected_user_id: "user_fixture" });
    assert.equal(result.refusal.code, "clerk_auth_policy_mismatch");
    assert.equal(authCalls(), 0);
    assert.equal(broker.authLandingUrlSha256, undefined);
    assert.doesNotMatch(JSON.stringify(result), /ticket_fixture|user_fixture|sess_fixture|other\.example|password|private/);
  });
}

for (const [label, transit] of [
  ["changed loader", pushedTransit({ loaderId: "loader-other" })],
  ["second same-document hop", pushedTransit({ sequence: 12 })],
  ["non-auth route", pushedTransit({ url: `${origin}/settings?next=%2Ftoday` })],
  ["wrong predecessor", pushedTransit({
    entries: [priorEntry, { id: 99, url: `${origin}/wrong` }, { id: 42, url: authUrl }]
  })],
  ["other origin", pushedTransit({
    url: "https://other.example.test/sign-in?next=%2Ftoday"
  })]
]) {
  test(`${label} cannot enter Clerk ticket exchange`, async () => {
    const { broker, authCalls } = transitBroker([transit]);
    const result = await broker.authenticateClerkTicket({ ticket: "ticket_fixture", expected_user_id: "user_fixture" });
    assert.equal(result.refusal.code, "clerk_auth_policy_mismatch");
    assert.equal(authCalls(), 0);
    assert.equal(broker.authLandingUrlSha256, undefined);
  });
}

test("a pending abort is drained before Clerk ticket exchange", async () => {
  const { broker, authCalls } = transitBroker([replacedTransit()]);
  let aborted = false;
  broker.requestQueue = Promise.resolve().then(() => {
    aborted = true;
  });
  broker.loadState = async () => ({
    abort: aborted ? { code: "private_forbidden_request_detail" } : null,
    working_day_deadline: new Date(Date.now() + 1_000).toISOString()
  });

  const result = await broker.authenticateClerkTicket({
    ticket: "ticket_private",
    expected_user_id: "user_private"
  });

  assert.equal(result.refusal.code, "run_aborted");
  assert.equal(authCalls(), 0);
  assert.equal(broker.clerkTransportPhase, null);
  assert.equal(broker.activeClerkSessionId, null);
  assert.equal(broker.authLandingUrlSha256, undefined);
  assert.doesNotMatch(JSON.stringify(result), /ticket_private|user_private|private_forbidden_request_detail|sign-in|next=/);
});

test("Clerk readiness and two fresh private admissions precede ticket exchange", async () => {
  const order = [];
  const { broker, authCalls } = transitBroker(
    [replacedTransit(), replacedTransit(), landingState(12), landingState(12)],
    { authenticate: async () => {
      order.push("ticket-exchange");
      return {
        ok: true,
        authenticated: true,
        outcome_confirmed_after_timeout: false,
        active_session_id: "sess_fixture"
      };
    } }
  );
  const snapshot = broker.privateNavigationSnapshot.bind(broker);
  const continuation = broker.admitPrivateAuthContinuation.bind(broker);
  broker.waitForClerkReadiness = async () => {
    order.push("readiness");
    return true;
  };
  broker.privateNavigationSnapshot = async () => {
    order.push("snapshot");
    return snapshot();
  };
  broker.admitPrivateAuthContinuation = async () => {
    order.push("cap");
    return continuation();
  };

  const result = await broker.authenticateClerkTicket({ ticket: "ticket_fixture", expected_user_id: "user_fixture" });

  assert.equal(result.ok, true);
  assert.equal(authCalls(), 1);
  assert.deepEqual(order.slice(0, 6), ["readiness", "snapshot", "cap", "snapshot", "cap", "ticket-exchange"]);
});

test("the broker binds the exchanged session before activation and refuses a second returned session", async () => {
  const { broker } = transitBroker(
    [replacedTransit(), replacedTransit(), landingState(12), landingState(12)],
    { realAuthenticator: true }
  );
  const phases = [];
  broker.callPageFunction = async (declaration) => {
    if (declaration === CLERK_PAGE_FUNCTIONS.start) {
      phases.push(broker.clerkTransportPhase);
      assert.equal(broker.activeClerkSessionId, null);
      return { created_session_id: "sess_created" };
    }
    if (declaration === CLERK_PAGE_FUNCTIONS.activate) {
      phases.push(broker.clerkTransportPhase);
      assert.equal(broker.activeClerkSessionId, "sess_created");
      assert.equal(broker.clerkTransportAttempt !== null, true);
      return { user_id: "user_fixture", session_id: "sess_other", token_present: true };
    }
    if (declaration === CLERK_PAGE_FUNCTIONS.lock) return { locked: true };
    throw new Error("unexpected page function");
  };

  const result = await broker.authenticateClerkTicket({ ticket: "ticket_fixture", expected_user_id: "user_fixture" });

  assert.equal(result.refusal.code, "clerk_auth_failed");
  assert.deepEqual(phases, ["bootstrap", "activating"]);
  assert.equal(broker.clerkTransportPhase, null);
  assert.equal(broker.activeClerkSessionId, null);
  assert.equal(broker.authLandingUrlSha256, undefined);
  assert.doesNotMatch(JSON.stringify(result), /sess_created|sess_other|ticket_fixture|user_fixture/);
});

test("a forbidden request queued after ticket exchange prevents session binding and activation", async () => {
  const { broker } = transitBroker([replacedTransit(), replacedTransit()], { realAuthenticator: true });
  let queuedAbort = false;
  let activationCalls = 0;
  broker.loadState = async () => ({
    abort: queuedAbort ? { code: "private-forbidden-request" } : null,
    working_day_deadline: new Date(Date.now() + 1_000).toISOString()
  });
  broker.callPageFunction = async (declaration) => {
    if (declaration === CLERK_PAGE_FUNCTIONS.start) {
      broker.requestQueue = Promise.resolve().then(() => { queuedAbort = true; });
      return { created_session_id: "sess_created" };
    }
    if (declaration === CLERK_PAGE_FUNCTIONS.activate) {
      activationCalls += 1;
      return { user_id: "user_fixture", session_id: "sess_created", token_present: true };
    }
    if (declaration === CLERK_PAGE_FUNCTIONS.lock) return { locked: true };
    throw new Error("unexpected page function");
  };

  const result = await broker.authenticateClerkTicket({ ticket: "ticket_fixture", expected_user_id: "user_fixture" });

  assert.equal(result.refusal.code, "clerk_auth_precondition_failed");
  assert.equal(activationCalls, 0);
  assert.equal(broker.activeClerkSessionId, null);
  assert.equal(broker.clerkTransportPhase, null);
  assert.equal(broker.authLandingUrlSha256, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-forbidden-request|sess_created|ticket_fixture|user_fixture/);
});

test("activation permits touch and token only for the privately bound exchanged session", async () => {
  const { broker } = transitBroker(
    [replacedTransit(), replacedTransit(), landingState(12), landingState(12)],
    { realAuthenticator: true }
  );
  broker.callPageFunction = async (declaration) => {
    if (declaration === CLERK_PAGE_FUNCTIONS.start) return { created_session_id: "sess_created" };
    if (declaration === CLERK_PAGE_FUNCTIONS.activate) {
      const base = {
        frontendApiOrigin: "https://clerk.example.test",
        method: "POST",
        phase: broker.clerkTransportPhase,
        activeSessionId: broker.activeClerkSessionId
      };
      assert.equal(isPermittedClerkMutation({ ...base, rawUrl: "https://clerk.example.test/v1/client/sessions/sess_created/touch" }), true);
      assert.equal(isPermittedClerkMutation({ ...base, rawUrl: "https://clerk.example.test/v1/client/sessions/sess_created/tokens" }), true);
      assert.equal(isPermittedClerkMutation({ ...base, rawUrl: "https://clerk.example.test/v1/client/sessions/sess_other/touch" }), false);
      return { user_id: "user_fixture", session_id: "sess_created", token_present: true };
    }
    if (declaration === CLERK_PAGE_FUNCTIONS.lock) return { locked: true };
    throw new Error("unexpected page function");
  };

  const result = await broker.authenticateClerkTicket({ ticket: "ticket_fixture", expected_user_id: "user_fixture" });

  assert.equal(result.ok, true);
  assert.equal(broker.clerkTransportPhase, "active");
  assert.equal(broker.activeClerkSessionId, "sess_created");
});

async function bootstrapTransportFixture({ otherOriginAllowed = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "flow-map-bootstrap-transport-"));
  const capPath = join(root, "cap.json");
  const deadline = Date.now() + 5_000;
  await mkdir(join(root, "screenshots"));
  await writeExclusiveJson(capPath, freshCapState({
    browser_active_seconds: 5,
    browser_operations_total: 1,
    browser_operations_per_rolling_minute: 1,
    browser_requests_total: 8,
    browser_requests_per_rolling_minute: 8,
    listed_one_way_actions_total: 0,
    app_side_cost_cap_eur: 0,
    model_cost_cap_eur: 0,
    combined_actual_plus_reserved_cap_eur: 0
  }, new Date(deadline).toISOString(), "fixture"));
  const broker = new BrowserBroker({
    runtime_mode: "source-blind-bounded-onboarding-v1",
    run_directory: root,
    profile_directory: "/unused",
    cap_state_path: capPath,
    initial_url: landingUrl,
    allowed_request_origins: [origin, "https://clerk.example.test", ...(otherOriginAllowed ? ["https://other.example.test"] : [])],
    allowed_navigation_origins: [origin],
    operation_deadline_ms: deadline,
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" }
  });
  const commands = [];
  broker.cdp = { send: async (method) => { commands.push(method); return {}; } };
  broker.clerkTransportAttempt = Object.freeze({});
  broker.clerkTransportPhase = "bootstrap";
  broker.clerkBootstrapTransportDeadlineMs = deadline;
  return { root, capPath, broker, commands };
}

function clerkPaused(url, requestId = "clerk-request") {
  return {
    method: "Fetch.requestPaused",
    sessionId: "page-session",
    params: { requestId, request: { url, method: "POST" }, resourceType: "Fetch" }
  };
}

test("one provisional bootstrap touch is reconciled to the exact created Clerk session", async () => {
  const value = await bootstrapTransportFixture();
  const touch = "https://clerk.example.test/v1/client/sessions/sess_created/touch?__clerk_js_version=5";
  value.broker.admitPrivateAuthContinuation = async () => {
    await value.broker.drainBoundedRequestQueue();
    return { ok: true };
  };
  value.broker.callPageFunction = async (declaration) => {
    if (declaration === CLERK_PAGE_FUNCTIONS.start) {
      value.broker.onCdpEvent(clerkPaused(touch));
      return { created_session_id: "sess_created" };
    }
    if (declaration === CLERK_PAGE_FUNCTIONS.activate) {
      return { user_id: "user_fixture", session_id: "sess_created", token_present: true };
    }
    throw new Error("unexpected page function");
  };
  try {
    const result = await value.broker.startClerkAuthentication("ticket_fixture", "user_fixture", landingUrl);
    assert.equal(result.session_id, "sess_created");
    assert.equal(value.broker.activeClerkSessionId, "sess_created");
    assert.equal(value.broker.provisionalClerkSessionId, "sess_created");
    assert.deepEqual(value.commands, ["Fetch.continueRequest"]);
    assert.equal(JSON.parse(await readFile(value.capPath, "utf8")).abort, null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a provisional Clerk touch must match the session returned by the ticket exchange", async () => {
  const value = await bootstrapTransportFixture();
  value.broker.admitPrivateAuthContinuation = async () => {
    await value.broker.drainBoundedRequestQueue();
    return { ok: true };
  };
  value.broker.callPageFunction = async (declaration) => {
    if (declaration === CLERK_PAGE_FUNCTIONS.start) {
      value.broker.onCdpEvent(clerkPaused("https://clerk.example.test/v1/client/sessions/sess_first/touch"));
      return { created_session_id: "sess_other" };
    }
    throw new Error("activation must not run");
  };
  try {
    assert.deepEqual(
      await value.broker.startClerkAuthentication("ticket_fixture", "user_fixture", landingUrl),
      { failure_stage: "session_mismatch" }
    );
    assert.equal(value.broker.activeClerkSessionId, null);
    assert.deepEqual(value.commands, ["Fetch.continueRequest"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

for (const [label, firstUrl, secondUrl, options] of [
  ["repeat", "https://clerk.example.test/v1/client/sessions/sess_first/touch", "https://clerk.example.test/v1/client/sessions/sess_first/touch", {}],
  ["wrong path", null, "https://clerk.example.test/v1/client/sessions/sess_first/tokens", {}],
  ["other origin", null, "https://other.example.test/v1/client/sessions/sess_first/touch", { otherOriginAllowed: true }]
]) {
  test(`bootstrap provisional transport rejects ${label}`, async () => {
    const value = await bootstrapTransportFixture(options);
    try {
      if (firstUrl) await value.broker.handlePausedRequest(clerkPaused(firstUrl, "first"), value.broker.boundedRequestReceipt());
      await value.broker.handlePausedRequest(clerkPaused(secondUrl, "second"), value.broker.boundedRequestReceipt());
      const cap = JSON.parse(await readFile(value.capPath, "utf8"));
      assert.equal(cap.abort.code, "unknown_mutation_request");
      assert.equal(value.commands.at(-1), "Fetch.failRequest");
      assert.equal(cap.abort.operator_diagnostic.boundary, "bounded_private_auth");
      assert.equal("pathname" in cap.abort.operator_diagnostic, false);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
}

test("bootstrap provisional transport expires at its receipt-time deadline", async () => {
  const value = await bootstrapTransportFixture();
  value.broker.clerkBootstrapTransportDeadlineMs = Date.now() - 1;
  try {
    await value.broker.handlePausedRequest(
      clerkPaused("https://clerk.example.test/v1/client/sessions/sess_late/touch"),
      value.broker.boundedRequestReceipt()
    );
    assert.equal(JSON.parse(await readFile(value.capPath, "utf8")).abort.code, "unknown_mutation_request");
    assert.equal(value.broker.provisionalClerkSessionId, null);
    assert.deepEqual(value.commands, ["Fetch.failRequest"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("queued Clerk bootstrap authorization uses phase captured at request receipt", async () => {
  const value = await bootstrapTransportFixture();
  let release;
  value.broker.requestQueue = new Promise((resolve) => { release = resolve; });
  value.broker.onCdpEvent(clerkPaused("https://clerk.example.test/v1/client/sessions/sess_queued/touch"));
  value.broker.clerkTransportPhase = "active";
  value.broker.activeClerkSessionId = "sess_different";
  release();
  try {
    await value.broker.requestQueue;
    assert.equal(value.broker.provisionalClerkSessionId, "sess_queued");
    assert.deepEqual(value.commands, ["Fetch.continueRequest"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("queued Clerk bootstrap touch is blocked when its captured deadline expires before dispatch", async () => {
  const value = await bootstrapTransportFixture();
  let release;
  value.broker.clerkBootstrapTransportDeadlineMs = Date.now() + 25;
  value.broker.requestQueue = new Promise((resolve) => { release = resolve; });
  value.broker.onCdpEvent(clerkPaused("https://clerk.example.test/v1/client/sessions/sess_queued/touch"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  release();
  try {
    await value.broker.requestQueue;
    assert.equal(JSON.parse(await readFile(value.capPath, "utf8")).abort.code, "unknown_mutation_request");
    assert.equal(value.broker.provisionalClerkSessionId, null);
    assert.deepEqual(value.commands, ["Fetch.failRequest"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("queued Clerk bootstrap touch is blocked when the absolute deadline expires before dispatch", async () => {
  const value = await bootstrapTransportFixture();
  let release;
  value.broker.clerkBootstrapTransportDeadlineMs = Date.now() + 1_000;
  value.broker.absoluteDeadlineMs = Date.now() + 25;
  value.broker.requestQueue = new Promise((resolve) => { release = resolve; });
  value.broker.onCdpEvent(clerkPaused("https://clerk.example.test/v1/client/sessions/sess_queued/touch"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  release();
  try {
    await value.broker.requestQueue;
    assert.equal(JSON.parse(await readFile(value.capPath, "utf8")).abort.code, "unknown_mutation_request");
    assert.equal(value.broker.provisionalClerkSessionId, null);
    assert.deepEqual(value.commands, ["Fetch.failRequest"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("queued Clerk activation authorization uses the session captured at request receipt", async () => {
  const value = await bootstrapTransportFixture();
  let release;
  value.broker.clerkTransportPhase = "activating";
  value.broker.activeClerkSessionId = "sess_expected";
  value.broker.requestQueue = new Promise((resolve) => { release = resolve; });
  value.broker.onCdpEvent(clerkPaused("https://clerk.example.test/v1/client/sessions/sess_expected/tokens"));
  value.broker.clerkTransportPhase = "active";
  value.broker.activeClerkSessionId = "sess_different";
  release();
  try {
    await value.broker.requestQueue;
    assert.deepEqual(value.commands, ["Fetch.continueRequest"]);
    assert.equal(JSON.parse(await readFile(value.capPath, "utf8")).abort, null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("private unknown-mutation diagnostics stay fixed, sanitized, first-abort-only, and out of broker output", async () => {
  const value = await bootstrapTransportFixture();
  const request = clerkPaused(`${origin}/api/users/user_private_123/progress?secret=query-value`, "unknown-app");
  try {
    await value.broker.handlePausedRequest(request, value.broker.boundedRequestReceipt());
    const first = JSON.parse(await readFile(value.capPath, "utf8"));
    assert.deepEqual(first.abort.operator_diagnostic, {
      boundary: "bounded_private_auth",
      request_class: "same_origin_mutation",
      captured_phase: "bootstrap",
      session_binding: false,
      method: "POST"
    });
    await value.broker.abort("second_abort", "second", { boundary: "changed" });
    assert.deepEqual(JSON.parse(await readFile(value.capPath, "utf8")), first);
    const metrics = await value.broker.execute({ method: "metrics" }, "sandbox");
    assert.equal(metrics.metrics.abort.code, "unknown_mutation_request");
    assert.equal("operator_diagnostic" in metrics.metrics.abort, false);
    const retained = (await Promise.all((await readdir(value.root)).filter((name) => name !== "cap.json").map((name) => readFile(join(value.root, name), "utf8").catch(() => "")))).join("\n");
    assert.doesNotMatch(JSON.stringify(metrics) + retained, /operator_diagnostic|user_private|query-value|\/api\/users/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

for (const [label, rawUrl, expectedClass, expectedBinding, method = "POST"] of [
  ["sign-in", "https://clerk.example.test/v1/client/sign_ins", "clerk_sign_in", false],
  ["touch", "https://clerk.example.test/v1/client/sessions/sess_other/touch", "clerk_touch", false],
  ["token", "https://clerk.example.test/v1/client/sessions/sess_other/tokens/template", "clerk_token", false],
  ["other", "https://clerk.example.test/v1/client/sessions/sess_other/end", "clerk_other", false],
  ["bound touch with forbidden method", "https://clerk.example.test/v1/client/sessions/sess_expected/touch", "clerk_touch", true, "DELETE"]
]) {
  test(`active auth diagnostics classify ${label} after the live attempt is cleared`, async () => {
    const value = await bootstrapTransportFixture();
    value.broker.clerkTransportAttempt = null;
    value.broker.clerkTransportPhase = "active";
    value.broker.activeClerkSessionId = "sess_expected";
    const request = clerkPaused(rawUrl, `diagnostic-${expectedClass}`);
    request.params.request.method = method;
    try {
      await value.broker.handlePausedRequest(request, value.broker.boundedRequestReceipt());
      const diagnostic = JSON.parse(await readFile(value.capPath, "utf8")).abort.operator_diagnostic;
      assert.deepEqual(diagnostic, {
        boundary: "bounded_private_auth",
        request_class: expectedClass,
        captured_phase: "active",
        session_binding: expectedBinding,
        method
      });
      assert.doesNotMatch(JSON.stringify(diagnostic), /sess_|\/v1\/|clerk\.example|sign_ins|tokens\/template/);
      assert.equal("pathname" in diagnostic, false);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
}

test("private auth diagnostics collapse an unknown captured phase to none", async () => {
  const value = await bootstrapTransportFixture();
  value.broker.clerkTransportAttempt = null;
  value.broker.clerkTransportPhase = "unexpected-private-phase";
  try {
    await value.broker.handlePausedRequest(
      clerkPaused(`${origin}/api/private?secret=value`, "diagnostic-none"),
      value.broker.boundedRequestReceipt()
    );
    const diagnostic = JSON.parse(await readFile(value.capPath, "utf8")).abort.operator_diagnostic;
    assert.equal(diagnostic.captured_phase, "none");
    assert.equal(diagnostic.session_binding, false);
    assert.equal("pathname" in diagnostic, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a late ticket exchange cannot restore a cleared transport phase", async () => {
  const broker = new BrowserBroker({
    run_directory: "/unused",
    profile_directory: "/unused",
    initial_url: landingUrl,
    allowed_request_origins: [origin, "https://clerk.example.test"],
    allowed_navigation_origins: [origin],
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" }
  });
  let releaseExchange;
  broker.callPageFunction = async (declaration) => {
    assert.equal(declaration, CLERK_PAGE_FUNCTIONS.start);
    return new Promise((resolve) => { releaseExchange = resolve; });
  };
  const attempt = Object.freeze({});
  broker.clerkTransportAttempt = attempt;
  const pending = broker.startClerkAuthentication("ticket_fixture", "user_fixture", landingUrl);
  broker.clerkTransportAttempt = null;
  broker.clerkTransportPhase = null;
  broker.activeClerkSessionId = null;
  releaseExchange({ created_session_id: "sess_late" });

  assert.deepEqual(await pending, { failure_stage: "precondition_failed" });
  assert.equal(broker.clerkTransportPhase, null);
  assert.equal(broker.activeClerkSessionId, null);
});

for (const [label, readiness, expectedCode] of [
  ["never becomes ready", async () => false, "clerk_auth_sdk_unavailable"],
  ["readiness evaluation throws", async () => { throw new Error("private SDK detail"); }, "clerk_auth_failed"]
]) {
  test(`Clerk ${label} fails once without ticket exchange`, async () => {
    const { broker, authCalls, lockCalls } = transitBroker([replacedTransit()]);
    broker.waitForClerkReadiness = readiness;

    const first = await broker.authenticateClerkTicket({ ticket: "ticket_private", expected_user_id: "user_private" });
    const second = await broker.authenticateClerkTicket({ ticket: "ticket_private", expected_user_id: "user_private" });

    assert.equal(first.refusal.code, expectedCode);
    assert.equal(second.refusal.code, "clerk_auth_locked");
    assert.equal(authCalls(), 0);
    assert.equal(lockCalls(), 1);
    assert.doesNotMatch(JSON.stringify({ first, second }), /ticket_private|user_private|private SDK detail|sign-in|next=/);
  });
}

test("a route change across the final cap check prevents ticket exchange", async () => {
  const elsewhere = locationState({
    url: `${origin}/elsewhere`,
    id: 43,
    index: 2,
    entries: [priorEntry, landingEntry, { id: 43, url: `${origin}/elsewhere` }],
    sequence: 12
  });
  const { broker, authCalls, lockCalls } = transitBroker([replacedTransit(), elsewhere]);

  const result = await broker.authenticateClerkTicket({ ticket: "ticket_private", expected_user_id: "user_private" });

  assert.equal(result.refusal.code, "clerk_auth_policy_mismatch");
  assert.equal(authCalls(), 0);
  assert.equal(lockCalls(), 1);
  assert.doesNotMatch(JSON.stringify(result), /ticket_private|user_private|elsewhere|sign-in|next=/);
});

test("a location href race is rejected before signIn.create", async () => {
  let createCalls = 0;
  const start = runInNewContext(`(${CLERK_PAGE_FUNCTIONS.start})`, {
    Clerk: {
      loaded: true,
      user: null,
      client: { signIn: { create: async () => { createCalls += 1; return { createdSessionId: "sess_fixture" }; } } },
      setActive: async () => {},
      session: null
    },
    location: { href: `${origin}/sign-in?next=%2Felsewhere` },
    Date,
    setTimeout
  });
  const result = await start("ticket_private", "user_fixture", authUrl);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { failure_stage: "precondition_failed" });
  assert.equal(createCalls, 0);
});

for (const [label, states, deadlineMs] of [
  ["never returns", [pushedTransit()], 100],
  ["lands elsewhere", [pushedTransit(), pushedTransit(), locationState({ url: `${origin}/elsewhere`, id: 43, index: 2, entries: [priorEntry, landingEntry, { id: 43, url: `${origin}/elsewhere` }], sequence: 12 })], 1_000],
  ["briefly lands and then leaves", [pushedTransit(), pushedTransit(), landingState(12), locationState({ url: `${origin}/elsewhere`, id: 43, index: 2, entries: [priorEntry, landingEntry, { id: 43, url: `${origin}/elsewhere` }], sequence: 13 })], 1_000]
]) {
  test(`authenticated transit that ${label} is an ambiguous fixed failure`, async () => {
    const { broker, authCalls } = transitBroker(states, { deadlineMs });
    const result = await broker.authenticateClerkTicket({ ticket: "ticket_fixture", expected_user_id: "user_fixture" });
    assert.equal(authCalls(), 1);
    assert.deepEqual(result, {
      ok: false,
      refusal: {
        code: "clerk_auth_landing_unconfirmed",
        message: "Clerk authentication landing could not be confirmed"
      }
    });
    assert.equal(broker.authLandingUrlSha256, undefined);
    assert.equal(broker.firstPostAuthCapturePending, undefined);
    assert.doesNotMatch(JSON.stringify(result), /sign-in|next=|%2Ftoday|elsewhere|sess_fixture/);
  });
}

function retainedLandingSnapshot(url = landingUrl) {
  return {
    exactUrl: url,
    entryId: landingEntry.id,
    entryIndex: 1,
    entryCount: 2,
    predecessorId: priorEntry.id,
    predecessorUrl: priorEntry.url,
    twoBackId: null,
    twoBackUrl: null,
    frameId: "frame-fixture",
    loaderId: "loader-fixture",
    sequence: 12,
    logicalSequence: 12
  };
}

function readyCapState(abort = null) {
  return {
    abort,
    working_day_deadline: new Date(Date.now() + 5_000).toISOString(),
    browser: { active_seconds: 0, operations: 1, requests: 2 },
    app: { actual_eur: 0, outstanding_reservations_eur: 0 },
    model: { actual_eur: 0, outstanding_reservations_eur: 0 }
  };
}

function postAuthReadinessBroker(root) {
  const broker = new BrowserBroker({
    run_id: "post-auth-readiness-fixture",
    run_directory: root,
    profile_directory: "/unused",
    initial_url: `${origin}/`,
    allowed_request_origins: [origin, "https://clerk.example.test"],
    allowed_navigation_origins: [origin],
    operation_deadline_ms: Date.now() + 5_000,
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" }
  });
  broker.initialNavigationConsumed = true;
  broker.initialLandingIdentity = Object.freeze({
    exactUrl: landingUrl,
    entryId: landingEntry.id,
    entryIndex: 1,
    frameId: "frame-fixture",
    loaderId: "loader-fixture",
    sequence: 10
  });
  broker.authLandingNavigationSequence = 12;
  broker.authLandingUrlSha256 = sha256Text(landingUrl);
  broker.firstPostAuthCapturePending = true;
  broker.clerkTransportPhase = "active";
  broker.activeClerkSessionId = "sess_private_never_retain";
  broker.navigationSequence = 12;
  broker.logicalNavigationSequence = 12;
  broker.topFrameId = "frame-fixture";
  broker.topFrameLoaderId = "loader-fixture";
  broker.lastTopLogicalLocation = {
    urlSha256: sha256Text(landingUrl),
    frameId: "frame-fixture",
    loaderId: "loader-fixture"
  };
  broker.lastNetworkActivityAt = Date.now() - 1_000;
  broker.privateNavigationSnapshot = async () => retainedLandingSnapshot();
  broker.reserveOperation = async () => ({ ok: true });
  broker.loadState = async () => readyCapState();
  return broker;
}

test("network activity in the stable window requires a fresh full readiness window", async () => {
  const broker = postAuthReadinessBroker("/unused");
  const ready = [{ ignored: false, role: { value: "button" }, name: { value: "Start" }, backendDOMNodeId: 7 }];
  broker.callPageFunction = async () => true;
  broker.cdp = {
    async send(method) {
      if (method === "Accessibility.getFullAXTree") return { nodes: ready };
      if (method === "Page.captureScreenshot") {
        return { data: Buffer.from("ready-private-pixels").toString("base64") };
      }
      throw new Error(`unexpected ${method}`);
    }
  };
  let activityFinishedAt = null;
  const activity = setTimeout(() => {
    broker.onCdpEvent({ method: "Network.requestWillBeSent", params: { requestId: "mid-window" } });
    broker.onCdpEvent({ method: "Network.loadingFinished", params: { requestId: "mid-window" } });
    activityFinishedAt = Date.now();
  }, 200);

  try {
    const result = await broker.confirmPrivatePostAuthReadiness();
    assert.equal(result.ok, true);
    assert.notEqual(activityFinishedAt, null);
    assert(Date.now() - activityFinishedAt >= 500);
    assert.equal(broker.postAuthReadinessFingerprint.networkSequence, 2);
  } finally {
    clearTimeout(activity);
  }
});

test("spinner and settled private network work are discarded before the first ready retained evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-post-auth-ready-"));
  await mkdir(join(root, "screenshots"));
  const broker = postAuthReadinessBroker(root);
  const spinner = [
    { ignored: false, role: { value: "progressbar" }, name: { value: "Loading private" } },
    { ignored: false, role: { value: "button" }, name: { value: "Premature action" }, backendDOMNodeId: 6 }
  ];
  const ready = [{ ignored: false, role: { value: "button" }, name: { value: "Start" }, backendDOMNodeId: 7 }];
  let axCalls = 0;
  let screenshotCalls = 0;
  broker.onCdpEvent({ method: "Network.requestWillBeSent", params: { requestId: "touch-private" } });
  broker.onCdpEvent({ method: "Network.loadingFinished", params: { requestId: "touch-private" } });
  broker.onCdpEvent({ method: "Network.requestWillBeSent", params: { requestId: "target-get" } });
  broker.onCdpEvent({ method: "Network.loadingFinished", params: { requestId: "target-get" } });
  broker.lastNetworkActivityAt = Date.now() - 1_000;
  broker.callPageFunction = async (declaration) => {
    assert.equal(declaration, CLERK_PAGE_FUNCTIONS.postAuthReady);
    return true;
  };
  broker.cdp = {
    async send(method) {
      if (method === "Accessibility.getFullAXTree") {
        axCalls += 1;
        return { nodes: axCalls === 1 ? spinner : ready };
      }
      if (method === "Page.captureScreenshot") {
        screenshotCalls += 1;
        const pixels = screenshotCalls === 1 ? "spinner-private-pixels" : "ready-pixels";
        return { data: Buffer.from(pixels).toString("base64") };
      }
      throw new Error(`unexpected ${method}`);
    }
  };
  try {
    const readinessStartedAt = Date.now();
    const result = await broker.execute({ method: "observe", action_class: "Observe" });
    assert.equal(result.ok, true);
    assert.equal(broker.postAuthReadinessConfirmed, true);
    assert.equal(broker.firstPostAuthCapturePending, false);
    assert(Date.now() - readinessStartedAt >= 500);
    assert(screenshotCalls >= 6);
    const screenshotNames = await readdir(join(root, "screenshots"));
    assert.deepEqual(screenshotNames.sort(), ["event-0001-after.png", "event-0001-before.png"]);
    for (const name of screenshotNames) {
      assert.equal(await readFile(join(root, "screenshots", name), "utf8"), "ready-pixels");
    }
    const retained = await readFile(join(root, "observations.jsonl"), "utf8");
    assert.doesNotMatch(retained, /Loading private|spinner-private-pixels|sess_private_never_retain|touch-private/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a request arriving after readiness certification prevents any retained evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-post-auth-late-request-"));
  await mkdir(join(root, "screenshots"));
  const broker = postAuthReadinessBroker(root);
  let abortAfterCertificate = false;
  broker.loadState = async () => readyCapState(abortAfterCertificate ? { code: "private-late-request" } : null);
  broker.callPageFunction = async () => true;
  const ready = [{ ignored: false, role: { value: "button" }, name: { value: "Start" }, backendDOMNodeId: 7 }];
  broker.cdp = {
    async send(method) {
      if (method === "Accessibility.getFullAXTree") return { nodes: ready };
      if (method === "Page.captureScreenshot") {
        if (broker.postAuthReadinessConfirmed && !abortAfterCertificate) {
          broker.onCdpEvent({ method: "Network.requestWillBeSent", params: { requestId: "late-private-request" } });
          broker.onCdpEvent({ method: "Network.loadingFinished", params: { requestId: "late-private-request" } });
          broker.requestQueue = Promise.resolve().then(() => { abortAfterCertificate = true; });
        }
        return { data: Buffer.from("ready-private-pixels").toString("base64") };
      }
      throw new Error(`unexpected ${method}`);
    }
  };
  try {
    const result = await broker.execute({ method: "observe", action_class: "Observe" });
    assert.equal(result.refusal.code, "clerk_auth_post_auth_readiness_unconfirmed");
    assert.equal(abortAfterCertificate, true);
    assert.deepEqual(await readdir(join(root, "screenshots")), []);
    assert.deepEqual((await readdir(root)).sort(), ["screenshots"]);
    assert.equal(broker.lastEvidence, undefined);
    assert.equal(broker.firstPostAuthCapturePending, true);
    assert.doesNotMatch(JSON.stringify(result), /private-late-request|late-private-request|sess_private/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a route flip during the final cap check prevents any retained evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-post-auth-final-route-"));
  await mkdir(join(root, "screenshots"));
  const broker = postAuthReadinessBroker(root);
  const ready = [{ ignored: false, role: { value: "button" }, name: { value: "Start" }, backendDOMNodeId: 7 }];
  const pixels = Buffer.from("ready-private-pixels").toString("base64");
  broker.postAuthReadinessConfirmed = true;
  broker.postAuthReadinessFingerprint = Object.freeze({
    axSha256: hashAccessibilityTree(ready),
    screenshotSha256: sha256Text(pixels),
    networkSequence: 0
  });
  let routeChanged = false;
  let capChecks = 0;
  broker.privateNavigationSnapshot = async () => routeChanged
    ? { ...retainedLandingSnapshot(`${origin}/elsewhere`), sequence: 13, logicalSequence: 13 }
    : retainedLandingSnapshot();
  broker.loadState = async () => {
    capChecks += 1;
    if (capChecks === 2) {
      routeChanged = true;
      broker.onCdpEvent({
        method: "Page.navigatedWithinDocument",
        params: { frameId: "frame-fixture", url: `${origin}/elsewhere`, navigationType: "historyApi" }
      });
    }
    return readyCapState();
  };
  broker.callPageFunction = async () => true;
  broker.cdp = {
    async send(method) {
      if (method === "Accessibility.getFullAXTree") return { nodes: ready };
      if (method === "Page.captureScreenshot") return { data: pixels };
      throw new Error(`unexpected ${method}`);
    }
  };

  try {
    const result = await broker.execute({ method: "observe", action_class: "Observe" });
    assert.equal(result.refusal.code, "clerk_auth_landing_unconfirmed");
    assert.equal(routeChanged, true);
    assert.equal(capChecks >= 3, true);
    assert.deepEqual(await readdir(join(root, "screenshots")), []);
    assert.deepEqual((await readdir(root)).sort(), ["screenshots"]);
    assert.equal(broker.lastEvidence, undefined);
    assert.equal(broker.firstPostAuthCapturePending, true);
    assert.doesNotMatch(JSON.stringify(result), /elsewhere|sess_private/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, configure, expectedCode] of [
  ["never becomes ready", (broker) => { broker.callPageFunction = async () => false; }, "clerk_auth_post_auth_readiness_unconfirmed"],
  ["leaves the exact landing", (broker) => { broker.privateNavigationSnapshot = async () => retainedLandingSnapshot(`${origin}/elsewhere`); }, "clerk_auth_landing_unconfirmed"],
  ["observes a durable abort", (broker) => { broker.loadState = async () => readyCapState({ code: "private-abort-detail" }); }, "clerk_auth_post_auth_readiness_unconfirmed"]
]) {
  test(`post-auth readiness that ${label} retains no screenshot or observation registry`, async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-map-post-auth-refusal-"));
    await mkdir(join(root, "screenshots"));
    const broker = postAuthReadinessBroker(root);
    broker.postAuthReadinessTimeoutMs = 10;
    configure(broker);
    broker.cdp = {
      async send(method) {
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: [{ ignored: false, role: { value: "button" }, name: { value: "Private" } }] };
        }
        if (method === "Page.captureScreenshot") return { data: Buffer.from("private-unretained").toString("base64") };
        throw new Error(`unexpected ${method}`);
      }
    };
    broker.callPageFunction ??= async () => true;
    try {
      const result = await broker.execute({ method: "observe", action_class: "Observe" });
      assert.equal(result.refusal.code, expectedCode);
      assert.deepEqual(await readdir(join(root, "screenshots")), []);
      assert.deepEqual((await readdir(root)).sort(), ["screenshots"]);
      assert.equal(broker.lastEvidence, undefined);
      assert.equal(broker.firstPostAuthCapturePending, true);
      assert.doesNotMatch(JSON.stringify(result), /private-abort-detail|elsewhere|sess_private/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("the first post-auth screenshot route race writes no bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-auth-capture-"));
  const other = locationState({
    url: `${origin}/elsewhere`,
    id: 43,
    index: 2,
    entries: [priorEntry, landingEntry, { id: 43, url: `${origin}/elsewhere` }],
    sequence: 13
  });
  const { broker } = transitBroker([]);
  broker.runDirectory = root;
  broker.authLandingNavigationSequence = 12;
  broker.authLandingUrlSha256 = sha256Text(landingUrl);
  broker.firstPostAuthCapturePending = true;
  const states = [landingState(12), landingState(12), other];
  broker.cdp = {
    async send(method) {
      if (method === "Accessibility.getFullAXTree") {
        assert.equal(broker.initialLandingIdentity?.exactUrl, landingUrl);
        return { nodes: [] };
      }
      if (method === "Page.captureScreenshot") return { data: Buffer.from("private-pixels").toString("base64") };
      assert.equal(method, "Page.getNavigationHistory");
      const state = states.shift();
      broker.navigationSequence = state.sequence;
      broker.logicalNavigationSequence = state.logicalSequence;
      broker.topFrameId = state.frameId;
      broker.topFrameLoaderId = state.loaderId;
      return state.history;
    }
  };
  try {
    await assert.rejects(() => broker.captureEvidence("event-fixture", "before"), /changed during screenshot/);
    assert.deepEqual(await readdir(root), []);
    assert.equal(broker.firstPostAuthCapturePending, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a physically duplicate landing notification still invalidates an in-flight screenshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-auth-physical-race-"));
  const { broker } = transitBroker([]);
  broker.runDirectory = root;
  broker.authLandingNavigationSequence = 12;
  broker.authLandingUrlSha256 = sha256Text(landingUrl);
  broker.firstPostAuthCapturePending = true;
  const first = locationState({
    url: landingUrl,
    id: landingEntry.id,
    index: 1,
    entries: [priorEntry, landingEntry],
    sequence: 15,
    logicalSequence: 12
  });
  const states = [first, { ...first, sequence: 16 }];
  let screenshotCalls = 0;
  broker.cdp = {
    async send(method) {
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "Page.captureScreenshot") {
        screenshotCalls += 1;
        return { data: Buffer.from("private-pixels").toString("base64") };
      }
      assert.equal(method, "Page.getNavigationHistory");
      const state = states.shift();
      broker.navigationSequence = state.sequence;
      broker.logicalNavigationSequence = state.logicalSequence;
      broker.topFrameId = state.frameId;
      broker.topFrameLoaderId = state.loaderId;
      return state.history;
    }
  };
  try {
    await assert.rejects(() => broker.captureEvidence("event-fixture", "before"), /changed during observation/);
    assert.equal(screenshotCalls, 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact initial navigation evidence establishes the private landing identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-initial-landing-"));
  await mkdir(join(root, "screenshots"));
  const broker = new BrowserBroker({
    run_directory: root,
    profile_directory: "/unused",
    initial_url: `${origin}/`,
    allowed_request_origins: [origin],
    allowed_navigation_origins: [origin]
  });
  broker.initialNavigationConsumed = true;
  broker.navigationSequence = 10;
  broker.logicalNavigationSequence = 10;
  broker.topFrameId = "frame-fixture";
  broker.topFrameLoaderId = "loader-fixture";
  broker.cdp = {
    async send(method) {
      if (method === "Page.getNavigationHistory") return landingState().history;
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "Page.captureScreenshot") return { data: Buffer.from("landing-pixels").toString("base64") };
      throw new Error(`unexpected ${method}`);
    }
  };
  try {
    await broker.captureEvidence("event-0001", "after");
    assert.deepEqual(broker.initialLandingIdentity, {
      exactUrl: landingUrl,
      entryId: 41,
      entryIndex: 1,
      frameId: "frame-fixture",
      loaderId: "loader-fixture",
      sequence: 10
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function preAuthCaptureBroker(root, states, { boundLanding = false } = {}) {
  const broker = new BrowserBroker({
    run_directory: root,
    profile_directory: "/unused",
    initial_url: `${origin}/`,
    allowed_request_origins: [origin, "https://clerk.example.test"],
    allowed_navigation_origins: [origin],
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" }
  });
  broker.initialNavigationConsumed = true;
  broker.navigationSequence = 10;
  broker.logicalNavigationSequence = 10;
  broker.topFrameId = "frame-fixture";
  broker.topFrameLoaderId = "loader-fixture";
  broker.initialNavigationPredecessor = {
    exactUrl: `${origin}/`,
    entryId: priorEntry.id,
    entryIndex: 0,
    entryCount: 1,
    predecessorId: null,
    predecessorUrl: null,
    twoBackId: null,
    twoBackUrl: null,
    frameId: "frame-before",
    loaderId: "loader-before",
    sequence: 9,
    logicalSequence: 9
  };
  broker.initialLandingEventCandidate = {
    exactUrl: landingUrl,
    frameId: "frame-fixture",
    loaderId: "loader-fixture",
    sequence: 10,
    sameUrlHistoryApiNotifications: 0
  };
  if (boundLanding) {
    broker.initialLandingIdentity = Object.freeze({
      exactUrl: landingUrl,
      entryId: landingEntry.id,
      entryIndex: 1,
      frameId: "frame-fixture",
      loaderId: "loader-fixture",
      sequence: 10
    });
  }
  const queue = [...states];
  let latest = queue[0];
  const calls = [];
  broker.cdp = {
    async send(method) {
      calls.push(method);
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (method === "Page.captureScreenshot") return { data: Buffer.from("unretained-pixels").toString("base64") };
      assert.equal(method, "Page.getNavigationHistory");
      latest = queue.length > 0 ? queue.shift() : latest;
      broker.navigationSequence = latest.sequence;
      broker.logicalNavigationSequence = latest.logicalSequence;
      broker.topFrameId = latest.frameId;
      broker.topFrameLoaderId = latest.loaderId;
      broker.lastTopNavigation = latest.navigationType
        ? { kind: "same-document", navigationType: latest.navigationType, sequence: latest.sequence }
        : { kind: "document", sequence: latest.sequence };
      broker.lastLogicalTopNavigation = latest.navigationType
        ? { kind: "same-document", navigationType: latest.navigationType, sequence: latest.logicalSequence }
        : { kind: "document", sequence: latest.logicalSequence };
      return latest.history;
    }
  };
  return { broker, calls };
}

function exactPrivateSnapshot(state) {
  const { entries, currentIndex } = state.history;
  const current = entries[currentIndex];
  const predecessor = currentIndex > 0 ? entries[currentIndex - 1] : null;
  const twoBack = currentIndex > 1 ? entries[currentIndex - 2] : null;
  return {
    exactUrl: current.url,
    entryId: current.id,
    entryIndex: currentIndex,
    entryCount: entries.length,
    predecessorId: predecessor?.id ?? null,
    predecessorUrl: predecessor?.url ?? null,
    twoBackId: twoBack?.id ?? null,
    twoBackUrl: twoBack?.url ?? null,
    frameId: state.frameId,
    loaderId: state.loaderId,
    sequence: state.sequence,
    logicalSequence: state.logicalSequence
  };
}

function privateBootstrapBroker(root, states) {
  const broker = new BrowserBroker({
    run_directory: root,
    profile_directory: "/unused",
    initial_url: `${origin}/`,
    allowed_request_origins: [origin, "https://clerk.example.test"],
    allowed_navigation_origins: [origin],
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" }
  });
  const predecessor = exactPrivateSnapshot(locationState({
    url: priorEntry.url,
    id: priorEntry.id,
    index: 0,
    entries: [priorEntry],
    sequence: 9,
    frameId: "frame-before",
    loaderId: "loader-before"
  }));
  const snapshots = [predecessor, ...states.map(exactPrivateSnapshot)];
  let latest = snapshots[0];
  const commands = [];
  broker.reserveOperation = async () => ({ ok: true });
  broker.reserveFixedFixtureWorkerRequest = async () => ({ ok: true });
  broker.waitForTopFrameLoad = async () => {};
  broker.admitPrivateAuthContinuation = async () => ({ ok: true });
  broker.abort = async () => {};
  broker.privateNavigationSnapshot = async () => {
    latest = snapshots.shift() ?? latest;
    broker.navigationSequence = latest.sequence;
    broker.logicalNavigationSequence = latest.logicalSequence;
    broker.topFrameId = latest.frameId;
    broker.topFrameLoaderId = latest.loaderId;
    const state = states.find((candidate) => candidate.sequence === latest.sequence && candidate.logicalSequence === latest.logicalSequence);
    if (state?.navigationType) {
      broker.lastTopNavigation = { kind: "same-document", navigationType: state.navigationType, sequence: state.sequence };
      broker.lastLogicalTopNavigation = { kind: "same-document", navigationType: state.navigationType, sequence: state.logicalSequence };
    }
    return latest;
  };
  broker.cdp = {
    async send(method) {
      commands.push(method);
      assert.equal(method, "Page.navigate");
      if (states[0]?.navigationType) {
        broker.initialLandingEventCandidate = {
          exactUrl: landingUrl,
          frameId: "frame-fixture",
          loaderId: "loader-fixture",
          sequence: 10,
          sameUrlHistoryApiNotifications: states[0].logicalSequence === 11 && states[0].sequence > 11 ? 1 : 0
        };
      }
      return {};
    }
  };
  return { broker, commands };
}

test("initial top-frame load gets a separate longer budget and remains deadline-bounded", async () => {
  assert.ok(INITIAL_TOP_FRAME_LOAD_TIMEOUT_MS > CDP_COMMAND_TIMEOUT_MS);
  const broker = new BrowserBroker({
    run_directory: "/unused",
    profile_directory: "/unused",
    initial_url: `${origin}/`,
    allowed_request_origins: [origin],
    allowed_navigation_origins: [origin]
  });
  broker.absoluteDeadlineMs = Date.now() + 1_000;
  broker.initialTopFrameLoadTimeoutMs = INITIAL_TOP_FRAME_LOAD_TIMEOUT_MS / 100;
  const delayedLoad = broker.waitForTopFrameLoad(0);
  await new Promise((resolveWait) => setTimeout(resolveWait, CDP_COMMAND_TIMEOUT_MS / 100 + 20));
  broker.onCdpEvent({ method: "Page.loadEventFired", params: {} });
  await delayedLoad;

  broker.initialTopFrameLoadTimeoutMs = 200;
  broker.absoluteDeadlineMs = Date.now() + 25;
  const started = Date.now();
  await assert.rejects(() => broker.waitForTopFrameLoad(broker.topFrameLoadSequence), /deadline/);
  assert.ok(Date.now() - started < 150);
});

for (const [label, arrange, expectedPoint] of [
  ["dispatch", (broker) => { broker.cdp.send = async () => { throw new Error("private dispatch detail"); }; }, "navigate_dispatch"],
  ["load wait", (broker) => { broker.waitForTopFrameLoad = async () => { throw new Error("private load detail"); }; }, "load_wait"]
]) {
  test(`private Clerk bootstrap reports only the fixed ${label} failure point`, async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-map-private-bootstrap-point-"));
    await mkdir(join(root, "screenshots"));
    const { broker } = privateBootstrapBroker(root, [landingState()]);
    arrange(broker);
    try {
      const result = await broker.execute({ method: "navigate", action_class: "Observe", url: `${origin}/` }, "supervisor");
      assert.equal(result.ok, false);
      assert.equal(result.failure_point, expectedPoint);
      assert.doesNotMatch(JSON.stringify(result), /private|detail|app\.example/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [label, states] of [
  ["stable exact landing", [landingState(), landingState(), landingState()]],
  ["production-shaped duplicate replace transit", [
    replacedTransit({ sequence: 14, logicalSequence: 11 }),
    replacedTransit({ sequence: 14, logicalSequence: 11 }),
    replacedTransit({ sequence: 14, logicalSequence: 11 })
  ]]
]) {
  test(`private Clerk bootstrap admits ${label} without pre-auth evidence`, async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-map-private-bootstrap-"));
    await mkdir(join(root, "screenshots"));
    const { broker, commands } = privateBootstrapBroker(root, states);
    try {
      const result = await broker.execute({ method: "navigate", action_class: "Observe", url: `${origin}/` }, "supervisor");
      assert.deepEqual(result, { ok: true, private_auth_handoff: true });
      assert.deepEqual(commands, ["Page.navigate"]);
      assert.equal(broker.eventSequence, 0);
      assert.equal(broker.lastEvidence, undefined);
      assert.equal(broker.refs.size, 0);
      assert.equal(broker.activeNavigation, null);
      assert.deepEqual(await readdir(join(root, "screenshots")), []);
      assert.deepEqual((await readdir(root)).sort(), ["screenshots"]);
      assert.doesNotMatch(JSON.stringify({ result, broker }), /sign-in|next=|%2Ftoday/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [label, state] of [
  ["wrong next", replacedTransit({ url: `${origin}/sign-in?next=%2Felsewhere` })],
  ["distinct intermediate URL", replacedTransit({ sequence: 12, logicalSequence: 12 })],
  ["wrong frame", replacedTransit({ frameId: "frame-other" })],
  ["new loader", replacedTransit({ loaderId: "loader-other" })],
  ["non-historyApi transition", replacedTransit({ navigationType: "fragment" })],
  ["hidden forward history", replacedTransit({
    entries: [priorEntry, { id: landingEntry.id, url: authUrl }, { id: 99, url: landingUrl }]
  })],
  ["Document navigation", { ...replacedTransit(), navigationType: null }]
]) {
  test(`private Clerk bootstrap rejects ${label} without evidence`, async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-map-private-bootstrap-matrix-"));
    await mkdir(join(root, "screenshots"));
    const { broker } = privateBootstrapBroker(root, [state]);
    try {
      const result = await broker.execute({ method: "navigate", action_class: "Observe", url: `${origin}/` }, "supervisor");
      assert.equal(result.refusal.code, "run_aborted");
      assert.equal(result.failure_point, "bootstrap_admission");
      assert.equal(broker.eventSequence, 0);
      assert.equal(broker.lastEvidence, undefined);
      assert.equal(broker.refs.size, 0);
      assert.equal(broker.activeNavigation, null);
      assert.deepEqual(await readdir(join(root, "screenshots")), []);
      assert.doesNotMatch(JSON.stringify(result), /sign-in|next=|elsewhere/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a later Document request cannot reuse the completed private bootstrap scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-private-bootstrap-scope-"));
  const capPath = join(root, "cap.json");
  const deadline = Date.now() + 5_000;
  await mkdir(join(root, "screenshots"));
  await writeExclusiveJson(capPath, freshCapState({
    browser_active_seconds: 5,
    browser_operations_total: 1,
    browser_operations_per_rolling_minute: 1,
    browser_requests_total: 2,
    browser_requests_per_rolling_minute: 2,
    listed_one_way_actions_total: 0,
    app_side_cost_cap_eur: 0,
    model_cost_cap_eur: 0,
    combined_actual_plus_reserved_cap_eur: 0
  }, new Date(deadline).toISOString(), "fixture"));
  const { broker } = privateBootstrapBroker(root, [landingState(), landingState(), landingState()]);
  broker.config.cap_state_path = capPath;
  broker.absoluteDeadlineMs = deadline;
  let ticketExchanges = 0;
  try {
    const navigation = await broker.execute({ method: "navigate", action_class: "Observe", url: `${origin}/` }, "supervisor");
    assert.deepEqual(navigation, { ok: true, private_auth_handoff: true });
    assert.equal(broker.activeNavigation, null);

    delete broker.admitPrivateAuthContinuation;
    delete broker.abort;
    broker.cdp = { async send() { return {}; } };
    broker.clerkAuthenticator = {
      async authenticate() {
        ticketExchanges += 1;
        return { ok: false, refusal: { code: "clerk_auth_failed", message: "Clerk authentication failed" } };
      },
      async lockMethods() { return true; }
    };
    broker.waitForClerkReadiness = async () => {
      broker.onCdpEvent({
        method: "Fetch.requestPaused",
        sessionId: "session-fixture",
        params: {
          requestId: "late-document",
          request: { url: `${origin}/`, method: "GET" },
          resourceType: "Document"
        }
      });
      return true;
    };

    const auth = await broker.authenticateClerkTicket({ ticket: "ticket_private", expected_user_id: "user_private" });

    assert.equal(auth.refusal.code, "run_aborted");
    assert.equal(ticketExchanges, 0);
    assert.equal(broker.eventSequence, 0);
    assert.equal(broker.lastEvidence, undefined);
    assert.equal(broker.refs.size, 0);
    assert.equal(broker.activeNavigation, null);
    assert.deepEqual(await readdir(join(root, "screenshots")), []);
    const retainedNames = (await readdir(root)).filter((name) => name !== "screenshots");
    assert.ok(retainedNames.includes("request-events.jsonl"));
    assert.equal(retainedNames.includes("events.jsonl"), false);
    const retained = await Promise.all(retainedNames.map((name) => readFile(join(root, name), "utf8")));
    assert.doesNotMatch(retained.join("\n"), /ticket_private|user_private|sign-in|next=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an approved auth transit during initial accessibility capture becomes a private no-write handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-pre-auth-during-"));
  await mkdir(join(root, "screenshots"));
  const { broker, calls } = preAuthCaptureBroker(root, [landingState(), replacedTransit()], { boundLanding: true });
  try {
    const result = await broker.captureEvidence("event-0001", "after");
    assert.equal(typeof result, "symbol");
    // Every capture now confirms the accessibility tree reads the same twice before trusting it
    // (so a reply mid-reveal is never frozen as final -- see waitForAccessibilitySettle), so the
    // fixture's always-identical mocked tree is fetched twice here instead of once.
    assert.deepEqual(calls, ["Page.getNavigationHistory", "Accessibility.getFullAXTree", "Accessibility.getFullAXTree", "Page.getNavigationHistory"]);
    assert.deepEqual(await readdir(join(root, "screenshots")), []);
    assert.equal(broker.lastEvidence, undefined);
    assert.equal(broker.refs.size, 0);
    assert.doesNotMatch(JSON.stringify(broker), /sign-in|next=|%2Ftoday|unretained-pixels/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exact same-entry replace transit already present before initial capture reconstructs only the private landing", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-pre-auth-before-"));
  await mkdir(join(root, "screenshots"));
  const productionTransit = replacedTransit({ sequence: 14, logicalSequence: 11 });
  const { broker, calls } = preAuthCaptureBroker(root, [productionTransit]);
  broker.initialLandingEventCandidate.sameUrlHistoryApiNotifications = 1;
  try {
    const result = await broker.captureEvidence("event-0001", "after");
    assert.equal(typeof result, "symbol");
    assert.deepEqual(calls, ["Page.getNavigationHistory"]);
    assert.deepEqual(broker.initialLandingIdentity, {
      exactUrl: landingUrl,
      entryId: landingEntry.id,
      entryIndex: 1,
      frameId: "frame-fixture",
      loaderId: "loader-fixture",
      sequence: 10
    });
    assert.deepEqual(await readdir(join(root, "screenshots")), []);
    assert.equal(broker.lastEvidence, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, state] of [
  ["wrong next", replacedTransit({ url: `${origin}/sign-in?next=%2Felsewhere` })],
  ["distinct intermediate URL", replacedTransit({ sequence: 12, logicalSequence: 12 })],
  ["wrong frame", replacedTransit({ frameId: "frame-other" })],
  ["new loader", replacedTransit({ loaderId: "loader-other" })],
  ["non-historyApi transition", replacedTransit({ navigationType: "fragment" })],
  ["hidden forward history after push-back-replace", replacedTransit({
    entries: [priorEntry, { id: landingEntry.id, url: authUrl }, { id: 99, url: landingUrl }]
  })],
  ["Document navigation", { ...replacedTransit(), navigationType: null, sequence: 11 }]
]) {
  test(`${label} before the initial capture cannot become a private auth handoff`, async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-map-pre-auth-refused-"));
    await mkdir(join(root, "screenshots"));
    const { broker, calls } = preAuthCaptureBroker(root, [state]);
    try {
      await assert.rejects(() => broker.captureEvidence("event-0001", "after"), /Auth-flow evidence retention is forbidden/);
      assert.deepEqual(calls, ["Page.getNavigationHistory"]);
      assert.deepEqual(await readdir(join(root, "screenshots")), []);
      assert.equal(broker.initialLandingIdentity, undefined);
      assert.doesNotMatch(JSON.stringify(broker), /sign-in|next=|%2Ftoday|elsewhere/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a pre-navigation current entry with hidden forward history is not admitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-pre-auth-prior-forward-"));
  await mkdir(join(root, "screenshots"));
  const { broker } = preAuthCaptureBroker(root, [replacedTransit()]);
  broker.initialNavigationPredecessor.entryCount = 2;
  try {
    await assert.rejects(() => broker.captureEvidence("event-0001", "after"), /Auth-flow evidence retention is forbidden/);
    assert.deepEqual(await readdir(join(root, "screenshots")), []);
    assert.equal(broker.initialLandingIdentity, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coalesced same-URL notification with an extra push entry is not provable", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-pre-auth-extra-entry-"));
  await mkdir(join(root, "screenshots"));
  const transit = pushedTransit({ sequence: 13, logicalSequence: 11 });
  const { broker } = preAuthCaptureBroker(root, [transit]);
  broker.initialLandingEventCandidate.sameUrlHistoryApiNotifications = 1;
  try {
    await assert.rejects(() => broker.captureEvidence("event-0001", "after"), /Auth-flow evidence retention is forbidden/);
    assert.deepEqual(await readdir(join(root, "screenshots")), []);
    assert.equal(broker.initialLandingIdentity, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a forbidden request accompanying the exact transit refuses the private handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-pre-auth-abort-"));
  const capPath = join(root, "cap.json");
  const deadline = Date.now() + 5_000;
  await mkdir(join(root, "screenshots"));
  await writeExclusiveJson(capPath, freshCapState({
    browser_active_seconds: 5,
    browser_operations_total: 1,
    browser_operations_per_rolling_minute: 1,
    browser_requests_total: 2,
    browser_requests_per_rolling_minute: 2,
    listed_one_way_actions_total: 0,
    app_side_cost_cap_eur: 0,
    model_cost_cap_eur: 0,
    combined_actual_plus_reserved_cap_eur: 0
  }, new Date(deadline).toISOString(), "fixture"));
  const broker = new BrowserBroker({
    run_directory: root,
    profile_directory: "/unused",
    cap_state_path: capPath,
    operation_deadline_ms: deadline,
    initial_url: `${origin}/`,
    allowed_request_origins: [origin, "https://clerk.example.test"],
    allowed_navigation_origins: [origin],
    suppressed_request_origins: [],
    app_cost_ledger: { allowed_one_way_classes: [] },
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" }
  });
  const predecessor = {
    exactUrl: `${origin}/`,
    entryId: priorEntry.id,
    entryIndex: 0,
    entryCount: 1,
    predecessorId: null,
    predecessorUrl: null,
    twoBackId: null,
    twoBackUrl: null,
    frameId: "frame-before",
    loaderId: "loader-before",
    sequence: 9,
    logicalSequence: 9
  };
  const transit = {
    exactUrl: authUrl,
    entryId: landingEntry.id,
    entryIndex: 1,
    entryCount: 2,
    predecessorId: priorEntry.id,
    predecessorUrl: priorEntry.url,
    twoBackId: null,
    twoBackUrl: null,
    frameId: "frame-fixture",
    loaderId: "loader-fixture",
    sequence: 11,
    logicalSequence: 11
  };
  const snapshots = [predecessor, transit];
  broker.privateNavigationSnapshot = async () => snapshots.shift() ?? transit;
  broker.waitForTopFrameLoad = async () => {};
  broker.cdp = {
    async send(method) {
      if (method === "Page.navigate") {
        broker.navigationSequence = 11;
        broker.logicalNavigationSequence = 11;
        broker.topFrameId = "frame-fixture";
        broker.topFrameLoaderId = "loader-fixture";
        broker.lastTopNavigation = { kind: "same-document", navigationType: "historyApi", sequence: 11 };
        broker.lastLogicalTopNavigation = { kind: "same-document", navigationType: "historyApi", sequence: 11 };
        broker.initialLandingEventCandidate = {
          exactUrl: landingUrl,
          frameId: "frame-fixture",
          loaderId: "loader-fixture",
          sequence: 10,
          sameUrlHistoryApiNotifications: 0
        };
        broker.onCdpEvent({
          method: "Fetch.requestPaused",
          sessionId: "session-fixture",
          params: {
            requestId: "forbidden-request",
            request: { url: "https://forbidden.example.test/private", method: "GET" },
            resourceType: "Fetch"
          }
        });
        return {};
      }
      assert.equal(method, "Fetch.failRequest");
      return {};
    }
  };

  try {
    const result = await broker.execute({ method: "navigate", action_class: "Observe", url: `${origin}/` }, "supervisor");
    assert.equal(result.refusal.code, "run_aborted");
    assert.deepEqual(await readdir(join(root, "screenshots")), []);
    assert.equal(broker.lastEvidence, undefined);
    assert.equal(broker.refs.size, 0);
    assert.equal(broker.activeNavigation, null);
    const retainedNames = (await readdir(root)).filter((name) => name !== "screenshots");
    assert.ok(retainedNames.includes("request-events.jsonl"));
    assert.equal(retainedNames.includes("events.jsonl"), false);
    const retained = await Promise.all(retainedNames.map((name) => readFile(join(root, name), "utf8")));
    assert.doesNotMatch(retained.join("\n"), /sign-in|next=|%2Ftoday|ticket_private|user_private/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Chromium turns the timed /today to exact replaceState sign-in race into a private handoff", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/") {
      response.writeHead(302, { location: "/today", "cache-control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">
      <title>Fixture landing</title><h1>Public landing</h1><script>
      history.replaceState({}, "", "/today");
      addEventListener("load", () => {
        history.replaceState({}, "", "/sign-in?next=%2Ftoday");
        history.replaceState({}, "", "/sign-in?next=%2Ftoday");
      }, { once: true });
      </script>`);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), "flow-map-pre-auth-browser-"));
  const runDirectory = join(root, "run");
  const profileDirectory = join(root, "profile");
  const capPath = join(root, "cap.json");
  const configPath = join(root, "config.json");
  const startupPath = join(root, "startup.jsonl");
  await mkdir(runDirectory);
  await mkdir(profileDirectory);
  const deadline = Date.now() + 15_000;
  await writeExclusiveJson(capPath, freshCapState({
    browser_active_seconds: 15,
    browser_operations_total: 2,
    browser_operations_per_rolling_minute: 2,
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
    startup_log_path: startupPath,
    profile_directory: profileDirectory,
    cap_state_path: capPath,
    operation_deadline_ms: deadline,
    initial_url: `${fixtureOrigin}/`,
    allowed_navigation_origins: [fixtureOrigin],
    allowed_request_origins: [fixtureOrigin, "https://clerk.example.test"],
    suppressed_request_origins: [],
    effect_registry: {},
    reversible_action_registry: {},
    app_cost_ledger: { allowed_one_way_classes: [] },
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" }
  });
  const browser = new BrokerProcess(
    fileURLToPath(new URL("../supervisor/browser-broker.mjs", import.meta.url)),
    configPath,
    deadline
  );
  try {
    await browser.ready;
    const navigation = await browser.call({ method: "navigate", action_class: "Observe", url: `${fixtureOrigin}/` });
    assert.deepEqual(navigation, { ok: true, private_auth_handoff: true });
    assert.deepEqual(await readdir(join(runDirectory, "screenshots")), []);
    const retainedNames = (await readdir(runDirectory)).filter((name) => name !== "screenshots");
    assert.equal(retainedNames.includes("events.jsonl"), false);
    for (const name of retainedNames) {
      assert.doesNotMatch(await readFile(join(runDirectory, name), "utf8"), /sign-in|next=|%2Ftoday|Public landing/);
    }
    assert.equal(requests.some((request) => request.includes("/sign-in")), false);
  } finally {
    await browser.stop().catch(() => {});
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

test("blocked auth Document navigation retains no route", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-auth-document-"));
  const capPath = join(root, "cap.json");
  const deadline = Date.now() + 5_000;
  await writeExclusiveJson(capPath, freshCapState({
    browser_active_seconds: 5,
    browser_operations_total: 1,
    browser_operations_per_rolling_minute: 1,
    browser_requests_total: 1,
    browser_requests_per_rolling_minute: 1,
    listed_one_way_actions_total: 0,
    app_side_cost_cap_eur: 0,
    model_cost_cap_eur: 0,
    combined_actual_plus_reserved_cap_eur: 0
  }, new Date(deadline).toISOString(), "fixture"));
  const broker = new BrowserBroker({
    run_directory: root,
    profile_directory: "/unused",
    cap_state_path: capPath,
    initial_url: `${origin}/`,
    allowed_request_origins: [origin],
    allowed_navigation_origins: [origin],
    operation_deadline_ms: deadline
  });
  const commands = [];
  broker.cdp = { send: async (method) => { commands.push(method); return {}; } };
  try {
    await broker.handlePausedRequest({
      sessionId: "session-fixture",
      params: {
        requestId: "request-fixture",
        request: { url: authUrl, method: "GET" },
        resourceType: "Document"
      }
    });
    const retained = await readFile(join(root, "request-events.jsonl"), "utf8");
    assert.deepEqual(commands, ["Fetch.failRequest"]);
    assert.doesNotMatch(retained, /sign-in|next=|%2Ftoday/);
    assert.deepEqual(JSON.parse(retained), {
      timestamp: JSON.parse(retained).timestamp,
      outcome: "auth-flow-blocked-before-dispatch",
      private_transport: "auth-flow-navigation",
      method: "GET",
      resource_type: "Document"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a concurrent wrong-session Clerk mutation aborts before evidence and retains no URL or id", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-map-wrong-clerk-session-"));
  const capPath = join(root, "cap.json");
  const deadline = Date.now() + 5_000;
  await mkdir(join(root, "screenshots"));
  await writeExclusiveJson(capPath, freshCapState({
    browser_active_seconds: 5,
    browser_operations_total: 1,
    browser_operations_per_rolling_minute: 1,
    browser_requests_total: 2,
    browser_requests_per_rolling_minute: 2,
    listed_one_way_actions_total: 0,
    app_side_cost_cap_eur: 0,
    model_cost_cap_eur: 0,
    combined_actual_plus_reserved_cap_eur: 0
  }, new Date(deadline).toISOString(), "fixture"));
  const broker = new BrowserBroker({
    run_directory: root,
    profile_directory: "/unused",
    cap_state_path: capPath,
    initial_url: landingUrl,
    allowed_request_origins: [origin, "https://clerk.example.test"],
    allowed_navigation_origins: [origin],
    operation_deadline_ms: deadline,
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: "https://clerk.example.test" }
  });
  broker.clerkTransportPhase = "activating";
  broker.activeClerkSessionId = "sess_expected_private";
  const commands = [];
  broker.cdp = { send: async (method) => { commands.push(method); return {}; } };
  try {
    await broker.handlePausedRequest({
      sessionId: "session-fixture",
      params: {
        requestId: "request-private",
        request: { url: "https://clerk.example.test/v1/client/sessions/sess_wrong_private/touch", method: "POST" },
        resourceType: "Fetch"
      }
    });
    const retained = await readFile(join(root, "request-events.jsonl"), "utf8");
    const cap = JSON.parse(await readFile(capPath, "utf8"));
    assert.deepEqual(commands, ["Fetch.failRequest"]);
    assert.equal(cap.abort.code, "unknown_mutation_request");
    assert.deepEqual(JSON.parse(retained), {
      timestamp: JSON.parse(retained).timestamp,
      outcome: "unknown-mutation-blocked-before-dispatch",
      private_transport: "clerk-session",
      method: "POST",
      resource_type: "Fetch"
    });
    assert.doesNotMatch(retained, /sess_wrong_private|sess_expected_private|\/v1\/client\/sessions|clerk\.example/);
    assert.deepEqual(await readdir(join(root, "screenshots")), []);
    assert.equal((await readdir(root)).includes("observations.jsonl"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
