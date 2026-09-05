import { createHash } from "node:crypto";

const SAFE_REJECTION_CODES = new Set([
  "observed_control_missing",
  "control_request_invalid",
  "control_observation_stale",
  "unknown_visible_control",
  "ambiguous_visible_control",
  "bounded_forbidden_semantic",
  "token_binding_missing",
  "action_token_invalid"
]);

const CAP_OR_DEADLINE = /(?:^|_)(?:cap|deadline)(?:_|$)/;
const OBSERVATION_HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const MAX_ACCESSIBILITY_BYTES = 10 * 1024;

function refusal(code, message) {
  return { ok: false, refusal: { code, message } };
}

function rejected(outcomeId, summary) {
  return { ok: true, outcome: { outcome_id: outcomeId, status: "rejected", summary } };
}

function unknown(outcomeId) {
  return {
    ok: true,
    outcome: {
      outcome_id: outcomeId,
      status: "unknown",
      summary: "The action may have changed the product, but its outcome could not be proven."
    }
  };
}

function completed(outcomeId, protocol = null) {
  return {
    ok: true,
    outcome: {
      outcome_id: outcomeId,
      status: "completed",
      summary: protocol === "scope_complete" ? "The observed action left the bound route." : "The action completed with retained before-and-after browser evidence.",
      ...(protocol ? { protocol } : {})
    }
  };
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function fingerprint(url, accessibility) {
  return createHash("sha256").update(JSON.stringify({ url, accessibility })).digest("hex");
}

function browserFailure(response) {
  const code = response?.refusal?.code;
  if (typeof code === "string" && CAP_OR_DEADLINE.test(code)) return refusal(code, "The run reached a fixed safety limit.");
  if (code === "run_aborted") return refusal("browser_broker_fatal", "The supervised browser run is no longer usable.");
  return refusal("browser_broker_fatal", "The supervised browser failed closed.");
}

function isUnknownResult(response) {
  return response?.event?.transition_kind === "unknown-terminal" || response?.refusal?.code === "unknown-terminal";
}

function hasCompletedEvidence(response, expectedBeforeHash) {
  const event = response?.event;
  return (
    event &&
    ID.test(event.event_id ?? "") &&
    ["solid", "none"].includes(event.transition_kind) &&
    event.before?.observation_hash === expectedBeforeHash &&
    OBSERVATION_HASH.test(event.after?.observation_hash ?? "")
  );
}

function boundedAccessibility(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (Buffer.byteLength(value, "utf8") <= MAX_ACCESSIBILITY_BYTES) return value;
  const lines = [];
  let bytes = 0;
  for (const line of value.split("\n")) {
    const nextBytes = Buffer.byteLength(`${line}${lines.length ? "\n" : ""}`, "utf8");
    if (bytes + nextBytes > MAX_ACCESSIBILITY_BYTES) break;
    lines.push(line);
    bytes += nextBytes;
  }
  return lines.join("\n").trimEnd() || null;
}

function validateExplorerAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  if (action.type === "click" && exactKeys(action, ["type", "ref"]) && /^e\d+$/.test(action.ref ?? "")) return action;
  if (
    action.type === "type" &&
    exactKeys(action, ["type", "ref", "text", "replace"]) &&
    /^e\d+$/.test(action.ref ?? "") &&
    typeof action.replace === "boolean" &&
    typeof action.text === "string" &&
    action.text.trim() &&
    Buffer.byteLength(action.text, "utf8") <= 160 &&
    !/[\u0000-\u001f\u007f]|https?:\/\/|\b[^\s@]+@[^\s@]+\.[^\s@]+\b|Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{10,}/i.test(action.text)
  ) return action;
  if (action.type === "scroll" && exactKeys(action, ["type", "direction"]) && ["up", "down"].includes(action.direction)) return action;
  return null;
}

function validateClassification(classified) {
  const value = classified?.classification;
  if (
    classified?.ok === true &&
    exactKeys(value, ["action_class", "bounded_progress_mutation_requests"]) &&
    value.action_class === "Bounded own-account bound-route progress" &&
    value.bounded_progress_mutation_requests === 1
  ) return value;
  if (
    classified?.ok !== true ||
    !exactKeys(value, ["action_class", "effect_id", "effect_class_id", "expected_request"]) ||
    !["Reversible own-account", "Listed own-account progress"].includes(value.action_class) ||
    typeof value.effect_id !== "string" ||
    typeof value.effect_class_id !== "string"
  ) return null;
  if (value.action_class === "Reversible own-account" && value.expected_request !== null) return null;
  if (
    value.action_class === "Listed own-account progress" &&
    (!exactKeys(value.expected_request, ["method", "url"]) || !["POST", "PUT", "PATCH", "DELETE"].includes(value.expected_request.method))
  ) return null;
  return value;
}

/**
 * Pure protocol adapter. The caller owns browser transport, safety classification,
 * authentication, persistence, and process lifetime.
 */
export function createExplorerSupervisorBridge({ callBrowser, classifyControl, mode = "source-blind-target-isolation" }) {
  if (typeof callBrowser !== "function" || typeof classifyControl !== "function") {
    throw new TypeError("The explorer bridge requires browser dispatch and private control classification");
  }

  let current = null;
  const boundedOnboarding = mode === "source-blind-bounded-onboarding-v1";
  let outcomeSequence = 0;
  const nextOutcomeId = () => `outcome-${String(++outcomeSequence).padStart(4, "0")}`;

  async function browser(payload) {
    return callBrowser(payload, "supervisor");
  }

  async function observe() {
    let response;
    try {
      response = await browser({ method: "observe", action_class: "Observe" });
    } catch {
      return refusal("browser_broker_fatal", "The supervised browser could not provide an observation.");
    }
    if (!response?.ok) return browserFailure(response);
    const event = response.event;
    const evidence = event?.after;
    if (
      !event ||
      !ID.test(event.event_id ?? "") ||
      event.transition_kind === "unknown-terminal" ||
      !evidence ||
      typeof evidence.url !== "string" ||
      !OBSERVATION_HASH.test(evidence.observation_hash ?? "")
    ) return refusal("browser_broker_fatal", "The supervised browser returned malformed observation evidence.");

    const accessibility = boundedAccessibility(evidence.visible_state_summary);
    if (!accessibility) return refusal("browser_broker_fatal", "The supervised browser returned malformed observation evidence.");

    const observation = {
      observation_id: event.event_id,
      url: evidence.url,
      accessibility
    };
    current = {
      ...observation,
      explorer_fingerprint: fingerprint(observation.url, observation.accessibility),
      browser_observation_hash: evidence.observation_hash
    };
    return { ok: true, observation };
  }

  function currentRequest(payload) {
    if (!current || payload.observation_id !== current.observation_id || payload.observation_fingerprint !== current.explorer_fingerprint) return false;
    return true;
  }

  async function inspect(ref, outcomeId) {
    let response;
    try {
      response = await browser({ method: "inspect_observed_control", ref });
    } catch {
      return { result: refusal("browser_broker_fatal", "The supervised browser could not verify the visible control.") };
    }
    if (!response?.ok) {
      if (SAFE_REJECTION_CODES.has(response?.refusal?.code)) return { result: rejected(outcomeId, "That control is not available in the current retained page.") };
      return { result: browserFailure(response) };
    }
    const control = response.control;
    if (
      !control ||
      control.ref !== ref ||
      control.url !== current.url ||
      control.observation_hash !== current.browser_observation_hash
    ) return { result: rejected(outcomeId, "The page changed before that control could be verified.") };
    return { control };
  }

  async function dispatchAction(request, outcomeId) {
    let response;
    try {
      response = await browser(request);
    } catch {
      return unknown(outcomeId);
    }
    if (response?.ok) {
      if (!hasCompletedEvidence(response, current.browser_observation_hash) || isUnknownResult(response)) return unknown(outcomeId);
      return completed(outcomeId, response.event?.observed_outcome === "route-scope-exit" ? "scope_complete" : null);
    }
    if (isUnknownResult(response)) return unknown(outcomeId);
    if (SAFE_REJECTION_CODES.has(response?.refusal?.code)) return rejected(outcomeId, "The action was denied before it reached the product.");
    return browserFailure(response);
  }

  async function perform(payload) {
    const outcomeId = nextOutcomeId();
    if (!currentRequest(payload)) return rejected(outcomeId, "The proposed action is based on an old page observation.");
    const action = validateExplorerAction(payload.action);
    if (!action) return refusal("bridge_protocol_mismatch", "The explorer action is malformed.");

    if (action.type === "scroll") {
      return dispatchAction({ method: "scroll", action_class: "Observe", observation_hash: current.browser_observation_hash, delta_y: action.direction === "down" ? 600 : -600 }, outcomeId);
    }

    const inspected = await inspect(action.ref, outcomeId);
    if (inspected.result) return inspected.result;
    if (action.type === "type") {
      if (boundedOnboarding) return rejected(outcomeId, "Typing is outside the bound route action boundary.");
      if (!["textbox", "searchbox"].includes(inspected.control.role)) {
        return rejected(outcomeId, "That visible control does not accept synthetic text.");
      }
      return dispatchAction(
        { method: "type", action_class: "Reversible own-account", observation_hash: current.browser_observation_hash, ref: action.ref, text: action.text, replace: action.replace, synthetic: true },
        outcomeId
      );
    }

    if (inspected.control.role === "link") {
      if (boundedOnboarding) return rejected(outcomeId, "Following links is outside the bound route action boundary.");
      return dispatchAction({ method: "click", action_class: "Observe", observation_hash: current.browser_observation_hash, ref: action.ref }, outcomeId);
    }

    let classified;
    try {
      classified = await classifyControl({
        requested: { ref: action.ref, observation_hash: current.browser_observation_hash },
        observed: inspected.control
      });
    } catch {
      return refusal("browser_broker_fatal", "Private action classification failed closed.");
    }
    if (!classified?.ok) {
      if (SAFE_REJECTION_CODES.has(classified?.refusal?.code)) return rejected(outcomeId, "That visible control is outside the approved action boundary.");
      return refusal("browser_broker_fatal", "Private action classification failed closed.");
    }
    const classification = validateClassification(classified);
    if (!classification) return refusal("browser_broker_fatal", "Private action classification was malformed.");

    let issued;
    try {
      issued = await browser({ method: "issue_action_token", ref: action.ref, ...classification });
    } catch {
      return refusal("browser_broker_fatal", "The supervisor could not authorize the action.");
    }
    if (!issued?.ok) {
      if (SAFE_REJECTION_CODES.has(issued?.refusal?.code)) return rejected(outcomeId, "The action was denied before it reached the product.");
      return browserFailure(issued);
    }
    if (typeof issued.authorization_token !== "string" || !issued.authorization_token) {
      return refusal("browser_broker_fatal", "The supervisor returned malformed action authorization.");
    }
    return dispatchAction(
      { method: "click", ref: action.ref, authorization_token: issued.authorization_token, ...classification },
      outcomeId
    );
  }

  return async function handleExplorerSupervisorRequest(payload) {
    if (exactKeys(payload, ["method"]) && payload.method === "observe") return observe();
    if (
      exactKeys(payload, ["method", "observation_id", "observation_fingerprint", "action"]) &&
      payload.method === "perform_action" &&
      typeof payload.observation_id === "string" &&
      typeof payload.observation_fingerprint === "string"
    ) return perform(payload);
    return refusal("bridge_protocol_mismatch", "The explorer supervisor request is malformed.");
  };
}
