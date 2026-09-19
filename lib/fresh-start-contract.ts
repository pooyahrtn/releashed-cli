const HASH = /^[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export const FRESH_START_RECORD_KIND = "spike-a-fresh-start-contract";
export const FIRST_OBSERVATION_AUTHORITY = "first-retained-browser-observation";

export type FreshStartAccount = {
  identity?: {
    provider_user_id?: unknown;
    username?: unknown;
  } | null;
};

export type FreshStartValidationOptions = {
  runId?: unknown;
  accountSha256?: unknown;
  account?: FreshStartAccount | null;
  clerkFrontendApiOrigin?: unknown;
};

export type FreshStartValidation = {
  run_id: string;
  account_sha256: string;
  clerk_frontend_api_origin: string;
  provider_user_id: string;
  username: string;
  product_state_authority: string;
};

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		JSON.stringify(Object.keys(value).sort()) ===
			JSON.stringify([...keys].sort())
	);
}

function requireCondition(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Fresh-start contract refused: ${message}`);
}

function normalizedHttpsOrigin(value: unknown): string | null {
	let url: URL;
	try {
		url = new URL(value as string);
	} catch {
		return null;
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
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
export function validateFreshStartContract(
	contract: unknown,
	{
		runId,
		accountSha256,
		account,
		clerkFrontendApiOrigin,
	}: FreshStartValidationOptions = {},
): FreshStartValidation {
	requireCondition(
		exactKeys(contract, [
			"schema_version",
			"record_kind",
			"status",
			"run_id",
			"approved_account_binding",
			"product_state_rule",
		]),
		"unknown or missing top-level fields",
	);
	requireCondition(
		contract.schema_version === 1 &&
			contract.record_kind === FRESH_START_RECORD_KIND &&
			contract.status === "pass",
		"schema identity or approval is invalid",
	);
	requireCondition(
		typeof contract.run_id === "string" &&
			RUN_ID.test(contract.run_id) &&
			contract.run_id === runId,
		"run binding is invalid",
	);

	const binding = contract.approved_account_binding;
	requireCondition(
		exactKeys(binding, [
			"file_name",
			"sha256",
			"clerk_frontend_api_origin",
			"provider_user_id",
			"username",
		]),
		"approved account binding is invalid",
	);
	requireCondition(
		binding.file_name === "account.json" &&
			HASH.test(String(binding.sha256 ?? "")) &&
			binding.sha256 === accountSha256,
		"approved account file hash does not match",
	);
	const configuredInstance = normalizedHttpsOrigin(clerkFrontendApiOrigin);
	requireCondition(
		configuredInstance &&
			normalizedHttpsOrigin(binding.clerk_frontend_api_origin) ===
				configuredInstance,
		"Clerk instance binding does not match",
	);
	requireCondition(
		typeof binding.provider_user_id === "string" &&
			binding.provider_user_id.length > 0 &&
			binding.provider_user_id === account?.identity?.provider_user_id,
		"approved provider user id does not match account.json",
	);
	requireCondition(
		typeof binding.username === "string" &&
			binding.username.length > 0 &&
			binding.username === account?.identity?.username,
		"synthetic account marker does not match account.json",
	);

	requireCondition(
		exactKeys(contract.product_state_rule, [
			"authority",
			"pre_observation_claims",
		]) &&
			contract.product_state_rule.authority === FIRST_OBSERVATION_AUTHORITY &&
			Array.isArray(contract.product_state_rule.pre_observation_claims) &&
			contract.product_state_rule.pre_observation_claims.length === 0,
		"the first retained observation must be the only product-state authority",
	);

	return {
		run_id: contract.run_id as string,
		account_sha256: binding.sha256 as string,
		clerk_frontend_api_origin: configuredInstance as string,
		provider_user_id: binding.provider_user_id as string,
		username: binding.username as string,
		product_state_authority: FIRST_OBSERVATION_AUTHORITY,
	};
}
