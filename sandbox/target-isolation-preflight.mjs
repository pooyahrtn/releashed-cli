import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const input = JSON.parse(await readFile(process.env.SPIKE_TARGET_PREFLIGHT_INPUT, "utf8"));
const waiters = new Map();
let nextRpcId = 1;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line);
  const waiter = waiters.get(message.rpc_id);
  if (!waiter) return;
  waiters.delete(message.rpc_id);
  waiter(message.response);
});

function rpc(broker, payload) {
  const rpcId = nextRpcId++;
  const pending = new Promise((resolve) => waiters.set(rpcId, resolve));
  process.stdout.write(`${JSON.stringify({ kind: "rpc", rpc_id: rpcId, broker, payload })}\n`);
  return pending;
}

async function denied(work) {
  try {
    await work();
    return false;
  } catch {
    return true;
  }
}

const checks = [];
const record = (id, pass) => checks.push({ id, pass: Boolean(pass) });
const environmentKeys = Object.keys(process.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").sort();
record("target_sandbox_environment_secret_free", JSON.stringify(environmentKeys) === JSON.stringify(["LANG", "SPIKE_TARGET_PREFLIGHT_INPUT"]));
const publicPackHash = createHash("sha256").update(input.public_pack_utf8).digest("hex");
const pack = JSON.parse(input.public_pack_utf8);
record("target_sandbox_reads_only_bound_public_pack", publicPackHash === input.public_pack_sha256 && pack.schema_version === 1 && Array.isArray(pack.claims));
for (const [id, path] of Object.entries(input.forbidden_paths)) record(`target_sandbox_cannot_read_${id}`, await denied(() => readFile(path)));
record("target_sandbox_cannot_list_browser_profile", await denied(() => readdir(input.browser_profile_path)));
record("target_sandbox_cannot_execute_process_tools", await denied(() => execFileAsync("/bin/ps", ["-ax"])));
record("target_sandbox_direct_network_denied", await denied(() => fetch(input.initial_url)));
const processInfo = await rpc("browser", { method: "process_info" });
record("target_sandbox_cannot_inspect_broker_process", !processInfo.ok && processInfo.refusal?.code === "method_not_exposed");
const registryDump = await rpc("supervisor", { method: "list_registry" });
record("target_sandbox_cannot_enumerate_registry", !registryDump.ok && registryDump.refusal?.code === "method_not_exposed");
const authAttempt = await rpc("browser", { method: "install_transient_auth", sentinel: input.credential_probe_value });
record("target_sandbox_cannot_install_auth", !authAttempt.ok && authAttempt.refusal?.code === "method_not_exposed");

let observation = await rpc("browser", { method: "observe", action_class: "Observe" });
record("explorer_begins_on_supervisor_authenticated_landing", observation.ok && observation.event?.visible_state_summary?.includes("Authenticated local target"));
const repeatedNavigation = await rpc("browser", { method: "navigate", action_class: "Observe", url: input.initial_url });
record("explorer_cannot_repeat_supervisor_bootstrap_navigation", !repeatedNavigation.ok && repeatedNavigation.refusal?.code === "direct_navigation_locked");
const summary = () => observation.event?.after?.visible_state_summary ?? "";
const refFor = (name) => summary().match(new RegExp(`^(e\\d+) \\[button\\] ${name}$`, "m"))?.[1] ?? null;
const act = (ref) => rpc("supervisor", { method: "act_on_visible_control", ref, observation_hash: observation.event.after.observation_hash });

const unknown = await act(refFor("Delete everything"));
record("unknown_visible_button_denied_without_token", !unknown.ok && unknown.status === "rejected" && unknown.reason === "unknown-visible-control");
const directClick = await rpc("browser", { method: "click", action_class: "Reversible own-account", ref: refFor("Toggle preference") });
record("explorer_cannot_bypass_supervisor_action_dispatch", !directClick.ok && directClick.refusal?.code === "action_token_invalid");

const reversibleRef = refFor("Toggle preference");
const reversible = await act(reversibleRef);
record("registered_reversible_action_uses_observation_bound_token", reversible.ok && reversible.status === "completed" && reversible.evidence?.transition_kind === "solid");
record("sandbox_receives_no_private_action_classification", !/(effect|expected_request|authorization_token|action_class|api\/progress)/i.test(JSON.stringify(reversible)));

observation = await rpc("browser", { method: "observe", action_class: "Observe" });
const listedRef = refFor("Complete step");
const listed = await act(listedRef);
record("registered_listed_action_uses_observation_bound_token", listed.ok && listed.status === "completed");
record("listed_result_contains_only_public_evidence_ids", !/(effect|expected_request|authorization_token|action_class|api\/progress)/i.test(JSON.stringify(listed)) && typeof listed.evidence?.event_id === "string");

observation = await rpc("browser", { method: "observe", action_class: "Observe" });
const mismatch = await act(refFor("Complete query-mismatched step"));
record("mutation_mismatch_fails_closed", !mismatch.ok && mismatch.status === "unknown" && mismatch.reason === "mutation-outcome-unknown");
record("mismatch_result_contains_no_private_expected_request", !/(effect|expected_request|authorization_token|action_class|dangerous|api\/progress)/i.test(JSON.stringify(mismatch)));

process.stdout.write(`${JSON.stringify({ kind: "sandbox_result", checks })}\n`, () => process.exit(0));
