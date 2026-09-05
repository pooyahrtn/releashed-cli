import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshCapState, sha256Text } from "../lib/scaffold.mjs";
import { BrowserBroker } from "../supervisor/browser-broker.mjs";

const origin = "https://app.example.test";
const limits = { browser_active_seconds: 7200, browser_operations_total: 150, browser_operations_per_rolling_minute: 30, browser_requests_total: 3000, browser_requests_per_rolling_minute: 300, listed_one_way_actions_total: 20, app_side_cost_cap_eur: 2, model_cost_cap_eur: 18, combined_actual_plus_reserved_cap_eur: 20 };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bounded-onboarding-"));
  const cap = join(root, "cap.json");
  await writeFile(cap, `${JSON.stringify(freshCapState(limits, new Date(Date.now() + 60_000).toISOString(), "bounded"))}\n`);
  const broker = new BrowserBroker({ runtime_mode: "source-blind-bounded-onboarding-v1", run_directory: root, profile_directory: root, cap_state_path: cap, initial_url: `${origin}/`, allowed_request_origins: [origin, "https://other.example.test"], allowed_navigation_origins: [origin] });
  broker.cdp = { send: async () => ({}) };
  broker.boundedScopeHref = `${origin}/today`;
  broker.boundedScopeRawUrlSha256 = sha256Text(broker.boundedScopeHref);
  return { root, cap, broker };
}

function mutation(url = `${origin}/api/progress`) {
  return { sessionId: "page", params: { requestId: `request-${Math.random()}`, request: { url, method: "POST" }, resourceType: "XHR" } };
}

function active() {
  return {
    action_class: "Bounded own-account bound-route progress",
    bounded_action_id: "event-test",
    bounded_mutation_phase: "pre-input-dispatch",
    bounded_click_dispatched: false,
    bounded_click_dispatch_generation: null,
    same_origin_mutation_requests_dispatched: 0,
    allowed_request: null,
    matched_write: false
  };
}

test("bounded broker blocks typing/link actions and mutations before input dispatch", async () => {
  const value = await fixture();
  try {
    assert.equal(value.broker.validateAction({ method: "type", action_class: "Reversible own-account" }).refusal.code, "bounded_action_forbidden");
    assert.equal(value.broker.validateAction({ method: "click", action_class: "Observe" }).refusal.code, "bounded_action_forbidden");
    value.broker.activeAction = active();
    const receipt = value.broker.boundedRequestReceipt();
    await value.broker.armBoundedMutationWindow();
    await value.broker.handlePausedRequest(mutation(), receipt);
    assert.equal(JSON.parse(await readFile(value.cap, "utf8")).abort.code, "unknown_mutation_request");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("bounded mutation window allows one same-origin request and aborts second or off-origin", async (context) => {
  await context.test("one", async () => {
    const value = await fixture();
    try {
      value.broker.activeAction = active();
      await value.broker.armBoundedMutationWindow();
      await value.broker.handlePausedRequest(mutation(), value.broker.boundedRequestReceipt());
      const cap = JSON.parse(await readFile(value.cap, "utf8"));
      assert.equal(cap.abort, null);
      assert.equal(value.broker.activeAction.same_origin_mutation_requests_dispatched, 1);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
  await context.test("second", async () => {
    const value = await fixture();
    try {
      value.broker.activeAction = active();
      await value.broker.armBoundedMutationWindow();
      await value.broker.handlePausedRequest(mutation(), value.broker.boundedRequestReceipt());
      await value.broker.handlePausedRequest(mutation(), value.broker.boundedRequestReceipt());
      assert.equal(JSON.parse(await readFile(value.cap, "utf8")).abort.code, "unknown_mutation_request");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
  await context.test("off-origin", async () => {
    const value = await fixture();
    try {
      value.broker.activeAction = active();
      await value.broker.armBoundedMutationWindow();
      await value.broker.handlePausedRequest(mutation("https://other.example.test/mutate"), value.broker.boundedRequestReceipt());
      assert.equal(JSON.parse(await readFile(value.cap, "utf8")).abort.code, "unknown_mutation_request");
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});

test("bounded request admission is fixed at CDP receipt through window close", async () => {
  const value = await fixture();
  let releaseQueue;
  try {
    value.broker.activeAction = active();
    // Hold an earlier queue item: this request is received before arm but handled
    // after arm. Its receipt phase still forces the fail-closed denial.
    value.broker.requestQueue = new Promise((resolve) => { releaseQueue = resolve; });
    value.broker.onCdpEvent({ method: "Fetch.requestPaused", ...mutation() });
    const arm = value.broker.armBoundedMutationWindow();
    releaseQueue();
    await assert.rejects(arm, /queued browser request/);
    await value.broker.requestQueue;
    assert.equal(JSON.parse(await readFile(value.cap, "utf8")).abort.code, "unknown_mutation_request");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("bounded lifecycle closes after evidence before recording and blocks late receipts", async () => {
  const value = await fixture();
  try {
    value.broker.activeAction = active();
    await value.broker.armBoundedMutationWindow();
    const duringEvidence = value.broker.boundedRequestReceipt();
    await value.broker.handlePausedRequest(mutation(), duringEvidence);
    await value.broker.closeBoundedMutationWindow();
    const late = value.broker.boundedRequestReceipt();
    await value.broker.handlePausedRequest(mutation(), late);
    const cap = JSON.parse(await readFile(value.cap, "utf8"));
    assert.equal(cap.abort.code, "unknown_mutation_request");
    assert.equal(value.broker.activeAction.same_origin_mutation_requests_dispatched, 1);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("bound-route cap admits exactly 20 clicks and rejects 21", async () => {
  const value = await fixture();
  try {
    for (let index = 0; index < 20; index += 1) assert.equal((await value.broker.reserveOperation({ action_class: "Bounded own-account bound-route progress" })).ok, true);
    assert.equal((await value.broker.reserveOperation({ action_class: "Bounded own-account bound-route progress" })).refusal.code, "one_way_action_cap");
    const cap = JSON.parse(await readFile(value.cap, "utf8"));
    assert.equal(cap.app.one_way_actions, 20);
    assert.equal(cap.app.actual_eur, 0);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("bounded tokens bind the current scope/control and cannot be replayed", async () => {
  const value = await fixture();
  const navigation = { exactUrl: `${origin}/today`, entryId: 1, entryIndex: 0, entryCount: 1, predecessorId: null, predecessorUrl: null, twoBackId: null, twoBackUrl: null, frameId: "frame", loaderId: "loader", sequence: 1, logicalSequence: 1 };
  try {
    value.broker.privateNavigationSnapshot = async () => structuredClone(navigation);
    value.broker.lastEvidence = { url: `${origin}/today`, observation_hash: "a".repeat(64) };
    value.broker.lastEvidenceRawUrlSha256 = sha256Text(`${origin}/today`);
    value.broker.refs.set("e1", { backendDOMNodeId: 1, role: "button", name: "Continue" });
    const issued = await value.broker.issueActionToken({ action_class: "Bounded own-account bound-route progress", ref: "e1", bounded_progress_mutation_requests: 1 });
    assert.equal(issued.ok, true);
    const request = { action_class: "Bounded own-account bound-route progress", ref: "e1", bounded_progress_mutation_requests: 1, authorization_token: issued.authorization_token };
    assert.equal(value.broker.consumeActionToken(request).ok, true);
    assert.equal(value.broker.consumeActionToken(request).refusal.code, "action_token_invalid");

    value.broker.lastEvidenceRawUrlSha256 = sha256Text(`${origin}/changed`);
    assert.equal((await value.broker.issueActionToken({ action_class: "Bounded own-account bound-route progress", ref: "e1", bounded_progress_mutation_requests: 1 })).refusal.code, "token_scope_invalid");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("an in-memory background abort latch blocks admission, inspection, tokens, and budget reservation even when persistence rejects", async () => {
  const value = await fixture();
  const navigation = { exactUrl: `${origin}/today`, entryId: 1, entryIndex: 0, entryCount: 1, predecessorId: null, predecessorUrl: null, twoBackId: null, twoBackUrl: null, frameId: "frame", loaderId: "loader", sequence: 1, logicalSequence: 1 };
  try {
    value.broker.privateNavigationSnapshot = async () => structuredClone(navigation);
    value.broker.lastEvidence = { url: `${origin}/today`, observation_hash: "a".repeat(64) };
    value.broker.lastEvidenceRawUrlSha256 = sha256Text(`${origin}/today`);
    value.broker.refs.set("e1", { backendDOMNodeId: 1, role: "button", name: "Continue" });
    value.broker.config.cap_state_path = join(value.root, "missing", "cap.json");
    value.broker.trackBackgroundAbort("late_abort", "private detail");
    await value.broker.drainBackgroundAbortTasks();

    const action = { method: "scroll", action_class: "Observe", observation_hash: "a".repeat(64) };
    assert.equal(value.broker.backgroundAbortLatched, true);
    assert.equal(value.broker.validateAction(action).refusal.code, "run_aborted");
    assert.equal((await value.broker.execute(action)).refusal.code, "run_aborted");
    assert.equal((await value.broker.execute({ method: "inspect_observed_control", ref: "e1" }, "supervisor")).refusal.code, "run_aborted");
    assert.equal((await value.broker.execute({ method: "issue_action_token", action_class: "Bounded own-account bound-route progress", ref: "e1", bounded_progress_mutation_requests: 1 }, "supervisor")).refusal.code, "run_aborted");
    assert.equal((await value.broker.reserveOperation({ action_class: "Bounded own-account bound-route progress" })).refusal.code, "run_aborted");
    assert.equal(value.broker.actionTokens.size, 0);
    const cap = JSON.parse(await readFile(value.cap, "utf8"));
    assert.equal(cap.abort, null);
    assert.equal(cap.browser.operations, 0);
    assert.equal(cap.app.one_way_actions, 0);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("a synchronous abort latches terminal state before failed persistence returns", async () => {
  const value = await fixture();
  try {
    value.broker.config.cap_state_path = join(value.root, "missing", "cap.json");
    value.broker.cdp = { send: async () => { throw new Error("session setup failed"); } };
    await assert.rejects(() => value.broker.configureSession("worker", "service_worker", true));
    assert.equal(value.broker.backgroundAbortLatched, true);
    assert.equal(value.broker.validateAction({ method: "scroll", action_class: "Observe" }).refusal.code, "run_aborted");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("initial page configuration persists its abort and still rejects startup", async () => {
  const value = await fixture();
  try {
    value.broker.cdp = { send: async () => { throw new Error("slow CDP setup exceeded its startup budget"); } };
    await assert.rejects(
      () => value.broker.configureSession("page", "page", false),
      /slow CDP setup exceeded its startup budget/
    );
    const cap = JSON.parse(await readFile(value.cap, "utf8"));
    assert.equal(cap.abort.code, "cdp_session_configuration_failed");
    assert.equal(value.broker.backgroundAbortLatched, true);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("a latch raised during request-cap reservation blocks network dispatch without consuming the request cap", async () => {
  const value = await fixture();
  const commands = [];
  try {
    value.broker.cdp = { send: async (method) => { commands.push(method); return {}; } };
    let latchReads = 0;
    Object.defineProperty(value.broker, "backgroundAbortLatched", {
      configurable: true,
      get() { latchReads += 1; return latchReads >= 2; }
    });
    await value.broker.handlePausedRequest({
      sessionId: "page",
      params: { requestId: "request-latched-cap", request: { url: `${origin}/api/read`, method: "GET" }, resourceType: "XHR" }
    });
    assert.deepEqual(commands, ["Fetch.failRequest"]);
    assert.equal(JSON.parse(await readFile(value.cap, "utf8")).browser.requests, 0);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("a latch raised after request reservation is rechecked immediately before network dispatch", async () => {
  const value = await fixture();
  const commands = [];
  try {
    value.broker.cdp = { send: async (method) => { commands.push(method); return {}; } };
    value.broker.appendRequestEvent = async () => { value.broker.backgroundAbortLatched = true; };
    await value.broker.handlePausedRequest({
      sessionId: "page",
      params: { requestId: "request-latched-dispatch", request: { url: `${origin}/api/read`, method: "GET" }, resourceType: "XHR" }
    });
    assert.equal(value.broker.backgroundAbortLatched, true);
    assert.deepEqual(commands, ["Fetch.failRequest"]);
    assert.equal(JSON.parse(await readFile(value.cap, "utf8")).browser.requests, 1);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("a latch raised while draining requests cannot arm the bounded input-dispatch window", async () => {
  const value = await fixture();
  const commands = [];
  try {
    value.broker.activeAction = active();
    value.broker.refs.set("e1", { backendDOMNodeId: 1, role: "button", name: "Continue" });
    value.broker.cdp = { send: async (method) => {
      commands.push(method);
      if (method === "DOM.getBoxModel") return { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } };
      return {};
    } };
    value.broker.drainBoundedRequestQueue = async () => { value.broker.backgroundAbortLatched = true; };
    await assert.rejects(() => value.broker.clickRef("e1", () => value.broker.armBoundedMutationWindow()), /not live/);
    assert.deepEqual(commands, ["DOM.scrollIntoViewIfNeeded", "DOM.getBoxModel"]);
    assert.equal(value.broker.activeAction.bounded_click_dispatched, false);
    assert.equal(value.broker.activeAction.bounded_click_dispatch_generation, null);
    assert.equal(value.broker.activeAction.bounded_mutation_phase, "pre-input-dispatch");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("operation reservation rechecks a latch raised while the cap state is being committed", async () => {
  const value = await fixture();
  try {
    let latchReads = 0;
    Object.defineProperty(value.broker, "backgroundAbortLatched", {
      configurable: true,
      get() { latchReads += 1; return latchReads >= 3; }
    });
    const reserved = await value.broker.reserveOperation({ action_class: "Bounded own-account bound-route progress" });
    assert.equal(reserved.refusal.code, "run_aborted");
    assert.equal(value.broker.backgroundAbortLatched, true);
    const cap = JSON.parse(await readFile(value.cap, "utf8"));
    assert.equal(cap.browser.operations, 1);
    assert.equal(cap.app.one_way_actions, 1);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("input and navigation helpers recheck a latch after their read-only CDP awaits", async (context) => {
  await context.test("input", async () => {
    const value = await fixture();
    const commands = [];
    try {
      value.broker.refs.set("e1", { backendDOMNodeId: 1, role: "button", name: "Continue" });
      value.broker.cdp = { send: async (method) => {
        commands.push(method);
        if (method === "DOM.getBoxModel") {
          value.broker.backgroundAbortLatched = true;
          return { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } };
        }
        return {};
      } };
      await assert.rejects(() => value.broker.clickRef("e1"), /not live/);
      assert.deepEqual(commands, ["DOM.scrollIntoViewIfNeeded", "DOM.getBoxModel"]);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
  await context.test("navigation", async () => {
    const value = await fixture();
    const commands = [];
    try {
      value.broker.currentUrl = `${origin}/today`;
      value.broker.refs.set("e1", { backendDOMNodeId: 1, role: "link", name: "Next" });
      value.broker.cdp = { send: async (method) => {
        commands.push(method);
        if (method === "DOM.describeNode") {
          value.broker.backgroundAbortLatched = true;
          return { node: { localName: "a", attributes: ["href", "/next"] } };
        }
        return {};
      } };
      await assert.rejects(() => value.broker.followObservedLink("e1"), /not live/);
      assert.deepEqual(commands, ["DOM.describeNode"]);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
  await context.test("effectful page function", async () => {
    const value = await fixture();
    const commands = [];
    try {
      value.broker.cdp = { send: async (method) => {
        commands.push(method);
        if (method === "Runtime.evaluate") {
          value.broker.backgroundAbortLatched = true;
          return { result: { objectId: "root" } };
        }
        return {};
      } };
      await assert.rejects(() => value.broker.callPageFunction("function() {}", [], true), /not live/);
      assert.deepEqual(commands, ["Runtime.evaluate"]);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
  await context.test("paused target resume", async () => {
    const value = await fixture();
    const commands = [];
    try {
      value.broker.backgroundAbortLatched = true;
      value.broker.abort = async () => {};
      value.broker.cdp = { send: async (method) => { commands.push(method); return {}; } };
      await assert.rejects(() => value.broker.configureSession("worker", "service_worker", true), /not live/);
      assert.deepEqual(commands, ["Network.enable", "Fetch.enable"]);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});

test("stable scope exit retains an exact navigation identity", async () => {
  const value = await fixture();
  const destination = { exactUrl: `${origin}/next`, entryId: 2, entryIndex: 1, entryCount: 2, predecessorId: 1, predecessorUrl: `${origin}/today`, twoBackId: null, twoBackUrl: null, frameId: "frame", loaderId: "loader", sequence: 2, logicalSequence: 2 };
  try {
    value.broker.privateNavigationSnapshot = async () => structuredClone(destination);
    const confirmed = await value.broker.confirmBoundedScopeExit();
    assert.deepEqual(confirmed, destination);
    assert.notEqual(confirmed, destination);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("scope-exit evidence rejects a destination that changes after confirmation", async () => {
  const value = await fixture();
  const destinationA = { exactUrl: `${origin}/next-a`, entryId: 2, entryIndex: 1, entryCount: 2, predecessorId: 1, predecessorUrl: `${origin}/today`, twoBackId: null, twoBackUrl: null, frameId: "frame", loaderId: "loader-a", sequence: 2, logicalSequence: 2 };
  const destinationB = { ...destinationA, exactUrl: `${origin}/next-b`, loaderId: "loader-b", sequence: 3, logicalSequence: 3 };
  try {
    // The settle confirmation observed A; the retained after screenshot sees B.
    // That is a race, never a completed scope exit.
    await mkdir(join(value.root, "screenshots"));
    const snapshots = [destinationA, destinationA, destinationB];
    value.broker.privateNavigationSnapshot = async () => structuredClone(snapshots.shift() ?? destinationB);
    value.broker.accessibilityObservation = async (url) => ({ url, visible_state_summary: "next page" });
    value.broker.cdp = { send: async (method) => method === "Page.captureScreenshot" ? { data: "eA==" } : {} };
    await assert.rejects(value.broker.captureEvidence("event-race", "after", destinationA), /changed during evidence/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("file chooser event fails closed", async () => {
  const value = await fixture();
  try {
    value.broker.onCdpEvent({ method: "Page.fileChooserOpened", params: {} });
    await value.broker.drainBackgroundAbortTasks();
    const state = JSON.parse(await readFile(value.cap, "utf8"));
    assert.equal(state.abort.code, "file_chooser_forbidden");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("unexpected popup target event fails closed and drains before the cap-state lockfile is removed", async () => {
  const value = await fixture();
  value.broker.pageTargetId = "page-1";
  try {
    value.broker.onCdpEvent({ method: "Target.targetCreated", params: { targetInfo: { targetId: "page-2", type: "page" } } });
    await value.broker.drainBackgroundAbortTasks();
    assert.equal(value.broker.backgroundAbortTasks.size, 0);
    const state = JSON.parse(await readFile(value.cap, "utf8"));
    assert.equal(state.abort.code, "unexpected_page_target");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("real Chromium bounded fixture intercepts permissions and chooser, then continues past a same-origin route change", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    if (request.url === "/") {
      response.end(`<!doctype html><button onclick="fetch('/api/progress',{method:'POST'});location.href='/next'">Continue</button><input type="file">`);
      return;
    }
    response.end(`<!doctype html><h1>Next</h1>`);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), "bounded-real-browser-"));
  const brokers = [];
  async function start(name) {
    const run = join(root, `${name}-run`);
    const profile = join(root, `${name}-profile`);
    const cap = join(root, `${name}-cap.json`);
    await mkdir(run);
    await mkdir(profile);
    await writeFile(cap, `${JSON.stringify(freshCapState(limits, new Date(Date.now() + 20_000).toISOString(), name))}\n`);
    const broker = new BrowserBroker({ run_id: name, runtime_mode: "source-blind-bounded-onboarding-v1", run_directory: run, startup_log_path: join(root, `${name}-startup.jsonl`), profile_directory: profile, cap_state_path: cap, operation_deadline_ms: Date.now() + 20_000, initial_url: `${localOrigin}/`, allowed_request_origins: [localOrigin], allowed_navigation_origins: [localOrigin], suppressed_request_origins: [] });
    await broker.start();
    brokers.push(broker);
    return { broker, cap };
  }
  try {
    const scope = await start("scope");
    assert.equal((await scope.broker.execute({ method: "navigate", action_class: "Observe", url: `${localOrigin}/` })).ok, true);
    scope.broker.boundedScopeHref = `${localOrigin}/`;
    scope.broker.boundedScopeRawUrlSha256 = sha256Text(`${localOrigin}/`);
    const permission = await scope.broker.cdp.send("Runtime.evaluate", {
      expression: "navigator.permissions.query({name:'geolocation'}).then(()=> 'allowed',()=> 'blocked')",
      awaitPromise: true,
      returnByValue: true
    }, scope.broker.pageSessionId);
    assert.equal(permission.result?.value, "blocked", JSON.stringify(permission));
    assert.equal((await scope.broker.execute({ method: "observe", action_class: "Observe" })).ok, true);
    const [ref] = [...scope.broker.refs.entries()].find(([, control]) => control.role === "button" && control.name === "Continue") ?? [];
    assert(ref);
    const issued = await scope.broker.issueActionToken({ action_class: "Bounded own-account bound-route progress", ref, bounded_progress_mutation_requests: 1 });
    const clicked = await scope.broker.execute({ method: "click", action_class: "Bounded own-account bound-route progress", ref, bounded_progress_mutation_requests: 1, authorization_token: issued.authorization_token });
    assert.equal(clicked.ok, true, JSON.stringify(clicked));
    // A same-origin route change now rebinds the bound scope to the new route instead of
    // ending the run -- exploration should keep going into the rest of the origin.
    assert.equal(clicked.event.observed_outcome, "clicked");
    assert.deepEqual(clicked.event.effect_evidence, {
      supervisor_authorized: true,
      authorization_consumed_once: true,
      mutation_window: "input-dispatch-through-after-evidence",
      mutation_association: "temporal-only",
      same_origin_mutation_requests_dispatched: 1,
      outside_window_mutation_policy: "block-and-abort"
    });
    assert.equal(scope.broker.boundedScopeHref, `${localOrigin}/next`);
    assert.equal((await scope.broker.execute({ method: "observe", action_class: "Observe" })).ok, true);

    const chooser = await start("chooser");
    assert.equal((await chooser.broker.execute({ method: "navigate", action_class: "Observe", url: `${localOrigin}/` })).ok, true);
    await chooser.broker.cdp.send("Runtime.evaluate", { expression: "document.querySelector('input[type=file]').click()", userGesture: true }, chooser.broker.pageSessionId);
    let state = JSON.parse(await readFile(chooser.cap, "utf8"));
    for (let index = 0; index < 80 && !state.abort; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      state = JSON.parse(await readFile(chooser.cap, "utf8"));
    }
    assert.equal(state.abort?.code, "file_chooser_forbidden");
    assert.equal(requests.includes("POST /api/progress"), true);
  } finally {
    await Promise.all(brokers.map((broker) => broker.shutdown().catch(() => {})));
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

// --- Private auth-bootstrap admission: a tiny, owner-declared allowance for a
// same-origin mutation the target's own client fires automatically before any
// session is bound (e.g. an onboarding surface's scripted first message). ---

async function privateAuthFixture(admissions = []) {
  const root = await mkdtemp(join(tmpdir(), "auth-bootstrap-"));
  const cap = join(root, "cap.json");
  await writeFile(cap, `${JSON.stringify(freshCapState(limits, new Date(Date.now() + 60_000).toISOString(), "bootstrap"))}\n`);
  const broker = new BrowserBroker({
    runtime_mode: "source-blind-bounded-onboarding-v1",
    run_directory: root,
    profile_directory: root,
    cap_state_path: cap,
    initial_url: `${origin}/`,
    allowed_request_origins: [origin],
    allowed_navigation_origins: [origin],
    clerk_auth: {},
    auth_bootstrap_admissions: admissions
  });
  broker.cdp = { send: async () => ({}) };
  return { root, cap, broker };
}

const bootstrapUrl = `${origin}/api/coach/onboarding-coach/messages/stream`;
const bootstrapAdmission = { id: "onboarding-coach-start", method: "POST", url: bootstrapUrl, maximum_count: 1, why: "Auto-fired scripted start message before the session is bound" };

function bootstrapRequest(url = bootstrapUrl) {
  return { sessionId: "page", params: { requestId: `request-${Math.random()}`, request: { url, method: "POST" }, resourceType: "XHR" } };
}

test("private auth bootstrap admits a declared request once and the run continues", async () => {
  const value = await privateAuthFixture([bootstrapAdmission]);
  try {
    assert.equal(value.broker.boundedPrivateAuthStart, true);
    await value.broker.handlePausedRequest(bootstrapRequest(), value.broker.boundedRequestReceipt());
    const cap = JSON.parse(await readFile(value.cap, "utf8"));
    assert.equal(cap.abort, null);
    assert.deepEqual(cap.browser.auth_bootstrap_admissions, { "onboarding-coach-start": 1 });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("private auth bootstrap aborts an undeclared same-origin mutation", async () => {
  const value = await privateAuthFixture([bootstrapAdmission]);
  try {
    await value.broker.handlePausedRequest(bootstrapRequest(`${origin}/api/progress`), value.broker.boundedRequestReceipt());
    assert.equal(JSON.parse(await readFile(value.cap, "utf8")).abort.code, "unknown_mutation_request");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
