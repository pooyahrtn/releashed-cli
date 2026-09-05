import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readOnlySandboxProfile, runBoundedJsonlChild, stopProcessTree } from "../lib/bounded-child.mjs";
import { filesBelow, readJson, writeExclusiveJson } from "../lib/scaffold.mjs";
import { classifyBoundedOnboardingControl, classifyObservedControl, preflightTargetRuntime } from "../lib/target-runtime.mjs";
import { BrokerProcess } from "./browser-broker-process.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function requiredFileContains(path, bytes) {
  return (await readFile(path)).includes(bytes);
}

function publicActionResult(response, capAbort) {
  const event = response?.event;
  const evidence = event ? {
    event_id: event.event_id,
    before_observation_hash: event.before?.observation_hash ?? null,
    after_observation_hash: event.after?.observation_hash ?? null,
    screenshot_path: event.screenshot_path ?? null,
    transition_kind: event.transition_kind
  } : null;
  if (response?.ok) return { ok: true, status: "completed", evidence };
  if (capAbort?.code === "unknown_mutation_request") return { ok: false, status: "unknown", reason: "mutation-outcome-unknown", evidence };
  return { ok: false, status: "unknown", reason: "supervised-action-did-not-complete", evidence };
}

async function authorizeAndDispatch({ browser, registry, request, capStatePath, boundedOnboarding }) {
  const inspected = await browser.call({ method: "inspect_observed_control", ref: request.ref });
  if (!inspected.ok) return { ok: false, status: "rejected", reason: "stale-or-missing-control", evidence: null };
  const classified = boundedOnboarding
    ? classifyBoundedOnboardingControl({ scopeHref: inspected.control.url, requested: { ref: request.ref, observation_hash: request.observation_hash }, observed: inspected.control })
    : classifyObservedControl({ registry, requested: { ref: request.ref, observation_hash: request.observation_hash }, observed: inspected.control });
  if (!classified.ok) return { ok: false, status: "rejected", reason: classified.refusal.code === "unknown_visible_control" ? "unknown-visible-control" : "stale-observation", evidence: null };
  const privateRequest = { method: "issue_action_token", ref: request.ref, ...classified.classification };
  const issued = await browser.call(privateRequest);
  if (!issued.ok) return { ok: false, status: "unknown", reason: "authorization-not-issued", evidence: null };
  const clickRequest = { method: "click", ref: request.ref, authorization_token: issued.authorization_token, ...classified.classification };
  const clicked = await browser.call(clickRequest);
  const reused = await browser.call(clickRequest);
  const reuseRefused = reused.refusal?.code === "action_token_invalid" ||
    (!clicked.ok && reused.refusal?.code === "run_aborted");
  if (reused.ok || !reuseRefused) throw new Error("Supervisor-issued action token was not one-use");
  return publicActionResult(clicked, (await readJson(capStatePath)).abort);
}

async function runSandbox({ browser, registry, config, inputPath, absoluteDeadlineMs }) {
  const scriptPath = await realpath(join(repository, "sandbox", "target-isolation-preflight.mjs"));
  const canonicalInputPath = await realpath(inputPath);
  const nodePath = await realpath(process.execPath);
  let result = null;
  let nextRpcId = 1;
  const processResult = await runBoundedJsonlChild({
    command: "/usr/bin/sandbox-exec",
    args: ["-p", readOnlySandboxProfile({ nodePath, readableFiles: [scriptPath, canonicalInputPath] }), nodePath, scriptPath],
    options: { cwd: "/", env: { LANG: "C.UTF-8", SPIKE_TARGET_PREFLIGHT_INPUT: canonicalInputPath } },
    timeoutMs: Math.max(1, Math.min(30_000, absoluteDeadlineMs - Date.now())),
    label: "Target sandbox session",
    async onMessage(message, child) {
      if (message.kind === "sandbox_result") {
        result = message;
        return { complete: true };
      }
      if (message.kind !== "rpc" || message.rpc_id !== nextRpcId++) throw new Error("Target sandbox returned a nonsequential protocol message");
      let response;
      if (message.broker === "browser") response = await browser.call(message.payload, "sandbox");
      else if (message.broker === "supervisor" && message.payload?.method === "act_on_visible_control") response = await authorizeAndDispatch({ browser, registry, request: message.payload, capStatePath: config.cap_state.path, boundedOnboarding: config.mode === "source-blind-bounded-onboarding-v1" });
      else response = { ok: false, refusal: { code: "method_not_exposed", message: "This supervisor method is not exposed" } };
      child.send({ rpc_id: message.rpc_id, response });
    }
  });
  if (processResult.exit.code !== 0 || !result) throw new Error(`Target sandbox failed closed (${processResult.exit.code ?? processResult.exit.signal}): ${processResult.stderr.slice(0, 200)}`);
  return result;
}

export async function runTargetIsolationSession({ configPath, repositoryRoot = repository }) {
  const { config, actionLedger, registry, fixtureAllowed, publicPackText } = await preflightTargetRuntime({ repository: repositoryRoot, configPath });
  if (!fixtureAllowed) throw new Error("Production target execution is disabled until the real explorer runner owns it");
  const sentinel = process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL;
  if (typeof sentinel !== "string" || sentinel.length < 16 || sentinel.length > 512 || /[\r\n]/.test(sentinel)) throw new Error("A bounded transient authentication sentinel is required");
  delete process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL;
  const absoluteDeadlineMs = Date.parse(config.cap_state.binding.working_day_deadline);
  await mkdir(config.outputs.target_run_directory, { recursive: false, mode: 0o700 });
  const browserConfig = {
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
    ...(config.mode === "source-blind-bounded-onboarding-v1"
      ? { auth_bootstrap_admissions: actionLedger.auth_bootstrap_admissions ?? [] }
      : {
          effect_registry: Object.fromEntries(registry.entries.filter((entry) => entry.action_class === "Listed own-account progress").map((entry) => [entry.effect_id, entry.effect_class_id])),
          reversible_action_registry: Object.fromEntries(registry.entries.filter((entry) => entry.action_class === "Reversible own-account").map((entry) => [entry.effect_id, entry.effect_class_id])),
          app_cost_ledger: actionLedger
        }),
    transient_auth: config.transient_auth,
    redact_private_effect_bindings: true
  };
  await writeExclusiveJson(config.outputs.browser_config_path, browserConfig);
  await mkdir(config.outputs.browser_profile_directory, { recursive: false, mode: 0o700 });
  const probePaths = Object.fromEntries(await Promise.all(Object.entries({
    account: config.private_owner_inputs["account.json"].path,
    ...(config.target_action_registry ? { registry: config.target_action_registry.path } : {}),
    broker_config: config.outputs.browser_config_path,
    target_runtime_config: resolve(configPath)
  }).map(async ([name, path]) => {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new Error(`Target isolation probe ${name} is not an ordinary file`);
    return [name, canonical];
  })));
  const sandboxInput = {
    public_pack_utf8: publicPackText,
    public_pack_sha256: config.public_pack.sha256,
    initial_url: config.target.initial_url,
    credential_probe_value: "synthetic-not-a-real-credential",
    forbidden_paths: probePaths,
    browser_profile_path: await realpath(config.outputs.browser_profile_directory)
  };
  await writeExclusiveJson(config.outputs.sandbox_input_path, sandboxInput);
  const browser = new BrokerProcess(join(repository, "supervisor", "browser-broker.mjs"), config.outputs.browser_config_path, absoluteDeadlineMs);
  const deadlineWatchdog = setTimeout(() => { void browser.stop(); }, Math.max(1, absoluteDeadlineMs - Date.now()));
  deadlineWatchdog.unref();
  let sandbox;
  try {
    await browser.ready;
    const auth = await browser.call({ method: "install_transient_auth", sentinel });
    if (!auth.ok || auth.consumed !== true) throw new Error("Supervisor could not consume transient authentication");
    const bootstrap = await browser.call({ method: "navigate", action_class: "Observe", url: config.target.initial_url });
    if (!bootstrap.ok) throw new Error("Supervisor could not open the exact target page");
    const cleared = await browser.call({ method: "clear_transient_auth" });
    if (!cleared.ok || cleared.cleared !== true) throw new Error("Supervisor could not clear transient authentication after bootstrap");
    sandbox = await runSandbox({ browser, registry, config, inputPath: config.outputs.sandbox_input_path, absoluteDeadlineMs });
  } finally {
    clearTimeout(deadlineWatchdog);
    try {
      await browser.stop();
    } finally {
      await rm(config.outputs.browser_profile_directory, { recursive: true, force: true });
    }
  }
  const sensitiveNeedle = Buffer.from(sentinel);
  const browserStartupPath = browserConfig.startup_log_path;
  const retainedFiles = [resolve(configPath), config.outputs.browser_config_path, config.outputs.sandbox_input_path, browserStartupPath, ...(await filesBelow(config.outputs.target_run_directory))];
  const secretAbsent = !(await Promise.all(retainedFiles.map((path) => requiredFileContains(path, sensitiveNeedle)))).some(Boolean);
  const cap = await readJson(config.cap_state.path);
  const report = {
    schema_version: 1,
    run_id: config.run_id,
    runtime_identity: config.runtime_identity,
    public_pack_sha256: config.public_pack.sha256,
    private_owner_input_sha256: Object.fromEntries(Object.entries(config.private_owner_inputs).map(([name, binding]) => [name, binding.sha256])),
    ...(config.target_action_registry ? { target_action_registry_sha256: config.target_action_registry.sha256 } : {}),
    transient_auth_consumed_by_supervisor: true,
    transient_auth_absent_from_config_trace_screenshots_and_history: secretAbsent,
    sandbox_checks: sandbox.checks,
    cap_abort: cap.abort ? { code: cap.abort.code, timestamp: cap.abort.timestamp, detail: cap.abort.detail } : null,
    pass: secretAbsent && sandbox.checks.every((check) => check.pass) && cap.abort?.code === "unknown_mutation_request"
  };
  await writeExclusiveJson(join(config.outputs.target_run_directory, "target-isolation-report.json"), report);
  return report;
}

export { BrokerProcess, stopProcessTree };

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--config") throw new Error("Usage: node supervisor/target-session.mjs --config <target-session-config.json>");
  const report = await runTargetIsolationSession({ configPath: resolve(process.argv[3]) });
  process.stdout.write(`${JSON.stringify({ run_id: report.run_id, pass: report.pass })}\n`);
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Target isolation failed"}\n`);
    process.exitCode = 1;
  });
}
