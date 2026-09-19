import { lstat, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  EXPLORER_CONTENT_CLASSIFICATION,
  EXPLORER_DECISION_LIMIT,
  EXPLORER_MAXIMUM_INPUT_TOKENS,
  EXPLORER_MAXIMUM_OUTPUT_TOKENS
} from "./explorer-protocol.ts";
import { combinedReservedAndActual, roundEur, sha256Text } from "./scaffold.ts";

export const EXPLORER_MODEL_POLICY_ID = "source-blind-explorer-decisions-v1";
export const EXPLORER_MODEL_CONFIG_NAME = "explorer-model-config.json";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const RETAINED_MODEL_CONFIG_KEYS = ["run_id", "run_directory", "cap_state_path", "model", "minimum_output_tokens", "approved_model_identity_policy", "pricing", "allowed_content_classifications"];
const EXPLORER_MODEL_CONFIG_KEYS = ["run_id", "run_directory", "cap_state_path", "model", "minimum_output_tokens", "approved_model_identity_policy", "pricing", "allowed_content_classifications", "owner_authority_binding", "retained_model_config_binding", "fixed_request_policy"];
const RETAINED_BINDING_KEYS = ["path", "sha256"];
const FIXED_POLICY_KEYS = ["policy_id", "content_classification", "maximum_calls", "maximum_input_tokens", "maximum_output_tokens", "initial_model_calls", "model_cost_cap_eur", "combined_cost_cap_eur", "per_call_reserved_eur", "worst_case_reserved_eur", "prepared_cap_state_sha256", "prepared_model_ledger_sha256"];
const PRODUCTION_CLASSIFICATIONS = [
  "generic-synthetic-non-target",
  "public-pack-text",
  "Synthetic visible app content from the disposable account after secret and personal-data checks."
];
const FROZEN_CAPS = { model_cost_cap_eur: 18, combined_actual_plus_reserved_cap_eur: 20 };

export type ExplorerModelConfig = {
  run_id: string;
  run_directory: string;
  cap_state_path: string;
  model: string;
  minimum_output_tokens: number;
  approved_model_identity_policy: unknown;
  pricing: unknown;
  allowed_content_classifications: unknown;
  owner_authority_binding: { path: string; sha256: string };
  retained_model_config_binding: { path: string; sha256: string };
  fixed_request_policy: {
    policy_id: string;
    content_classification: string;
    maximum_calls: number;
    maximum_input_tokens: number;
    maximum_output_tokens: number;
    initial_model_calls: number;
    model_cost_cap_eur: number;
    combined_cost_cap_eur: number;
    per_call_reserved_eur: number;
    worst_case_reserved_eur: number;
    prepared_cap_state_sha256: string;
    prepared_model_ledger_sha256: string;
  };
};

type LedgerRow = Record<string, unknown>;

type PricingRecord = {
  input_per_million_tokens: number;
  cached_input_per_million_tokens: number;
  output_per_million_tokens: number;
  cache_write_reservation_multiplier_on_uncached_input: number;
  accounting_rate: { usd: number; eur: number };
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function exactKeys(value: unknown, keys: string[]): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n")
  );
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validClassCounts(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    )
  );
}

async function requireOrdinaryFile(path: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    requireCondition(metadata.isFile() && !metadata.isSymbolicLink(), `${label} is not an ordinary file`);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("ordinary file")) throw error;
    throw new Error(`${label} is missing or unreadable`);
  }
}

async function readByteSnapshot(path: string, label: string): Promise<{ bytes: Buffer; sha256: string }> {
  await requireOrdinaryFile(path, label);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`${label} is missing or unreadable`);
  }
  return { bytes, sha256: sha256Text(bytes) };
}

async function readJsonSnapshot(
  path: string,
  label: string,
): Promise<{ bytes: Buffer; sha256: string; value: unknown }> {
  const snapshot = await readByteSnapshot(path, label);
  try {
    return { ...snapshot, value: JSON.parse(snapshot.bytes.toString("utf8")) as unknown };
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

function validateApprovedIdentityPolicy(policy: unknown, model: unknown): void {
  const record = policy as Record<string, unknown>;
  requireCondition(
    exactKeys(policy, ["approved_alias", "approved_snapshots"]) &&
      typeof model === "string" && model.length > 0 &&
      record.approved_alias === model &&
      Array.isArray(record.approved_snapshots) && record.approved_snapshots.length === 0,
    "Approved model identity policy has drifted from the frozen policy"
  );
}

function validateCompletePricing(pricing: unknown): void {
  const record = pricing as Record<string, unknown>;
  const source = (pricing as { source_url?: unknown } | null | undefined)?.source_url;
  let sourceUrl: URL | null;
  try {
    sourceUrl = new URL(source as string);
  } catch {
    sourceUrl = null;
  }
  // The accounting rate is read inside the condition chain, after exactKeys has established
  // that pricing is a non-null object, exactly as the original direct accesses did.
  const account = (): Record<string, unknown> =>
    (pricing as Record<string, unknown>).accounting_rate as Record<string, unknown>;
  requireCondition(
    exactKeys(pricing, ["currency", "input_per_million_tokens", "cached_input_per_million_tokens", "output_per_million_tokens", "cache_write_reservation_multiplier_on_uncached_input", "accounting_rate", "source_url", "retrieved_date", "price_version"]) &&
    exactKeys(record.accounting_rate, ["usd", "eur", "reason"]) &&
      record.currency === "USD" &&
      finiteNonnegative(record.input_per_million_tokens) &&
      finiteNonnegative(record.cached_input_per_million_tokens) &&
      finiteNonnegative(record.output_per_million_tokens) &&
      finiteNonnegative(record.cache_write_reservation_multiplier_on_uncached_input) &&
      Number.isFinite(account().usd) && (account().usd as number) > 0 &&
      Number.isFinite(account().eur) && (account().eur as number) > 0 &&
      typeof account().reason === "string" && (account().reason as string).length > 0 &&
      sourceUrl?.protocol === "https:" &&
      /^\d{4}-\d{2}-\d{2}$/.test(record.retrieved_date as string) &&
      typeof record.price_version === "string" && (record.price_version as string).length > 0,
    "Model pricing has drifted from the complete frozen price record"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown } | null | undefined)?.code === "ENOENT") return false;
    throw new Error("Explorer model output could not be checked safely");
  }
}

function reservationFromPricing(pricing: unknown): { perCall: number; worstCase: number } {
  validateCompletePricing(pricing);
  const record = pricing as PricingRecord;
  const input = EXPLORER_MAXIMUM_INPUT_TOKENS * record.input_per_million_tokens * record.cache_write_reservation_multiplier_on_uncached_input / 1_000_000;
  const output = EXPLORER_MAXIMUM_OUTPUT_TOKENS * record.output_per_million_tokens / 1_000_000;
  const perCall = roundEur((input + output) * record.accounting_rate.eur / record.accounting_rate.usd);
  return { perCall, worstCase: roundEur(perCall * EXPLORER_DECISION_LIMIT) };
}

function parseLedger(body: string): LedgerRow[] {
  try {
    return body.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)) as LedgerRow[];
  } catch {
    throw new Error("Retained model ledger is invalid JSONL");
  }
}

function validateCurrentCapAndLedger({
  cap,
  ledgerRows,
  runId,
}: {
  cap: unknown;
  ledgerRows: LedgerRow[];
  runId: string;
}): void {
  const state = cap as Record<string, unknown>;
  requireCondition(state?.run_id === runId && state.abort === null, "Current cap state is not usable for explorer decisions");
  requireCondition(Number.isFinite(Date.parse(state.working_day_deadline as string)) && Date.parse(state.working_day_deadline as string) > Date.now(), "Current working-day deadline has expired");
  const caps = state.caps as Record<string, unknown>;
  requireCondition(caps?.model_cost_cap_eur === FROZEN_CAPS.model_cost_cap_eur && caps?.combined_actual_plus_reserved_cap_eur === FROZEN_CAPS.combined_actual_plus_reserved_cap_eur, "Current cap state does not retain the frozen cost caps");
  const model = state.model as Record<string, unknown>;
  const app = state.app as Record<string, unknown>;
  requireCondition(
    Number.isSafeInteger(model?.calls) && (model?.calls as number) >= 0 &&
      Number.isSafeInteger(model?.refused_before_dispatch) && (model?.refused_before_dispatch as number) >= 0 &&
      finiteNonnegative(model?.actual_eur) && finiteNonnegative(model?.outstanding_reservations_eur) &&
      Number.isSafeInteger(app?.one_way_actions) && (app?.one_way_actions as number) >= 0 &&
      finiteNonnegative(app?.actual_eur) && finiteNonnegative(app?.outstanding_reservations_eur) &&
      validClassCounts(app?.class_counts),
    "Current cap state contains invalid counters"
  );
  const reconciliations = ledgerRows.filter((row) => row.phase === "reconciliation");
  const reservations = ledgerRows.filter((row) => row.phase === "reservation");
  const refusals = ledgerRows.filter((row) => row.outcome === "refused-before-provider-dispatch");
  const actual = roundEur(reconciliations.reduce((sum, row) => sum + Number(row.actual_eur), 0));
  requireCondition(reconciliations.every((row) => finiteNonnegative(row.actual_eur) && row.reservation_within_bound === true && row.credential_exposed === false), "Retained model ledger contains an unsafe reconciliation");
  requireCondition(reservations.length === reconciliations.length && model.calls === reconciliations.length && model.refused_before_dispatch === refusals.length && model.outstanding_reservations_eur === 0, "Current model counters do not match the retained ledger");
  requireCondition(Math.abs((model.actual_eur as number) - actual) < 1e-12, "Current model cost does not match the retained ledger");
}

function validateRetainedModel({
  retained,
  authority,
  runId,
  runDirectory,
  capStatePath,
}: {
  retained: unknown;
  authority: unknown;
  runId: string;
  runDirectory: string;
  capStatePath: string;
}): Record<string, unknown> {
  const state = retained as Record<string, unknown>;
  const owner = authority as Record<string, unknown> | null | undefined;
  const approval = owner?.model_broker_approval as Record<string, unknown> | undefined;
  const limits = owner?.limits as Record<string, unknown> | undefined;
  requireCondition(owner?.status === "pass" && approval?.status === "approved-not-called" && approval.provider === "OpenAI" && approval.api === "Responses API" && typeof approval.model === "string" && approval.model.length > 0, "Frozen owner model authority is not approved");
  requireCondition(limits?.model_cost_cap_eur === FROZEN_CAPS.model_cost_cap_eur && limits?.combined_actual_plus_reserved_cap_eur === FROZEN_CAPS.combined_actual_plus_reserved_cap_eur, "Frozen owner authority does not retain the exact cost caps");
  requireCondition(exactKeys(retained, RETAINED_MODEL_CONFIG_KEYS), "Retained model configuration has unknown or missing fields");
  requireCondition(state.run_id === runId && state.run_directory === runDirectory && state.cap_state_path === capStatePath, "Retained model configuration is not bound to this run");
  requireCondition(state.model === approval!.model && state.minimum_output_tokens === 16, "Retained model identity or provider floor does not match frozen authority");
  validateApprovedIdentityPolicy(state.approved_model_identity_policy, approval!.model);
  validateCompletePricing(approval!.pricing);
  validateCompletePricing(state.pricing);
  requireCondition(JSON.stringify(state.pricing) === JSON.stringify(approval!.pricing), "Retained pricing does not match frozen authority");
  requireCondition(JSON.stringify(state.allowed_content_classifications) === JSON.stringify(PRODUCTION_CLASSIFICATIONS), "Retained model classifications have drifted");
  return approval!;
}

function validateBoundRetainedModel({
  retained,
  config,
}: {
  retained: unknown;
  config: ExplorerModelConfig;
}): void {
  const bound = retained as Record<string, unknown>;
  requireCondition(exactKeys(retained, RETAINED_MODEL_CONFIG_KEYS), "Bound retained model configuration has unknown or missing fields");
  requireCondition(
    bound.run_id === config.run_id &&
      bound.run_directory === config.run_directory &&
      bound.cap_state_path === config.cap_state_path &&
      bound.model === config.model &&
      bound.minimum_output_tokens === 16 &&
      JSON.stringify(bound.approved_model_identity_policy) === JSON.stringify(config.approved_model_identity_policy) &&
      JSON.stringify(bound.pricing) === JSON.stringify(config.pricing) &&
      JSON.stringify(bound.allowed_content_classifications) === JSON.stringify(PRODUCTION_CLASSIFICATIONS),
    "Bound retained model policy does not match the prepared explorer policy"
  );
  validateApprovedIdentityPolicy(bound.approved_model_identity_policy, config.model);
  validateCompletePricing(bound.pricing);
}

function validateBoundAuthority({
  authority,
  config,
}: {
  authority: unknown;
  config: ExplorerModelConfig;
}): void {
  const owner = authority as Record<string, unknown> | null | undefined;
  const approval = owner?.model_broker_approval as Record<string, unknown> | undefined;
  const limits = owner?.limits as Record<string, unknown> | undefined;
  requireCondition(
    owner?.status === "pass" &&
      limits?.model_cost_cap_eur === FROZEN_CAPS.model_cost_cap_eur &&
      limits?.combined_actual_plus_reserved_cap_eur === FROZEN_CAPS.combined_actual_plus_reserved_cap_eur &&
      approval?.status === "approved-not-called" &&
      approval.provider === "OpenAI" &&
      approval.api === "Responses API" &&
      approval.model === config.model &&
      JSON.stringify(approval.pricing) === JSON.stringify(config.pricing),
    "Bound owner authority does not match the prepared explorer model policy"
  );
  validateCompletePricing(approval!.pricing);
}

export function validateExplorerModelConfig(config: unknown): ExplorerModelConfig {
  const record = config as Record<string, unknown>;
  requireCondition(exactKeys(config, EXPLORER_MODEL_CONFIG_KEYS), "Explorer model configuration has unknown or missing fields");
  requireCondition(typeof record.run_id === "string" && RUN_ID_PATTERN.test(record.run_id) && typeof record.run_directory === "string" && typeof record.cap_state_path === "string" && typeof record.model === "string" && record.model.length > 0, "Explorer model configuration is not bound to a model or run");
  validateApprovedIdentityPolicy(record.approved_model_identity_policy, record.model);
  validateCompletePricing(record.pricing);
  const ownerBinding = record.owner_authority_binding as Record<string, unknown> | undefined;
  requireCondition(exactKeys(ownerBinding, RETAINED_BINDING_KEYS) && resolve(ownerBinding!.path as string) === ownerBinding!.path && /^[0-9a-f]{64}$/.test(ownerBinding!.sha256 as string), "Explorer model configuration lacks its owner-authority binding");
  const retainedBinding = record.retained_model_config_binding as Record<string, unknown> | undefined;
  requireCondition(exactKeys(retainedBinding, RETAINED_BINDING_KEYS) && retainedBinding!.path === join(dirname(record.cap_state_path as string), "model-config.json") && /^[0-9a-f]{64}$/.test(retainedBinding!.sha256 as string), "Explorer model configuration lacks its retained-policy binding");
  const policy = record.fixed_request_policy as Record<string, unknown>;
  requireCondition(exactKeys(policy, FIXED_POLICY_KEYS), "Explorer fixed-request policy has unknown or missing fields");
  requireCondition(
    policy.policy_id === EXPLORER_MODEL_POLICY_ID &&
      policy.content_classification === EXPLORER_CONTENT_CLASSIFICATION &&
      policy.maximum_calls === EXPLORER_DECISION_LIMIT &&
      policy.maximum_input_tokens === EXPLORER_MAXIMUM_INPUT_TOKENS &&
      policy.maximum_output_tokens === EXPLORER_MAXIMUM_OUTPUT_TOKENS &&
      Number.isSafeInteger(policy.initial_model_calls) && (policy.initial_model_calls as number) >= 0 &&
      policy.model_cost_cap_eur === FROZEN_CAPS.model_cost_cap_eur &&
      policy.combined_cost_cap_eur === FROZEN_CAPS.combined_actual_plus_reserved_cap_eur &&
      /^[0-9a-f]{64}$/.test(policy.prepared_cap_state_sha256 as string) &&
      /^[0-9a-f]{64}$/.test(policy.prepared_model_ledger_sha256 as string),
    "Explorer fixed-request policy does not match the production decision contract"
  );
  requireCondition(record.minimum_output_tokens === EXPLORER_MAXIMUM_OUTPUT_TOKENS && JSON.stringify(record.allowed_content_classifications) === JSON.stringify([EXPLORER_CONTENT_CLASSIFICATION]), "Explorer model broker is not restricted to its exact output and content class");
  const reservation = reservationFromPricing(record.pricing);
  requireCondition(policy.per_call_reserved_eur === reservation.perCall && policy.worst_case_reserved_eur === reservation.worstCase, "Explorer model reservation does not match frozen pricing");
  return config as ExplorerModelConfig;
}

export async function preflightExplorerModelConfig(config: unknown): Promise<{
  cap: Record<string, unknown>;
  policy: ExplorerModelConfig["fixed_request_policy"];
}> {
  validateExplorerModelConfig(config);
  const record = config as ExplorerModelConfig;
  const [capSnapshot, ledgerSnapshot, retainedSnapshot, authoritySnapshot] = await Promise.all([
    readJsonSnapshot(record.cap_state_path, "Explorer cap state"),
    readByteSnapshot(join(record.run_directory, "model-ledger.jsonl"), "Explorer model ledger"),
    readJsonSnapshot(record.retained_model_config_binding.path, "Bound retained model configuration"),
    readJsonSnapshot(record.owner_authority_binding.path, "Bound owner authority")
  ]);
  const policy = record.fixed_request_policy;
  requireCondition(capSnapshot.sha256 === policy.prepared_cap_state_sha256 && ledgerSnapshot.sha256 === policy.prepared_model_ledger_sha256 && retainedSnapshot.sha256 === record.retained_model_config_binding.sha256 && authoritySnapshot.sha256 === record.owner_authority_binding.sha256, "Explorer model cap state, ledger, or retained policy changed after preparation");
  validateBoundAuthority({ authority: authoritySnapshot.value, config: record });
  validateBoundRetainedModel({ retained: retainedSnapshot.value, config: record });
  const cap = capSnapshot.value as Record<string, unknown>;
  validateCurrentCapAndLedger({ cap, ledgerRows: parseLedger(ledgerSnapshot.bytes.toString("utf8")), runId: record.run_id });
  const model = cap.model as Record<string, unknown>;
  requireCondition(model.calls === policy.initial_model_calls, "Explorer model call baseline changed after preparation");
  requireCondition((model.actual_eur as number) + (model.outstanding_reservations_eur as number) + policy.worst_case_reserved_eur <= FROZEN_CAPS.model_cost_cap_eur, "The full explorer decision budget no longer fits the model cap");
  requireCondition(combinedReservedAndActual(cap) + policy.worst_case_reserved_eur <= FROZEN_CAPS.combined_actual_plus_reserved_cap_eur, "The full explorer decision budget no longer fits the combined cap");
  return { cap, policy };
}

async function writeExclusivePrivateJson(path: string, value: unknown): Promise<void> {
  let created = false;
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
    await chmod(path, 0o600);
  } catch {
    if (created) await rm(path, { force: true }).catch(() => {});
    throw new Error("Explorer model configuration could not be created exclusively");
  }
}

export async function prepareExplorerModelRuntime({
  repository,
  ownerDirectory,
  runId,
}: {
  repository: string;
  ownerDirectory: string;
  runId: string;
}): Promise<{
  run_id: string;
  config_path: string;
  maximum_calls: number;
  worst_case_reserved_eur: number;
}> {
  requireCondition(typeof runId === "string" && RUN_ID_PATTERN.test(runId), "Run id is invalid");
  const repo = resolve(repository);
  const owner = resolve(ownerDirectory);
  const runDirectory = join(repo, "runs", runId);
  const runtimeDirectory = join(repo, ".runtime", runId);
  const capStatePath = join(runtimeDirectory, "cap-state.json");
  const retainedModelConfigPath = join(runtimeDirectory, "model-config.json");
  const modelLedgerPath = join(runDirectory, "model-ledger.jsonl");
  const authorityPath = join(owner, "authority-and-start.json");
  const inputManifestPath = join(runDirectory, "input-manifest.json");
  const outputPath = join(runtimeDirectory, EXPLORER_MODEL_CONFIG_NAME);
  requireCondition(!(await pathExists(outputPath)), "Explorer model output already exists");
  const [capSnapshot, retainedSnapshot, ledgerSnapshot, authoritySnapshot, inputManifestSnapshot] = await Promise.all([
    readJsonSnapshot(capStatePath, "Current cap state"),
    readJsonSnapshot(retainedModelConfigPath, "Retained model configuration"),
    readByteSnapshot(modelLedgerPath, "Retained model ledger"),
    readJsonSnapshot(authorityPath, "Frozen owner authority"),
    readJsonSnapshot(inputManifestPath, "Retained input manifest")
  ]);
  const cap = capSnapshot.value as Record<string, unknown>;
  const retained = retainedSnapshot.value as Record<string, unknown>;
  const authority = authoritySnapshot.value as Record<string, unknown>;
  const inputManifest = inputManifestSnapshot.value as Record<string, unknown>;
  const inputHashes = inputManifest.owner_input_hashes as Record<string, unknown> | undefined;
  requireCondition(inputManifest?.run_id === runId && inputManifest.owner_inputs_sealed_before_broker_start === true && inputHashes?.["authority-and-start.json"] === authoritySnapshot.sha256, "Frozen owner authority is not bound to the retained input manifest");
  const approval = validateRetainedModel({ retained, authority, runId, runDirectory, capStatePath });
  validateCurrentCapAndLedger({ cap, ledgerRows: parseLedger(ledgerSnapshot.bytes.toString("utf8")), runId });
  const caps = cap.caps as Record<string, unknown>;
  const authorityLimits = authority.limits as Record<string, unknown> | undefined;
  requireCondition(caps.model_cost_cap_eur === authorityLimits?.model_cost_cap_eur && caps.combined_actual_plus_reserved_cap_eur === authorityLimits?.combined_actual_plus_reserved_cap_eur, "Current cost caps do not match frozen owner authority");
  const reservation = reservationFromPricing(retained.pricing);
  const model = cap.model as Record<string, unknown>;
  requireCondition((model.actual_eur as number) + (model.outstanding_reservations_eur as number) + reservation.worstCase <= FROZEN_CAPS.model_cost_cap_eur, "The full explorer decision budget does not fit the remaining model cap");
  requireCondition(combinedReservedAndActual(cap) + reservation.worstCase <= FROZEN_CAPS.combined_actual_plus_reserved_cap_eur, "The full explorer decision budget does not fit the remaining combined cap");
  requireCondition(retained.model === approval.model, "Explorer model does not match frozen owner authority");
  const config = validateExplorerModelConfig({
    run_id: runId,
    run_directory: runDirectory,
    cap_state_path: capStatePath,
    model: retained.model,
    minimum_output_tokens: EXPLORER_MAXIMUM_OUTPUT_TOKENS,
    approved_model_identity_policy: retained.approved_model_identity_policy,
    pricing: retained.pricing,
    allowed_content_classifications: [EXPLORER_CONTENT_CLASSIFICATION],
    owner_authority_binding: { path: authorityPath, sha256: authoritySnapshot.sha256 },
    retained_model_config_binding: { path: retainedModelConfigPath, sha256: retainedSnapshot.sha256 },
    fixed_request_policy: {
      policy_id: EXPLORER_MODEL_POLICY_ID,
      content_classification: EXPLORER_CONTENT_CLASSIFICATION,
      maximum_calls: EXPLORER_DECISION_LIMIT,
      maximum_input_tokens: EXPLORER_MAXIMUM_INPUT_TOKENS,
      maximum_output_tokens: EXPLORER_MAXIMUM_OUTPUT_TOKENS,
      initial_model_calls: model.calls,
      model_cost_cap_eur: authorityLimits!.model_cost_cap_eur,
      combined_cost_cap_eur: authorityLimits!.combined_actual_plus_reserved_cap_eur,
      per_call_reserved_eur: reservation.perCall,
      worst_case_reserved_eur: reservation.worstCase,
      prepared_cap_state_sha256: capSnapshot.sha256,
      prepared_model_ledger_sha256: ledgerSnapshot.sha256
    }
  });
  await writeExclusivePrivateJson(outputPath, config);
  return {
    run_id: runId,
    config_path: relative(repo, outputPath),
    maximum_calls: EXPLORER_DECISION_LIMIT,
    worst_case_reserved_eur: reservation.worstCase
  };
}
