#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freshCapState, writeExclusiveJson } from "../lib/scaffold.mjs";
import { isSafeClerkAuthFailureCode } from "../lib/clerk-auth.mjs";
import { BrokerProcess } from "../supervisor/browser-broker-process.mjs";
import { provisionDisposableClerkIdentity } from "../supervisor/clerk-bootstrap.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOwnerDirectory = resolve(repository, "../flow-map-lab-private/spike-a");
const defaultSelectionTimeoutMs = 180_000;
const maximumSelectionBytes = 2_048;
const inputRemainders = new WeakMap();

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function exactOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The frozen origin policy is invalid");
  }
  return url.origin;
}

export function sanitizeObservedUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("The observed URL is invalid");
  url.search = "";
  url.hash = "";
  const identifier = /^(?:user|sess|sit)_[A-Za-z0-9_-]+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^eyJ[A-Za-z0-9_-]+$/i;
  url.pathname = url.pathname.split("/").map((part) => {
    try { return identifier.test(decodeURIComponent(part)) ? ":redacted" : part; } catch { return ":redacted"; }
  }).join("/");
  return url.href;
}

export function sanitizeVisibleText(value, sensitiveValues = []) {
  let text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive === "string" && sensitive.length >= 4) text = text.split(sensitive).join("[redacted]");
  }
  text = text
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, "[redacted-email]")
    .replace(/\b(?:user|sess|sit)_[A-Za-z0-9_-]+\b/g, "[redacted-id]")
    .replace(/\beyJ[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, "[redacted-token]");
  while (Buffer.byteLength(text) > 160) text = text.slice(0, -1);
  return text;
}

async function loadFrozenPolicy(ownerDirectory = defaultOwnerDirectory) {
  const path = join(resolve(ownerDirectory), "origin-allowlist.json");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("The frozen origin policy is unavailable");
  const policy = JSON.parse(await readFile(path, "utf8"));
  if (policy?.status !== "pass") throw new Error("The frozen origin policy is not approved");
  const targetOrigin = exactOrigin(policy?.deployed_origins?.learner_app);
  const allowed = policy?.browser_request_dispatch?.allow ?? [];
  const clerkRows = allowed.filter((entry) => typeof entry?.purpose === "string" && /Clerk frontend\/auth session transport only/i.test(entry.purpose));
  if (clerkRows.length !== 1) throw new Error("The frozen policy does not identify one Clerk frontend origin");
  const clerkFrontendOrigin = exactOrigin(clerkRows[0].origin);
  const allowedRequestOrigins = allowed.map((entry) => exactOrigin(entry.origin));
  const suppressedOrigins = (policy?.browser_request_dispatch?.recognized_but_suppress_before_dispatch ?? []).map((entry) => exactOrigin(entry.origin));
  if (!allowedRequestOrigins.includes(targetOrigin) || !allowedRequestOrigins.includes(clerkFrontendOrigin)) throw new Error("The frozen origin policy is incomplete");
  return {
    targetOrigin,
    initialUrl: `${targetOrigin}/`,
    clerkFrontendOrigin,
    allowedRequestOrigins,
    allowedNavigationOrigins: [targetOrigin],
    suppressedOrigins
  };
}

function writeRow(output, value) {
  output.write(`${JSON.stringify(value)}\n`);
}

export async function writeRecoveryRecord(path, value, { exclusive = false } = {}) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function readLine(input, timeoutMs) {
  const retained = inputRemainders.get(input) ?? "";
  const newline = retained.indexOf("\n");
  if (newline >= 0) {
    inputRemainders.set(input, retained.slice(newline + 1));
    return { state: "line", line: retained.slice(0, newline).trim() };
  }
  return new Promise((resolveLine) => {
    let buffer = retained;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveLine(value);
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > maximumSelectionBytes) return finish({ state: "invalid" });
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      inputRemainders.set(input, buffer.slice(at + 1));
      input.pause?.();
      finish({ state: "line", line: buffer.slice(0, at).trim() });
    };
    const onEnd = () => finish(buffer.trim() ? { state: "line", line: buffer.trim() } : { state: "eof" });
    const onError = () => finish({ state: "invalid" });
    const timer = setTimeout(() => finish({ state: "timeout" }), timeoutMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume?.();
  });
}

function parseSelection(read, action, observation) {
  if (read.state !== "line") return { state: read.state };
  if (read.line === "abort" && action === "probe") return { state: "abort" };
  let value;
  try { value = JSON.parse(read.line); } catch { return { state: "invalid" }; }
  const keys = ["action", "observation_sha256", "role", "accessible_name", "nearby_visible_text"].sort();
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\n") !== keys.join("\n")) return { state: "invalid" };
  if (value.action !== action || value.observation_sha256 !== observation.observation_sha256 || value.role !== "button") return { state: "invalid" };
  if (typeof value.accessible_name !== "string" || !Array.isArray(value.nearby_visible_text) || value.nearby_visible_text.some((text) => typeof text !== "string")) return { state: "invalid" };
  const matches = observation.buttons.filter((button) =>
    button.role === value.role && button.accessible_name === value.accessible_name &&
    JSON.stringify(button.nearby_visible_text) === JSON.stringify(value.nearby_visible_text)
  );
  return matches.length === 1 ? { state: "selected", value } : { state: "invalid" };
}

function observationRow(kind, observation) {
  return {
    schema_version: 1,
    kind,
    status: "awaiting-selection",
    observation,
    selection: {
      exact_json_keys: ["action", "observation_sha256", "role", "accessible_name", "nearby_visible_text"],
      action: kind === "authenticated-start" ? "probe" : "reverse",
      abort_allowed: kind === "authenticated-start"
    }
  };
}

function registryRow(selection, observation) {
  const key = sha256(JSON.stringify(selection)).slice(0, 8);
  return {
    visible_control: {
      url: observation.url,
      role: selection.role,
      accessible_name: selection.accessible_name,
      required_visible_text: selection.nearby_visible_text
    },
    action_class: "Reversible own-account",
    effect_id: `reversible-${selection.accessible_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "control"}-${key}`,
    effect_class_id: "reversible-own-account",
    expected_request: null
  };
}

const SAFE_FAILURE_STAGES = new Set([
  "identity-provisioning",
  "browser-start",
  "initial-navigation",
  "clerk-authentication",
  "authenticated-observation",
  "probe-selection",
  "open-control",
  "reverse-selection",
  "reverse-control",
  "reversal-proof"
]);

const SAFE_FAILURE_CODES = new Set([
  "calibration_observation_stale",
  "calibration_open_state_stale",
  "calibration_selection_invalid",
  "calibration_start_url_changed",
  "calibration_state_invalid",
  "clerk_sign_in_token_mint_outcome_unknown"
]);

function isSafeFailureCode(value) {
  return SAFE_FAILURE_CODES.has(value) || isSafeClerkAuthFailureCode(value);
}

function refusedOperation(response, fallbackMessage) {
  const error = new Error(fallbackMessage);
  if (isSafeFailureCode(response?.refusal?.code)) {
    Object.defineProperty(error, "calibration_failure_code", { value: response.refusal.code });
  }
  return error;
}

function safeFailure(stage, error = null) {
  const normalizedStage = SAFE_FAILURE_STAGES.has(stage) ? stage : "identity-provisioning";
  const code = isSafeFailureCode(error?.calibration_failure_code)
    ? error.calibration_failure_code
    : "operation_failed";
  return { stage: normalizedStage, code };
}

function finalRow({ status, probe, registry, cleanup, failure = null }) {
  return {
    schema_version: 1,
    kind: "calibration-result",
    status,
    probe,
    registry_row: registry,
    unknown_outcome_blocks_registry: registry === null,
    cleanup,
    failure
  };
}

async function persistFinalRow(output, runDirectory, value) {
  const line = `${JSON.stringify(value)}\n`;
  const handle = await open(join(runDirectory, "calibration-result.json"), "wx", 0o600);
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  output.write(line);
}

export async function runTrustedControlProbe({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  selectionTimeoutMs = defaultSelectionTimeoutMs,
  runtimeParent = join(repository, ".runtime"),
  runParent = join(repository, "runs"),
  policy: suppliedPolicy = null,
  dependencies = {}
} = {}) {
  if (!Number.isSafeInteger(selectionTimeoutMs) || selectionTimeoutMs < 1 || selectionTimeoutMs > 300_000) throw new Error("Selection timeout is outside its bound");
  const policy = suppliedPolicy ?? await loadFrozenPolicy();
  const provisionIdentity = dependencies.provisionIdentity ?? provisionDisposableClerkIdentity;
  const createBrowser = dependencies.createBrowser ?? ((configPath, deadline) =>
    new BrokerProcess(join(repository, "supervisor", "browser-broker.mjs"), configPath, deadline));
  const writeRecovery = dependencies.writeRecoveryRecord ?? writeRecoveryRecord;
  const started = Date.now();
  const absoluteDeadlineMs = started + Math.min(600_000, selectionTimeoutMs * 2 + 30_000);
  const runName = `safe-control-probe-${new Date(started).toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  await mkdir(runtimeParent, { recursive: true, mode: 0o700 });
  await mkdir(runParent, { recursive: true, mode: 0o700 });
  const runtimeDirectory = await mkdtemp(join(runtimeParent, "safe-control-probe-"));
  const profileDirectory = join(runtimeDirectory, "profile");
  const recoveryPath = join(runtimeDirectory, "recovery.json");
  const fallbackRecoveryPath = join(runtimeDirectory, "recovery-fallback.json");
  const configPath = join(runtimeDirectory, "browser-config.json");
  const capPath = join(runtimeDirectory, "cap-state.json");
  const runDirectory = join(runParent, runName);
  await mkdir(profileDirectory, { mode: 0o700 });
  await mkdir(runDirectory, { mode: 0o700 });
  await writeExclusiveJson(capPath, freshCapState({
    browser_active_seconds: Math.ceil((absoluteDeadlineMs - started) / 1000),
    browser_operations_total: 4,
    browser_operations_per_rolling_minute: 4,
    browser_requests_total: 200,
    browser_requests_per_rolling_minute: 200,
    listed_one_way_actions_total: 0,
    app_side_cost_cap_eur: 0,
    model_cost_cap_eur: 0,
    combined_actual_plus_reserved_cap_eur: 0
  }, new Date(absoluteDeadlineMs).toISOString(), runName));
  await writeExclusiveJson(configPath, {
    run_id: runName,
    run_directory: runDirectory,
    startup_log_path: join(runtimeDirectory, "browser-startup.jsonl"),
    profile_directory: profileDirectory,
    cap_state_path: capPath,
    operation_deadline_ms: absoluteDeadlineMs,
    initial_url: policy.initialUrl,
    allowed_navigation_origins: policy.allowedNavigationOrigins,
    allowed_request_origins: policy.allowedRequestOrigins,
    suppressed_request_origins: policy.suppressedOrigins,
    effect_registry: {},
    reversible_action_registry: {},
    app_cost_ledger: { allowed_one_way_classes: [] },
    clerk_auth: { mode: "one-use-ticket", frontend_api_origin: policy.clerkFrontendOrigin },
    calibration_probe: { mode: "trusted-reversible-control-v1", public_run_path: `${basename(runParent)}/${runName}` },
    redact_private_effect_bindings: true
  });

  let lifecycle = null;
  let browser = null;
  let browserStopped = true;
  let selectionState = "not-reached";
  let chosen = null;
  let chosenObservation = null;
  let proof = null;
  let intendedAbort = false;
  let recoveryMaterialRetained = false;
  let activeStage = "identity-provisioning";
  let failure = null;
  let cleanupProvider = {
    cleanup_complete: true,
    sessions_revoked_or_absent: true,
    sign_in_token_unusable: true,
    synthetic_identity_deleted: true
  };
  try {
    lifecycle = await provisionIdentity({
      environment,
      expectedFrontendOrigin: policy.clerkFrontendOrigin,
      workingDayDeadline: new Date(absoluteDeadlineMs).toISOString(),
      onRecoveryMaterial: async (material) => {
        cleanupProvider = {
          cleanup_complete: false,
          sessions_revoked_or_absent: false,
          sign_in_token_unusable: false,
          synthetic_identity_deleted: false
        };
        await writeRecovery(recoveryPath, {
          schema_version: 1,
          ...material,
          profile_directory: profileDirectory,
          browser_config_path: configPath,
          run_directory: runDirectory
        }, { exclusive: material.state === "creation-pending" });
        recoveryMaterialRetained = true;
      }
    });
    activeStage = "browser-start";
    browser = createBrowser(configPath, absoluteDeadlineMs);
    browserStopped = false;
    await browser.ready;
    activeStage = "initial-navigation";
    const navigation = await browser.call({ method: "navigate", action_class: "Observe", url: policy.initialUrl });
    if (!navigation?.ok) throw refusedOperation(navigation, "navigation refused");
    activeStage = "clerk-authentication";
    await lifecycle.authenticate({ browser });
    activeStage = "authenticated-observation";
    const start = await browser.call({ method: "calibration_observe_start" });
    if (!start?.ok) throw refusedOperation(start, "start observation refused");
    writeRow(output, observationRow("authenticated-start", start.observation));
    activeStage = "probe-selection";
    const first = parseSelection(await readLine(input, Math.max(1, Math.min(selectionTimeoutMs, absoluteDeadlineMs - Date.now()))), "probe", start.observation);
    selectionState = first.state;
    if (first.state !== "selected") {
      intendedAbort = ["abort", "eof", "timeout"].includes(first.state);
    } else {
      chosen = first.value;
      chosenObservation = start.observation;
      activeStage = "open-control";
      const opened = await browser.call({ method: "calibration_open", selection: chosen });
      if (!opened?.ok) throw refusedOperation(opened, "open probe refused");
      writeRow(output, observationRow("open-state", opened.observation));
      activeStage = "reverse-selection";
      const second = parseSelection(await readLine(input, Math.max(1, Math.min(selectionTimeoutMs, absoluteDeadlineMs - Date.now()))), "reverse", opened.observation);
      selectionState = second.state === "selected" ? "probed" : `reverse-${second.state}`;
      if (second.state === "selected") {
        activeStage = "reverse-control";
        const reversed = await browser.call({ method: "calibration_reverse", selection: second.value });
        if (!reversed?.ok) throw refusedOperation(reversed, "reverse probe refused");
        proof = reversed.proof;
        if (proof?.safe !== true) activeStage = "reversal-proof";
      }
    }
  } catch (error) {
    failure = safeFailure(activeStage, error);
    if (!lifecycle && typeof error?.cleanup_handle === "function") {
      try { cleanupProvider = await error.cleanup_handle(); } catch { cleanupProvider = error.cleanup; }
    } else if (!lifecycle && error?.cleanup) cleanupProvider = error.cleanup;
    if (!lifecycle && error?.recovery_material && cleanupProvider?.cleanup_complete !== true) {
      try {
        await writeRecovery(fallbackRecoveryPath, {
          schema_version: 1,
          ...error.recovery_material,
          recovery_reason: "primary-recovery-write-failed",
          profile_directory: profileDirectory,
          browser_config_path: configPath,
          run_directory: runDirectory
        }, { exclusive: true });
        recoveryMaterialRetained = true;
      } catch {
        recoveryMaterialRetained = false;
      }
    }
    if (selectionState === "not-reached") selectionState = "failed";
  } finally {
    if (browser) {
      try { await browser.stop(); browserStopped = true; } catch { browserStopped = false; }
    }
    if (lifecycle && browserStopped) {
      try { cleanupProvider = await lifecycle.cleanup({ browserStopped: true }); } catch {
        cleanupProvider = { cleanup_complete: false, sessions_revoked_or_absent: false, sign_in_token_unusable: false, synthetic_identity_deleted: false };
      }
    } else if (lifecycle) {
      cleanupProvider = { cleanup_complete: false, sessions_revoked_or_absent: false, sign_in_token_unusable: false, synthetic_identity_deleted: false };
    }
  }

  let profileRemoved = false;
  if (browserStopped) {
    try { await rm(profileDirectory, { recursive: true, force: true }); profileRemoved = true; } catch {}
  }
  const cleanupComplete = browserStopped && cleanupProvider.cleanup_complete === true && profileRemoved;
  if (cleanupComplete) await rm(runtimeDirectory, { recursive: true, force: true });
  const cleanup = {
    browser_closed: browserStopped,
    sessions_revoked_or_absent: cleanupProvider.sessions_revoked_or_absent === true,
    sign_in_token_unusable: cleanupProvider.sign_in_token_unusable === true,
    synthetic_identity_deleted: cleanupProvider.synthetic_identity_deleted === true,
    profile_removed: profileRemoved,
    recovery_material_retained: !cleanupComplete && recoveryMaterialRetained,
    cleanup_complete: cleanupComplete
  };
  const ready = proof?.safe === true && cleanupComplete;
  const status = ready ? "registry-row-ready" : intendedAbort && cleanupComplete ? "aborted" : !cleanupComplete ? "blocked-cleanup-unknown" : "blocked-unknown";
  const registry = ready ? registryRow(chosen, chosenObservation) : null;
  if (!ready && !intendedAbort && failure === null) failure = safeFailure(activeStage);
  await persistFinalRow(output, runDirectory, finalRow({ status, probe: proof, registry, cleanup, failure }));
  return { exit_code: ready || status === "aborted" ? 0 : 1, selection_state: selectionState };
}

function parseArgs(argv) {
  if (argv.length === 2) return { selectionTimeoutMs: defaultSelectionTimeoutMs };
  if (argv.length !== 4 || argv[2] !== "--selection-timeout-ms") throw new Error("Usage: npm run calibrate:control -- [--selection-timeout-ms N]");
  const selectionTimeoutMs = Number(argv[3]);
  if (!Number.isSafeInteger(selectionTimeoutMs) || selectionTimeoutMs < 1_000 || selectionTimeoutMs > 300_000) throw new Error("Selection timeout must be between 1000 and 300000 milliseconds");
  return { selectionTimeoutMs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result = { exit_code: 1 };
  try { result = await runTrustedControlProbe(parseArgs(process.argv)); } catch {
    process.stdout.write(`${JSON.stringify(finalRow({
      status: "blocked-unknown",
      probe: null,
      registry: null,
      cleanup: null,
      failure: { stage: "identity-provisioning", code: "operation_failed" }
    }))}\n`);
  }
  process.exitCode = result.exit_code;
}
