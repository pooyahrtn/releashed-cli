import { lstat, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  EXPLORER_CONTENT_CLASSIFICATION,
  EXPLORER_DECISION_LIMIT,
  EXPLORER_MAXIMUM_INPUT_TOKENS,
  EXPLORER_MAXIMUM_OUTPUT_TOKENS
} from "./explorer-protocol.mjs";
import { combinedReservedAndActual, roundEur, sha256Text } from "./scaffold.mjs";

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

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validClassCounts(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((count) => Number.isSafeInteger(count) && count >= 0);
}

async function requireOrdinaryFile(path, label) {
  try {
    const metadata = await lstat(path);
    requireCondition(metadata.isFile() && !metadata.isSymbolicLink(), `${label} is not an ordinary file`);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("ordinary file")) throw error;
    throw new Error(`${label} is missing or unreadable`);
  }
}

async function readByteSnapshot(path, label) {
  await requireOrdinaryFile(path, label);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`${label} is missing or unreadable`);
  }
  return { bytes, sha256: sha256Text(bytes) };
}

async function readJsonSnapshot(path, label) {
  const snapshot = await readByteSnapshot(path, label);
  try {
    return { ...snapshot, value: JSON.parse(snapshot.bytes.toString("utf8")) };
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

function validateApprovedIdentityPolicy(policy, model) {
  requireCondition(
    exactKeys(policy, ["approved_alias", "approved_snapshots"]) &&
      typeof model === "string" && model.length > 0 &&
      policy.approved_alias === model &&
      Array.isArray(policy.approved_snapshots) && policy.approved_snapshots.length === 0,
    "Approved model identity policy has drifted from the frozen policy"
  );
}

function validateCompletePricing(pricing) {
  let sourceUrl;
  try {
    sourceUrl = new URL(pricing?.source_url);
  } catch {
    sourceUrl = null;
  }
  requireCondition(
    exactKeys(pricing, ["currency", "input_per_million_tokens", "cached_input_per_million_tokens", "output_per_million_tokens", "cache_write_reservation_multiplier_on_uncached_input", "accounting_rate", "source_url", "retrieved_date", "price_version"]) &&
    exactKeys(pricing.accounting_rate, ["usd", "eur", "reason"]) &&
      pricing.currency === "USD" &&
      finiteNonnegative(pricing.input_per_million_tokens) &&
      finiteNonnegative(pricing.cached_input_per_million_tokens) &&
      finiteNonnegative(pricing.output_per_million_tokens) &&
      finiteNonnegative(pricing.cache_write_reservation_multiplier_on_uncached_input) &&
      Number.isFinite(pricing.accounting_rate.usd) && pricing.accounting_rate.usd > 0 &&
      Number.isFinite(pricing.accounting_rate.eur) && pricing.accounting_rate.eur > 0 &&
      typeof pricing.accounting_rate.reason === "string" && pricing.accounting_rate.reason.length > 0 &&
      sourceUrl?.protocol === "https:" &&
      /^\d{4}-\d{2}-\d{2}$/.test(pricing.retrieved_date) &&
      typeof pricing.price_version === "string" && pricing.price_version.length > 0,
    "Model pricing has drifted from the complete frozen price record"
  );
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("Explorer model output could not be checked safely");
  }
}

function reservationFromPricing(pricing) {
  validateCompletePricing(pricing);
  const input = EXPLORER_MAXIMUM_INPUT_TOKENS * pricing.input_per_million_tokens * pricing.cache_write_reservation_multiplier_on_uncached_input / 1_000_000;
  const output = EXPLORER_MAXIMUM_OUTPUT_TOKENS * pricing.output_per_million_tokens / 1_000_000;
  const perCall = roundEur((input + output) * pricing.accounting_rate.eur / pricing.accounting_rate.usd);
  return { perCall, worstCase: roundEur(perCall * EXPLORER_DECISION_LIMIT) };
}

function parseLedger(body) {
  try {
    return body.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    throw new Error("Retained model ledger is invalid JSONL");
  }
}

function validateCurrentCapAndLedger({ cap, ledgerRows, runId }) {
  requireCondition(cap?.run_id === runId && cap.abort === null, "Current cap state is not usable for explorer decisions");
  requireCondition(Number.isFinite(Date.parse(cap.working_day_deadline)) && Date.parse(cap.working_day_deadline) > Date.now(), "Current working-day deadline has expired");
  requireCondition(cap.caps?.model_cost_cap_eur === FROZEN_CAPS.model_cost_cap_eur && cap.caps?.combined_actual_plus_reserved_cap_eur === FROZEN_CAPS.combined_actual_plus_reserved_cap_eur, "Current cap state does not retain the frozen cost caps");
  requireCondition(
    Number.isSafeInteger(cap.model?.calls) && cap.model.calls >= 0 &&
      Number.isSafeInteger(cap.model?.refused_before_dispatch) && cap.model.refused_before_dispatch >= 0 &&
      finiteNonnegative(cap.model?.actual_eur) && finiteNonnegative(cap.model?.outstanding_reservations_eur) &&
      Number.isSafeInteger(cap.app?.one_way_actions) && cap.app.one_way_actions >= 0 &&
      finiteNonnegative(cap.app?.actual_eur) && finiteNonnegative(cap.app?.outstanding_reservations_eur) &&
      validClassCounts(cap.app?.class_counts),
    "Current cap state contains invalid counters"
  );
  const reconciliations = ledgerRows.filter((row) => row.phase === "reconciliation");
  const reservations = ledgerRows.filter((row) => row.phase === "reservation");
  const refusals = ledgerRows.filter((row) => row.outcome === "refused-before-provider-dispatch");
  const actual = roundEur(reconciliations.reduce((sum, row) => sum + Number(row.actual_eur), 0));
  requireCondition(reconciliations.every((row) => finiteNonnegative(row.actual_eur) && row.reservation_within_bound === true && row.credential_exposed === false), "Retained model ledger contains an unsafe reconciliation");
  requireCondition(reservations.length === reconciliations.length && cap.model.calls === reconciliations.length && cap.model.refused_before_dispatch === refusals.length && cap.model.outstanding_reservations_eur === 0, "Current model counters do not match the retained ledger");
  requireCondition(Math.abs(cap.model.actual_eur - actual) < 1e-12, "Current model cost does not match the retained ledger");
}

function validateRetainedModel({ retained, authority, runId, runDirectory, capStatePath }) {
  const approval = authority?.model_broker_approval;
  requireCondition(authority?.status === "pass" && approval?.status === "approved-not-called" && approval.provider === "OpenAI" && approval.api === "Responses API" && typeof approval.model === "string" && approval.model.length > 0, "Frozen owner model authority is not approved");
  requireCondition(authority.limits?.model_cost_cap_eur === FROZEN_CAPS.model_cost_cap_eur && authority.limits?.combined_actual_plus_reserved_cap_eur === FROZEN_CAPS.combined_actual_plus_reserved_cap_eur, "Frozen owner authority does not retain the exact cost caps");
  requireCondition(exactKeys(retained, RETAINED_MODEL_CONFIG_KEYS), "Retained model configuration has unknown or missing fields");
  requireCondition(retained.run_id === runId && retained.run_directory === runDirectory && retained.cap_state_path === capStatePath, "Retained model configuration is not bound to this run");
  requireCondition(retained.model === approval.model && retained.minimum_output_tokens === 16, "Retained model identity or provider floor does not match frozen authority");
  validateApprovedIdentityPolicy(retained.approved_model_identity_policy, approval.model);
  validateCompletePricing(approval.pricing);
  validateCompletePricing(retained.pricing);
  requireCondition(JSON.stringify(retained.pricing) === JSON.stringify(approval.pricing), "Retained pricing does not match frozen authority");
  requireCondition(JSON.stringify(retained.allowed_content_classifications) === JSON.stringify(PRODUCTION_CLASSIFICATIONS), "Retained model classifications have drifted");
  return approval;
}

function validateBoundRetainedModel({ retained, config }) {
  requireCondition(exactKeys(retained, RETAINED_MODEL_CONFIG_KEYS), "Bound retained model configuration has unknown or missing fields");
  requireCondition(
    retained.run_id === config.run_id &&
      retained.run_directory === config.run_directory &&
      retained.cap_state_path === config.cap_state_path &&
      retained.model === config.model &&
      retained.minimum_output_tokens === 16 &&
      JSON.stringify(retained.approved_model_identity_policy) === JSON.stringify(config.approved_model_identity_policy) &&
      JSON.stringify(retained.pricing) === JSON.stringify(config.pricing) &&
      JSON.stringify(retained.allowed_content_classifications) === JSON.stringify(PRODUCTION_CLASSIFICATIONS),
    "Bound retained model policy does not match the prepared explorer policy"
  );
  validateApprovedIdentityPolicy(retained.approved_model_identity_policy, config.model);
  validateCompletePricing(retained.pricing);
}

function validateBoundAuthority({ authority, config }) {
  const approval = authority?.model_broker_approval;
  requireCondition(
    authority?.status === "pass" &&
      authority.limits?.model_cost_cap_eur === FROZEN_CAPS.model_cost_cap_eur &&
      authority.limits?.combined_actual_plus_reserved_cap_eur === FROZEN_CAPS.combined_actual_plus_reserved_cap_eur &&
      approval?.status === "approved-not-called" &&
      approval.provider === "OpenAI" &&
      approval.api === "Responses API" &&
      approval.model === config.model &&
      JSON.stringify(approval.pricing) === JSON.stringify(config.pricing),
    "Bound owner authority does not match the prepared explorer model policy"
  );
  validateCompletePricing(approval.pricing);
}

export function validateExplorerModelConfig(config) {
  requireCondition(exactKeys(config, EXPLORER_MODEL_CONFIG_KEYS), "Explorer model configuration has unknown or missing fields");
  requireCondition(typeof config.run_id === "string" && RUN_ID_PATTERN.test(config.run_id) && typeof config.run_directory === "string" && typeof config.cap_state_path === "string" && typeof config.model === "string" && config.model.length > 0, "Explorer model configuration is not bound to a model or run");
  validateApprovedIdentityPolicy(config.approved_model_identity_policy, config.model);
  validateCompletePricing(config.pricing);
  requireCondition(exactKeys(config.owner_authority_binding, RETAINED_BINDING_KEYS) && resolve(config.owner_authority_binding.path) === config.owner_authority_binding.path && /^[0-9a-f]{64}$/.test(config.owner_authority_binding.sha256 ?? ""), "Explorer model configuration lacks its owner-authority binding");
  requireCondition(exactKeys(config.retained_model_config_binding, RETAINED_BINDING_KEYS) && config.retained_model_config_binding.path === join(dirname(config.cap_state_path), "model-config.json") && /^[0-9a-f]{64}$/.test(config.retained_model_config_binding.sha256 ?? ""), "Explorer model configuration lacks its retained-policy binding");
  const policy = config.fixed_request_policy;
  requireCondition(exactKeys(policy, FIXED_POLICY_KEYS), "Explorer fixed-request policy has unknown or missing fields");
  requireCondition(
    policy.policy_id === EXPLORER_MODEL_POLICY_ID &&
      policy.content_classification === EXPLORER_CONTENT_CLASSIFICATION &&
      policy.maximum_calls === EXPLORER_DECISION_LIMIT &&
      policy.maximum_input_tokens === EXPLORER_MAXIMUM_INPUT_TOKENS &&
      policy.maximum_output_tokens === EXPLORER_MAXIMUM_OUTPUT_TOKENS &&
      Number.isSafeInteger(policy.initial_model_calls) && policy.initial_model_calls >= 0 &&
      policy.model_cost_cap_eur === FROZEN_CAPS.model_cost_cap_eur &&
      policy.combined_cost_cap_eur === FROZEN_CAPS.combined_actual_plus_reserved_cap_eur &&
      /^[0-9a-f]{64}$/.test(policy.prepared_cap_state_sha256 ?? "") &&
      /^[0-9a-f]{64}$/.test(policy.prepared_model_ledger_sha256 ?? ""),
    "Explorer fixed-request policy does not match the production decision contract"
  );
  requireCondition(config.minimum_output_tokens === EXPLORER_MAXIMUM_OUTPUT_TOKENS && JSON.stringify(config.allowed_content_classifications) === JSON.stringify([EXPLORER_CONTENT_CLASSIFICATION]), "Explorer model broker is not restricted to its exact output and content class");
  const reservation = reservationFromPricing(config.pricing);
  requireCondition(policy.per_call_reserved_eur === reservation.perCall && policy.worst_case_reserved_eur === reservation.worstCase, "Explorer model reservation does not match frozen pricing");
  return config;
}

export async function preflightExplorerModelConfig(config) {
  validateExplorerModelConfig(config);
  const [capSnapshot, ledgerSnapshot, retainedSnapshot, authoritySnapshot] = await Promise.all([
    readJsonSnapshot(config.cap_state_path, "Explorer cap state"),
    readByteSnapshot(join(config.run_directory, "model-ledger.jsonl"), "Explorer model ledger"),
    readJsonSnapshot(config.retained_model_config_binding.path, "Bound retained model configuration"),
    readJsonSnapshot(config.owner_authority_binding.path, "Bound owner authority")
  ]);
  const policy = config.fixed_request_policy;
  requireCondition(capSnapshot.sha256 === policy.prepared_cap_state_sha256 && ledgerSnapshot.sha256 === policy.prepared_model_ledger_sha256 && retainedSnapshot.sha256 === config.retained_model_config_binding.sha256 && authoritySnapshot.sha256 === config.owner_authority_binding.sha256, "Explorer model cap state, ledger, or retained policy changed after preparation");
  validateBoundAuthority({ authority: authoritySnapshot.value, config });
  validateBoundRetainedModel({ retained: retainedSnapshot.value, config });
  const cap = capSnapshot.value;
  validateCurrentCapAndLedger({ cap, ledgerRows: parseLedger(ledgerSnapshot.bytes.toString("utf8")), runId: config.run_id });
  requireCondition(cap.model.calls === policy.initial_model_calls, "Explorer model call baseline changed after preparation");
  requireCondition(cap.model.actual_eur + cap.model.outstanding_reservations_eur + policy.worst_case_reserved_eur <= FROZEN_CAPS.model_cost_cap_eur, "The full explorer decision budget no longer fits the model cap");
  requireCondition(combinedReservedAndActual(cap) + policy.worst_case_reserved_eur <= FROZEN_CAPS.combined_actual_plus_reserved_cap_eur, "The full explorer decision budget no longer fits the combined cap");
  return { cap, policy };
}

async function writeExclusivePrivateJson(path, value) {
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

export async function prepareExplorerModelRuntime({ repository, ownerDirectory, runId }) {
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
  const cap = capSnapshot.value;
  const retained = retainedSnapshot.value;
  const authority = authoritySnapshot.value;
  const inputManifest = inputManifestSnapshot.value;
  requireCondition(inputManifest?.run_id === runId && inputManifest.owner_inputs_sealed_before_broker_start === true && inputManifest.owner_input_hashes?.["authority-and-start.json"] === authoritySnapshot.sha256, "Frozen owner authority is not bound to the retained input manifest");
  const approval = validateRetainedModel({ retained, authority, runId, runDirectory, capStatePath });
  validateCurrentCapAndLedger({ cap, ledgerRows: parseLedger(ledgerSnapshot.bytes.toString("utf8")), runId });
  requireCondition(cap.caps.model_cost_cap_eur === authority.limits?.model_cost_cap_eur && cap.caps.combined_actual_plus_reserved_cap_eur === authority.limits?.combined_actual_plus_reserved_cap_eur, "Current cost caps do not match frozen owner authority");
  const reservation = reservationFromPricing(retained.pricing);
  requireCondition(cap.model.actual_eur + cap.model.outstanding_reservations_eur + reservation.worstCase <= FROZEN_CAPS.model_cost_cap_eur, "The full explorer decision budget does not fit the remaining model cap");
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
      initial_model_calls: cap.model.calls,
      model_cost_cap_eur: authority.limits.model_cost_cap_eur,
      combined_cost_cap_eur: authority.limits.combined_actual_plus_reserved_cap_eur,
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
