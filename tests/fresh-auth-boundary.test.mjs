import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { filesBelow, freshCapState, isAuthFlowUrl } from "../lib/scaffold.mjs";
import { preflightTargetRuntime } from "../lib/target-runtime.mjs";
import { prepareTargetRun } from "../scripts/prepare-target-run.mjs";
import { BrowserBroker, CLERK_PAGE_FUNCTIONS } from "../supervisor/browser-broker.mjs";
import { bootstrapClerkAuthentication } from "../supervisor/clerk-bootstrap.mjs";
import {
  createExclusiveEmptyBrowserProfile,
  removeOwnedBrowserProfile,
  revalidateOwnedBrowserProfile
} from "../supervisor/explorer-session.mjs";
import { privateJson, RUN_ID, targetRuntimeFixture } from "./target-runtime-fixture.mjs";

const appOrigin = "https://app.example.test";
const clerkOrigin = "https://clerk.example.test";
const providerUserId = "user_approved";
const username = `flowmap_${"a".repeat(32)}`;
const deadline = () => new Date(Date.now() + 5_000).toISOString();

function domainResponse() {
  return Response.json({ data: [{ frontend_api_url: clerkOrigin }], total_count: 1 });
}

function approvedUserResponse() {
  return Response.json({ id: providerUserId, username });
}

function safePreAuth() {
  return {
    ok: true,
    clerk_ready: true,
    signed_out: true,
    session_absent: true,
    sign_in_clean: true,
    caps_valid: true
  };
}

function freshBootstrapHarness({ sessionResponse = () => Response.json([]), userResponse = approvedUserResponse, preAuth = safePreAuth, route = { ok: true, route_bound: true } } = {}) {
  const calls = [];
  let inventoryCalls = 0;
  let preAuthCalls = 0;
  const browser = {
    async call(payload) {
      calls.push(`browser:${payload.method}`);
      if (payload.method === "inspect_clerk_pre_auth") return preAuth(preAuthCalls++);
      if (payload.method === "authenticate_clerk_ticket") {
        return {
          ok: true,
          authenticated: true,
          current_context_auth_methods_locked: true,
          persistent_clerk_network_filter: true,
          active_session_id: "sess_fresh"
        };
      }
      if (payload.method === "bind_bounded_post_auth_route") return route;
      throw new Error("unexpected browser call");
    },
    async stop() {
      calls.push("browser:stop");
    }
  };
  const fetchImpl = async (url, init) => {
    const href = String(url);
    if (href.endsWith("/v1/domains")) {
      calls.push("provider:instance");
      return domainResponse();
    }
    if (href.endsWith(`/v1/users/${providerUserId}`)) {
      calls.push("provider:identity");
      return userResponse();
    }
    if (href.includes("/v1/sessions?")) {
      calls.push("provider:inventory");
      return sessionResponse(inventoryCalls++, url, init);
    }
    if (href.endsWith("/v1/sign_in_tokens")) {
      calls.push("provider:mint");
      return Response.json({ id: "sit_fresh", token: "ticket_fresh" });
    }
    if (href.endsWith("/v1/sessions/sess_fresh/revoke")) {
      calls.push("provider:session-revoke");
      return Response.json({});
    }
    if (href.endsWith("/v1/sign_in_tokens/sit_fresh/revoke")) {
      calls.push("provider:token-revoke");
      return Response.json({});
    }
    throw new Error(`unexpected provider request: ${href}`);
  };
  const run = () => bootstrapClerkAuthentication({
    browser,
    expectedUserId: providerUserId,
    expectedFrontendOrigin: clerkOrigin,
    workingDayDeadline: deadline(),
    environment: { CLERK_SECRET_KEY: "sk_private_fixture" },
    fetchImpl,
    requireFreshAuth: true,
    approvedDisposableIdentity: { providerUserId, username },
    deferFailureCleanup: true
  });
  return { calls, run };
}

test("bounded profile creation is exclusive, empty, mode-0700, and leaves an existing profile untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "fresh-profile-"));
  const fresh = join(root, "fresh");
  const occupied = join(root, "occupied");
  try {
    const ownership = await createExclusiveEmptyBrowserProfile(fresh);
    assert.equal(ownership.path, await realpath(fresh));
    assert.equal(Number.isSafeInteger(ownership.root.dev), true);
    assert.equal(Number.isSafeInteger(ownership.root.ino), true);
    assert.equal(Number.isSafeInteger(ownership.parent.dev), true);
    assert.equal(Number.isSafeInteger(ownership.parent.ino), true);
    await revalidateOwnedBrowserProfile(ownership, { requireEmpty: true });
    assert.deepEqual(await readdir(fresh), []);
    assert.equal((await stat(fresh)).mode & 0o777, 0o700);
    const outside = join(root, "outside-marker");
    await writeFile(outside, "keep outside\n");
    await mkdir(join(fresh, "Default"));
    await writeFile(join(fresh, "Default", "Preferences"), "{}\n");
    await symlink(outside, join(fresh, "outside-link"));
    assert.equal(await removeOwnedBrowserProfile(ownership, true), true);
    assert.equal(await readFile(outside, "utf8"), "keep outside\n");
    await mkdir(occupied);
    await writeFile(join(occupied, "owned-by-someone-else"), "keep\n");
    await assert.rejects(() => createExclusiveEmptyBrowserProfile(occupied), { code: "EEXIST" });
    assert.equal(await readFile(join(occupied, "owned-by-someone-else"), "utf8"), "keep\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile custody refuses a swapped root and never deletes the replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "fresh-profile-swap-"));
  const profile = join(root, "profile");
  const displaced = join(root, "displaced-owned-profile");
  const run = join(root, "run");
  try {
    await mkdir(run);
    const ownership = await createExclusiveEmptyBrowserProfile(profile);
    await rename(profile, displaced);
    await mkdir(profile, { mode: 0o700 });
    const marker = join(profile, "replacement-marker");
    await writeFile(marker, "must survive\n");
    await assert.rejects(() => revalidateOwnedBrowserProfile(ownership, { requireEmpty: true }), /ownership changed/);
    const broker = new BrowserBroker({
      runtime_mode: "source-blind-bounded-onboarding-v1",
      run_directory: run,
      startup_log_path: join(root, "startup.jsonl"),
      profile_directory: ownership.path,
      profile_ownership: ownership,
      cap_state_path: join(root, "unused-cap.json"),
      initial_url: `${appOrigin}/`,
      allowed_request_origins: [appOrigin, clerkOrigin],
      allowed_navigation_origins: [appOrigin],
      clerk_auth: {
        mode: "one-use-ticket",
        frontend_api_origin: clerkOrigin,
        approved_disposable_identity: { provider_user_id: providerUserId, username }
      }
    });
    await assert.rejects(() => broker.start(), /ownership changed/);
    assert.equal(broker.chrome, undefined);
    assert.equal(await removeOwnedBrowserProfile(ownership, true), false);
    assert.equal(await readFile(marker, "utf8"), "must survive\n");
    assert.deepEqual(await readdir(displaced), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded target preflight privately returns only the exact sealed Clerk identity", async () => {
  const fixture = await targetRuntimeFixture("https://app.example.test");
  try {
    const accountPath = join(fixture.ownerDirectory, "account.json");
    const account = JSON.parse(await readFile(accountPath, "utf8"));
    account.identity.username = username;
    await privateJson(accountPath, account);
    const ledgerPath = join(fixture.ownerDirectory, "action-and-app-cost-ledger.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.allowed_one_way_classes.push({
      id: "bounded-onboarding",
      action_matrix_row: "Bounded own-account onboarding progress",
      maximum_count: 20,
      worst_case_eur_per_action: 0,
      maximum_reserved_eur: 0,
      allowed_effects: "bound-route onboarding progress only",
      reservation_rule: "reserve zero and settle zero per bound-route action"
    });
    await privateJson(ledgerPath, ledger);
    const manifestPath = join(fixture.runDirectory, "input-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const [name, path] of [["account.json", accountPath], ["action-and-app-cost-ledger.json", ledgerPath]]) {
      manifest.owner_input_hashes[name] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
    await privateJson(manifestPath, manifest);
    await prepareTargetRun({
      repository: fixture.repository,
      ownerDirectory: fixture.ownerDirectory,
      runId: RUN_ID,
      mode: "source-blind-bounded-onboarding-v1"
    });
    const config = JSON.parse(await readFile(fixture.configPath, "utf8"));
    config.clerk_auth.approved_disposable_identity = {
      provider_user_id: account.identity.provider_user_id,
      username
    };
    await privateJson(fixture.configPath, config);
    const verified = await preflightTargetRuntime({ repository: fixture.repository, configPath: fixture.configPath });
    assert.deepEqual(verified.clerkIdentity, { providerUserId: "user_fixture", username });
    assert.equal(Object.hasOwn(verified.config, "clerkIdentity"), false);

    config.clerk_auth.approved_disposable_identity.username = "flowmap_wrong";
    await privateJson(fixture.configPath, config);
    await assert.rejects(
      () => preflightTargetRuntime({ repository: fixture.repository, configPath: fixture.configPath }),
      /not bound to the approved disposable account/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("page pre-authentication inspection returns booleans only", () => {
  const inspect = runInNewContext(`(${CLERK_PAGE_FUNCTIONS.preAuth})`, {
    Clerk: {
      loaded: true,
      user: null,
      session: null,
      client: { sessions: [], signIn: { status: null } }
    }
  });
  const clean = JSON.parse(JSON.stringify(inspect()));
  assert.deepEqual(clean, {
    clerk_ready: true,
    signed_out: true,
    session_absent: true,
    sign_in_clean: true
  });
  assert.equal(Object.values(clean).every((value) => typeof value === "boolean"), true);
  assert.doesNotMatch(JSON.stringify(clean), /user_|sess_|cookie|token|clerk\.example/);

  const occupied = runInNewContext(`(${CLERK_PAGE_FUNCTIONS.preAuth})`, {
    Clerk: {
      loaded: true,
      user: { id: "user_private" },
      session: { id: "sess_private" },
      client: { sessions: [{ id: "sess_private" }], signIn: { status: "complete" } }
    }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(occupied())), {
    clerk_ready: true,
    signed_out: false,
    session_absent: false,
    sign_in_clean: false
  });
});

test("broker pre-authentication inspection exposes only fixed booleans and remains supervisor-only", async () => {
  const broker = new BrowserBroker({
    runtime_mode: "source-blind-bounded-onboarding-v1",
    run_directory: "/unused",
    profile_directory: "/unused",
    cap_state_path: "/unused",
    operation_deadline_ms: Date.now() + 5_000,
    initial_url: `${appOrigin}/`,
    allowed_request_origins: [appOrigin, clerkOrigin],
    allowed_navigation_origins: [appOrigin],
    suppressed_request_origins: [],
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: clerkOrigin }
  });
  broker.initialNavigationConsumed = true;
  broker.initialLandingIdentity = navigation(`${appOrigin}/`);
  broker.privateNavigationSnapshot = async () => navigation(`${appOrigin}/`);
  broker.admitPrivateClerkLocation = () => ({ kind: "direct", exactCurrentHref: `${appOrigin}/` });
  broker.waitForClerkReadiness = async () => true;
  broker.callPageFunction = async () => ({ clerk_ready: true, signed_out: true, session_absent: true, sign_in_clean: true });
  broker.admitPrivateAuthContinuation = async () => ({ ok: true });
  assert.deepEqual(await broker.execute({ method: "inspect_clerk_pre_auth" }, "supervisor"), safePreAuth());

  let snapshots = 0;
  broker.privateNavigationSnapshot = async () => {
    snapshots += 1;
    if (snapshots === 2) broker.backgroundAbortLatched = true;
    return navigation(`${appOrigin}/`);
  };
  assert.deepEqual(await broker.execute({ method: "inspect_clerk_pre_auth" }, "supervisor"), {
    ...safePreAuth(),
    ok: false,
    caps_valid: false
  });
  assert.equal((await broker.execute({ method: "inspect_clerk_pre_auth" }, "sandbox")).refusal.code, "method_not_exposed");
});

test("fresh bootstrap verifies instance, exact account, zero sessions, browser state, then binds after authentication", async () => {
  const harness = freshBootstrapHarness();
  const auth = await harness.run();
  assert.equal(auth.authenticated, true);
  assert.deepEqual(harness.calls, [
    "provider:instance",
    "provider:identity",
    "provider:inventory",
    "browser:inspect_clerk_pre_auth",
    "browser:inspect_clerk_pre_auth",
    "provider:inventory",
    "provider:mint",
    "browser:authenticate_clerk_ticket",
    "browser:bind_bounded_post_auth_route"
  ]);
  assert.doesNotMatch(JSON.stringify(auth), new RegExp(`${providerUserId}|${username}|ticket_fresh|sess_fresh`));
});

test("a session created concurrently after browser pre-auth prevents token minting", async () => {
  const harness = freshBootstrapHarness({
    sessionResponse: (call) => Response.json(call === 0 ? [] : [{ id: "sess_concurrent" }])
  });
  const error = await harness.run().catch((caught) => caught);
  assert.equal(error.message, "Clerk authentication preparation failed");
  assert.deepEqual(harness.calls, [
    "provider:instance",
    "provider:identity",
    "provider:inventory",
    "browser:inspect_clerk_pre_auth",
    "browser:inspect_clerk_pre_auth",
    "provider:inventory"
  ]);
  assert.equal(harness.calls.includes("provider:mint"), false);
  assert.equal(error.cleanup?.cleanup_complete, true);
});

test("a session created during the last browser admission is caught by the final inventory", async () => {
  let sessionAppeared = false;
  const harness = freshBootstrapHarness({
    preAuth: (call) => {
      if (call === 1) sessionAppeared = true;
      return safePreAuth();
    },
    sessionResponse: (call) => Response.json(call === 0 || !sessionAppeared ? [] : [{ id: "sess_during_admission" }])
  });
  const error = await harness.run().catch((caught) => caught);
  assert.equal(error.message, "Clerk authentication preparation failed");
  assert.deepEqual(harness.calls, [
    "provider:instance",
    "provider:identity",
    "provider:inventory",
    "browser:inspect_clerk_pre_auth",
    "browser:inspect_clerk_pre_auth",
    "provider:inventory"
  ]);
  assert.equal(harness.calls.includes("provider:mint"), false);
  assert.equal(error.cleanup?.cleanup_complete, true);
});

for (const [label, options] of [
  ["nonzero inventory", { sessionResponse: () => Response.json([{ id: "sess_existing" }]) }],
  ["provider error", { sessionResponse: () => Response.json({ private: "detail" }, { status: 503 }) }],
  ["incomplete pagination", { sessionResponse: () => Response.json({ data: [], total_count: 1 }) }],
  ["ambiguous duplicate rows", { sessionResponse: () => Response.json([{ id: "sess_same" }, { id: "sess_same" }]) }],
  ["account mismatch", { userResponse: () => Response.json({ id: providerUserId, username: "flowmap_wrong" }) }],
  ["browser session present", { preAuth: () => ({ ...safePreAuth(), session_absent: false }) }],
  ["failed final cap check", { preAuth: (call) => ({ ...safePreAuth(), caps_valid: call === 0 }) }]
]) {
  test(`fresh bootstrap rejects ${label} without a token-mint request`, async () => {
    const harness = freshBootstrapHarness(options);
    const error = await harness.run().catch((caught) => caught);
    assert.equal(error.message, "Clerk authentication preparation failed");
    assert.equal(harness.calls.includes("provider:mint"), false);
    assert.equal(harness.calls.includes("browser:authenticate_clerk_ticket"), false);
    assert.equal(error.cleanup?.cleanup_complete, true);
    assert.doesNotMatch(`${error.message}\n${error.stack}`, /private|sess_existing|flowmap_wrong/);
  });
}

test("fresh bootstrap times out an incomplete inventory without minting", async () => {
  const started = Date.now();
  const error = await bootstrapClerkAuthentication({
    browser: { call: async () => assert.fail("browser pre-auth must not run") },
    expectedUserId: providerUserId,
    expectedFrontendOrigin: clerkOrigin,
    workingDayDeadline: Date.now() + 30,
    environment: { CLERK_SECRET_KEY: "sk_private_fixture" },
    fetchImpl: async (url, init) => {
      const href = String(url);
      if (href.endsWith("/v1/domains")) return domainResponse();
      if (href.endsWith(`/v1/users/${providerUserId}`)) return approvedUserResponse();
      if (href.includes("/v1/sessions?")) return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("private timeout")), { once: true }));
      assert.fail("mint must not be dispatched");
    },
    requireFreshAuth: true,
    approvedDisposableIdentity: { providerUserId, username }
  }).catch((caught) => caught);
  assert.equal(error.message, "Clerk authentication preparation failed");
  assert.ok(Date.now() - started < 500);
});

function navigation(url = `${appOrigin}/bound-route`, overrides = {}) {
  return {
    exactUrl: url,
    entryId: 2,
    entryIndex: 1,
    entryCount: 2,
    predecessorId: 1,
    predecessorUrl: `${appOrigin}/`,
    twoBackId: null,
    twoBackUrl: null,
    frameId: "top-frame",
    loaderId: "loader",
    sequence: 2,
    logicalSequence: 2,
    ...overrides
  };
}

async function routeBroker(root, snapshots) {
  const capPath = join(root, "cap.json");
  await mkdir(join(root, "screenshots"));
  await writeFile(capPath, `${JSON.stringify(freshCapState({
    browser_active_seconds: 10,
    browser_operations_total: 10,
    browser_operations_per_rolling_minute: 10,
    browser_requests_total: 10,
    browser_requests_per_rolling_minute: 10,
    listed_one_way_actions_total: 20,
    app_side_cost_cap_eur: 2,
    model_cost_cap_eur: 18,
    combined_actual_plus_reserved_cap_eur: 20
  }, deadline(), "route"))}\n`);
  const broker = new BrowserBroker({
    runtime_mode: "source-blind-bounded-onboarding-v1",
    run_directory: root,
    profile_directory: join(root, "profile"),
    cap_state_path: capPath,
    operation_deadline_ms: Date.now() + 500,
    initial_url: `${appOrigin}/`,
    allowed_request_origins: [appOrigin, clerkOrigin],
    allowed_navigation_origins: [appOrigin],
    suppressed_request_origins: [],
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: clerkOrigin }
  });
  broker.boundedPostAuthStartPending = true;
  broker.clerkTransportPhase = "active";
  broker.activeClerkSessionId = "sess_fresh";
  broker.boundedExpectedClerkUserId = providerUserId;
  broker.boundedPostAuthHandoff = Object.freeze({
    kind: "direct",
    navigation: Object.freeze(structuredClone(snapshots[0] ?? navigation(`${appOrigin}/`)))
  });
  broker.inspectClerkAuthentication = async () => ({
    user_id: providerUserId,
    session_id: "sess_fresh",
    token_present: true
  });
  broker.waitForClerkReadiness = async () => true;
  broker.lockClerkAuthenticationMethods = async () => {};
  broker.boundedRouteBindingTimeoutMs = 150;
  broker.boundedRouteStableWindowMs = 0;
  broker.boundedRouteStableSamples = 2;
  let latest = snapshots[0];
  broker.privateNavigationSnapshot = async () => {
    latest = snapshots.shift() ?? latest;
    broker.lastTopLogicalLocation = {
      urlSha256: createHash("sha256").update(latest.exactUrl).digest("hex"),
      frameId: latest.frameId,
      loaderId: latest.loaderId
    };
    broker.topFrameId = latest.frameId;
    broker.topFrameLoaderId = latest.loaderId;
    broker.navigationSequence = latest.sequence;
    broker.logicalNavigationSequence = latest.logicalSequence;
    return structuredClone(latest);
  };
  return broker;
}

function delayedAuthTransit(overrides = {}) {
  return navigation(`${appOrigin}/sign-in?next=%2F`, {
    entryId: 41,
    entryIndex: 1,
    entryCount: 2,
    predecessorId: 40,
    predecessorUrl: `${appOrigin}/before`,
    frameId: "top-frame",
    loaderId: "initial-loader",
    sequence: 2,
    logicalSequence: 2,
    ...overrides
  });
}

function delayedBoundRoute(path = "/onboarding-coach", overrides = {}) {
  return navigation(`${appOrigin}${path}`, {
    entryId: 42,
    entryIndex: 2,
    entryCount: 3,
    predecessorId: 41,
    predecessorUrl: `${appOrigin}/sign-in?next=%2F`,
    twoBackId: 40,
    twoBackUrl: `${appOrigin}/before`,
    frameId: "top-frame",
    loaderId: "bound-loader",
    sequence: 3,
    logicalSequence: 3,
    ...overrides
  });
}

async function delayedRouteBroker(root, steps) {
  const broker = await routeBroker(root, []);
  broker.absoluteDeadlineMs = Date.now() + 2_000;
  broker.boundedRouteBindingTimeoutMs = 1_000;
  broker.boundedRouteStableWindowMs = 0;
  broker.boundedRouteStableSamples = 2;
  broker.initialLandingIdentity = Object.freeze({
    exactUrl: `${appOrigin}/`,
    entryId: 41,
    entryIndex: 1,
    frameId: "top-frame",
    loaderId: "initial-loader",
    sequence: 1
  });
  broker.initialNavigationPredecessor = {
    exactUrl: `${appOrigin}/before`,
    entryId: 40,
    entryIndex: 0,
    entryCount: 1,
    predecessorId: null,
    predecessorUrl: null,
    twoBackId: null,
    twoBackUrl: null,
    frameId: "prior-frame",
    loaderId: "prior-loader",
    sequence: 0,
    logicalSequence: 0
  };
  broker.boundedPostAuthHandoff = Object.freeze({
    kind: "transit",
    navigation: Object.freeze(delayedAuthTransit())
  });
  let queue = [...steps];
  let latest = queue[0];
  let samples = 0;
  broker.privateNavigationSnapshot = async () => {
    const step = queue.shift() ?? latest;
    latest = step;
    samples += 1;
    broker.networkInflight = new Set(Array.from({ length: step.inflight ?? 0 }, (_, index) => `request-${index}`));
    const snapshot = step.snapshot;
    broker.lastLogicalTopNavigation = isAuthFlowUrl(snapshot.exactUrl)
      ? { kind: "same-document", navigationType: "historyApi", sequence: snapshot.logicalSequence }
      : { kind: "document", sequence: snapshot.logicalSequence };
    broker.lastTopLogicalLocation = {
      urlSha256: createHash("sha256").update(snapshot.exactUrl).digest("hex"),
      frameId: snapshot.frameId,
      loaderId: snapshot.loaderId
    };
    broker.topFrameId = snapshot.frameId;
    broker.topFrameLoaderId = snapshot.loaderId;
    broker.navigationSequence = snapshot.sequence;
    broker.logicalNavigationSequence = snapshot.logicalSequence;
    return structuredClone(snapshot);
  };
  return {
    broker,
    samples: () => samples,
    replaceSteps(nextSteps) {
      queue = [...nextSteps];
      latest = queue[0] ?? latest;
    }
  };
}

async function resumableRouteBroker(root, {
  clerkStates = [{ user_id: providerUserId, session_id: "sess_fresh", token_present: true }],
  navigate = "success",
  transitSteps = null,
  postNavigateSteps = null
} = {}) {
  const transit = delayedAuthTransit();
  const landed = delayedBoundRoute("/", {
    exactUrl: `${appOrigin}/`,
    predecessorUrl: transit.exactUrl
  });
  const value = await delayedRouteBroker(root, transitSteps ?? [{ snapshot: transit, inflight: 0 }]);
  const navigations = [];
  let inspectionIndex = 0;
  let currentContext = "transit";
  const readyContexts = [];
  const lockedContexts = [];
  value.broker.inspectClerkAuthentication = async () => clerkStates[Math.min(inspectionIndex++, clerkStates.length - 1)];
  value.broker.waitForClerkReadiness = async () => {
    readyContexts.push(currentContext);
    return true;
  };
  value.broker.lockClerkAuthenticationMethods = async () => {
    lockedContexts.push(currentContext);
  };
  value.broker.pageSessionId = "page-session";
  value.broker.cdp = {
    async send(method, params) {
      assert.equal(method, "Page.navigate");
      navigations.push(params.url);
      if (navigate === "timeout") return new Promise(() => {});
      if (navigate === "failure") return { errorText: "private failure" };
      if (navigate === "redirect") {
        value.broker.activeNavigation.last_url = params.url;
        value.broker.onCdpEvent({
          method: "Network.requestWillBeSent",
          params: {
            requestId: "redirect",
            type: "Document",
            redirectResponse: { url: params.url },
            request: { url: `${appOrigin}/redirected` }
          }
        });
        return {};
      }
      currentContext = "landing";
      value.replaceSteps(postNavigateSteps ?? [
        { snapshot: landed, inflight: 0 },
        { snapshot: landed, inflight: 0 },
        { snapshot: landed, inflight: 0 }
      ]);
      return {};
    }
  };
  return { ...value, navigations, readyContexts, lockedContexts };
}

test("bounded route binding leaves an already completed app redirect unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-delayed-"));
  try {
    const destination = delayedBoundRoute();
    const value = await delayedRouteBroker(root, [
      { snapshot: destination, inflight: 1 },
      { snapshot: destination, inflight: 0 },
      { snapshot: destination, inflight: 0 }
    ]);
    assert.deepEqual(await value.broker.bindBoundedPostAuthRoute(), { ok: true, route_bound: true });
    assert.equal(value.broker.boundedPostAuthResumeAttempted, false);
    assert.equal(value.broker.boundedScopeHref, `${appOrigin}/onboarding-coach`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stuck exact Clerk transit resumes once to the frozen pre-auth landing and binds", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-resume-"));
  try {
    const value = await resumableRouteBroker(root);
    const result = await value.broker.bindBoundedPostAuthRoute();
    assert.deepEqual(result, { ok: true, route_bound: true });
    assert.deepEqual(value.navigations, [`${appOrigin}/`]);
    assert.equal(value.broker.boundedPostAuthResumeAttempted, true);
    assert.equal(value.broker.boundedScopeHref, `${appOrigin}/`);
    assert.deepEqual(value.readyContexts, ["landing"]);
    assert.deepEqual(value.lockedContexts, ["landing"]);
    assert.equal(value.broker.firstPostAuthCapturePending, true);
    assert.deepEqual(await readdir(join(root, "screenshots")), []);
    await assert.rejects(() => stat(join(root, "request-events.jsonl")), { code: "ENOENT" });
    assert.equal(value.broker.lastEvidence, undefined);
    assert.doesNotMatch(JSON.stringify(result), /user_|sess_|sign-in|app\.example/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a duplicate physical event for the same exact auth transit remains eligible for one-shot resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-auth-duplicate-"));
  try {
    const duplicate = delayedAuthTransit({ sequence: 3 });
    const value = await resumableRouteBroker(root, {
      transitSteps: [
        { snapshot: duplicate, inflight: 0 },
        { snapshot: duplicate, inflight: 0 },
        { snapshot: duplicate, inflight: 0 }
      ]
    });
    assert.deepEqual(await value.broker.bindBoundedPostAuthRoute(), { ok: true, route_bound: true });
    assert.deepEqual(value.navigations, [`${appOrigin}/`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded route binding follows a short automatic same-origin route chain to stability", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-auto-chain-"));
  try {
    const first = delayedBoundRoute("/first");
    const second = delayedBoundRoute("/second", {
      exactUrl: `${appOrigin}/second`,
      loaderId: first.loaderId,
      sequence: first.sequence + 1,
      logicalSequence: first.logicalSequence + 1
    });
    const value = await delayedRouteBroker(root, [
      { snapshot: first, inflight: 0 },
      { snapshot: second, inflight: 0 },
      { snapshot: second, inflight: 0 },
      { snapshot: second, inflight: 0 }
    ]);
    let inspections = 0;
    let relocks = 0;
    value.broker.lockClerkAuthenticationMethods = async () => { relocks += 1; };
    value.broker.inspectClerkAuthentication = async () => {
      inspections += 1;
      return { user_id: providerUserId, session_id: "sess_fresh", token_present: true };
    };
    assert.deepEqual(await value.broker.bindBoundedPostAuthRoute(), { ok: true, route_bound: true });
    assert.equal(value.broker.boundedScopeHref, `${appOrigin}/second`);
    assert.equal(inspections, 1);
    assert.equal(relocks, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a settled automatic route chain still requires the exact final Clerk state", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-auto-chain-clerk-"));
  try {
    const first = delayedBoundRoute("/first");
    const second = delayedBoundRoute("/second", {
      exactUrl: `${appOrigin}/second`, loaderId: first.loaderId,
      sequence: first.sequence + 1, logicalSequence: first.logicalSequence + 1
    });
    const value = await delayedRouteBroker(root, [
      { snapshot: first, inflight: 0 },
      { snapshot: second, inflight: 0 },
      { snapshot: second, inflight: 0 },
      { snapshot: second, inflight: 0 }
    ]);
    value.broker.inspectClerkAuthentication = async () => ({
      user_id: providerUserId,
      session_id: "sess_wrong",
      token_present: true
    });
    const result = await value.broker.bindBoundedPostAuthRoute();
    assert.equal(result.ok, false);
    assert.equal(result.failure_stage, "exact_clerk_inspection");
    assert.equal(result.failure_point, "clerk_final_inspection");
    assert.equal(value.broker.boundedScopeIdentity, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit resume can settle through the frozen landing and one automatic route hop", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-resume-chain-"));
  try {
    const transit = delayedAuthTransit();
    const landing = delayedBoundRoute("/", { exactUrl: `${appOrigin}/`, predecessorUrl: transit.exactUrl });
    const destination = delayedBoundRoute("/ready", {
      exactUrl: `${appOrigin}/ready`,
      entryId: landing.entryId,
      entryIndex: landing.entryIndex,
      entryCount: landing.entryCount,
      predecessorId: landing.predecessorId,
      predecessorUrl: landing.predecessorUrl,
      twoBackId: landing.twoBackId,
      twoBackUrl: landing.twoBackUrl,
      loaderId: landing.loaderId,
      sequence: landing.sequence + 1,
      logicalSequence: landing.logicalSequence + 1
    });
    const value = await resumableRouteBroker(root, {
      postNavigateSteps: [
        { snapshot: landing, inflight: 0 },
        { snapshot: destination, inflight: 0 },
        { snapshot: destination, inflight: 0 },
        { snapshot: destination, inflight: 0 }
      ]
    });
    assert.deepEqual(await value.broker.bindBoundedPostAuthRoute(), { ok: true, route_bound: true });
    assert.deepEqual(value.navigations, [`${appOrigin}/`]);
    assert.equal(value.broker.boundedScopeHref, `${appOrigin}/ready`);
    assert.deepEqual(value.lockedContexts, ["landing"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded route binding rejects automatic route churn beyond its hop cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-hop-cap-"));
  try {
    const first = delayedBoundRoute("/first");
    const second = delayedBoundRoute("/second", {
      exactUrl: `${appOrigin}/second`, loaderId: first.loaderId,
      sequence: first.sequence + 1, logicalSequence: first.logicalSequence + 1
    });
    const third = delayedBoundRoute("/third", {
      exactUrl: `${appOrigin}/third`, loaderId: first.loaderId,
      sequence: second.sequence + 1, logicalSequence: second.logicalSequence + 1
    });
    const value = await delayedRouteBroker(root, [
      { snapshot: first, inflight: 0 },
      { snapshot: second, inflight: 0 },
      { snapshot: third, inflight: 0 }
    ]);
    value.broker.boundedRouteHopCap = 1;
    const result = await value.broker.bindBoundedPostAuthRoute();
    assert.equal(result.ok, false);
    assert.equal(result.failure_point, "route_hop_limit");
    assert.equal(value.broker.boundedScopeIdentity, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the first non-auth destination must follow the admitted transit and consumes the hop budget", async () => {
  const lineageRoot = await mkdtemp(join(tmpdir(), "route-bind-first-lineage-"));
  const budgetRoot = await mkdtemp(join(tmpdir(), "route-bind-first-budget-"));
  try {
    const skipped = delayedBoundRoute("/skipped", { sequence: 99, logicalSequence: 99 });
    const lineage = await delayedRouteBroker(lineageRoot, [{ snapshot: skipped, inflight: 0 }]);
    const lineageResult = await lineage.broker.bindBoundedPostAuthRoute();
    assert.equal(lineageResult.ok, false);
    assert.equal(lineageResult.failure_point, "route_lineage");

    const first = delayedBoundRoute("/first");
    const budget = await delayedRouteBroker(budgetRoot, [{ snapshot: first, inflight: 0 }]);
    budget.broker.boundedRouteHopCap = 0;
    const budgetResult = await budget.broker.bindBoundedPostAuthRoute();
    assert.equal(budgetResult.ok, false);
    assert.equal(budgetResult.failure_point, "route_hop_limit");
  } finally {
    await rm(lineageRoot, { recursive: true, force: true });
    await rm(budgetRoot, { recursive: true, force: true });
  }
});

test("bounded route binding rejects a return to auth after reaching a non-auth route", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-return-auth-"));
  try {
    const first = delayedBoundRoute("/first");
    const value = await delayedRouteBroker(root, [
      { snapshot: first, inflight: 0 },
      { snapshot: delayedAuthTransit({ sequence: 4, logicalSequence: 4 }), inflight: 0 }
    ]);
    const result = await value.broker.bindBoundedPostAuthRoute();
    assert.equal(result.ok, false);
    assert.equal(result.failure_point, "route_returned_to_auth");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded route binding never adopts a route while another navigation is active", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-active-navigation-"));
  try {
    const first = delayedBoundRoute("/first");
    const value = await delayedRouteBroker(root, [{ snapshot: first, inflight: 0 }]);
    value.broker.activeNavigation = { allowed_urls: new Set([first.exactUrl]), last_url: null };
    const result = await value.broker.bindBoundedPostAuthRoute();
    assert.equal(result.ok, false);
    assert.equal(result.failure_point, "route_admission");
    assert.equal(value.broker.boundedScopeIdentity, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, transient, expectedPoint] of [
  ["auth", navigation(`${appOrigin}/sign-in?next=%2Fbound-route`, { sequence: 3, logicalSequence: 3 }), "route_returned_to_auth"],
  ["off-origin", navigation("https://elsewhere.example/transient", { sequence: 3, logicalSequence: 3 }), "route_off_origin"]
]) {
  test(`final Clerk verification rejects a transient ${label} route even when the following sample returns`, async () => {
    const root = await mkdtemp(join(tmpdir(), "route-bind-final-transient-"));
    try {
      const stable = navigation();
      const broker = await routeBroker(root, [stable, stable, stable, transient, stable]);
      broker.finalizeBoundedRouteBinding = async () => null;
      const result = await broker.bindBoundedPostAuthRoute();
      assert.equal(result.ok, false);
      assert.equal(result.failure_point, expectedPoint);
      assert.equal(broker.boundedScopeIdentity, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [label, current] of [
  ["unexpected auth URL", delayedAuthTransit({ exactUrl: `${appOrigin}/sign-in?next=%2Fother` })],
  ["off-origin URL", delayedAuthTransit({ exactUrl: "https://elsewhere.example/sign-in?next=%2F" })],
  ["different transit lineage", delayedAuthTransit({ entryId: 99 })]
]) {
  test(`post-auth resume refuses ${label} without navigation`, async () => {
    const root = await mkdtemp(join(tmpdir(), "route-bind-resume-refuse-"));
    try {
      const value = await delayedRouteBroker(root, [{ snapshot: current, inflight: 0 }]);
      const navigations = [];
      value.broker.cdp = { send: async (method, params) => { navigations.push([method, params]); return {}; } };
      const result = await value.broker.bindBoundedPostAuthRoute();
      assert.equal(result.ok, false);
      assert.equal(result.failure_stage, "candidate_wait");
      assert.deepEqual(navigations, []);
      assert.equal(value.broker.boundedPostAuthResumeAttempted, false);
      assert.doesNotMatch(JSON.stringify(result), /user_|sess_|sign-in|elsewhere|app\.example/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const mode of ["failure", "timeout", "redirect"]) {
  test(`post-auth resume fails closed on ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "route-bind-resume-failure-"));
    try {
      const value = await resumableRouteBroker(root, { navigate: mode });
      value.broker.boundedRouteBindingTimeoutMs = 40;
      const result = await value.broker.bindBoundedPostAuthRoute();
      assert.equal(result.ok, false);
      assert.deepEqual(value.navigations, [`${appOrigin}/`]);
      assert.equal(value.broker.boundedPostAuthResumeAttempted, true);
      assert.equal(value.broker.boundedScopeIdentity, null);
      assert.equal(value.broker.firstPostAuthCapturePending, undefined);
      assert.doesNotMatch(JSON.stringify(result), /user_|sess_|sign-in|app\.example/i);
      await Promise.allSettled([value.broker.requestQueue]);
      await value.broker.drainBackgroundAbortTasks();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("post-auth resume requires the exact Clerk user, session, and token before navigating", async () => {
  const cases = [
    { user_id: "user_wrong", session_id: "sess_fresh", token_present: true },
    { user_id: providerUserId, session_id: "sess_wrong", token_present: true },
    { user_id: providerUserId, session_id: "sess_fresh", token_present: false }
  ];
  for (const clerkState of cases) {
    const root = await mkdtemp(join(tmpdir(), "route-bind-resume-clerk-"));
    try {
      const value = await resumableRouteBroker(root, { clerkStates: [clerkState] });
      const result = await value.broker.bindBoundedPostAuthRoute();
      assert.equal(result.ok, false);
      assert.equal(result.failure_stage, "exact_clerk_inspection");
      assert.deepEqual(value.navigations, []);
      assert.equal(value.broker.boundedPostAuthResumeAttempted, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("post-auth resume rechecks the exact Clerk state in the landed context before evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-resume-post-clerk-"));
  try {
    const value = await resumableRouteBroker(root, {
      clerkStates: [
        { user_id: providerUserId, session_id: "sess_fresh", token_present: true },
        { user_id: providerUserId, session_id: "sess_wrong", token_present: true }
      ]
    });
    const result = await value.broker.bindBoundedPostAuthRoute();
    assert.equal(result.ok, false);
    assert.equal(result.failure_stage, "exact_clerk_inspection");
    assert.deepEqual(value.navigations, [`${appOrigin}/`]);
    assert.deepEqual(value.lockedContexts, ["landing"]);
    assert.equal(value.broker.boundedScopeIdentity, null);
    assert.equal(value.broker.firstPostAuthCapturePending, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-auth resume never dispatches a second navigation", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-resume-once-"));
  try {
    const value = await resumableRouteBroker(root, { navigate: "failure" });
    assert.equal((await value.broker.bindBoundedPostAuthRoute()).ok, false);
    value.broker.boundedPostAuthStartPending = true;
    value.broker.clerkTransportPhase = "active";
    value.broker.activeClerkSessionId = "sess_fresh";
    value.broker.boundedExpectedClerkUserId = providerUserId;
    value.broker.boundedPostAuthHandoff = Object.freeze({
      kind: "transit",
      navigation: Object.freeze(delayedAuthTransit())
    });
    assert.equal((await value.broker.bindBoundedPostAuthRoute()).ok, false);
    assert.deepEqual(value.navigations, [`${appOrigin}/`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, steps] of [
  ["an unexpected auth URL", [{ snapshot: delayedAuthTransit({ exactUrl: `${appOrigin}/sign-in?next=%2Fother` }), inflight: 1 }]],
  ["a different auth-transit lineage", [{ snapshot: delayedAuthTransit({ entryId: 44 }), inflight: 1 }]],
  ["an off-origin destination", [{ snapshot: delayedAuthTransit(), inflight: 1 }, { snapshot: delayedBoundRoute("/onboarding-coach", { exactUrl: "https://elsewhere.example/onboarding-coach" }), inflight: 0 }]],
  ["multiple destinations", [{ snapshot: delayedAuthTransit(), inflight: 1 }, { snapshot: delayedBoundRoute("/first"), inflight: 0 }, { snapshot: delayedBoundRoute("/second", { entryId: 43, sequence: 4, logicalSequence: 4 }), inflight: 0 }]]
]) {
  test(`bounded delayed route binding rejects ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "route-bind-delayed-refused-"));
    try {
      const { broker } = await delayedRouteBroker(root, steps);
      const result = await broker.bindBoundedPostAuthRoute();
      assert.equal(result.ok, false);
      assert.equal(result.refusal.code, "clerk_auth_landing_unconfirmed");
      assert.equal(result.failure_stage, "candidate_wait");
      assert.equal(result.failure_code, "clerk_auth_route_candidate_unconfirmed");
      assert.equal(broker.boundedScopeIdentity, null);
      assert.equal(broker.firstPostAuthCapturePending, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("bounded delayed route binding keeps polling admitted inflight transit but rejects a cap abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-delayed-abort-"));
  try {
    const value = await delayedRouteBroker(root, [{ snapshot: delayedAuthTransit(), inflight: 1 }]);
    const admittedState = await value.broker.loadState();
    let admissions = 0;
    value.broker.loadState = async () => admissions++ === 0 ? admittedState : { ...admittedState, abort: { code: "cap_abort" } };
    const result = await value.broker.bindBoundedPostAuthRoute();
    assert.equal(result.ok, false);
    assert.equal(result.refusal.code, "clerk_auth_landing_unconfirmed");
    assert.equal(value.samples(), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded delayed route binding rejects a failed request queue before sampling", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-delayed-queue-"));
  try {
    const value = await delayedRouteBroker(root, [{ snapshot: delayedAuthTransit(), inflight: 1 }]);
    value.broker.requestQueue = { then(_resolve, reject) { reject(new Error("private request failure")); } };
    const result = await value.broker.bindBoundedPostAuthRoute();
    assert.equal(result.ok, false);
    assert.equal(result.refusal.code, "clerk_auth_landing_unconfirmed");
    assert.equal(value.samples(), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, stall] of [
  ["request queue", (broker) => { broker.requestQueue = new Promise(() => {}); }],
  ["background-abort drain", (broker) => { broker.backgroundAbortTasks.add(new Promise(() => {})); }],
  ["navigation snapshot", (broker) => { broker.privateNavigationSnapshot = () => new Promise(() => {}); }],
  ["Clerk token inspection", (broker) => {
    broker.boundedRouteStableSamples = 1;
    broker.inspectClerkAuthentication = () => new Promise(() => {});
  }]
]) {
  test(`the one route-binding deadline bounds a never-settling ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "route-bind-deadline-"));
    try {
      const broker = await routeBroker(root, [navigation()]);
      broker.boundedRouteBindingTimeoutMs = 20;
      stall(broker);
      const outerTimeout = Symbol("outer-timeout");
      let timer;
      const result = await Promise.race([
        broker.bindBoundedPostAuthRoute(),
        new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(outerTimeout), 150); })
      ]).finally(() => clearTimeout(timer));
      assert.notEqual(result, outerTimeout);
      assert.equal(result.ok, false);
      assert.equal(result.refusal.code, "clerk_auth_landing_unconfirmed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [label, inspected] of [
  ["wrong identity", { user_id: "user_other", session_id: "sess_fresh", token_present: true }],
  ["zero active session", { user_id: providerUserId, session_id: null, token_present: true }],
  ["wrong active session", { user_id: providerUserId, session_id: "sess_other", token_present: true }],
  ["missing token", { user_id: providerUserId, session_id: "sess_fresh", token_present: false }]
]) {
  test(`bounded route binding rejects Clerk inspection with ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "route-bind-auth-inspection-"));
    try {
      const broker = await routeBroker(root, [navigation()]);
      broker.boundedRouteStableSamples = 1;
      let inspections = 0;
      broker.inspectClerkAuthentication = async () => {
        inspections += 1;
        return inspected;
      };
      const result = await broker.bindBoundedPostAuthRoute();
      assert.equal(result.ok, false);
      assert.equal(result.refusal.code, "clerk_auth_landing_unconfirmed");
      assert.equal(result.failure_stage, "exact_clerk_inspection");
      assert.equal(result.failure_code, "clerk_auth_exact_inspection_unconfirmed");
      const explicitMismatch =
        (inspected.user_id != null && inspected.user_id !== providerUserId) ||
        (inspected.session_id != null && inspected.session_id !== "sess_fresh");
      assert.equal(explicitMismatch ? inspections === 1 : inspections > 1, true);
      assert.equal(broker.boundedScopeIdentity, null);
      assert.equal(broker.boundedExpectedClerkUserId, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("bounded route binding polls one provisional Clerk inspection but rejects an explicit mismatch immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-auth-provisional-"));
  const mismatchRoot = await mkdtemp(join(tmpdir(), "route-bind-auth-mismatch-"));
  try {
    const broker = await routeBroker(root, [navigation()]);
    broker.boundedRouteStableSamples = 1;
    broker.boundedRouteBindingTimeoutMs = 150;
    broker.absoluteDeadlineMs = Date.now() + 500;
    let inspections = 0;
    broker.inspectClerkAuthentication = async () => {
      inspections += 1;
      if (inspections === 1) return { user_id: null, session_id: null, token_present: false };
      return { user_id: providerUserId, session_id: "sess_fresh", token_present: true };
    };
    assert.deepEqual(await broker.bindBoundedPostAuthRoute(), { ok: true, route_bound: true });
    assert.equal(inspections, 2);

    const mismatch = await routeBroker(mismatchRoot, [navigation()]);
    mismatch.boundedRouteStableSamples = 1;
    let mismatchInspections = 0;
    mismatch.inspectClerkAuthentication = async () => {
      mismatchInspections += 1;
      return { user_id: "user_wrong", session_id: null, token_present: false };
    };
    const result = await mismatch.bindBoundedPostAuthRoute();
    assert.equal(result.failure_stage, "exact_clerk_inspection");
    assert.equal(mismatchInspections, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(mismatchRoot, { recursive: true, force: true });
  }
});

test("bounded route binding ignores request churn while proving the route and retries a late token completion seal", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-production-churn-"));
  try {
    const broker = await routeBroker(root, [navigation()]);
    broker.suppressedOrigins.add("https://noise.example.test");
    broker.boundedRouteStableSamples = 3;
    broker.boundedRouteStableWindowMs = 30;
    broker.boundedRouteBindingTimeoutMs = 300;
    broker.absoluteDeadlineMs = Date.now() + 500;
    let inspected = false;
    let requestNumber = 0;
    const snapshot = broker.privateNavigationSnapshot;
    broker.privateNavigationSnapshot = async () => {
      if (!inspected) {
        const allowedId = `allowed-${requestNumber}`;
        const suppressedId = `suppressed-${requestNumber++}`;
        broker.onCdpEvent({ method: "Network.requestWillBeSent", params: { requestId: allowedId, request: { url: `${appOrigin}/readiness` } } });
        broker.onCdpEvent({ method: "Network.loadingFinished", params: { requestId: allowedId } });
        broker.onCdpEvent({ method: "Network.requestWillBeSent", params: { requestId: suppressedId, request: { url: "https://noise.example.test/pixel" } } });
        broker.onCdpEvent({ method: "Network.loadingFailed", params: { requestId: suppressedId } });
      }
      return snapshot();
    };
    let inspections = 0;
    broker.inspectClerkAuthentication = async () => {
      inspected = true;
      inspections += 1;
      if (inspections === 1) {
        broker.onCdpEvent({ method: "Network.requestWillBeSent", params: { requestId: "token", request: { url: `${clerkOrigin}/v1/client/tokens` } } });
        broker.requestQueue = new Promise((resolvePromise) => {
          setTimeout(() => {
            broker.onCdpEvent({ method: "Network.loadingFinished", params: { requestId: "token" } });
            resolvePromise();
          }, 5);
        });
      }
      return { user_id: providerUserId, session_id: "sess_fresh", token_present: true };
    };
    assert.deepEqual(await broker.bindBoundedPostAuthRoute(), { ok: true, route_bound: true });
    assert.equal(requestNumber > 2, true);
    assert.equal(inspections, 2);
    assert.equal(broker.routeBindingNetworkInflight.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded route stability restarts for a duplicate physical history notification but rejects logical lineage change", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-duplicate-history-"));
  const refusedRoot = await mkdtemp(join(tmpdir(), "route-bind-changed-history-"));
  try {
    const initial = navigation();
    const duplicate = navigation(undefined, { sequence: initial.sequence + 1 });
    const broker = await routeBroker(root, [initial, duplicate, duplicate, duplicate]);
    broker.boundedRouteStableSamples = 2;
    broker.boundedRouteBindingTimeoutMs = 150;
    broker.absoluteDeadlineMs = Date.now() + 500;
    assert.deepEqual(await broker.bindBoundedPostAuthRoute(), { ok: true, route_bound: true });
    assert.equal(broker.boundedScopeIdentity.sequence, duplicate.sequence);

    const changedHistory = navigation(undefined, { sequence: 3, entryId: 99 });
    const refused = await routeBroker(refusedRoot, [initial, changedHistory]);
    const result = await refused.bindBoundedPostAuthRoute();
    assert.equal(result.failure_stage, "candidate_wait");
    assert.equal(refused.boundedScopeIdentity, null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(refusedRoot, { recursive: true, force: true });
  }
});

test("bounded route binding reseals queue and network activity caused by Clerk token inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-auth-reseal-"));
  try {
    const broker = await routeBroker(root, [navigation()]);
    broker.boundedRouteStableSamples = 1;
    let snapshotsAfterInspection = 0;
    let inspected = false;
    const snapshot = broker.privateNavigationSnapshot;
    broker.privateNavigationSnapshot = async () => {
      if (inspected) snapshotsAfterInspection += 1;
      return snapshot();
    };
    broker.inspectClerkAuthentication = async () => {
      inspected = true;
      broker.networkInflight.add("token-request");
      broker.routeBindingNetworkInflight.add("token-request");
      broker.networkActivitySequence += 1;
      broker.routeBindingNetworkActivitySequence += 1;
      broker.requestQueue = Promise.resolve().then(() => {
        broker.networkInflight.delete("token-request");
        broker.routeBindingNetworkInflight.delete("token-request");
        broker.networkActivitySequence += 1;
        broker.routeBindingNetworkActivitySequence += 1;
      });
      return { user_id: providerUserId, session_id: "sess_fresh", token_present: true };
    };
    assert.deepEqual(await broker.bindBoundedPostAuthRoute(), { ok: true, route_bound: true });
    assert.equal(snapshotsAfterInspection > 0, true);
    assert.equal(broker.networkInflight.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded route telemetry identifies a failed post-inspection reseal without private detail", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-auth-reseal-failure-"));
  try {
    const broker = await routeBroker(root, [navigation()]);
    broker.boundedRouteStableSamples = 1;
    let inspected = false;
    const snapshot = broker.privateNavigationSnapshot;
    broker.privateNavigationSnapshot = async () => {
      const value = await snapshot();
      if (inspected) {
        broker.routeBindingNetworkActivitySequence += 1;
      }
      return value;
    };
    broker.inspectClerkAuthentication = async () => {
      inspected = true;
      return { user_id: providerUserId, session_id: "sess_fresh", token_present: true };
    };
    const result = await broker.bindBoundedPostAuthRoute();
    assert.equal(result.refusal.code, "clerk_auth_landing_unconfirmed");
    assert.equal(result.failure_stage, "post_inspection_reseal");
    assert.equal(result.failure_code, "clerk_auth_post_inspection_reseal_unconfirmed");
    assert.equal(result.failure_point, "clerk_final_reseal");
    assert.doesNotMatch(JSON.stringify(result), /user_|sess_|onboarding|sign-in/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a background abort stays terminal when abort persistence rejects", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-abort-latch-"));
  try {
    const broker = await routeBroker(root, [navigation()]);
    broker.config.cap_state_path = join(root, "missing", "cap.json");
    broker.trackBackgroundAbort("late_abort", "private detail");
    await broker.drainBackgroundAbortTasks();
    const result = await broker.bindBoundedPostAuthRoute();
    assert.equal(result.ok, false);
    assert.equal(result.refusal.code, "clerk_auth_landing_unconfirmed");
    assert.equal(broker.backgroundAbortLatched, true);
    assert.equal(broker.boundedScopeIdentity, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded post-auth route binding freezes one stable same-origin non-auth top-frame destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-stable-"));
  try {
    const stable = navigation();
    const broker = await routeBroker(root, [stable, stable, stable]);
    await broker.appendRequestEvent({ url: `${appOrigin}/private-start` });
    await assert.rejects(() => stat(join(root, "request-events.jsonl")), { code: "ENOENT" });
    assert.deepEqual(await broker.bindBoundedPostAuthRoute(), { ok: true, route_bound: true });
    assert.deepEqual(broker.boundedScopeIdentity, stable);
    assert.equal(broker.boundedPrivateAuthStart, false);
    assert.equal(broker.firstPostAuthCapturePending, true);
    assert.deepEqual(await readdir(join(root, "screenshots")), []);
    assert.equal(broker.lastEvidence, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded route final commit rejects a request queued across its sealed snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-queue-race-"));
  try {
    const stable = navigation();
    const broker = await routeBroker(root, [stable]);
    const originalSnapshot = broker.privateNavigationSnapshot;
    let snapshots = 0;
    broker.privateNavigationSnapshot = async () => {
      const snapshot = await originalSnapshot();
      snapshots += 1;
      if (snapshots === 1) {
        broker.requestQueue = Promise.resolve();
        broker.routeBindingNetworkActivitySequence += 1;
      }
      return snapshot;
    };
    assert.equal(await broker.finalizeBoundedRouteBinding(stable, Date.now() + 100), null);
    assert.equal(broker.boundedScopeIdentity, null);
    assert.equal(broker.firstPostAuthCapturePending, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded route final commit rejects network activity across its sealed snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-network-race-"));
  try {
    const stable = navigation();
    const broker = await routeBroker(root, [stable]);
    const originalSnapshot = broker.privateNavigationSnapshot;
    let snapshots = 0;
    broker.privateNavigationSnapshot = async () => {
      const snapshot = await originalSnapshot();
      snapshots += 1;
      if (snapshots === 1) broker.routeBindingNetworkActivitySequence += 1;
      return snapshot;
    };
    assert.equal(await broker.finalizeBoundedRouteBinding(stable, Date.now() + 100), null);
    assert.equal(broker.boundedScopeIdentity, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded route final commit rejects a delayed background abort before persistence drains", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-background-abort-"));
  try {
    const stable = navigation();
    const broker = await routeBroker(root, [stable]);
    const originalSnapshot = broker.privateNavigationSnapshot;
    let snapshots = 0;
    broker.privateNavigationSnapshot = async () => {
      const snapshot = await originalSnapshot();
      snapshots += 1;
      if (snapshots === 1) broker.trackBackgroundAbort("late_route_abort", "private detail");
      return snapshot;
    };
    assert.equal(await broker.finalizeBoundedRouteBinding(stable, Date.now() + 100), null);
    assert.equal(broker.backgroundAbortLatched, true);
    await broker.drainBackgroundAbortTasks();
    assert.equal(broker.backgroundAbortTasks.size, 0);
    assert.equal((await readFile(broker.config.cap_state_path, "utf8")).includes("late_route_abort"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded route final commit rejects inflight work appearing across its sealed snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "route-bind-inflight-race-"));
  try {
    const stable = navigation();
    const broker = await routeBroker(root, [stable]);
    const originalSnapshot = broker.privateNavigationSnapshot;
    let snapshots = 0;
    broker.privateNavigationSnapshot = async () => {
      const snapshot = await originalSnapshot();
      snapshots += 1;
      if (snapshots === 1) broker.routeBindingNetworkInflight.add("late-request");
      return snapshot;
    };
    assert.equal(await broker.finalizeBoundedRouteBinding(stable, Date.now() + 100), null);
    assert.equal(broker.boundedScopeIdentity, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, snapshots] of [
  ["unstable destination", [navigation(), navigation(`${appOrigin}/other`), navigation(), navigation(`${appOrigin}/other`)]],
  ["off-origin destination", [navigation("https://elsewhere.example/bound-route")]],
  ["auth destination", [navigation(`${appOrigin}/sign-in?next=%2Fbound-route`)]]
]) {
  test(`bounded post-auth route binding rejects ${label} before retained evidence`, async () => {
    const root = await mkdtemp(join(tmpdir(), "route-bind-refused-"));
    try {
      const broker = await routeBroker(root, snapshots);
      const result = await broker.bindBoundedPostAuthRoute();
      assert.equal(result.ok, false);
      assert.equal(result.refusal.code, "clerk_auth_landing_unconfirmed");
      if (label === "off-origin destination") assert.equal(result.failure_point, "route_off_origin");
      assert.deepEqual(await readdir(join(root, "screenshots")), []);
      assert.equal(broker.lastEvidence, undefined);
      assert.equal(broker.refs.size, 0);
      await assert.rejects(() => stat(join(root, "request-events.jsonl")), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("route-bind failure keeps custody of the one created session and never deletes the approved identity", async () => {
  let inventories = 0;
  const calls = [];
  const harness = freshBootstrapHarness({
    route: {
      ok: false,
      refusal: { code: "clerk_auth_landing_unconfirmed" },
      failure_stage: "exact_clerk_inspection",
      failure_code: "clerk_auth_exact_inspection_unconfirmed",
      failure_point: "clerk_final_inspection"
    },
    sessionResponse: () => Response.json(inventories++ < 2 ? [] : [{ id: "sess_fresh" }])
  });
  const error = await harness.run().catch((caught) => caught);
  assert.equal(error.calibration_failure_substage, "exact_clerk_inspection");
  assert.equal(error.calibration_failure_subcode, "clerk_auth_exact_inspection_unconfirmed");
  assert.equal(error.calibration_failure_point, "clerk_final_inspection");
  assert.equal(typeof error.cleanup, "function");
  const cleanup = await error.cleanup({ browserStopped: true });
  calls.push(...harness.calls);
  assert.equal(cleanup.cleanup_complete, true);
  assert.equal(calls.includes("provider:session-revoke"), true);
  assert.equal(calls.some((call) => call.includes("user-delete")), false);
});

test("real Chromium refuses a visible sealed username before retaining any evidence", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><main data-provider-id="${providerUserId}"><h1>${username}</h1><button>Continue</button></main>`);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), "fresh-visible-identity-"));
  const run = join(root, "run");
  const profile = join(root, "profile");
  const cap = join(root, "cap.json");
  await mkdir(run);
  await writeFile(cap, `${JSON.stringify(freshCapState({
    browser_active_seconds: 20,
    browser_operations_total: 10,
    browser_operations_per_rolling_minute: 10,
    browser_requests_total: 20,
    browser_requests_per_rolling_minute: 20,
    listed_one_way_actions_total: 20,
    app_side_cost_cap_eur: 2,
    model_cost_cap_eur: 18,
    combined_actual_plus_reserved_cap_eur: 20
  }, new Date(Date.now() + 20_000).toISOString(), "identity-live"))}\n`);
  const ownership = await createExclusiveEmptyBrowserProfile(profile);
  const broker = new BrowserBroker({
    run_id: "identity-live",
    runtime_mode: "source-blind-bounded-onboarding-v1",
    run_directory: run,
    startup_log_path: join(root, "startup.jsonl"),
    profile_directory: ownership.path,
    profile_ownership: ownership,
    cap_state_path: cap,
    operation_deadline_ms: Date.now() + 20_000,
    initial_url: `${origin}/`,
    allowed_request_origins: [origin, clerkOrigin],
    allowed_navigation_origins: [origin],
    suppressed_request_origins: [],
    clerk_auth: {
      mode: "one-use-ticket",
      frontend_api_origin: clerkOrigin,
      approved_disposable_identity: { provider_user_id: providerUserId, username }
    }
  });
  let browserStopped = false;
  try {
    await broker.start();
    assert.equal((await broker.execute({ method: "navigate", action_class: "Observe", url: `${origin}/` }, "supervisor")).ok, true);
    broker.clerkTransportPhase = "active";
    broker.activeClerkSessionId = "sess_live";
    broker.boundedExpectedClerkUserId = providerUserId;
    broker.boundedPostAuthStartPending = true;
    broker.boundedPostAuthHandoff = Object.freeze({
      kind: "direct",
      navigation: Object.freeze(await broker.privateNavigationSnapshot())
    });
    broker.waitForClerkReadiness = async () => true;
    broker.lockClerkAuthenticationMethods = async () => {};
    broker.inspectClerkAuthentication = async () => ({ user_id: providerUserId, session_id: "sess_live", token_present: true });
    broker.boundedRouteStableWindowMs = 0;
    broker.boundedRouteStableSamples = 1;
    assert.deepEqual(await broker.bindBoundedPostAuthRoute(), { ok: true, route_bound: true });
    const observed = await broker.execute({ method: "observe", action_class: "Observe" });
    assert.equal(observed.ok, false);
    assert.equal(observed.refusal.code, "private_identity_exposure");
    assert.equal((await readFile(cap, "utf8")).includes(username), false);
    assert.deepEqual(await filesBelow(run), []);
    assert.equal(broker.lastEvidence, undefined);
    assert.equal(broker.refs.size, 0);
  } finally {
    browserStopped = await broker.shutdown().catch(() => false);
    const profileRemoved = await removeOwnedBrowserProfile(ownership, browserStopped);
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
    assert.equal(profileRemoved, true);
  }
});
