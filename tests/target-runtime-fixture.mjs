import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const RUN_ID = "source-blind-target-test";
const hash = (body) => createHash("sha256").update(body).digest("hex");

export async function privateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function ownerValues(targetOrigin) {
  const limits = {
    browser_active_seconds: 7200,
    browser_operations_total: 150,
    browser_operations_per_rolling_minute: 30,
    browser_requests_total: 3000,
    browser_requests_per_rolling_minute: 300,
    listed_one_way_actions_total: 20,
    app_side_cost_cap_eur: 2,
    model_cost_cap_eur: 18,
    combined_actual_plus_reserved_cap_eur: 20
  };
  const authority = { schema_version: 1, record_kind: "authority", status: "pass", limits };
  const origin = {
    schema_version: 1,
    record_kind: "origins",
    status: "pass",
    deployed_origins: { learner_app: "https://app.example.test" },
    browser_request_dispatch: {
      allow: [
        { origin: "https://app.example.test", purpose: "Learner app" },
        { origin: "https://clerk.example.test", purpose: "Clerk frontend/auth session transport only" }
      ],
      recognized_but_suppress_before_dispatch: []
    }
  };
  const account = {
    schema_version: 1,
    record_kind: "account",
    status: "pass",
    identity: { provider: "Clerk", provider_user_id: "user_fixture" }
  };
  const retention = { schema_version: 1, record_kind: "retention", status: "pass" };
  const actionLedger = {
    schema_version: 1,
    record_kind: "spike-a-action-and-app-cost-ledger",
    status: "pass",
    caps: { listed_one_way_actions_total: 20, app_side_actual_plus_outstanding_reservations_eur: 2, combined_model_and_app_actual_plus_outstanding_reservations_eur: 20 },
    allowed_one_way_classes: [{ id: "own-account-state", action_matrix_row: "Listed own-account progress", maximum_count: 4, worst_case_eur_per_action: 0 }]
  };
  const registry = {
    schema_version: 1,
    record_kind: "spike-a-target-action-registry",
    status: "pass",
    target_origin: targetOrigin,
    entries: [
      { visible_control: { url: `${targetOrigin}/`, role: "button", accessible_name: "Toggle preference", required_visible_text: ["Authenticated local target"] }, action_class: "Reversible own-account", effect_id: "toggle-preference", effect_class_id: "reversible-own-account", expected_request: null },
      { visible_control: { url: `${targetOrigin}/`, role: "button", accessible_name: "Complete step", required_visible_text: ["Authenticated local target", "fresh"] }, action_class: "Listed own-account progress", effect_id: "complete-step", effect_class_id: "own-account-state", expected_request: { method: "POST", url: `${targetOrigin}/api/progress` } },
      { visible_control: { url: `${targetOrigin}/`, role: "button", accessible_name: "Complete query-mismatched step", required_visible_text: ["Authenticated local target"] }, action_class: "Listed own-account progress", effect_id: "mismatch-step", effect_class_id: "own-account-state", expected_request: { method: "POST", url: `${targetOrigin}/api/progress` } }
    ]
  };
  return { authority, origin, account, retention, actionLedger, registry };
}

export async function targetRuntimeFixture(targetOrigin = "http://127.0.0.1:45678") {
  const root = await mkdtemp(join(tmpdir(), "flow-map-target-runtime-"));
  const repository = join(root, "flow-map-lab");
  const ownerDirectory = join(root, "flow-map-lab-private", "spike-a");
  const runDirectory = join(repository, "runs", RUN_ID);
  const runtimeDirectory = join(repository, ".runtime", RUN_ID);
  const packDirectory = join(repository, "packs", `public-pack-${RUN_ID}`);
  await Promise.all([mkdir(runDirectory, { recursive: true }), mkdir(runtimeDirectory, { recursive: true }), mkdir(packDirectory, { recursive: true }), mkdir(ownerDirectory, { recursive: true })]);
  const owner = ownerValues(targetOrigin);
  const ownerFiles = {
    "authority-and-start.json": owner.authority,
    "origin-allowlist.json": owner.origin,
    "account.json": owner.account,
    "action-and-app-cost-ledger.json": owner.actionLedger,
    "retention.json": owner.retention
  };
  const ownerHashes = {};
  for (const [name, value] of Object.entries(ownerFiles)) {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(join(ownerDirectory, name), body, { mode: 0o600 });
    ownerHashes[name] = hash(body);
  }
  const registryPath = join(ownerDirectory, "target-action-registry.json");
  await privateJson(registryPath, owner.registry);
  await privateJson(join(runDirectory, "input-manifest.json"), { run_id: RUN_ID, owner_input_hashes: ownerHashes });
  const cap = {
    run_id: RUN_ID,
    working_day_deadline: new Date(Date.now() + 60_000).toISOString(),
    abort: null,
    browser: { started_at: null, active_seconds: 0, operations: 0, peak_operations_per_minute: 0, requests: 0, peak_requests_per_minute: 0, blocked_origin_attempts: 0, redirects: 0 },
    app: { one_way_actions: 0, actual_eur: 0, outstanding_reservations_eur: 0, class_counts: {} },
    model: { calls: 2, refused_before_dispatch: 1, actual_eur: 0.015, outstanding_reservations_eur: 0 },
    caps: owner.authority.limits
  };
  await privateJson(join(runtimeDirectory, "cap-state.json"), cap);
  const modelRows = [
    { phase: "reservation" },
    { phase: "reconciliation", actual_eur: 0.005, reservation_within_bound: true, credential_exposed: false },
    { outcome: "refused-before-provider-dispatch" },
    { phase: "reservation" },
    { phase: "reconciliation", actual_eur: 0.01, reservation_within_bound: true, credential_exposed: false }
  ];
  await writeFile(join(runDirectory, "model-ledger.jsonl"), `${modelRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const pack = {
    schema_version: 1,
    product_summary: "Synthetic product",
    claims: [{ id: "claim", kind: "promise", text: "A synthetic promise", source_ids: ["source-001"] }],
    sources: [{ source_id: "source-001", initial_url: "https://public.example/", final_url: "https://public.example/", retrieved_at: new Date().toISOString(), status: 200, content_type: "text/html", redirect_chain: ["https://public.example/"], raw_sha256: "a".repeat(64), raw_bytes: 1, derived_text_sha256: "b".repeat(64), derived_text_bytes: 1 }]
  };
  const packBody = `${JSON.stringify(pack, null, 2)}\n`;
  await writeFile(join(packDirectory, "public-pack.json"), packBody, { mode: 0o600 });
  await writeFile(join(packDirectory, "author-runtime-manifest.json"), "stale and deliberately irrelevant\n", { mode: 0o600 });
  await privateJson(join(packDirectory, "public-pack-content-manifest.json"), { schema_version: 1, files: [{ path: "author-runtime-manifest.json", sha256: "f".repeat(64) }, { path: "public-pack.json", sha256: hash(packBody) }] });
  return {
    root,
    repository,
    ownerDirectory,
    registryPath,
    runtimeDirectory,
    runDirectory,
    packDirectory,
    configPath: join(runtimeDirectory, "target-session-config.json"),
    capPath: join(runtimeDirectory, "cap-state.json")
  };
}
