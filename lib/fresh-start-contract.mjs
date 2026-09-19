const HASH = /^[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
export const FRESH_START_RECORD_KIND = "spike-a-fresh-start-contract";
export const FIRST_OBSERVATION_AUTHORITY = "first-retained-browser-observation";
function exactKeys(value, keys) {
    return (!!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        JSON.stringify(Object.keys(value).sort()) ===
            JSON.stringify([...keys].sort()));
}
function requireCondition(condition, message) {
    if (!condition)
        throw new Error(`Fresh-start contract refused: ${message}`);
}
function normalizedHttpsOrigin(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return null;
    }
    if (url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash) {
        return null;
    }
    return url.origin;
}
/**
 * Validate the deliberately small, durable owner statement for a new run.
 *
 * Product/browser/session state is intentionally unrepresentable in this
 * schema. The live auth boundary proves its own facts later; the first retained
 * browser observation is the sole authority for the product state presented to
 * the explorer.
 */
export function validateFreshStartContract(contract, { runId, accountSha256, account, clerkFrontendApiOrigin, } = {}) {
    requireCondition(exactKeys(contract, [
        "schema_version",
        "record_kind",
        "status",
        "run_id",
        "approved_account_binding",
        "product_state_rule",
    ]), "unknown or missing top-level fields");
    requireCondition(contract.schema_version === 1 &&
        contract.record_kind === FRESH_START_RECORD_KIND &&
        contract.status === "pass", "schema identity or approval is invalid");
    requireCondition(typeof contract.run_id === "string" &&
        RUN_ID.test(contract.run_id) &&
        contract.run_id === runId, "run binding is invalid");
    const binding = contract.approved_account_binding;
    requireCondition(exactKeys(binding, [
        "file_name",
        "sha256",
        "clerk_frontend_api_origin",
        "provider_user_id",
        "username",
    ]), "approved account binding is invalid");
    requireCondition(binding.file_name === "account.json" &&
        HASH.test(String(binding.sha256 ?? "")) &&
        binding.sha256 === accountSha256, "approved account file hash does not match");
    const configuredInstance = normalizedHttpsOrigin(clerkFrontendApiOrigin);
    requireCondition(configuredInstance &&
        normalizedHttpsOrigin(binding.clerk_frontend_api_origin) ===
            configuredInstance, "Clerk instance binding does not match");
    requireCondition(typeof binding.provider_user_id === "string" &&
        binding.provider_user_id.length > 0 &&
        binding.provider_user_id === account?.identity?.provider_user_id, "approved provider user id does not match account.json");
    requireCondition(typeof binding.username === "string" &&
        binding.username.length > 0 &&
        binding.username === account?.identity?.username, "synthetic account marker does not match account.json");
    requireCondition(exactKeys(contract.product_state_rule, [
        "authority",
        "pre_observation_claims",
    ]) &&
        contract.product_state_rule.authority === FIRST_OBSERVATION_AUTHORITY &&
        Array.isArray(contract.product_state_rule.pre_observation_claims) &&
        contract.product_state_rule.pre_observation_claims.length === 0, "the first retained observation must be the only product-state authority");
    return {
        run_id: contract.run_id,
        account_sha256: binding.sha256,
        clerk_frontend_api_origin: configuredInstance,
        provider_user_id: binding.provider_user_id,
        username: binding.username,
        product_state_authority: FIRST_OBSERVATION_AUTHORITY,
    };
}
