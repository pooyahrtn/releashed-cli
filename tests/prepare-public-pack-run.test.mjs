import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { preparePublicPackRun } from "../scripts/prepare-public-pack-run.mjs";

const RUN_ID = "spike-a-live-calibration-20260903T164116Z";
const CALIBRATION_CHECK_IDS = [
  "minimal_model_call_output_exact",
  "minimal_model_usage_complete",
  "minimal_model_cost_within_reservation",
  "returned_model_identity_matches_approved_alias_or_snapshot",
  "over_budget_request_refused_before_dispatch"
];
const NON_MODEL_CHECK_IDS = `
all_frozen_caps_schema_and_values_exact
app_and_combined_caps_match_frozen_authority
app_effect_classes_have_closed_finite_reservations
append_evidence_collision_refused
approved_calibration_reservation_exact
approved_model_bound_includes_conservative_framing
approved_model_calibration_frozen_values_exact
approved_pricing_exact
arbitrary_navigation_after_initial_refused
authorized_reversible_click_has_changed_after_state_and_effect_evidence
browser_broker_bounded_interface
browser_broker_not_aborted
browser_broker_refuses_nonempty_run_directory
browser_process_inspection_refused
browser_profile_api_refused
browser_profile_read_denied
child_environment_exact_allowlist
concurrent_reservation_cap_exhaustion_admits_no_more_than_limit
cross_process_lock_serializes_concurrent_updates
direct_network_denied
explorer_cannot_mint_action_token
fixture_allowed_dispatched_requests_exactly_six
fixture_blocked_origin_attempt_exactly_one
fixture_blocked_origin_dispatched_zero
fixture_fetch_request_exactly_one
fixture_navigation_requests_exactly_two
fixture_redirect_response_exactly_one
fixture_service_worker_pre_reserved_and_observed
fixture_service_worker_request_exactly_one
fixture_subresource_requests_exactly_two
frozen_owner_public_pack_fetch_scope_present_for_later_supervisor_fetch
frozen_public_author_allocation_and_combined_caps_exact
frozen_public_source_policy_schema_and_values_exact
isolated_one_shot_public_pack_author_runtime_ready
local_fixture_navigation_completed
model_and_combined_caps_frozen
model_broker_output_usage_refusal_interface
model_content_approved
model_ledger_read_denied
no_target_browser_or_session_started
outside_canary_read_denied
owner_action_ledger_pass
owner_authority_pass
owner_input_digests_presealed_before_brokers
owner_origin_allowlist_pass
owner_retention_pass
owner_source_digests_well_formed
owner_synthetic_account_pass
page_initiated_off_origin_fetch_blocked
page_worker_and_live_channels_blocked
persisted_urls_strip_query_fragment_and_sensitive_paths
provider_environment_api_refused
raw_request_stream_api_refused
renderer_refuses_duplicate_event_ids
renderer_rejects_invalid_solid_transition
reversible_action_token_is_one_use
semantic_observation_only
shell_tool_execution_denied
supervisor_issues_observation_bound_reversible_token
supervisor_response_constrained
unallowed_directory_listing_denied
worker_oopif_live_channels_fail_closed_policy`.trim().split("\n");

function hash(body) {
  return createHash("sha256").update(body).digest("hex");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prepare-public-pack-"));
  const repository = join(root, "flow-map-lab");
  const ownerDirectory = join(root, "flow-map-lab-private", "spike-a");
  const runDirectory = join(repository, "runs", RUN_ID);
  const runtimeDirectory = join(repository, ".runtime", RUN_ID);
  await Promise.all([mkdir(join(runDirectory, "preflight"), { recursive: true }), mkdir(runtimeDirectory, { recursive: true }), mkdir(join(repository, "packs"), { recursive: true }), mkdir(ownerDirectory, { recursive: true })]);
  const authority = {
    limits: { model_cost_cap_eur: 18, combined_actual_plus_reserved_cap_eur: 20 },
    model_broker_approval: {
      model: "gpt-5.6-terra",
      minimal_live_preflight: { maximum_output_tokens: 16, worst_case_reserved_eur: 0.000352 },
      public_pack_author: { model: "gpt-5.6-terra", maximum_output_tokens: 2_000 },
      pricing: { input_per_million_tokens: 2, output_per_million_tokens: 12, accounting_rate: { usd: 1, eur: 1 }, source_url: "frozen", retrieved_date: "2026-09-03" }
    }
  };
  const origin = { status: "pass", public_pack_fetch_policy: { content_classification: "public-only" } };
  const authorityBody = `${JSON.stringify(authority)}\n`;
  const originBody = `${JSON.stringify(origin)}\n`;
  const authorityPath = join(ownerDirectory, "authority-and-start.json");
  const originPath = join(ownerDirectory, "origin-allowlist.json");
  await Promise.all([writeFile(authorityPath, authorityBody), writeFile(originPath, originBody), writeFile(join(runtimeDirectory, "sealed-public-pack-author-canary.txt"), "sealed\n")]);
  const capStatePath = join(runtimeDirectory, "cap-state.json");
  const report = {
    run_id: RUN_ID,
    non_model_preflight: "pass",
    checks: NON_MODEL_CHECK_IDS.map((id) => ({ id, pass: true })),
    model_calibration: { status: "pass", actual_eur: 0.0001, checks: CALIBRATION_CHECK_IDS.map((id) => ({ id, pass: true })) },
    target_or_public_origin_accessed: false,
    safe_to_start_public_pack_authoring: true,
    public_pack_complete: false,
    safe_to_continue_to_pack: false,
    safe_to_continue_to_target: false
  };
  const inputManifest = {
    run_id: RUN_ID,
    owner_inputs_sealed_before_broker_start: true,
    model: "gpt-5.6-terra",
    owner_input_hashes: { "authority-and-start.json": hash(authorityBody), "origin-allowlist.json": hash(originBody) }
  };
  const capState = {
    run_id: RUN_ID,
    working_day_deadline: new Date(Date.now() + 60_000).toISOString(),
    abort: null,
    model: { calls: 1, refused_before_dispatch: 1, actual_eur: 0.0001, outstanding_reservations_eur: 0 },
    app: { actual_eur: 0, outstanding_reservations_eur: 0, one_way_actions: 0 },
    caps: { model_cost_cap_eur: 18, combined_actual_plus_reserved_cap_eur: 20 }
  };
  const modelConfig = {
    run_id: RUN_ID,
    run_directory: runDirectory,
    cap_state_path: capStatePath,
    model: "gpt-5.6-terra",
    minimum_output_tokens: 16,
    approved_model_identity_policy: { approved_alias: "gpt-5.6-terra", approved_snapshots: [] },
    pricing: authority.model_broker_approval.pricing,
    allowed_content_classifications: [
      "generic-synthetic-non-target",
      "public-pack-text",
      "Synthetic visible app content from the disposable account after secret and personal-data checks."
    ]
  };
  await Promise.all([
    writeJson(join(runDirectory, "preflight", "report.json"), report),
    writeJson(join(runDirectory, "input-manifest.json"), inputManifest),
    writeJson(join(runDirectory, "metrics.json"), capState),
    writeJson(capStatePath, capState),
    writeJson(join(runtimeDirectory, "model-config.json"), modelConfig)
  ]);
  return {
    root,
    repository,
    ownerDirectory,
    reportPath: join(runDirectory, "preflight", "report.json"),
    metricsPath: join(runDirectory, "metrics.json"),
    capStatePath,
    modelConfigPath: join(runtimeDirectory, "model-config.json"),
    publicPackModelConfigPath: join(runtimeDirectory, "public-pack-model-config.json"),
    inputManifestPath: join(runDirectory, "input-manifest.json"),
    authorityPath,
    configPath: join(runtimeDirectory, "public-pack-live-runtime.json")
  };
}

test("prepares only the two fixed, private live configurations", async () => {
  const setup = await fixture();
  try {
    const before = await readdir(join(setup.repository, ".runtime", RUN_ID));
    const result = await preparePublicPackRun({ repository: setup.repository, ownerDirectory: setup.ownerDirectory, runId: RUN_ID });
    assert.deepEqual(result, { run_id: RUN_ID, config_path: `.runtime/${RUN_ID}/public-pack-live-runtime.json` });
    assert.equal((await stat(setup.configPath)).mode & 0o777, 0o600);
    const after = await readdir(join(setup.repository, ".runtime", RUN_ID));
    assert.deepEqual(after.filter((name) => !before.includes(name)).sort(), ["public-pack-live-runtime.json", "public-pack-model-config.json"]);
    const config = JSON.parse(await readFile(setup.configPath, "utf8"));
    assert.deepEqual(config.author_request, { maximum_input_tokens: 32_000, maximum_output_tokens: 2_000 });
    assert.equal(config.cap_state_path, setup.capStatePath);
    assert.equal(config.model_config_path, setup.publicPackModelConfigPath);
    assert.equal(config.public_fetch_output_directory, join(setup.repository, ".runtime", RUN_ID, "public-fetch"));
    assert.equal(config.public_input_mount, join(setup.repository, ".runtime", RUN_ID, "public-fetch", "author-input"));
    assert.equal(config.output_directory, join(setup.repository, "packs", `public-pack-${RUN_ID}`));
    assert.equal(config.pack_id, `public-pack-${RUN_ID}`);
    assert.equal(config.test_only_local_fixture, undefined);
    assert.equal(config.test_only_fragment_jsonl, undefined);
    assert.equal((await stat(setup.publicPackModelConfigPath)).mode & 0o777, 0o600);
    const publicPackModelConfig = JSON.parse(await readFile(setup.publicPackModelConfigPath, "utf8"));
    assert.deepEqual(publicPackModelConfig.allowed_content_classifications, ["public-pack-text"]);
    assert.equal(publicPackModelConfig.minimum_output_tokens, 2_000);
    assert.equal(publicPackModelConfig.provider_url, undefined);
    await assert.rejects(() => preparePublicPackRun({ repository: setup.repository, ownerDirectory: setup.ownerDirectory, runId: RUN_ID }), /target already exists/);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("rejects unsafe run ids without reading or creating run paths", async () => {
  await assert.rejects(() => preparePublicPackRun({ repository: "/unused", ownerDirectory: "/unused", runId: "../private" }), /Run id/);
});

for (const [name, mutate, expected] of [
  ["a substituted non-model check", async (setup) => { const value = JSON.parse(await readFile(setup.reportPath)); value.checks[0].id = "substituted_check"; await writeJson(setup.reportPath, value); }, /check identities/],
  ["a duplicate non-model check", async (setup) => { const value = JSON.parse(await readFile(setup.reportPath)); value.checks[0].id = value.checks[1].id; await writeJson(setup.reportPath, value); }, /check identities/],
  ["a renamed calibration check", async (setup) => { const value = JSON.parse(await readFile(setup.reportPath)); value.model_calibration.checks[0].id = "shortcut"; await writeJson(setup.reportPath, value); }, /identities/],
  ["a consumed or outstanding calibration ledger", async (setup) => { const value = JSON.parse(await readFile(setup.capStatePath)); value.model.outstanding_reservations_eur = 0.01; await writeJson(setup.capStatePath, value); }, /call or reservation/],
  ["an expired run deadline", async (setup) => { const value = JSON.parse(await readFile(setup.capStatePath)); value.working_day_deadline = new Date(Date.now() - 1_000).toISOString(); await writeJson(setup.capStatePath, value); }, /not safe/],
  ["an app-side action", async (setup) => { const value = JSON.parse(await readFile(setup.capStatePath)); value.app.one_way_actions = 1; await writeJson(setup.capStatePath, value); }, /app-side/],
  ["drift between metrics and actual cap state", async (setup) => { const value = JSON.parse(await readFile(setup.metricsPath)); value.model.actual_eur = 0.00009; await writeJson(setup.metricsPath, value); }, /metrics and actual/],
  ["a retained model configuration with a provider override", async (setup) => { const value = JSON.parse(await readFile(setup.modelConfigPath)); value.provider_url = "https://example.invalid"; await writeJson(setup.modelConfigPath, value); }, /unknown or missing/],
  ["a shortened retained classification list", async (setup) => { const value = JSON.parse(await readFile(setup.modelConfigPath)); value.allowed_content_classifications.pop(); await writeJson(setup.modelConfigPath, value); }, /exact production list/],
  ["a mismatched retained model configuration", async (setup) => { const value = JSON.parse(await readFile(setup.modelConfigPath)); value.model = "different-model"; await writeJson(setup.modelConfigPath, value); }, /model identities/],
  ["changed frozen owner input", async (setup) => { const value = JSON.parse(await readFile(setup.authorityPath)); value.status = "changed"; await writeFile(setup.authorityPath, `${JSON.stringify(value)}\n`); }, /owner inputs/]
]) {
  test(`fails closed without output for ${name}`, async () => {
    const setup = await fixture();
    try {
      await mutate(setup);
      await assert.rejects(() => preparePublicPackRun({ repository: setup.repository, ownerDirectory: setup.ownerDirectory, runId: RUN_ID }), expected);
      await assert.rejects(() => stat(setup.configPath), { code: "ENOENT" });
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  });
}

test("refuses every pre-existing generated, fetch, or pack target before creating a configuration", async () => {
  for (const target of ["model-config", "runtime-config", "fetch", "pack"]) {
    const setup = await fixture();
    try {
      const path = target === "model-config" ? setup.publicPackModelConfigPath : target === "runtime-config" ? setup.configPath : target === "fetch" ? join(setup.repository, ".runtime", RUN_ID, "public-fetch") : join(setup.repository, "packs", `public-pack-${RUN_ID}`);
      if (target.endsWith("config")) await writeFile(path, "occupied\n");
      else await mkdir(path, { recursive: true });
      await assert.rejects(() => preparePublicPackRun({ repository: setup.repository, ownerDirectory: setup.ownerDirectory, runId: RUN_ID }), /target already exists/);
      if (target === "runtime-config") assert.equal(await readFile(setup.configPath, "utf8"), "occupied\n");
      else await assert.rejects(() => stat(setup.configPath), { code: "ENOENT" });
      if (target === "model-config") assert.equal(await readFile(setup.publicPackModelConfigPath, "utf8"), "occupied\n");
      else await assert.rejects(() => stat(setup.publicPackModelConfigPath), { code: "ENOENT" });
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  }
});
