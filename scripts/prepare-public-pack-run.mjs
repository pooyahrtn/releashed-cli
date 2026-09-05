import { chmod, lstat, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_SCHEMA } from "../lib/public-pack-runtime.mjs";
import { readJson, sha256File, sha256Text } from "../lib/scaffold.mjs";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
// SHA-256 of the 62 sorted check IDs in retained run
// spike-a-live-calibration-20260903T164116Z, joined with one newline and no trailing newline.
const NON_MODEL_CHECK_IDS_SHA256 = "2aeceb5c0de853c679468a4fa0712305f490a4309a12fa54dcbe0ed7f61285d3";
const RETAINED_MODEL_CONFIG_KEYS = ["run_id", "run_directory", "cap_state_path", "model", "minimum_output_tokens", "approved_model_identity_policy", "pricing", "allowed_content_classifications"];
const PRODUCTION_CLASSIFICATIONS = [
  "generic-synthetic-non-target",
  "public-pack-text",
  "Synthetic visible app content from the disposable account after secret and personal-data checks."
];
const CALIBRATION_CHECK_IDS = new Set([
  "minimal_model_call_output_exact",
  "minimal_model_usage_complete",
  "minimal_model_cost_within_reservation",
  "returned_model_identity_matches_approved_alias_or_snapshot",
  "over_budget_request_refused_before_dispatch"
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function hasExactKeys(value, keys) {
  return !!value && typeof value === "object" && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

async function readRequiredJson(path, label) {
  try {
    return await readJson(path);
  } catch {
    throw new Error(`${label} is missing or invalid`);
  }
}

async function requiredHash(path, label) {
  try {
    return await sha256File(path);
  } catch {
    throw new Error(`${label} is missing or unreadable`);
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("A public-pack target could not be checked safely");
  }
}

async function requireExistingFile(path, label) {
  try {
    const metadata = await lstat(path);
    requireCondition(metadata.isFile() && !metadata.isSymbolicLink(), `${label} is not an ordinary retained file`);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("retained file")) throw error;
    throw new Error(`${label} is missing or invalid`);
  }
}

function validateReport(report, runId) {
  requireCondition(report?.run_id === runId, "Preflight report is not bound to the requested run");
  requireCondition(report.non_model_preflight === "pass", "Non-model preflight did not pass");
  const checkIds = Array.isArray(report.checks) ? report.checks.map((check) => check?.id) : [];
  const uniqueCheckIds = new Set(checkIds);
  requireCondition(checkIds.length === 62 && uniqueCheckIds.size === 62 && report.checks.every((check) => check?.pass === true) && sha256Text([...checkIds].sort().join("\n")) === NON_MODEL_CHECK_IDS_SHA256, "The retained non-model check identities or results are invalid");
  const calibrationChecks = report.model_calibration?.checks;
  requireCondition(report.model_calibration?.status === "pass" && Array.isArray(calibrationChecks) && calibrationChecks.length === CALIBRATION_CHECK_IDS.size, "Model calibration did not pass exactly five checks");
  requireCondition(new Set(calibrationChecks.map((check) => check?.id)).size === CALIBRATION_CHECK_IDS.size && calibrationChecks.every((check) => CALIBRATION_CHECK_IDS.has(check?.id) && check.pass === true), "Model calibration check identities or results are invalid");
  requireCondition(report.safe_to_start_public_pack_authoring === true, "Preflight did not authorize public-pack authoring");
  requireCondition(report.target_or_public_origin_accessed === false, "Preflight already accessed a target or public origin");
  requireCondition(report.public_pack_complete === false && report.safe_to_continue_to_pack === false && report.safe_to_continue_to_target === false, "A later-stage preflight flag is already set");
}

function validateCapState({ capState, retainedMetrics, report, authority, runId }) {
  const approvedReservation = authority?.model_broker_approval?.minimal_live_preflight?.worst_case_reserved_eur;
  requireCondition(Number.isFinite(approvedReservation) && approvedReservation >= 0, "Approved calibration reservation is invalid");
  requireCondition(capState?.run_id === runId && capState.abort === null && Number.isFinite(Date.parse(capState.working_day_deadline)) && Date.parse(capState.working_day_deadline) > Date.now(), "Actual cap state is not safe for this run");
  requireCondition(capState.caps?.model_cost_cap_eur === 18 && capState.caps?.model_cost_cap_eur === authority?.limits?.model_cost_cap_eur && capState.caps?.combined_actual_plus_reserved_cap_eur === 20 && capState.caps?.combined_actual_plus_reserved_cap_eur === authority?.limits?.combined_actual_plus_reserved_cap_eur, "Actual cap state does not retain the exact frozen cost caps");
  requireCondition(capState.model?.calls === 1 && capState.model?.refused_before_dispatch === 1 && capState.model?.outstanding_reservations_eur === 0, "Actual model call or reservation state is invalid");
  requireCondition(Number.isFinite(capState.model?.actual_eur) && capState.model.actual_eur >= 0 && capState.model.actual_eur <= approvedReservation, "Actual calibration cost exceeds its approved reservation");
  requireCondition(report.model_calibration?.actual_eur === capState.model.actual_eur, "Reported and actual calibration cost do not match");
  requireCondition(capState.app?.actual_eur === 0 && capState.app?.outstanding_reservations_eur === 0 && capState.app?.one_way_actions === 0, "Actual app-side cap state is not untouched");
  requireCondition(JSON.stringify(retainedMetrics) === JSON.stringify(capState), "Retained metrics and actual cap state do not match");
}

function validateRetainedBindings({ modelConfig, inputManifest, authority, runId, runDirectory, capStatePath }) {
  const model = authority?.model_broker_approval?.model;
  const publicPackModel = authority?.model_broker_approval?.public_pack_author?.model;
  const approvedPreflight = authority?.model_broker_approval?.minimal_live_preflight;
  requireCondition(inputManifest?.run_id === runId && inputManifest.owner_inputs_sealed_before_broker_start === true, "Run input manifest is not sealed for this run");
  requireCondition(hasExactKeys(modelConfig, RETAINED_MODEL_CONFIG_KEYS), "Retained model configuration has unknown or missing fields");
  requireCondition(modelConfig.run_id === runId && modelConfig.run_directory === runDirectory && modelConfig.cap_state_path === capStatePath, "Retained model configuration is not bound to the actual run cap state");
  requireCondition(typeof model === "string" && modelConfig.model === model && inputManifest.model === model && publicPackModel === model, "Retained model identities do not match");
  requireCondition(modelConfig.minimum_output_tokens === approvedPreflight?.maximum_output_tokens, "Retained model output floor does not match the frozen calibration");
  requireCondition(hasExactKeys(modelConfig.approved_model_identity_policy, ["approved_alias", "approved_snapshots"]) && modelConfig.approved_model_identity_policy.approved_alias === model && Array.isArray(modelConfig.approved_model_identity_policy.approved_snapshots) && modelConfig.approved_model_identity_policy.approved_snapshots.length === 0, "Retained approved-model policy is invalid");
  requireCondition(JSON.stringify(modelConfig.pricing) === JSON.stringify(authority?.model_broker_approval?.pricing), "Retained pricing does not match frozen authority");
  requireCondition(JSON.stringify(modelConfig.allowed_content_classifications) === JSON.stringify(PRODUCTION_CLASSIFICATIONS), "Retained model classifications are not the exact production list");
}

async function writeExclusivePrivateJson(path, value) {
  let created = false;
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
    await chmod(path, 0o600);
  } catch {
    if (created) await rm(path, { force: true }).catch(() => {});
    throw new Error("A generated public-pack configuration could not be created exclusively");
  }
}

export async function preparePublicPackRun({ repository, ownerDirectory, runId }) {
  requireCondition(typeof runId === "string" && RUN_ID_PATTERN.test(runId), "Run id must contain only letters, digits, and hyphens");
  const repo = resolve(repository);
  const owner = resolve(ownerDirectory);
  const runDirectory = join(repo, "runs", runId);
  const runtimeDirectory = join(repo, ".runtime", runId);
  const reportPath = join(runDirectory, "preflight", "report.json");
  const inputManifestPath = join(runDirectory, "input-manifest.json");
  const metricsPath = join(runDirectory, "metrics.json");
  const capStatePath = join(runtimeDirectory, "cap-state.json");
  const modelConfigPath = join(runtimeDirectory, "model-config.json");
  const authorityPath = join(owner, "authority-and-start.json");
  const originAllowlistPath = join(owner, "origin-allowlist.json");
  const canaryPath = join(runtimeDirectory, "sealed-public-pack-author-canary.txt");
  const publicFetchOutputDirectory = join(runtimeDirectory, "public-fetch");
  const publicInputMount = join(publicFetchOutputDirectory, "author-input");
  const packId = `public-pack-${runId}`;
  const outputDirectory = join(repo, "packs", packId);
  const publicPackModelConfigPath = join(runtimeDirectory, "public-pack-model-config.json");
  const configPath = join(runtimeDirectory, "public-pack-live-runtime.json");

  const targets = [publicPackModelConfigPath, configPath, publicFetchOutputDirectory, publicInputMount, outputDirectory];
  requireCondition(!(await Promise.all(targets.map(pathExists))).some(Boolean), "A public-pack target already exists");
  await Promise.all([
    requireExistingFile(reportPath, "Preflight report"),
    requireExistingFile(inputManifestPath, "Run input manifest"),
    requireExistingFile(metricsPath, "Retained metrics"),
    requireExistingFile(capStatePath, "Actual cap state"),
    requireExistingFile(modelConfigPath, "Retained model configuration"),
    requireExistingFile(authorityPath, "Frozen owner authority"),
    requireExistingFile(originAllowlistPath, "Frozen owner origin policy"),
    requireExistingFile(canaryPath, "Sealed author canary")
  ]);

  const [report, inputManifest, retainedMetrics, capState, modelConfig, authority, authorityHash, originHash] = await Promise.all([
    readRequiredJson(reportPath, "Preflight report"),
    readRequiredJson(inputManifestPath, "Run input manifest"),
    readRequiredJson(metricsPath, "Retained metrics"),
    readRequiredJson(capStatePath, "Actual cap state"),
    readRequiredJson(modelConfigPath, "Retained model configuration"),
    readRequiredJson(authorityPath, "Frozen owner authority"),
    requiredHash(authorityPath, "Frozen owner authority"),
    requiredHash(originAllowlistPath, "Frozen owner origin policy")
  ]);

  validateReport(report, runId);
  validateCapState({ capState, retainedMetrics, report, authority, runId });
  validateRetainedBindings({ modelConfig, inputManifest, authority, runId, runDirectory, capStatePath });
  requireCondition(inputManifest.owner_input_hashes?.["authority-and-start.json"] === authorityHash && inputManifest.owner_input_hashes?.["origin-allowlist.json"] === originHash, "Current frozen owner inputs do not match the retained run manifest");

  const publicPackModelConfig = {
    run_id: runId,
    run_directory: runDirectory,
    cap_state_path: capStatePath,
    model: modelConfig.model,
    minimum_output_tokens: authority.model_broker_approval.public_pack_author.maximum_output_tokens,
    approved_model_identity_policy: modelConfig.approved_model_identity_policy,
    pricing: modelConfig.pricing,
    allowed_content_classifications: ["public-pack-text"]
  };

  const config = {
    schema_version: 1,
    runtime_identity: RUNTIME_SCHEMA,
    mode: "one-shot-public-pack-author",
    run_id: runId,
    cap_state_path: capStatePath,
    owner_authority_path: authorityPath,
    owner_origin_allowlist_path: originAllowlistPath,
    model_config_path: publicPackModelConfigPath,
    author_request: { maximum_input_tokens: 32_000, maximum_output_tokens: 2_000 },
    public_fetch_output_directory: publicFetchOutputDirectory,
    public_input_mount: publicInputMount,
    output_directory: outputDirectory,
    pack_id: packId,
    isolation_canary_path: canaryPath
  };
  await writeExclusivePrivateJson(publicPackModelConfigPath, publicPackModelConfig);
  try {
    await writeExclusivePrivateJson(configPath, config);
  } catch (error) {
    await rm(publicPackModelConfigPath, { force: true });
    throw error;
  }
  const configRelativePath = relative(repo, configPath);
  requireCondition(configRelativePath === `.runtime/${runId}/public-pack-live-runtime.json`, "Prepared configuration path is not repository-local");
  return { run_id: runId, config_path: configRelativePath };
}

async function main() {
  const args = process.argv.slice(2);
  requireCondition(args.length === 2 && args[0] === "--run-id" && args[1], "Usage: node scripts/prepare-public-pack-run.mjs --run-id <run-id>");
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await preparePublicPackRun({ repository, ownerDirectory: resolve(repository, "../flow-map-lab-private/spike-a"), runId: args[1] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Public-pack preparation failed"}\n`);
    process.exitCode = 1;
  });
}
