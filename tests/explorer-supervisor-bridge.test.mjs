import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateObservation } from "../lib/explorer-protocol.mjs";
import { createExplorerSupervisorBridge } from "../lib/explorer-supervisor-bridge.mjs";

const URL = "https://app.example.test/learn";
const ACCESSIBILITY = "e1 [button] Continue\ne2 [link] Help\ne3 [textbox] Answer";
const BROWSER_HASH = "a".repeat(64);

function observationEvent(overrides = {}) {
  const { after: afterOverrides = {}, ...eventOverrides } = overrides;
  return {
    ok: true,
    event: {
      event_id: "event-0001",
      transition_kind: "none",
      after: {
        url: URL,
        visible_state_summary: ACCESSIBILITY,
        observation_hash: BROWSER_HASH,
        ...afterOverrides
      },
      ...eventOverrides
    }
  };
}

function actionEvent(overrides = {}) {
  return {
    ok: true,
    event: {
      event_id: "event-0002",
      transition_kind: "solid",
      before: { observation_hash: BROWSER_HASH },
      after: { observation_hash: "b".repeat(64) },
      ...overrides
    }
  };
}

function reversibleClassification() {
  return {
    ok: true,
    classification: {
      action_class: "Reversible own-account",
      effect_id: "toggle-preference",
      effect_class_id: "reversible-own-account",
      expected_request: null
    }
  };
}

function listedClassification() {
  return {
    ok: true,
    classification: {
      action_class: "Listed own-account progress",
      effect_id: "complete-step",
      effect_class_id: "own-account-completion-no-external-meter",
      expected_request: { method: "POST", url: "https://app.example.test/api/progress" }
    }
  };
}

function harness({ responses = [], classify = reversibleClassification, mode } = {}) {
  const calls = [];
  const classifications = [];
  const queue = [...responses];
  const bridge = createExplorerSupervisorBridge({
    callBrowser: async (payload, caller) => {
      calls.push({ payload, caller });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next(payload);
      return next;
    },
    mode,
    classifyControl: async (request) => {
      classifications.push(request);
      return typeof classify === "function" ? classify(request) : classify;
    }
  });
  return { bridge, calls, classifications, queue };
}

function fingerprint() {
  return createHash("sha256").update(JSON.stringify({ url: URL, accessibility: ACCESSIBILITY })).digest("hex");
}

function perform(action, overrides = {}) {
  return {
    method: "perform_action",
    observation_id: "event-0001",
    observation_fingerprint: fingerprint(),
    action,
    ...overrides
  };
}

function inspected(role = "button", overrides = {}) {
  return {
    ok: true,
    control: {
      url: URL,
      observation_hash: BROWSER_HASH,
      ref: role === "link" ? "e2" : role === "textbox" ? "e3" : "e1",
      role,
      name: role === "link" ? "Help" : role === "textbox" ? "Answer" : "Continue",
      visible_state_summary: ACCESSIBILITY,
      ...overrides
    }
  };
}

test("observe maps retained browser evidence and binds the current explorer fingerprint", async () => {
  const { bridge, calls } = harness({ responses: [observationEvent()] });
  assert.deepEqual(await bridge({ method: "observe" }), {
    ok: true,
    observation: { observation_id: "event-0001", url: URL, accessibility: ACCESSIBILITY }
  });
  assert.deepEqual(calls, [{ caller: "supervisor", payload: { method: "observe", action_class: "Observe" } }]);
});

test("observe keeps complete accessibility lines within the explorer's 10KB boundary", async () => {
  const oversized = Array.from({ length: 200 }, (_, index) => `e${index + 1} [button] ${"visible control ".repeat(12)}${index}`).join("\n");
  assert.ok(Buffer.byteLength(oversized, "utf8") > 10 * 1024);
  const { bridge } = harness({ responses: [observationEvent({ after: { visible_state_summary: oversized } })] });
  const result = await bridge({ method: "observe" });
  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(result.observation.accessibility, "utf8") <= 10 * 1024);
  assert.equal(oversized.startsWith(result.observation.accessibility), true);
  assert.equal(result.observation.accessibility.endsWith("\n"), false);
  assert.doesNotThrow(() => validateObservation(result));
});

test("malformed or unavailable observation evidence fails terminally", async (t) => {
  const cases = [
    ["transport failure", new Error("private transport detail"), "browser_broker_fatal"],
    ["malformed evidence", { ok: true, event: { event_id: "event-0001", transition_kind: "none", after: null } }, "browser_broker_fatal"],
    ["unknown evidence", observationEvent({ transition_kind: "unknown-terminal" }), "browser_broker_fatal"],
    ["cap", { ok: false, refusal: { code: "browser_operation_cap", message: "private" } }, "browser_operation_cap"],
    ["deadline", { ok: false, refusal: { code: "working_day_deadline", message: "private" } }, "working_day_deadline"],
    ["broker refusal", { ok: false, refusal: { code: "browser_broker_error", message: "private" } }, "browser_broker_fatal"]
  ];
  for (const [name, response, code] of cases) {
    await t.test(name, async () => {
      const { bridge } = harness({ responses: [response] });
      const result = await bridge({ method: "observe" });
      assert.equal(result.ok, false);
      assert.equal(result.refusal.code, code);
      assert.doesNotMatch(JSON.stringify(result), /private/);
    });
  }
});

test("stale explorer observation is safely rejected without touching the browser", async () => {
  const { bridge, calls } = harness({ responses: [observationEvent()] });
  await bridge({ method: "observe" });
  const result = await bridge(perform({ type: "click", ref: "e1" }, { observation_fingerprint: "b".repeat(64) }));
  assert.equal(result.outcome.status, "rejected");
  assert.equal(calls.length, 1);
});

test("a browser binding mismatch is safely rejected before classification or action", async () => {
  const { bridge, calls, classifications } = harness({ responses: [observationEvent(), inspected("button", { observation_hash: "b".repeat(64) })] });
  await bridge({ method: "observe" });
  const result = await bridge(perform({ type: "click", ref: "e1" }));
  assert.equal(result.outcome.status, "rejected");
  assert.equal(calls.length, 2);
  assert.equal(classifications.length, 0);
});

test("scroll maps to a bounded observe-class browser action", async () => {
  const { bridge, calls } = harness({ responses: [observationEvent(), actionEvent()] });
  await bridge({ method: "observe" });
  const result = await bridge(perform({ type: "scroll", direction: "up" }));
  assert.equal(result.outcome.status, "completed");
  assert.deepEqual(calls[1], { caller: "supervisor", payload: { method: "scroll", action_class: "Observe", observation_hash: BROWSER_HASH, delta_y: -600 } });
});

test("typing verifies the current visible input then dispatches only synthetic unsent text", async () => {
  const { bridge, calls, classifications } = harness({ responses: [observationEvent(), inspected("textbox"), actionEvent()] });
  await bridge({ method: "observe" });
  const result = await bridge(perform({ type: "type", ref: "e3", text: "voorbeeld", replace: true }));
  assert.equal(result.outcome.status, "completed");
  assert.deepEqual(calls[2], {
    caller: "supervisor",
    payload: { method: "type", action_class: "Reversible own-account", observation_hash: BROWSER_HASH, ref: "e3", text: "voorbeeld", replace: true, synthetic: true }
  });
  assert.equal(classifications.length, 0);
});

test("typing a non-input is safely rejected before browser dispatch", async () => {
  const { bridge, calls } = harness({ responses: [observationEvent(), inspected("button")] });
  await bridge({ method: "observe" });
  const result = await bridge(perform({ type: "type", ref: "e1", text: "voorbeeld", replace: true }));
  assert.equal(result.outcome.status, "rejected");
  assert.equal(calls.length, 2);
});

test("an observed link uses the browser's constrained Observe click without private classification", async () => {
  const { bridge, calls, classifications } = harness({ responses: [observationEvent(), inspected("link"), actionEvent()] });
  await bridge({ method: "observe" });
  const result = await bridge(perform({ type: "click", ref: "e2" }));
  assert.equal(result.outcome.status, "completed");
  assert.deepEqual(calls[2], { caller: "supervisor", payload: { method: "click", action_class: "Observe", observation_hash: BROWSER_HASH, ref: "e2" } });
  assert.equal(classifications.length, 0);
});

test("a retained same-origin scope exit is reported as a protocol halt, not another action", async () => {
  const { bridge } = harness({ responses: [
    observationEvent(),
    inspected(),
    { ok: true, authorization_token: "one-use-token" },
    actionEvent({ observed_outcome: "route-scope-exit" })
  ], classify: () => ({ ok: true, classification: { action_class: "Bounded own-account bound-route progress", bounded_progress_mutation_requests: 1 } }) });
  await bridge({ method: "observe" });
  const result = await bridge(perform({ type: "click", ref: "e1" }));
  assert.deepEqual(result.outcome, {
    outcome_id: "outcome-0001",
    status: "completed",
    summary: "The observed action left the bound route.",
    protocol: "scope_complete"
  });
  assert.doesNotMatch(JSON.stringify(result), /onboarding/i);
});

test("bounded mode rejects typing and link following before browser dispatch", async () => {
  const typing = harness({ responses: [observationEvent(), inspected("textbox")], mode: "source-blind-bounded-onboarding-v1" });
  await typing.bridge({ method: "observe" });
  assert.equal((await typing.bridge(perform({ type: "type", ref: "e3", text: "voorbeeld", replace: true }))).outcome.status, "rejected");
  assert.equal(typing.calls.length, 2);
  const link = harness({ responses: [observationEvent(), inspected("link")], mode: "source-blind-bounded-onboarding-v1" });
  await link.bridge({ method: "observe" });
  assert.equal((await link.bridge(perform({ type: "click", ref: "e2" }))).outcome.status, "rejected");
  assert.equal(link.calls.length, 2);
});

test("a ref reordered after inspection is rejected by the browser's retained-observation binding before dispatch", async () => {
  const changedHash = "c".repeat(64);
  const { bridge, calls } = harness({
    responses: [
      observationEvent(),
      inspected("link"),
      (request) => {
        assert.equal(request.observation_hash, BROWSER_HASH);
        return {
          ok: false,
          event: {
            event_id: "event-0002",
            transition_kind: "none",
            before: { observation_hash: changedHash },
            after: { observation_hash: changedHash }
          },
          refusal: { code: "control_observation_stale", message: "private ref now points elsewhere" }
        };
      }
    ]
  });
  await bridge({ method: "observe" });
  const result = await bridge(perform({ type: "click", ref: "e2" }));
  assert.equal(result.outcome.status, "rejected");
  assert.equal(calls.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /private|elsewhere/);
});

for (const [label, classification] of [["reversible", reversibleClassification()], ["listed one-way", listedClassification()]]) {
  test(`a ${label} click is observation-bound, privately classified, tokenized, and dispatched`, async () => {
    const { bridge, calls, classifications } = harness({ responses: [observationEvent(), inspected(), { ok: true, authorization_token: "one-use-token" }, actionEvent()], classify: classification });
    await bridge({ method: "observe" });
    const result = await bridge(perform({ type: "click", ref: "e1" }));
    assert.equal(result.outcome.status, "completed");
    assert.deepEqual(classifications, [{ requested: { ref: "e1", observation_hash: BROWSER_HASH }, observed: inspected().control }]);
    assert.deepEqual(calls[2].payload, { method: "issue_action_token", ref: "e1", ...classification.classification });
    assert.deepEqual(calls[3].payload, { method: "click", ref: "e1", authorization_token: "one-use-token", ...classification.classification });
  });
}

test("known pre-dispatch denials are recoverable rejections and never dispatch an action", async (t) => {
  const cases = [
    ["missing observed control", [{ ok: false, refusal: { code: "observed_control_missing", message: "private" } }], reversibleClassification, 2],
    ["unknown classified control", [inspected()], () => ({ ok: false, refusal: { code: "unknown_visible_control", message: "private" } }), 2],
    ["stale token binding", [inspected(), { ok: false, refusal: { code: "token_binding_missing", message: "private" } }], reversibleClassification, 3]
  ];
  for (const [name, afterObserve, classify, callCount] of cases) {
    await t.test(name, async () => {
      const { bridge, calls } = harness({ responses: [observationEvent(), ...afterObserve], classify });
      await bridge({ method: "observe" });
      const result = await bridge(perform({ type: "click", ref: "e1" }));
      assert.equal(result.outcome.status, "rejected");
      assert.equal(calls.length, callCount);
      assert.doesNotMatch(JSON.stringify(result), /private/);
    });
  }
});

test("unknown action outcomes are terminal unknown, including ambiguous transport loss", async (t) => {
  const cases = [
    ["broker retained unknown evidence", { ok: false, event: { transition_kind: "unknown-terminal" }, refusal: { code: "unknown-terminal", message: "private" } }],
    ["transport disappeared after dispatch", new Error("private transport detail")],
    ["success without retained event", { ok: true }],
    ["completed event began from a different observation", actionEvent({ before: { observation_hash: "c".repeat(64) } })]
  ];
  for (const [name, actionResponse] of cases) {
    await t.test(name, async () => {
      const { bridge } = harness({ responses: [observationEvent(), actionResponse] });
      await bridge({ method: "observe" });
      const result = await bridge(perform({ type: "scroll", direction: "down" }));
      assert.equal(result.ok, true);
      assert.equal(result.outcome.status, "unknown");
      assert.doesNotMatch(JSON.stringify(result), /private/);
    });
  }
});

test("cap, deadline, run abort, and broker failures are terminal rather than recoverable", async (t) => {
  const cases = [
    ["one-way cap", "one_way_action_cap", "one_way_action_cap"],
    ["deadline", "working_day_deadline", "working_day_deadline"],
    ["prior abort", "run_aborted", "browser_broker_fatal"],
    ["fatal broker", "browser_broker_error", "browser_broker_fatal"]
  ];
  for (const [name, browserCode, expectedCode] of cases) {
    await t.test(name, async () => {
      const { bridge } = harness({ responses: [observationEvent(), { ok: false, refusal: { code: browserCode, message: "private" } }] });
      await bridge({ method: "observe" });
      const result = await bridge(perform({ type: "scroll", direction: "down" }));
      assert.equal(result.ok, false);
      assert.equal(result.refusal.code, expectedCode);
      assert.doesNotMatch(JSON.stringify(result), /private/);
    });
  }
});

test("authorization and classification failures before dispatch fail closed", async (t) => {
  const cases = [
    ["classification throws", [inspected()], () => { throw new Error("private"); }],
    ["classification malformed", [inspected()], () => ({ ok: true, classification: {} })],
    ["authorization transport throws", [inspected(), new Error("private")], reversibleClassification],
    ["authorization malformed", [inspected(), { ok: true }], reversibleClassification],
    ["authorization policy refusal", [inspected(), { ok: false, refusal: { code: "unproven_reversible_effect", message: "private" } }], reversibleClassification]
  ];
  for (const [name, afterObserve, classify] of cases) {
    await t.test(name, async () => {
      const { bridge } = harness({ responses: [observationEvent(), ...afterObserve], classify });
      await bridge({ method: "observe" });
      const result = await bridge(perform({ type: "click", ref: "e1" }));
      assert.equal(result.ok, false);
      assert.equal(result.refusal.code, "browser_broker_fatal");
      assert.doesNotMatch(JSON.stringify(result), /private/);
    });
  }
});

test("malformed explorer requests and unsafe typed content never reach the browser", async (t) => {
  const { bridge, calls } = harness({ responses: [observationEvent()] });
  await bridge({ method: "observe" });
  const cases = [
    { method: "navigate", url: "https://elsewhere.test" },
    { method: "observe", extra: true },
    perform({ type: "type", ref: "e3", text: "person@example.test", replace: true }),
    perform({ type: "click", ref: "e999", extra: true })
  ];
  for (const value of cases) {
    await t.test(JSON.stringify(value.action ?? value), async () => {
      const result = await bridge(value);
      assert.equal(result.ok, false);
      assert.equal(result.refusal.code, "bridge_protocol_mismatch");
    });
  }
  assert.equal(calls.length, 1);
});
