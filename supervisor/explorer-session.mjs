import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSafeClerkAuthFailureCode, safeClerkBoundedRouteFailure } from "../lib/clerk-auth.mjs";
import { EXPLORER_MODEL_CONFIG_NAME, preflightExplorerModelConfig } from "../lib/explorer-model-runtime.mjs";
import { safeInitialNavigationFailurePoint } from "../lib/browser-runtime-limits.mjs";
import {
  EXPLORER_CONTENT_CLASSIFICATION,
  EXPLORER_MAXIMUM_INPUT_TOKENS,
  EXPLORER_MAXIMUM_OUTPUT_TOKENS
} from "../lib/explorer-protocol.mjs";
import { createExplorerSupervisorBridge } from "../lib/explorer-supervisor-bridge.mjs";
import { retireCompletedOwnerBundle } from "../lib/completed-owner-bundle-retirement.mjs";
import { classifyBoundedOnboardingControl, classifyObservedControl, preflightTargetRuntime } from "../lib/target-runtime.mjs";
import { readOnlySandboxProfile, runBoundedJsonlChild } from "../lib/bounded-child.mjs";
import { filesBelow, readJson, roundEur, writeExclusiveJson } from "../lib/scaffold.mjs";
import { browserBrokerEnvironment, BrokerProcess } from "./browser-broker-process.mjs";
import {
  createExclusiveEmptyBrowserProfile,
  removeOwnedBrowserProfile,
  revalidateOwnedBrowserProfile
} from "./browser-profile-custody.mjs";
import { bootstrapClerkAuthentication, preflightFreshClerkAuthentication } from "./clerk-bootstrap.mjs";
import { explorerModelBrokerEnvironment, ExplorerModelBrokerProcess } from "./model-broker-process.mjs";

const codeRepository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const CLERK_CLEANUP_WINDOW_MS = 70_000;
const CLERK_CLEANUP_RETRY_MS = 250;
const CLERK_CLEANUP_MAX_ATTEMPTS = 3;

function validModelRequest(payload) {
  return (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload).sort().join("\n") === ["content", "content_classification", "maximum_input_tokens", "maximum_output_tokens", "method"].sort().join("\n") &&
    payload?.method === "request" &&
    payload.content_classification === EXPLORER_CONTENT_CLASSIFICATION &&
    payload.maximum_input_tokens === EXPLORER_MAXIMUM_INPUT_TOKENS &&
    payload.maximum_output_tokens === EXPLORER_MAXIMUM_OUTPUT_TOKENS &&
    typeof payload.content === "string"
  );
}

export async function runSandboxedExplorer({
  config,
  bridge,
  requestModel,
  isolationProbe = null,
  absoluteDeadlineMs,
  timeoutMs = 15_000,
  retainFixtureTranscript = false
}) {
  if (process.platform !== "darwin") throw new Error("The Spike A explorer sandbox currently requires macOS sandbox-exec");
  const sourceFiles = await Promise.all([
    "sandbox/explorer.mjs",
    "lib/explorer-protocol.mjs",
    "lib/public-pack-schema.mjs"
  ].map((path) => realpath(join(codeRepository, path))));
  const publicPackPath = await realpath(config.public_pack.path);
  const nodePath = await realpath(process.execPath);
  const transcript = [];
  const modelRequests = [];
  let modelRequestCount = 0;
  let completion = null;
  let isolation = null;
  let nextRpcId = 1;
  let phase = isolationProbe ? "isolation" : "running";
  const boundHttpOrigin = config.target?.origin && new URL(config.target.origin).protocol === "http:" ? config.target.origin : null;
  const childEnvironment = {
    LANG: "C.UTF-8",
    FLOW_MAP_EXPLORER_PUBLIC_PACK: publicPackPath,
    FLOW_MAP_EXPLORER_PUBLIC_PACK_SHA256: config.public_pack.sha256,
    // config.target.origin was already checked against the private, owner-authored
    // origin-allowlist in lib/target-runtime.mjs -- a plain-HTTP origin here means this run is
    // genuinely bound to a non-HTTPS target (this lab's own local iteration target; a production
    // origin is always HTTPS), not an unvetted value. Passing the exact origin, rather than
    // relaxing the sandbox's own HTTPS check generally, keeps that exemption scoped to this one
    // run's one bound origin.
    ...(boundHttpOrigin ? { FLOW_MAP_EXPLORER_ALLOWED_HTTP_ORIGIN: boundHttpOrigin } : {}),
    ...(isolationProbe
      ? {
          SPIKE_A_TEST_ONLY_TARGET_FIXTURE: "1",
          FLOW_MAP_EXPLORER_TEST_ISOLATION: JSON.stringify(isolationProbe)
        }
      : {})
  };
  const processResult = await runBoundedJsonlChild({
    command: "/usr/bin/sandbox-exec",
    args: ["-p", readOnlySandboxProfile({ nodePath, readableFiles: [...sourceFiles, publicPackPath] }), nodePath, sourceFiles[0]],
    options: {
      cwd: "/",
      env: childEnvironment
    },
    timeoutMs: Math.max(1, Math.min(timeoutMs, absoluteDeadlineMs - Date.now())),
    label: "Explorer sandbox",
    async onMessage(message, child) {
      if (retainFixtureTranscript) transcript.push(message);
      if (message.kind === "explorer_isolation_check" && phase === "isolation") {
        isolation = message;
        phase = "running";
        return;
      }
      if (message.kind === "explorer_complete" && phase === "running") {
        completion = message;
        phase = "complete";
        return { complete: true };
      }
      if (message.kind === "explorer_failed_closed") throw new Error(`Explorer failed closed: ${message.reason}`);
      const expectedRpcId = `explorer-${String(nextRpcId).padStart(4, "0")}`;
      if (phase !== "running" || message.kind !== "rpc" || message.rpc_id !== expectedRpcId) throw new Error("Explorer returned a nonsequential protocol message");
      nextRpcId += 1;
      let response;
      if (message.broker === "supervisor") {
        response = await bridge(message.payload);
      } else if (message.broker === "model") {
        if (!validModelRequest(message.payload)) throw new Error("Explorer model request escaped the fixed decision contract");
        modelRequestCount += 1;
        if (retainFixtureTranscript) modelRequests.push(message.payload);
        response = await requestModel(message.payload, modelRequestCount);
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Explorer model broker returned an invalid response");
      } else {
        throw new Error("Explorer requested an unknown broker");
      }
      child.send({ rpc_id: message.rpc_id, response });
    }
  });
  if (processResult.exit.code !== 0 || !completion) throw new Error(`Explorer sandbox failed (${processResult.exit.code ?? processResult.exit.signal}): ${processResult.stderr.slice(0, 200)}`);
  if (isolationProbe && (!isolation?.source_and_private_file_read_denied || !isolation.direct_network_denied)) throw new Error("Explorer sandbox isolation proof failed");
  return { completion, isolation, transcript, modelRequests, modelRequestCount };
}

function browserRuntimeConfig({ config, actionLedger, registry }) {
  const boundedOnboarding = config.mode === "source-blind-bounded-onboarding-v1";
  return {
    run_id: config.run_id,
    run_directory: config.outputs.target_run_directory,
    startup_log_path: join(dirname(config.outputs.browser_config_path), "target-browser-startup.jsonl"),
    profile_directory: config.outputs.browser_profile_directory,
    cap_state_path: config.cap_state.path,
    initial_url: config.target.initial_url,
    allowed_navigation_origins: config.target.allowed_navigation_origins,
    allowed_request_origins: config.target.allowed_request_origins,
    suppressed_request_origins: config.target.suppressed_request_origins,
    runtime_mode: config.mode,
    ...(boundedOnboarding
      ? { auth_bootstrap_admissions: actionLedger.auth_bootstrap_admissions ?? [] }
      : {
          effect_registry: Object.fromEntries(registry.entries.filter((entry) => entry.action_class === "Listed own-account progress").map((entry) => [entry.effect_id, entry.effect_class_id])),
          reversible_action_registry: Object.fromEntries(registry.entries.filter((entry) => entry.action_class === "Reversible own-account").map((entry) => [entry.effect_id, entry.effect_class_id])),
          app_cost_ledger: actionLedger
        }),
    ...(config.test_only_local_fixture ? { transient_auth: config.transient_auth } : { clerk_auth: config.clerk_auth }),
    ...(config.saved_session ? { saved_session: config.saved_session } : {}),
    redact_private_effect_bindings: true
  };
}

/** Test-only composition of the real sandbox, bridge, and browser fixture. */
export async function runLocalExplorerFixtureSession({ configPath, repositoryRoot, scriptedModelResponder, isolationSourcePath }) {
  if (typeof scriptedModelResponder !== "function") throw new TypeError("A fixed scripted model responder is required");
  const { config, actionLedger, registry, fixtureAllowed } = await preflightTargetRuntime({ repository: repositoryRoot, configPath });
  if (!fixtureAllowed) throw new Error("Production explorer execution remains disabled");
  const isolationPaths = await Promise.all([isolationSourcePath, ...(config.target_action_registry ? [config.target_action_registry.path] : [])].map(async (path) => {
    if (typeof path !== "string" || !path) throw new Error("Explorer isolation probe path is missing");
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new Error("Explorer isolation probe path is not an ordinary file");
    return canonical;
  }));
  if (new Set(isolationPaths).size !== isolationPaths.length) throw new Error("Explorer isolation probe paths must be distinct");
  const sentinel = process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL;
  if (typeof sentinel !== "string" || sentinel.length < 16 || sentinel.length > 512 || /[\r\n]/.test(sentinel)) throw new Error("A bounded transient authentication sentinel is required");
  delete process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL;
  const absoluteDeadlineMs = Date.parse(config.cap_state.binding.working_day_deadline);
  await mkdir(config.outputs.target_run_directory, { recursive: false, mode: 0o700 });
  const browserConfig = browserRuntimeConfig({ config, actionLedger, registry });
  await writeExclusiveJson(config.outputs.browser_config_path, browserConfig);
  await mkdir(config.outputs.browser_profile_directory, { recursive: false, mode: 0o700 });
  const browser = new BrokerProcess(join(codeRepository, "supervisor", "browser-broker.mjs"), config.outputs.browser_config_path, absoluteDeadlineMs);
  let explorer;
  try {
    await browser.ready;
    const auth = await browser.call({ method: "install_transient_auth", sentinel });
    if (!auth.ok || auth.consumed !== true) throw new Error("Supervisor could not consume fixture authentication");
    const bootstrap = await browser.call({ method: "navigate", action_class: "Observe", url: config.target.initial_url });
    if (!bootstrap.ok) throw new Error("Supervisor could not open the exact fixture page");
    const cleared = await browser.call({ method: "clear_transient_auth" });
    if (!cleared.ok || cleared.cleared !== true) throw new Error("Supervisor could not clear fixture authentication");
    const bridge = createExplorerSupervisorBridge({
      callBrowser: (payload, caller) => browser.call(payload, caller),
      mode: config.mode,
      classifyControl: (request) => config.mode === "source-blind-bounded-onboarding-v1"
        ? classifyBoundedOnboardingControl({ scopeHref: request.observed.url, ...request })
        : classifyObservedControl({ registry, ...request })
    });
    explorer = await runSandboxedExplorer({
      config,
      bridge,
      requestModel: async (payload, count) => {
        const output = await scriptedModelResponder(payload, count);
        if (typeof output !== "string") throw new Error("Scripted model responder must return JSON text");
        return { ok: true, output };
      },
      isolationProbe: {
        forbidden_paths: isolationPaths,
        network_url: `${config.target.origin}/explorer-network-canary`
      },
      absoluteDeadlineMs,
      retainFixtureTranscript: true
    });
  } finally {
    try {
      await browser.stop();
    } finally {
      await rm(config.outputs.browser_profile_directory, { recursive: true, force: true });
    }
  }
  const retainedFiles = [config.outputs.browser_config_path, browserConfig.startup_log_path, ...(await filesBelow(config.outputs.target_run_directory))];
  const authAbsent = !(await Promise.all(retainedFiles.map((path) => readFile(path).then((body) => body.includes(Buffer.from(sentinel)))))).some(Boolean) && !JSON.stringify(explorer.transcript).includes(sentinel);
  if (!authAbsent) throw new Error("Transient fixture authentication leaked into retained evidence or explorer protocol");
  return {
    result: explorer.completion.result,
    public_pack_sha256: explorer.completion.public_pack_sha256,
    isolation: explorer.isolation,
    transcript: explorer.transcript,
    model_requests: explorer.modelRequests,
    target_run_directory: config.outputs.target_run_directory,
    transient_auth_absent: authAbsent
  };
}

export function productionExplorerConfigPaths(repositoryRoot, runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) throw new Error("Production explorer run id is invalid");
  const repository = resolve(repositoryRoot);
  const runtimeDirectory = join(repository, ".runtime", runId);
  return {
    target: join(runtimeDirectory, "target-session-config.json"),
    model: join(runtimeDirectory, EXPLORER_MODEL_CONFIG_NAME)
  };
}

export function productionExplorerTimeoutMs(config, now = Date.now()) {
  const deadline = Date.parse(config?.cap_state?.binding?.working_day_deadline);
  const browserSeconds = config?.cap_state?.binding?.caps?.browser_active_seconds;
  if (!Number.isFinite(deadline) || !Number.isFinite(browserSeconds) || browserSeconds <= 0) throw new Error("Production explorer deadline is invalid");
  const remaining = Math.min(deadline - now, browserSeconds * 1_000);
  if (remaining <= 0) throw new Error("Production explorer deadline has expired");
  return Math.floor(remaining);
}

async function readPrivateConfig(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) throw new Error("Explorer model configuration must be an ordinary mode-0600 file");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Explorer model configuration is invalid JSON");
  }
}

function validateProductionBindings({ target, modelConfig, modelPreflight }) {
  const { config, registry, fixtureAllowed } = target;
  // preflightTargetRuntime already requires clerk_auth for every shape except an explicit
  // bounded-onboarding anonymous config (no fixture, no Clerk phase), so its absence here is
  // not itself a sign of a fixture/test config.
  if (fixtureAllowed || config.test_only_local_fixture) throw new Error("Production explorer requires the exact production target configuration");
  if (config.mode !== "source-blind-bounded-onboarding-v1" && (!Array.isArray(registry?.entries) || registry.entries.length === 0)) throw new Error("Production explorer requires a nonempty frozen action registry");
  if (
    modelConfig.run_id !== config.run_id ||
    modelConfig.cap_state_path !== config.cap_state.path ||
    modelConfig.run_directory !== dirname(config.model_ledger.path) ||
    modelConfig.fixed_request_policy?.prepared_cap_state_sha256 !== config.cap_state.sha256 ||
    modelConfig.fixed_request_policy?.prepared_model_ledger_sha256 !== config.model_ledger.sha256 ||
    modelPreflight?.policy?.prepared_cap_state_sha256 !== config.cap_state.sha256 ||
    modelPreflight?.policy?.prepared_model_ledger_sha256 !== config.model_ledger.sha256
  ) throw new Error("Production target and explorer model configurations are not bound to the same untouched run");
}

function safeCleanup(value, defaultComplete = false) {
  return {
    cleanup_complete: value?.cleanup_complete === true || (value === null && defaultComplete),
    session_reconciled: value?.session_reconciled === true || (value === null && defaultComplete),
    run_session_revoked: value?.run_session_revoked === true,
    unused_sign_in_token_revoked: value?.unused_sign_in_token_revoked === true
  };
}

const GENERIC_PRODUCTION_FAILURE_CODES = Object.freeze({
  "create-outputs": "output_creation_failed",
  "pre-authentication": "clerk_auth_preflight_failed",
  "browser-start": "browser_start_failed",
  "model-start": "model_start_failed",
  "initial-navigation": "initial_navigation_failed",
  authentication: "clerk_auth_failed",
  exploration: "exploration_failed"
});

function completedOwnerBundleDirectory(target, runId) {
  if (!target.boundedOnboarding) return null;
  const entries = Object.entries(target.config.private_owner_inputs);
  const directories = new Set(entries.map(([, binding]) => dirname(resolve(binding.path))));
  if (directories.size !== 1) throw new Error("Production target is not bound to one completed owner bundle");
  const [bundleDirectory] = directories;
  if (
    basename(bundleDirectory) !== runId ||
    entries.some(([name, binding]) => resolve(binding.path) !== join(bundleDirectory, name))
  ) throw new Error("Production target is not bound to the exact completed owner bundle");
  return bundleDirectory;
}

function safeProductionFailureCode(stage, error) {
  const diagnostic = error?.calibration_failure_code;
  if (
    stage === "authentication" &&
    (isSafeClerkAuthFailureCode(diagnostic) || diagnostic === "clerk_sign_in_token_mint_outcome_unknown")
  ) return diagnostic;
  return GENERIC_PRODUCTION_FAILURE_CODES[stage] ?? null;
}

function safeProductionFailureSubdiagnostic(stage, error) {
  if (stage !== "authentication") return null;
  return safeClerkBoundedRouteFailure(
    error?.calibration_failure_substage,
    error?.calibration_failure_subcode,
    error?.calibration_failure_point ?? null
  );
}

async function settleAttachedClerkCleanup({
  cleanupHandle,
  browserStopped,
  absoluteDeadlineMs,
  timing = {}
}) {
  if (typeof cleanupHandle !== "function") return safeCleanup(cleanupHandle);
  const now = timing.now ?? (() => Date.now());
  const wait = timing.wait ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const cleanupDeadlineAt = Math.min(absoluteDeadlineMs, now() + CLERK_CLEANUP_WINDOW_MS);
  let last = safeCleanup(null);
  for (let attempt = 0; attempt < CLERK_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
    if (now() >= cleanupDeadlineAt) break;
    try {
      last = safeCleanup(await cleanupHandle({ browserStopped, cleanupDeadlineAt }));
    } catch {
      last = safeCleanup(null);
    }
    if (last.cleanup_complete) return last;
    if (attempt + 1 >= CLERK_CLEANUP_MAX_ATTEMPTS) break;
    const remaining = cleanupDeadlineAt - now();
    if (remaining <= 0) break;
    try {
      await wait(Math.min(CLERK_CLEANUP_RETRY_MS, remaining));
    } catch {
      break;
    }
  }
  return last;
}

async function stopBroker(broker) {
  if (!broker) return true;
  try {
    await broker.stop();
    return true;
  } catch {
    return false;
  }
}

function reconciledModelLedger(rows, finalCap) {
  if (!Array.isArray(rows)) return false;
  const reservations = rows.filter((row) => row?.phase === "reservation");
  const reconciliations = rows.filter((row) => row?.phase === "reconciliation");
  const refusals = rows.filter((row) => row?.outcome === "refused-before-provider-dispatch");
  const actual = roundEur(reconciliations.reduce((sum, row) => sum + Number(row.actual_eur), 0));
  return (
    reservations.length === reconciliations.length &&
    reconciliations.length === finalCap?.model?.calls &&
    refusals.length === finalCap?.model?.refused_before_dispatch &&
    reconciliations.every((row) => Number.isFinite(row.actual_eur) && row.actual_eur >= 0 && row.reservation_within_bound === true && row.credential_exposed === false) &&
    Math.abs(actual - finalCap.model.actual_eur) < 1e-12
  );
}

function costSummary({ initialCap, finalCap, finalModelLedger, modelRequestCount }) {
  const initialClassCounts = initialCap?.app?.class_counts;
  const finalClassCounts = finalCap?.app?.class_counts;
  const exactCaps = JSON.stringify(finalCap?.caps) === JSON.stringify(initialCap?.caps);
  const exactDeadline = finalCap?.working_day_deadline === initialCap?.working_day_deadline;
  const classCountsMonotonic =
    !!initialClassCounts && typeof initialClassCounts === "object" && !Array.isArray(initialClassCounts) &&
    !!finalClassCounts && typeof finalClassCounts === "object" && !Array.isArray(finalClassCounts) &&
    Object.entries(initialClassCounts).every(([id, count]) => Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(finalClassCounts[id]) && finalClassCounts[id] >= count) &&
    Object.values(finalClassCounts).every((count) => Number.isSafeInteger(count) && count >= 0);
  const valid =
    finalCap?.run_id === initialCap?.run_id &&
    exactDeadline &&
    exactCaps &&
    finalCap?.abort === null &&
    Number.isSafeInteger(finalCap?.model?.calls) &&
    Number.isSafeInteger(initialCap?.model?.calls) &&
    finalCap.model.calls - initialCap.model.calls === modelRequestCount &&
    finalCap.model.refused_before_dispatch === initialCap.model.refused_before_dispatch &&
    Number.isFinite(finalCap.model.actual_eur) &&
    Number.isFinite(initialCap.model.actual_eur) &&
    finalCap.model.actual_eur >= initialCap.model.actual_eur &&
    finalCap.model.outstanding_reservations_eur === 0 &&
    reconciledModelLedger(finalModelLedger, finalCap) &&
    Number.isSafeInteger(finalCap?.app?.one_way_actions) &&
    Number.isSafeInteger(initialCap?.app?.one_way_actions) &&
    finalCap.app.one_way_actions >= initialCap.app.one_way_actions &&
    classCountsMonotonic &&
    Object.values(finalClassCounts).reduce((sum, count) => sum + count, 0) === finalCap.app.one_way_actions &&
    Number.isFinite(finalCap?.app?.actual_eur) &&
    Number.isFinite(initialCap?.app?.actual_eur) &&
    finalCap.app.actual_eur >= initialCap.app.actual_eur &&
    finalCap.app.outstanding_reservations_eur === 0 &&
    finalCap.app.actual_eur <= finalCap.caps?.app_side_cost_cap_eur &&
    finalCap.model.actual_eur <= finalCap.caps?.model_cost_cap_eur &&
    finalCap.model.actual_eur + finalCap.app.actual_eur <= finalCap.caps?.combined_actual_plus_reserved_cap_eur;
  return {
    consistent: valid,
    model_calls: valid ? modelRequestCount : null,
    model_actual_eur: valid ? roundEur(finalCap.model.actual_eur - initialCap.model.actual_eur) : null,
    app_one_way_actions: valid ? finalCap.app.one_way_actions - initialCap.app.one_way_actions : null,
    app_actual_eur: valid ? roundEur(finalCap.app.actual_eur - initialCap.app.actual_eur) : null,
    outstanding_reservations_eur: Number.isFinite(finalCap?.model?.outstanding_reservations_eur) && Number.isFinite(finalCap?.app?.outstanding_reservations_eur)
      ? roundEur(finalCap.model.outstanding_reservations_eur + finalCap.app.outstanding_reservations_eur)
      : null
  };
}

function eligibleExplorerResult(result) {
  return result?.status === "done" || (result?.status === "halted" && result.stop_reason === "decision_limit");
}

/**
 * Production composition only. Tests inject production-shaped local boundaries;
 * the default dependencies are the real brokers and Clerk lifecycle.
 */
async function runProductionExplorerSessionCore({
  runId,
  repositoryRoot = codeRepository,
  environment = process.env,
  clerkFetch = fetch,
  runtimeDependencies = {}
}) {
  const repository = resolve(repositoryRoot);
  const paths = productionExplorerConfigPaths(repository, runId);
  const target = await preflightTargetRuntime({ repository, configPath: paths.target });
  const modelConfig = await readPrivateConfig(paths.model);
  const checkedModel = await preflightExplorerModelConfig(modelConfig);
  validateProductionBindings({ target, modelConfig, modelPreflight: checkedModel });

  const { config, actionLedger, registry, clerkUserId } = target;
  // An anonymous bounded run (no clerk_auth) never binds a disposable identity, so it has no
  // "completed owner bundle" to locate or retire later -- that concept is identity-only.
  const ownerBundleDirectory = config.clerk_auth ? completedOwnerBundleDirectory(target, runId) : null;
  const absoluteDeadlineMs = Date.parse(config.cap_state.binding.working_day_deadline);
  const preflightAuthentication = runtimeDependencies.preflightFreshClerkAuthentication ?? preflightFreshClerkAuthentication;

  const browserConfig = browserRuntimeConfig({ config, actionLedger, registry });
  const browserEnvironment = browserBrokerEnvironment(environment);
  const modelEnvironment = explorerModelBrokerEnvironment(environment);
  let clerkSecret = environment.CLERK_SECRET_KEY;
  delete environment.CLERK_SECRET_KEY;
  const createBrowser = runtimeDependencies.createBrowser ?? ((configPath, deadline, options) => new BrokerProcess(join(codeRepository, "supervisor", "browser-broker.mjs"), configPath, deadline, options));
  const createModel = runtimeDependencies.createModel ?? ((configPath, deadline, options) => new ExplorerModelBrokerProcess(configPath, deadline, options));
  const authenticate = runtimeDependencies.bootstrapClerkAuthentication ?? bootstrapClerkAuthentication;
  const explore = runtimeDependencies.runSandboxedExplorer ?? runSandboxedExplorer;
  const retireIdentity = runtimeDependencies.retireCompletedOwnerBundle ?? retireCompletedOwnerBundle;

  let runDirectoryOwned = false;
  let profileOwnership = null;
  let legacyProfileOwned = false;
  let browser = null;
  let model = null;
  let auth = null;
  let attachedCleanup = null;
  let explorer = null;
  let modelRequestCount = 0;
  let failureStage = null;
  let failureCode = null;
  let failureSubstage = null;
  let failureSubcode = null;
  let failurePoint = null;
  let modelStopped = true;
  let browserStopped = true;
  let profileDeleted = false;
  let authCleanup = safeCleanup(null);
  let identityRetirementConfirmed = false;

  try {
    failureStage = "create-outputs";
    await mkdir(config.outputs.target_run_directory, { recursive: false, mode: 0o700 });
    runDirectoryOwned = true;
    if (target.boundedOnboarding) {
      profileOwnership = await createExclusiveEmptyBrowserProfile(config.outputs.browser_profile_directory);
      await writeExclusiveJson(config.outputs.browser_config_path, {
        ...browserConfig,
        profile_directory: profileOwnership.path,
        profile_ownership: profileOwnership
      });
    } else {
      await writeExclusiveJson(config.outputs.browser_config_path, browserConfig);
      await mkdir(config.outputs.browser_profile_directory, { recursive: false, mode: 0o700 });
      legacyProfileOwned = true;
    }

    if (target.boundedOnboarding && config.clerk_auth) {
      failureStage = "pre-authentication";
      await preflightAuthentication({
        expectedUserId: clerkUserId,
        expectedFrontendOrigin: config.clerk_auth.frontend_api_origin,
        workingDayDeadline: config.cap_state.binding.working_day_deadline,
        environment: { CLERK_SECRET_KEY: clerkSecret },
        fetchImpl: clerkFetch,
        approvedDisposableIdentity: target.clerkIdentity
      });
    }
    // Before ticket mint, a successful fresh preflight proves that this run has no Clerk
    // session or token to reconcile. Legacy mode has not minted one yet, and an anonymous
    // bounded run (no clerk_auth) never mints one at all.
    authCleanup = safeCleanup(null, true);

    failureStage = "browser-start";
    if (profileOwnership) await revalidateOwnedBrowserProfile(profileOwnership, { requireEmpty: true });
    browser = createBrowser(config.outputs.browser_config_path, absoluteDeadlineMs, { environment: { ...browserEnvironment } });
    browserStopped = false;
    await browser.ready;

    // The model broker validates the untouched prepared cap/ledger at startup.
    // Browser navigation mutates those counters, so model readiness must precede it.
    failureStage = "model-start";
    model = createModel(paths.model, absoluteDeadlineMs, { environmentSource: { ...modelEnvironment } });
    modelStopped = false;
    await model.ready;

    failureStage = "initial-navigation";
    const navigation = await browser.call({ method: "navigate", action_class: "Observe", url: config.target.initial_url });
    if (!navigation?.ok) {
      const error = new Error("Initial target navigation was refused");
      Object.defineProperty(error, "initial_navigation_failure_point", { value: navigation?.failure_point ?? null });
      throw error;
    }

    // An anonymous bounded run has no clerk_auth policy to authenticate against at all --
    // it goes straight from the initial navigation into exploration as a signed-out visitor.
    if (config.clerk_auth) {
      failureStage = "authentication";
      authCleanup = safeCleanup(null);
      try {
        auth = await authenticate({
          browser,
          expectedUserId: clerkUserId,
          expectedFrontendOrigin: config.clerk_auth.frontend_api_origin,
          workingDayDeadline: config.cap_state.binding.working_day_deadline,
          environment: { CLERK_SECRET_KEY: clerkSecret },
          fetchImpl: clerkFetch,
          deferFailureCleanup: true,
          ...(target.boundedOnboarding
            ? {
                requireFreshAuth: true,
                approvedDisposableIdentity: target.clerkIdentity
              }
            : {})
        });
      } catch (error) {
        attachedCleanup = error?.cleanup ?? null;
        throw error;
      }
    }

    failureStage = "exploration";
    const bridge = createExplorerSupervisorBridge({
      callBrowser: (payload, caller) => browser.call(payload, caller),
      mode: config.mode,
      classifyControl: (request) => config.mode === "source-blind-bounded-onboarding-v1"
        ? classifyBoundedOnboardingControl({ scopeHref: request.observed.url, ...request })
        : classifyObservedControl({ registry, ...request })
    });
    explorer = await explore({
      config,
      bridge,
      requestModel: (payload) => model.call(payload),
      absoluteDeadlineMs,
      timeoutMs: productionExplorerTimeoutMs(config),
      retainFixtureTranscript: false
    });
    modelRequestCount = explorer.modelRequestCount;
    failureStage = null;
  } catch (error) {
    // Retain only fixed stage/code enums, never raw errors or provider values.
    failureCode = safeProductionFailureCode(failureStage, error);
    const subdiagnostic = safeProductionFailureSubdiagnostic(failureStage, error);
    failureSubstage = subdiagnostic?.stage ?? null;
    failureSubcode = subdiagnostic?.code ?? null;
    failurePoint = subdiagnostic?.point ?? (
      failureStage === "initial-navigation"
        ? safeInitialNavigationFailurePoint(error?.initial_navigation_failure_point)
        : null
    );
  } finally {
    modelStopped = await stopBroker(model);
    browserStopped = await stopBroker(browser);
    const cleanupHandle = auth?.cleanup ?? attachedCleanup;
    if (cleanupHandle) {
      authCleanup = await settleAttachedClerkCleanup({
        cleanupHandle,
        browserStopped,
        absoluteDeadlineMs,
        timing: runtimeDependencies.clerkCleanupTiming
      });
    } else if (failureStage === "authentication") {
      authCleanup = safeCleanup(null);
    }
    if (profileOwnership) {
      try {
        profileDeleted = await removeOwnedBrowserProfile(profileOwnership, browserStopped);
      } catch {
        profileDeleted = false;
      }
    } else if (legacyProfileOwned && browserStopped) {
      try {
        await rm(config.outputs.browser_profile_directory, { recursive: true, force: true });
        profileDeleted = !(await lstat(config.outputs.browser_profile_directory).catch(() => null));
      } catch {}
    }
    if (ownerBundleDirectory !== null) {
      try {
        const receipt = await retireIdentity({
          bundleDirectory: ownerBundleDirectory,
          runId,
          environment: { CLERK_SECRET_KEY: clerkSecret },
          fetchImpl: clerkFetch
        });
        identityRetirementConfirmed = receipt?.status === "retired";
      } catch {
        identityRetirementConfirmed = false;
      }
    } else if (target.boundedOnboarding && !config.clerk_auth) {
      // An anonymous bounded run never bound an identity, so there is nothing to retire.
      // Legacy mode still falls through here with no identity concept at all -- leave its
      // existing "always incomplete" behavior untouched.
      identityRetirementConfirmed = true;
    }
    clerkSecret = null;
  }

  if (!runDirectoryOwned) throw new Error("Production explorer outputs could not be created exclusively");
  let finalCap = null;
  let finalModelLedger = null;
  try {
    finalCap = await readJson(config.cap_state.path);
  } catch {}
  try {
    finalModelLedger = (await readFile(config.model_ledger.path, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {}
  const costs = costSummary({ initialCap: checkedModel.cap, finalCap, finalModelLedger, modelRequestCount });
  let resultRetained = false;
  if (explorer?.completion?.result) {
    try {
      await writeExclusiveJson(join(config.outputs.target_run_directory, "explorer-result.json"), explorer.completion.result);
      resultRetained = true;
    } catch {}
  }
  const explorerEligible = eligibleExplorerResult(explorer?.completion?.result);
  const reasons = [];
  if (failureStage) reasons.push("run-failed");
  if (!explorerEligible || !resultRetained) reasons.push("exploration-incomplete");
  if (!modelStopped || !browserStopped || !profileDeleted) reasons.push("teardown-incomplete");
  if (!authCleanup.cleanup_complete) reasons.push("clerk-cleanup-incomplete");
  if (!identityRetirementConfirmed) reasons.push("identity-retirement-incomplete");
  if (!costs.consistent) reasons.push("cost-reconciliation-incomplete");
  const nonPublishableReasons = [...new Set(reasons)];
  const candidateEligible = nonPublishableReasons.length === 0;
  const report = {
    schema_version: 1,
    run_id: config.run_id,
    public_pack_sha256: config.public_pack.sha256,
    status: candidateEligible ? "completed" : "failed",
    explorer_status: explorer?.completion?.result?.status ?? "not-started",
    explorer_stop_reason: explorer?.completion?.result?.stop_reason ?? null,
    model_calls: costs.model_calls,
    model_actual_eur: costs.model_actual_eur,
    app_one_way_actions: costs.app_one_way_actions,
    app_actual_eur: costs.app_actual_eur,
    outstanding_reservations_eur: costs.outstanding_reservations_eur,
    model_stopped: modelStopped,
    browser_stopped: browserStopped,
    profile_deleted: profileDeleted,
    auth_cleanup_complete: authCleanup.cleanup_complete,
    identity_retirement_confirmed: identityRetirementConfirmed,
    cleanup_complete: authCleanup.cleanup_complete && identityRetirementConfirmed === true,
    // Owner-authored admission ids only (see admitPrivateAuthBootstrapMutation in
    // browser-broker.mjs) — never a URL. A reader resolves id -> URL via the
    // private ledger file whose sha256 this report's input manifest already binds.
    auth_bootstrap_admissions: finalCap?.browser?.auth_bootstrap_admissions ?? {},
    // Sanitised reason code + operation type + timestamp for the most recent browser-broker
    // refusal, if any -- see recordRefusal() in browser-broker.mjs. Surfaced here so a refused
    // (not aborted) explorer operation is visible without archaeology across .runtime files.
    last_refusal: finalCap?.browser?.refusals?.at(-1) ?? null,
    candidate_eligible: candidateEligible,
    non_publishable_reasons: nonPublishableReasons,
    failure_stage: failureStage,
    failure_code: failureCode,
    failure_substage: failureSubstage,
    failure_subcode: failureSubcode,
    failure_point: failurePoint
  };
  await writeExclusiveJson(join(config.outputs.target_run_directory, "production-run-report.json"), report);
  return report;
}

export function runProductionExplorerSession({ runId, repositoryRoot = codeRepository }) {
  return runProductionExplorerSessionCore({ runId, repositoryRoot, environment: process.env, clerkFetch: fetch, runtimeDependencies: {} });
}

/** Production-shaped integration seam. Never enabled by the production CLI. */
export function runProductionExplorerSessionForTest(options) {
  if (process.env.SPIKE_A_TEST_ONLY_PRODUCTION_RUNNER !== "1") throw new Error("Production explorer test dependencies are disabled");
  return runProductionExplorerSessionCore({ ...options, runtimeDependencies: options.runtimeDependencies });
}

export { createExclusiveEmptyBrowserProfile, removeOwnedBrowserProfile, revalidateOwnedBrowserProfile };
