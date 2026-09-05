import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendJsonl,
  combinedReservedAndActual,
  isoNow,
  mutateCapState,
  readJson,
  refusal,
  roundEur,
  writeJsonLine
} from "../lib/scaffold.mjs";
import { attachBoundedJsonLineReader } from "../lib/bounded-child.mjs";
import { preflightExplorerModelConfig, validateExplorerModelConfig } from "../lib/explorer-model-runtime.mjs";
import { approvedModelIdentity, minimumOutputGuard, providerFailureReason, safeProviderFailureMetadata, validateApprovedModelPolicy } from "../lib/model-guards.mjs";

const BROKER_ID = "spike-a-openai-model-broker-v1";
const EXPOSED_METHODS = ["ping", "request", "metrics"];
const FRAMING_OVERHEAD_TOKENS = 16;

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validClassCounts(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((count) => Number.isSafeInteger(count) && count >= 0);
}

function validateMutableExplorerCapState(state, config, policy, expected) {
  if (!policy) return;
  if (
    !expected ||
    state?.run_id !== config.run_id ||
    state.caps?.model_cost_cap_eur !== policy.model_cost_cap_eur ||
    state.caps?.combined_actual_plus_reserved_cap_eur !== policy.combined_cost_cap_eur ||
    !Number.isSafeInteger(state.model?.calls) ||
    state.model.calls < policy.initial_model_calls ||
    state.model.calls > policy.initial_model_calls + policy.maximum_calls ||
    !Number.isSafeInteger(state.model?.refused_before_dispatch) ||
    state.model.refused_before_dispatch < 0 ||
    !finiteNonnegative(state.model?.actual_eur) ||
    !finiteNonnegative(state.model?.outstanding_reservations_eur) ||
    state.model.calls !== expected.model.calls ||
    state.model.refused_before_dispatch !== expected.model.refused_before_dispatch ||
    state.model.actual_eur !== expected.model.actual_eur ||
    state.model.outstanding_reservations_eur !== expected.model.outstanding_reservations_eur ||
    !Number.isSafeInteger(state.app?.one_way_actions) ||
    state.app.one_way_actions < expected.app.one_way_actions ||
    !finiteNonnegative(state.app?.actual_eur) ||
    state.app.actual_eur < expected.app.actual_eur ||
    !finiteNonnegative(state.app?.outstanding_reservations_eur) ||
    state.app.outstanding_reservations_eur < expected.app.outstanding_reservations_eur ||
    !validClassCounts(state.app.class_counts) ||
    Object.entries(expected.app.class_counts).some(([id, count]) => !Number.isSafeInteger(state.app.class_counts[id]) || state.app.class_counts[id] < count) ||
    state.working_day_deadline !== expected.working_day_deadline ||
    (expected.abort !== null && JSON.stringify(state.abort) !== JSON.stringify(expected.abort))
  ) {
    throw new Error("Mutable explorer cap state no longer matches its frozen run and counter invariants");
  }
}

function parseArgs() {
  const values = {};
  for (let index = 2; index < process.argv.length; index += 2) values[process.argv[index]] = process.argv[index + 1];
  if (!values["--config"]) throw new Error("--config is required");
  return values;
}

function outputText(response) {
  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("");
}

export class ModelBroker {
  constructor(config, { apiKey = process.env.OPENAI_API_KEY, providerFetch = globalThis.fetch } = {}) {
    this.config = config;
    this.pricing = config.pricing;
    this.apiKey = apiKey;
    this.providerFetch = providerFetch;
    this.modelPolicy = validateApprovedModelPolicy(config.approved_model_identity_policy);
    this.minimumOutputTokens = config.minimum_output_tokens;
    this.providerUrl = config.provider_url ?? "https://api.openai.com/v1/responses";
    this.fixedRequestPolicy = config.fixed_request_policy ? validateExplorerModelConfig(config).fixed_request_policy : null;
    this.expectedState = null;
  }

  async preflight() {
    if (this.fixedRequestPolicy) {
      const { cap } = await preflightExplorerModelConfig(this.config);
      this.expectedState = {
        model: structuredClone(cap.model),
        app: structuredClone(cap.app),
        working_day_deadline: cap.working_day_deadline,
        abort: structuredClone(cap.abort)
      };
    }
  }

  async mutateState(mutation) {
    return mutateCapState(this.config.cap_state_path, (state) => {
      validateMutableExplorerCapState(state, this.config, this.fixedRequestPolicy, this.expectedState);
      const result = mutation(state);
      if (this.fixedRequestPolicy) {
        this.expectedState = {
          model: structuredClone(state.model),
          app: structuredClone(state.app),
          working_day_deadline: state.working_day_deadline,
          abort: structuredClone(state.abort)
        };
      }
      return result;
    });
  }

  reservation(maximumInputTokens, maximumOutputTokens) {
    const input = maximumInputTokens * this.pricing.input_per_million_tokens * this.pricing.cache_write_reservation_multiplier_on_uncached_input / 1_000_000;
    const output = maximumOutputTokens * this.pricing.output_per_million_tokens / 1_000_000;
    return roundEur((input + output) * this.pricing.accounting_rate.eur / this.pricing.accounting_rate.usd);
  }

  actualCost(usage) {
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    const input = usage.input_tokens ?? 0;
    const uncached = Math.max(0, input - cached);
    const conservativeUncached = uncached * this.pricing.input_per_million_tokens * this.pricing.cache_write_reservation_multiplier_on_uncached_input;
    const cachedCost = cached * this.pricing.cached_input_per_million_tokens;
    const outputCost = (usage.output_tokens ?? 0) * this.pricing.output_per_million_tokens;
    return roundEur(((conservativeUncached + cachedCost + outputCost) / 1_000_000) * this.pricing.accounting_rate.eur / this.pricing.accounting_rate.usd);
  }

  async state() {
    return readJson(this.config.cap_state_path);
  }

  async refuseBeforeDispatch(code, message, request, reservedEur = null) {
    await this.mutateState((state) => {
      state.model.refused_before_dispatch += 1;
    });
    const evidence = {
      timestamp: isoNow(),
      provider: "OpenAI",
      model: this.config.model,
      outcome: "refused-before-provider-dispatch",
      refusal_code: code,
      requested_maximum_input_tokens: request.maximum_input_tokens,
      requested_maximum_output_tokens: request.maximum_output_tokens,
      calculated_reservation_eur: reservedEur,
      provider_cost_eur: 0
    };
    await appendJsonl(join(this.config.run_directory, "model-ledger.jsonl"), evidence);
    return refusal(code, message);
  }

  async request(request) {
    if (typeof request.content !== "string" || request.content.length === 0) return this.refuseBeforeDispatch("invalid_content", "Model content must be non-empty text", request);
    if (this.fixedRequestPolicy && (
      request.content_classification !== this.fixedRequestPolicy.content_classification ||
      request.maximum_input_tokens !== this.fixedRequestPolicy.maximum_input_tokens ||
      request.maximum_output_tokens !== this.fixedRequestPolicy.maximum_output_tokens
    )) {
      return this.refuseBeforeDispatch("fixed_request_policy_mismatch", "Model request does not match the fixed explorer decision contract", request);
    }
    if (!this.config.allowed_content_classifications.includes(request.content_classification)) {
      return this.refuseBeforeDispatch("content_not_approved", "Content classification is not approved", request);
    }
    const maximumInputTokens = Number(request.maximum_input_tokens);
    const maximumOutputTokens = Number(request.maximum_output_tokens);
    if (!Number.isSafeInteger(maximumInputTokens) || maximumInputTokens <= 0 || !Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens <= 0) {
      return this.refuseBeforeDispatch("invalid_usage_bound", "Positive integer token bounds are required", request);
    }
    const outputFloor = minimumOutputGuard(request, this.minimumOutputTokens);
    if (!outputFloor.ok) return this.refuseBeforeDispatch(outputFloor.refusal.code, outputFloor.refusal.message, request);
    if (maximumInputTokens <= FRAMING_OVERHEAD_TOKENS || Buffer.byteLength(request.content, "utf8") > maximumInputTokens - FRAMING_OVERHEAD_TOKENS) {
      return this.refuseBeforeDispatch("input_bound_too_small", "Content plus conservative framing overhead exceeds the declared input-token bound", request);
    }
    const reservedEur = this.reservation(maximumInputTokens, maximumOutputTokens);
    if (!this.apiKey) return this.refuseBeforeDispatch("provider_credential_unavailable", "The supervisor model broker has no provider credential", request, reservedEur);
    let capRefusal = null;
    await this.mutateState((state) => {
      if (state.abort) capRefusal = ["run_aborted", state.abort.code];
      else if (Date.now() >= Date.parse(state.working_day_deadline)) capRefusal = ["working_day_deadline", "Working-day deadline reached"];
      else if (this.fixedRequestPolicy && state.model.calls < this.fixedRequestPolicy.initial_model_calls) capRefusal = ["model_call_baseline_drift", "Model call baseline changed"];
      else if (this.fixedRequestPolicy && state.model.calls - this.fixedRequestPolicy.initial_model_calls >= this.fixedRequestPolicy.maximum_calls) capRefusal = ["fixed_request_call_limit", "Fixed explorer model-call limit reached"];
      else if (state.model.actual_eur + state.model.outstanding_reservations_eur + reservedEur > state.caps.model_cost_cap_eur) capRefusal = ["model_cost_cap", "Model cost cap would be exceeded"];
      else if (combinedReservedAndActual(state) + reservedEur > state.caps.combined_actual_plus_reserved_cap_eur) capRefusal = ["combined_cost_cap", "Combined cost cap would be exceeded"];
      else state.model.outstanding_reservations_eur = roundEur(state.model.outstanding_reservations_eur + reservedEur);
    });
    if (capRefusal) return this.refuseBeforeDispatch(capRefusal[0], capRefusal[1], request, reservedEur);
    const reservationRecord = {
      timestamp: isoNow(),
      phase: "reservation",
      provider: "OpenAI",
      api: "Responses API",
      model: this.config.model,
      content_classification: request.content_classification,
      maximum_input_tokens: maximumInputTokens,
      conservative_framing_overhead_tokens: FRAMING_OVERHEAD_TOKENS,
      maximum_content_input_tokens: maximumInputTokens - FRAMING_OVERHEAD_TOKENS,
      maximum_output_tokens: maximumOutputTokens,
      currency: "EUR",
      input_per_million_tokens_usd: this.pricing.input_per_million_tokens,
      cached_input_per_million_tokens_usd: this.pricing.cached_input_per_million_tokens,
      output_per_million_tokens_usd: this.pricing.output_per_million_tokens,
      possible_cache_write_multiplier: this.pricing.cache_write_reservation_multiplier_on_uncached_input,
      accounting_rate_usd_to_eur: 1,
      pricing_source_url: this.pricing.source_url,
      pricing_retrieved_date: this.pricing.retrieved_date,
      price_version: this.pricing.price_version,
      reserved_eur: reservedEur
    };
    await appendJsonl(join(this.config.run_directory, "model-ledger.jsonl"), reservationRecord);

    let finalPreDispatchRefusal = null;
    await this.mutateState((state) => {
      if (state.abort) finalPreDispatchRefusal = ["run_aborted", state.abort.code];
      else if (Date.now() >= Date.parse(state.working_day_deadline)) finalPreDispatchRefusal = ["working_day_deadline", "Working-day deadline reached"];
    });
    if (finalPreDispatchRefusal) return this.refuseBeforeDispatch(finalPreDispatchRefusal[0], finalPreDispatchRefusal[1], request, reservedEur);

    let providerResponse;
    try {
      providerResponse = await this.providerFetch(this.providerUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          input: request.content,
          max_output_tokens: maximumOutputTokens,
          // Reasoning-capable models bill hidden reasoning tokens out of the same
          // max_output_tokens budget as the visible answer. On a busy screen the model spent the
          // full 512-token cap reasoning and never emitted its JSON decision (empty output,
          // "malformed_output" halt, evidence in spike-a-local-20260904T162200Z). "low" asks
          // for the least reasoning the model will do, leaving the fixed budget for the answer.
          // Not a cost or safety cap: same dollar reservation, same decision limit either way.
          reasoning: { effort: "low" },
          store: false
        }),
        signal: AbortSignal.timeout(60_000)
      });
      if (!providerResponse.ok) {
        let providerError = null;
        try {
          const parsed = await providerResponse.json();
          providerError = parsed && typeof parsed === "object" && parsed.error && typeof parsed.error === "object"
            ? { param: parsed.error.param, code: parsed.error.code }
            : null;
        } catch {}
        const failure = { ...safeProviderFailureMetadata({ response: providerResponse }), provider_reason: providerFailureReason({ status: providerResponse.status, error: providerError }) };
        await this.mutateState((state) => {
          state.abort = { code: "model_provider_failure", timestamp: isoNow(), detail: "Provider request failed" };
        });
        await appendJsonl(join(this.config.run_directory, "model-ledger.jsonl"), {
          timestamp: isoNow(), phase: "provider-failure", provider: "OpenAI", model: this.config.model,
          reserved_eur: reservedEur, reservation_released_eur: 0, ...failure
        });
        return refusal("model_provider_failure", "Provider request failed; reservation remains consumed and the run is aborted");
      }
      providerResponse = await providerResponse.json();
    } catch (error) {
      const failure = safeProviderFailureMetadata({ error });
      await this.mutateState((state) => {
        state.abort = { code: "model_provider_failure", timestamp: isoNow(), detail: "Provider request failed" };
      });
      await appendJsonl(join(this.config.run_directory, "model-ledger.jsonl"), {
        timestamp: isoNow(), phase: "provider-failure", provider: "OpenAI", model: this.config.model,
        reserved_eur: reservedEur, reservation_released_eur: 0, ...failure
      });
      return refusal("model_provider_failure", "Provider request failed; reservation remains consumed and the run is aborted");
    }

    const usage = providerResponse.usage;
    if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) {
      await this.mutateState((state) => {
        state.abort = { code: "model_usage_missing", timestamp: isoNow(), detail: "Provider response lacked required usage" };
      });
      return refusal("model_usage_missing", "Provider usage telemetry is missing; reservation remains consumed and the run is aborted");
    }
    const actualEur = this.actualCost(usage);
    let reservationMismatch = false;
    await this.mutateState((state) => {
      if (this.fixedRequestPolicy && state.model.outstanding_reservations_eur < reservedEur) throw new Error("Explorer reservation disappeared before reconciliation");
      state.model.outstanding_reservations_eur = roundEur(Math.max(0, state.model.outstanding_reservations_eur - reservedEur));
      state.model.actual_eur = roundEur(state.model.actual_eur + actualEur);
      state.model.calls += 1;
      reservationMismatch = usage.input_tokens > maximumInputTokens || usage.output_tokens > maximumOutputTokens || actualEur > reservedEur;
      if (reservationMismatch) state.abort = { code: "model_reservation_mismatch", timestamp: isoNow(), detail: "Actual usage exceeded a declared reservation bound" };
    });
    const normalizedUsage = {
      input_tokens: usage.input_tokens,
      cached_input_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
      output_tokens: usage.output_tokens,
      cache_write_tokens_reported_by_provider: null,
      conservative_possible_cache_write_tokens_priced: Math.max(0, usage.input_tokens - (usage.input_tokens_details?.cached_tokens ?? 0))
    };
    const modelIdentity = approvedModelIdentity(this.modelPolicy, providerResponse.model);
    const text = outputText(providerResponse);
    await appendJsonl(join(this.config.run_directory, "model-ledger.jsonl"), {
      timestamp: isoNow(),
      phase: "reconciliation",
      provider: "OpenAI",
      api: "Responses API",
      model: modelIdentity.returned_model,
      model_identity: modelIdentity,
      provider_response_id: providerResponse.id,
      output: text,
      usage: normalizedUsage,
      reserved_eur: reservedEur,
      actual_eur: actualEur,
      released_eur: roundEur(Math.max(0, reservedEur - actualEur)),
      pricing_source_url: this.pricing.source_url,
      pricing_retrieved_date: this.pricing.retrieved_date,
      price_version: this.pricing.price_version,
      reservation_within_bound: actualEur <= reservedEur,
      credential_exposed: false
    });
    if (reservationMismatch) return refusal("model_reservation_mismatch", "Usage exceeded the pre-dispatch reservation; run aborted");
    if (!modelIdentity.approved) {
      await this.mutateState((state) => {
        state.abort = { code: "model_identity_not_approved", timestamp: isoNow(), detail: "Provider returned a model outside the approved alias or snapshot policy" };
      });
      return refusal("model_identity_not_approved", "Provider returned a model outside the approved alias or snapshot policy");
    }
    return { ok: true, output: text, usage: normalizedUsage, model: modelIdentity.returned_model, model_identity: modelIdentity, actual_eur: actualEur };
  }

  async execute(payload) {
    if (payload.method === "ping") return { ok: true, broker: BROKER_ID, model: this.config.model, interface: "output-usage-or-refusal", methods: EXPOSED_METHODS };
    if (payload.method === "metrics") return { ok: true, metrics: await this.state() };
    if (payload.method === "request") return this.request(payload);
    return refusal("method_not_exposed", "The model broker exposes only bounded model requests and normalized results");
  }
}

async function main() {
  const args = parseArgs();
  const config = await readJson(args["--config"]);
  const broker = new ModelBroker(config);
  try {
    await broker.preflight();
    writeJsonLine(process.stdout, { ready: true, broker: BROKER_ID });
    attachBoundedJsonLineReader(process.stdin, {
      async onMessage(message) {
        let response;
        try {
          response = await broker.execute(message.payload ?? {});
        } catch {
          response = refusal("model_broker_error", "The supervised model request failed closed");
        }
        writeJsonLine(process.stdout, { rpc_id: message.rpc_id, response });
      },
      onError() {
        process.exitCode = 1;
        process.stdin.destroy();
      }
    });
  } catch {
    writeJsonLine(process.stdout, { ready: false, error: "Explorer model broker startup preflight failed" });
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
