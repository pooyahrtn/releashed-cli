const SAFE_HTTP_STATUS_MIN = 100;
const SAFE_HTTP_STATUS_MAX = 599;

export function safeProviderFailureMetadata({ response = null, error = null } = {}) {
  if (response) {
    const status = Number(response.status);
    return {
      provider_http_status: Number.isInteger(status) && status >= SAFE_HTTP_STATUS_MIN && status <= SAFE_HTTP_STATUS_MAX ? status : null,
      provider_error_category: "http-non-success"
    };
  }
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return { provider_http_status: null, provider_error_category: "timeout" };
  }
  if (error instanceof SyntaxError) {
    return { provider_http_status: null, provider_error_category: "invalid-provider-json" };
  }
  return { provider_http_status: null, provider_error_category: "network-or-transport" };
}

export function providerFailureReason({ status, error = null }) {
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || status === 503) return "model-unavailable";
  if (status === 429 && error?.code === "insufficient_quota") return "quota";
  if (status === 429) return "rate-limit";
  if (status === 400 && (error?.param === "max_output_tokens" || error?.code === "invalid_output_limit")) return "invalid-output-limit";
  if (status === 400) return "invalid-request-other";
  return "unknown";
}

export function minimumOutputGuard(request, minimumOutputTokens) {
  const requested = Number(request.maximum_output_tokens);
  if (!Number.isSafeInteger(minimumOutputTokens) || minimumOutputTokens <= 0) throw new Error("Approved minimum output token floor is required");
  if (!Number.isSafeInteger(requested) || requested < minimumOutputTokens) {
    return { ok: false, refusal: { code: "output_below_approved_floor", message: "Model output bound is below the approved provider minimum" } };
  }
  return { ok: true };
}

export function validateApprovedModelPolicy(policy) {
  if (!policy || typeof policy !== "object") throw new Error("Approved model identity policy is required");
  if (typeof policy.approved_alias !== "string" || !policy.approved_alias) throw new Error("Approved model alias is required");
  if (!Array.isArray(policy.approved_snapshots) || !policy.approved_snapshots.every((value) => typeof value === "string" && value)) {
    throw new Error("Approved model snapshots must be an explicit string list");
  }
  if (new Set(policy.approved_snapshots).size !== policy.approved_snapshots.length) throw new Error("Approved model snapshots must not repeat");
  return policy;
}

export function approvedModelIdentity(policy, returnedModel) {
  validateApprovedModelPolicy(policy);
  const returned_model = typeof returnedModel === "string" ? returnedModel : null;
  return {
    returned_model,
    identity_policy: {
      approved_alias: policy.approved_alias,
      approved_snapshots: [...policy.approved_snapshots]
    },
    approved: returned_model === policy.approved_alias || policy.approved_snapshots.includes(returned_model)
  };
}
