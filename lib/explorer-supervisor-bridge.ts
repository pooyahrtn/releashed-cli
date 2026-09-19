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

type Refusal = {
  ok: false;
  refusal: { code: string; message: string };
};

type OutcomeReply = {
  ok: true;
  outcome: {
    outcome_id: string;
    status: string;
    summary: string;
    protocol?: string;
  };
};

type BridgeReply = Refusal | OutcomeReply;

type ObservationReply = {
  ok: true;
  observation: { observation_id: string; url: string; accessibility: string };
};

export type ExplorerBridgeAction =
  | { type: "click"; ref: string }
  | { type: "type"; ref: string; text: string; replace: boolean }
  | { type: "scroll"; direction: "up" | "down" };

type CurrentObservation = {
  observation_id: string;
  url: string;
  accessibility: string;
  explorer_fingerprint: string;
  browser_observation_hash: string;
};

function refusal(code: string, message: string): Refusal {
  return { ok: false, refusal: { code, message } };
}

function rejected(outcomeId: string, summary: string): OutcomeReply {
  return { ok: true, outcome: { outcome_id: outcomeId, status: "rejected", summary } };
}

function unknown(outcomeId: string): OutcomeReply {
  return {
    ok: true,
    outcome: {
      outcome_id: outcomeId,
      status: "unknown",
      summary: "The action may have changed the product, but its outcome could not be proven."
    }
  };
}

function completed(outcomeId: string, protocol: string | null = null): OutcomeReply {
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

function exactKeys(value: unknown, keys: string[]): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n")
  );
}

function fingerprint(url: string, accessibility: string): string {
  return createHash("sha256").update(JSON.stringify({ url, accessibility })).digest("hex");
}

function refusalCode(response: unknown): unknown {
  return (
    (response as { refusal?: { code?: unknown } } | null | undefined)?.refusal
      ?.code
  );
}

function browserFailure(response: unknown): Refusal {
  const code = refusalCode(response);
  if (typeof code === "string" && CAP_OR_DEADLINE.test(code)) return refusal(code, "The run reached a fixed safety limit.");
  if (code === "run_aborted") return refusal("browser_broker_fatal", "The supervised browser run is no longer usable.");
  return refusal("browser_broker_fatal", "The supervised browser failed closed.");
}

function isUnknownResult(response: unknown): boolean {
  const record = response as
    | { event?: { transition_kind?: unknown }; refusal?: { code?: unknown } }
    | null
    | undefined;
  return record?.event?.transition_kind === "unknown-terminal" || record?.refusal?.code === "unknown-terminal";
}

function hasCompletedEvidence(response: unknown, expectedBeforeHash: string): boolean {
  const event = (response as Record<string, unknown> | null | undefined)?.event as
    | Record<string, unknown>
    | undefined;
  return (
    !!event &&
    ID.test(String(event.event_id ?? "")) &&
    ["solid", "none"].includes(event.transition_kind as string) &&
    (event.before as Record<string, unknown> | undefined)?.observation_hash === expectedBeforeHash &&
    OBSERVATION_HASH.test(String((event.after as Record<string, unknown> | undefined)?.observation_hash ?? ""))
  );
}

function boundedAccessibility(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (Buffer.byteLength(value, "utf8") <= MAX_ACCESSIBILITY_BYTES) return value;
  const lines: string[] = [];
  let bytes = 0;
  for (const line of value.split("\n")) {
    const nextBytes = Buffer.byteLength(`${line}${lines.length ? "\n" : ""}`, "utf8");
    if (bytes + nextBytes > MAX_ACCESSIBILITY_BYTES) break;
    lines.push(line);
    bytes += nextBytes;
  }
  return lines.join("\n").trimEnd() || null;
}

function validateExplorerAction(action: unknown): ExplorerBridgeAction | null {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  const candidate = action as Record<string, unknown>;
  if (candidate.type === "click" && exactKeys(candidate, ["type", "ref"]) && /^e\d+$/.test(String(candidate.ref ?? ""))) return action as ExplorerBridgeAction;
  if (
    candidate.type === "type" &&
    exactKeys(candidate, ["type", "ref", "text", "replace"]) &&
    /^e\d+$/.test(String(candidate.ref ?? "")) &&
    typeof candidate.replace === "boolean" &&
    typeof candidate.text === "string" &&
    candidate.text.trim() &&
    Buffer.byteLength(candidate.text, "utf8") <= 160 &&
    !/[\u0000-\u001f\u007f]|https?:\/\/|\b[^\s@]+@[^\s@]+\.[^\s@]+\b|Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{10,}/i.test(candidate.text)
  ) return action as ExplorerBridgeAction;
  if (candidate.type === "scroll" && exactKeys(candidate, ["type", "direction"]) && ["up", "down"].includes(candidate.direction as string)) return action as ExplorerBridgeAction;
  return null;
}

function validateClassification(classified: unknown): Record<string, unknown> | null {
  const body = classified as Record<string, unknown> | null | undefined;
  const value = body?.classification as Record<string, unknown> | undefined;
  if (
    body?.ok === true &&
    !!value &&
    exactKeys(value, ["action_class", "bounded_progress_mutation_requests"]) &&
    value.action_class === "Bounded own-account bound-route progress" &&
    value.bounded_progress_mutation_requests === 1
  ) return value;
  if (
    body?.ok !== true ||
    !value ||
    !exactKeys(value, ["action_class", "effect_id", "effect_class_id", "expected_request"]) ||
    !["Reversible own-account", "Listed own-account progress"].includes(value.action_class as string) ||
    typeof value.effect_id !== "string" ||
    typeof value.effect_class_id !== "string"
  ) return null;
  if (value.action_class === "Reversible own-account" && value.expected_request !== null) return null;
  const expected = value.expected_request as Record<string, unknown> | null | undefined;
  if (
    value.action_class === "Listed own-account progress" &&
    (!exactKeys(expected, ["method", "url"]) || !["POST", "PUT", "PATCH", "DELETE"].includes(expected?.method as string))
  ) return null;
  return value;
}

/**
 * Pure protocol adapter. The caller owns browser transport, safety classification,
 * authentication, persistence, and process lifetime.
 */
export function createExplorerSupervisorBridge({
  callBrowser,
  classifyControl,
  mode = "source-blind-target-isolation",
}: {
  callBrowser: (payload: Record<string, unknown>, scope: string) => Promise<unknown>;
  classifyControl: (input: Record<string, unknown>) => Promise<unknown>;
  mode?: string;
}): (payload: Record<string, unknown>) => Promise<BridgeReply | ObservationReply> {
  if (typeof callBrowser !== "function" || typeof classifyControl !== "function") {
    throw new TypeError("The explorer bridge requires browser dispatch and private control classification");
  }

  let current: CurrentObservation | null = null;
  const boundedOnboarding = mode === "source-blind-bounded-onboarding-v1";
  let outcomeSequence = 0;
  const nextOutcomeId = (): string => `outcome-${String(++outcomeSequence).padStart(4, "0")}`;

  async function browser(payload: Record<string, unknown>): Promise<unknown> {
    return callBrowser(payload, "supervisor");
  }

  async function observe(): Promise<Refusal | ObservationReply> {
    let response: unknown;
    try {
      response = await browser({ method: "observe", action_class: "Observe" });
    } catch {
      return refusal("browser_broker_fatal", "The supervised browser could not provide an observation.");
    }
    const body = response as Record<string, unknown> | null | undefined;
    if (!body?.ok) return browserFailure(response);
    const event = body.event as Record<string, unknown> | undefined;
    const evidence = event?.after as Record<string, unknown> | undefined;
    if (
      !event ||
      !ID.test(String(event.event_id ?? "")) ||
      event.transition_kind === "unknown-terminal" ||
      !evidence ||
      typeof evidence.url !== "string" ||
      !OBSERVATION_HASH.test(String(evidence.observation_hash ?? ""))
    ) return refusal("browser_broker_fatal", "The supervised browser returned malformed observation evidence.");

    const accessibility = boundedAccessibility(evidence.visible_state_summary);
    if (!accessibility) return refusal("browser_broker_fatal", "The supervised browser returned malformed observation evidence.");

    const observation = {
      observation_id: event.event_id as string,
      url: evidence.url,
      accessibility
    };
    current = {
      ...observation,
      explorer_fingerprint: fingerprint(observation.url, observation.accessibility),
      browser_observation_hash: evidence.observation_hash as string
    };
    return { ok: true, observation };
  }

  function currentRequest(payload: Record<string, unknown>): boolean {
    if (!current || payload.observation_id !== current.observation_id || payload.observation_fingerprint !== current.explorer_fingerprint) return false;
    return true;
  }

  async function inspect(
    ref: string,
    outcomeId: string,
  ): Promise<{ result: BridgeReply } | { control: Record<string, unknown> }> {
    let response: unknown;
    try {
      response = await browser({ method: "inspect_observed_control", ref });
    } catch {
      return { result: refusal("browser_broker_fatal", "The supervised browser could not verify the visible control.") };
    }
    const body = response as Record<string, unknown> | null | undefined;
    if (!body?.ok) {
      if (SAFE_REJECTION_CODES.has(refusalCode(response) as string)) return { result: rejected(outcomeId, "That control is not available in the current retained page.") };
      return { result: browserFailure(response) };
    }
    const control = body.control as Record<string, unknown> | undefined;
    if (
      !control ||
      control.ref !== ref ||
      control.url !== current!.url ||
      control.observation_hash !== current!.browser_observation_hash
    ) return { result: rejected(outcomeId, "The page changed before that control could be verified.") };
    return { control };
  }

  async function dispatchAction(request: Record<string, unknown>, outcomeId: string): Promise<BridgeReply> {
    let response: unknown;
    try {
      response = await browser(request);
    } catch {
      return unknown(outcomeId);
    }
    if ((response as { ok?: unknown } | null | undefined)?.ok) {
      if (!hasCompletedEvidence(response, current!.browser_observation_hash) || isUnknownResult(response)) return unknown(outcomeId);
      const event = (response as Record<string, unknown>).event as Record<string, unknown> | undefined;
      return completed(outcomeId, event?.observed_outcome === "route-scope-exit" ? "scope_complete" : null);
    }
    if (isUnknownResult(response)) return unknown(outcomeId);
    if (SAFE_REJECTION_CODES.has(refusalCode(response) as string)) return rejected(outcomeId, "The action was denied before it reached the product.");
    return browserFailure(response);
  }

  async function perform(payload: Record<string, unknown>): Promise<BridgeReply> {
    const outcomeId = nextOutcomeId();
    if (!currentRequest(payload)) return rejected(outcomeId, "The proposed action is based on an old page observation.");
    const action = validateExplorerAction(payload.action);
    if (!action) return refusal("bridge_protocol_mismatch", "The explorer action is malformed.");

    if (action.type === "scroll") {
      return dispatchAction({ method: "scroll", action_class: "Observe", observation_hash: current!.browser_observation_hash, delta_y: action.direction === "down" ? 600 : -600 }, outcomeId);
    }

    const inspected = await inspect(action.ref, outcomeId);
    if ("result" in inspected) return inspected.result;
    if (action.type === "type") {
      if (boundedOnboarding) return rejected(outcomeId, "Typing is outside the bound route action boundary.");
      if (!["textbox", "searchbox"].includes(inspected.control.role as string)) {
        return rejected(outcomeId, "That visible control does not accept synthetic text.");
      }
      return dispatchAction(
        { method: "type", action_class: "Reversible own-account", observation_hash: current!.browser_observation_hash, ref: action.ref, text: action.text, replace: action.replace, synthetic: true },
        outcomeId
      );
    }

    if (inspected.control.role === "link") {
      if (boundedOnboarding) return rejected(outcomeId, "Following links is outside the bound route action boundary.");
      return dispatchAction({ method: "click", action_class: "Observe", observation_hash: current!.browser_observation_hash, ref: action.ref }, outcomeId);
    }

    let classified: unknown;
    try {
      classified = await classifyControl({
        requested: { ref: action.ref, observation_hash: current!.browser_observation_hash },
        observed: inspected.control
      });
    } catch {
      return refusal("browser_broker_fatal", "Private action classification failed closed.");
    }
    const classifiedBody = classified as Record<string, unknown> | null | undefined;
    if (!classifiedBody?.ok) {
      if (SAFE_REJECTION_CODES.has(refusalCode(classified) as string)) return rejected(outcomeId, "That visible control is outside the approved action boundary.");
      return refusal("browser_broker_fatal", "Private action classification failed closed.");
    }
    const classification = validateClassification(classified);
    if (!classification) return refusal("browser_broker_fatal", "Private action classification was malformed.");

    let issued: unknown;
    try {
      issued = await browser({ method: "issue_action_token", ref: action.ref, ...classification });
    } catch {
      return refusal("browser_broker_fatal", "The supervisor could not authorize the action.");
    }
    const issuedBody = issued as Record<string, unknown> | null | undefined;
    if (!issuedBody?.ok) {
      if (SAFE_REJECTION_CODES.has(refusalCode(issued) as string)) return rejected(outcomeId, "The action was denied before it reached the product.");
      return browserFailure(issued);
    }
    if (typeof issuedBody.authorization_token !== "string" || !issuedBody.authorization_token) {
      return refusal("browser_broker_fatal", "The supervisor returned malformed action authorization.");
    }
    return dispatchAction(
      { method: "click", ref: action.ref, authorization_token: issuedBody.authorization_token, ...classification },
      outcomeId
    );
  }

  return async function handleExplorerSupervisorRequest(payload: Record<string, unknown>): Promise<BridgeReply | ObservationReply> {
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
