import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startAuthenticatedTargetFixture } from "../fixture/authenticated-target.mjs";
import { classifyBoundedOnboardingControl, classifyObservedControl, isBoundedOnboardingForbiddenSemantic, preflightTargetRuntime, validateActionLedger, validateBoundedOnboardingLedger, validateTargetActionRegistry } from "../lib/target-runtime.mjs";
import { prepareTargetRun } from "../scripts/prepare-target-run.mjs";
import { BrokerProcess, runTargetIsolationSession, stopProcessTree } from "../supervisor/target-session.mjs";
import { RUN_ID, ownerValues, privateJson, targetRuntimeFixture } from "./target-runtime-fixture.mjs";

test("private registry classifies only a requested current visible control", () => {
  const targetOrigin = "https://app.example.test";
  const owner = ownerValues(targetOrigin);
  validateTargetActionRegistry(owner.registry, { targetOrigin, actionLedger: owner.actionLedger, authority: owner.authority });
  const observed = { url: `${targetOrigin}/`, observation_hash: "a".repeat(64), ref: "e2", role: "button", name: "Toggle preference", visible_state_summary: "Authenticated local target\nToggle preference" };
  const classified = classifyObservedControl({ registry: owner.registry, requested: { ref: "e2", observation_hash: "a".repeat(64) }, observed });
  assert.equal(classified.ok, true);
  assert.equal(classified.classification.action_class, "Reversible own-account");
  assert.equal(classifyObservedControl({ registry: owner.registry, requested: { ref: "e3", observation_hash: "a".repeat(64) }, observed: { ...observed, ref: "e3", name: "Delete everything" } }).refusal.code, "unknown_visible_control");
  assert.equal(classifyObservedControl({ registry: owner.registry, requested: { ref: "e2", observation_hash: "a".repeat(64) }, observed: { ...observed, url: `${targetOrigin}/another-screen` } }).refusal.code, "unknown_visible_control");
});

test("bound-route classification is source-blind, scope-bound, and denies fixed dangerous semantics", () => {
  const scopeHref = "https://app.example.test/today";
  const observed = { url: scopeHref, observation_hash: "a".repeat(64), ref: "e2", role: "button", name: "Continue", visible_state_summary: "e2 [button] Continue" };
  assert.deepEqual(classifyBoundedOnboardingControl({ scopeHref, requested: { ref: "e2", observation_hash: "a".repeat(64) }, observed }), {
    ok: true,
    classification: { action_class: "Bounded own-account bound-route progress", bounded_progress_mutation_requests: 1 }
  });
  assert.equal(classifyBoundedOnboardingControl({ scopeHref, requested: { ref: "e2", observation_hash: "a".repeat(64) }, observed: { ...observed, url: "https://app.example.test/other" } }).refusal.code, "control_observation_stale");
  assert.equal(classifyBoundedOnboardingControl({ scopeHref, requested: { ref: "e2", observation_hash: "a".repeat(64) }, observed: { ...observed, name: "Start free trial" } }).refusal.code, "bounded_forbidden_semantic");
  assert.equal(classifyBoundedOnboardingControl({ scopeHref, requested: { ref: "e2", observation_hash: "a".repeat(64) }, observed: { ...observed, role: "link" } }).refusal.code, "unknown_visible_control");
  for (const label of ["Delete account", "Upload file", "Email a friend", "Notification permission", "Security settings", "Upgrade to premium", "Nu betalen", "Stuur bericht", "Camera toestaan", "Kies bestand", "Wachtwoord wijzigen", "Instellingen"]) assert.equal(isBoundedOnboardingForbiddenSemantic({ name: label }), true);
  assert.equal(isBoundedOnboardingForbiddenSemantic({ name: "Create account" }), false);
});

test("registry rejects flow hints, ambiguous controls, and unbound listed effects", () => {
  const targetOrigin = "https://app.example.test";
  const owner = ownerValues(targetOrigin);
  assert.throws(() => validateTargetActionRegistry({ ...owner.registry, journeys: [] }, { targetOrigin, actionLedger: owner.actionLedger, authority: owner.authority }), /schema/);
  assert.throws(() => validateTargetActionRegistry({ ...owner.registry, entries: [...owner.registry.entries, { ...owner.registry.entries[0], effect_id: "other" }] }, { targetOrigin, actionLedger: owner.actionLedger, authority: owner.authority }), /ambiguously/);
  const changed = structuredClone(owner.registry);
  changed.entries[1].effect_class_id = "not-authorized";
  assert.throws(() => validateTargetActionRegistry(changed, { targetOrigin, actionLedger: owner.actionLedger, authority: owner.authority }), /not admitted/);
});

test("mixed action ledger admits one reserved bounded row alongside legacy listed rows", () => {
  const targetOrigin = "https://app.example.test";
  const owner = ownerValues(targetOrigin);
  const boundedRow = {
    id: "bounded-onboarding",
    action_matrix_row: "Bounded own-account onboarding progress",
    maximum_count: 20,
    worst_case_eur_per_action: 0,
    maximum_reserved_eur: 0,
    allowed_effects: "bound-route onboarding progress only",
    reservation_rule: "reserve zero and settle zero per bound-route action"
  };
  const mixedLedger = { ...owner.actionLedger, allowed_one_way_classes: [...owner.actionLedger.allowed_one_way_classes, boundedRow] };

  const classes = validateActionLedger(mixedLedger, owner.authority);
  assert.equal(classes.has("bounded-onboarding"), false);
  assert.equal(classes.has("own-account-state"), true);
  validateBoundedOnboardingLedger(mixedLedger, owner.authority);

  const changed = structuredClone(owner.registry);
  changed.entries[1].effect_class_id = "bounded-onboarding";
  assert.throws(() => validateTargetActionRegistry(changed, { targetOrigin, actionLedger: mixedLedger, authority: owner.authority }), /not admitted/);

  const malformed = { ...owner.actionLedger, allowed_one_way_classes: [...owner.actionLedger.allowed_one_way_classes, { ...boundedRow, reservation_rule: "" }] };
  assert.throws(() => validateActionLedger(malformed, owner.authority), /malformed/);
  assert.throws(() => validateBoundedOnboardingLedger(malformed, owner.authority), /malformed/);

  for (const field of ["maximum_reserved_eur", "allowed_effects", "reservation_rule"]) {
    const { [field]: _omit, ...incompleteRow } = boundedRow;
    const missingField = { ...owner.actionLedger, allowed_one_way_classes: [...owner.actionLedger.allowed_one_way_classes, incompleteRow] };
    assert.throws(() => validateActionLedger(missingField, owner.authority), /malformed/, `missing ${field} should fail validateActionLedger`);
    assert.throws(() => validateBoundedOnboardingLedger(missingField, owner.authority), /malformed/, `missing ${field} should fail validateBoundedOnboardingLedger`);
  }

  const duplicated = { ...owner.actionLedger, allowed_one_way_classes: [...owner.actionLedger.allowed_one_way_classes, boundedRow, boundedRow] };
  assert.throws(() => validateActionLedger(duplicated, owner.authority), /duplicate/);
  assert.throws(() => validateBoundedOnboardingLedger(duplicated, owner.authority), /duplicate/);

  assert.throws(() => validateBoundedOnboardingLedger(owner.actionLedger, owner.authority), /exactly one/);

  const unknownKind = { ...owner.actionLedger, allowed_one_way_classes: [...owner.actionLedger.allowed_one_way_classes, { id: "mystery-row", action_matrix_row: "Some unknown kind", maximum_count: 1, worst_case_eur_per_action: 0 }] };
  assert.throws(() => validateActionLedger(unknownKind, owner.authority), /invalid allowed class/);

  const dupeId = { ...owner.actionLedger, allowed_one_way_classes: [...owner.actionLedger.allowed_one_way_classes, { ...owner.actionLedger.allowed_one_way_classes[0] }] };
  assert.throws(() => validateActionLedger(dupeId, owner.authority), /duplicate/);

  const capMismatch = { ...mixedLedger, caps: { ...mixedLedger.caps, listed_one_way_actions_total: mixedLedger.caps.listed_one_way_actions_total + 1 } };
  assert.throws(() => validateBoundedOnboardingLedger(capMismatch, owner.authority), /caps do not match/);
});

test("bounded auth-bootstrap admissions accept one exact declared mutation and reject an origin/URL mistake", () => {
  const targetOrigin = "https://app.example.test";
  const owner = ownerValues(targetOrigin);
  const boundedRow = {
    id: "bounded-onboarding",
    action_matrix_row: "Bounded own-account onboarding progress",
    maximum_count: 20,
    worst_case_eur_per_action: 0,
    maximum_reserved_eur: 0,
    allowed_effects: "bound-route onboarding progress only",
    reservation_rule: "reserve zero and settle zero per bound-route action"
  };
  const boundedLedger = { ...owner.actionLedger, allowed_one_way_classes: [...owner.actionLedger.allowed_one_way_classes, boundedRow] };
  const admission = { id: "onboarding-coach-start", method: "POST", url: `${targetOrigin}/api/coach/onboarding-coach/messages/stream`, maximum_count: 1, why: "Auto-fired scripted start message before the session is bound" };

  // Absent key still validates (every existing fixture omits it).
  validateBoundedOnboardingLedger(boundedLedger, owner.authority, { targetOrigin });

  // A well-formed admission validates.
  validateBoundedOnboardingLedger({ ...boundedLedger, auth_bootstrap_admissions: [admission] }, owner.authority, { targetOrigin });

  // A non-exact (non-normalized) URL is a real mistake.
  assert.throws(() => validateBoundedOnboardingLedger({ ...boundedLedger, auth_bootstrap_admissions: [{ ...admission, url: admission.url.replace("/messages/stream", "/messages/./stream") }] }, owner.authority, { targetOrigin }));

  // A wrong origin (e.g. accidentally declaring Clerk's own origin) is a real mistake.
  assert.throws(() => validateBoundedOnboardingLedger({ ...boundedLedger, auth_bootstrap_admissions: [{ ...admission, url: admission.url.replace(targetOrigin, "https://clerk.example.test") }] }, owner.authority, { targetOrigin }));

  // Legacy/full-mode has no targetOrigin here, so the same admission fails closed.
  assert.throws(() => validateActionLedger({ ...boundedLedger, auth_bootstrap_admissions: [admission] }, owner.authority));
});

test("preparation binds only public-pack.json, current costs, and private hashes", async () => {
  const fixture = await targetRuntimeFixture();
  process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE = "1";
  try {
    const result = await prepareTargetRun({ repository: fixture.repository, ownerDirectory: fixture.ownerDirectory, runId: RUN_ID, registryPath: fixture.registryPath, targetOriginOverride: "http://127.0.0.1:45678", testOnlyLocalFixture: true });
    assert.equal(result.config_path, `.runtime/${RUN_ID}/target-session-config.json`);
    assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o600);
    const config = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.deepEqual(Object.keys(config.public_pack).sort(), ["path", "sha256"]);
    assert.equal(config.cap_state.binding.model.calls, 2);
    assert.equal(config.cap_state.binding.model.actual_eur, 0.015);
    assert.doesNotMatch(JSON.stringify(config), /author-runtime-manifest/);
    await writeFile(join(fixture.packDirectory, "author-runtime-manifest.json"), "changed but still irrelevant\n");
    await preflightTargetRuntime({ repository: fixture.repository, configPath: fixture.configPath });
  } finally {
    delete process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production preparation binds one owner-declared Clerk transport without credentials", async () => {
  const fixture = await targetRuntimeFixture("https://app.example.test");
  try {
    await prepareTargetRun({
      repository: fixture.repository,
      ownerDirectory: fixture.ownerDirectory,
      runId: RUN_ID,
      registryPath: fixture.registryPath
    });
    const config = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.deepEqual(config.clerk_auth, {
      mode: "one-use-ticket",
      frontend_api_origin: "https://clerk.example.test"
    });
    assert.doesNotMatch(JSON.stringify(config), /CLERK_SECRET_KEY|user_fixture|sk_live_|sk_test_/i);
    await preflightTargetRuntime({ repository: fixture.repository, configPath: fixture.configPath });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production preparation refuses an empty safety registry before creating its config", async () => {
  const fixture = await targetRuntimeFixture("https://app.example.test");
  try {
    const registry = JSON.parse(await readFile(fixture.registryPath, "utf8"));
    registry.entries = [];
    await privateJson(fixture.registryPath, registry);
    await assert.rejects(
      () => prepareTargetRun({ repository: fixture.repository, ownerDirectory: fixture.ownerDirectory, runId: RUN_ID, registryPath: fixture.registryPath }),
      /requires a nonempty frozen action registry/
    );
    await assert.rejects(() => stat(fixture.configPath), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bounded onboarding preparation has an explicit registry-free runtime shape", async () => {
  const fixture = await targetRuntimeFixture();
  process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE = "1";
  try {
    const ledgerPath = join(fixture.ownerDirectory, "action-and-app-cost-ledger.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.allowed_one_way_classes.push({
      id: "bounded-onboarding",
      action_matrix_row: "Bounded own-account onboarding progress",
      maximum_count: 20,
      worst_case_eur_per_action: 0,
      maximum_reserved_eur: 0,
      allowed_effects: "bound-route onboarding progress only",
      reservation_rule: "reserve zero and settle zero per bound-route action"
    });
    await privateJson(ledgerPath, ledger);
    const manifestPath = join(fixture.runDirectory, "input-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.owner_input_hashes["action-and-app-cost-ledger.json"] = createHash("sha256").update(await readFile(ledgerPath)).digest("hex");
    await privateJson(manifestPath, manifest);
    await prepareTargetRun({ repository: fixture.repository, ownerDirectory: fixture.ownerDirectory, runId: RUN_ID, mode: "source-blind-bounded-onboarding-v1", targetOriginOverride: "http://127.0.0.1:45678", testOnlyLocalFixture: true });
    const config = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal(config.mode, "source-blind-bounded-onboarding-v1");
    assert.equal(Object.hasOwn(config, "target_action_registry"), false);
    assert.doesNotMatch(JSON.stringify(config), /target-action-registry|expected_request/);
    await preflightTargetRuntime({ repository: fixture.repository, configPath: fixture.configPath });
  } finally {
    delete process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an anonymous bounded run omits clerk_auth entirely and may target a second owner-approved origin", async () => {
  const fixture = await targetRuntimeFixture("https://app.example.test");
  try {
    const ledgerPath = join(fixture.ownerDirectory, "action-and-app-cost-ledger.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.allowed_one_way_classes.push({
      id: "bounded-onboarding",
      action_matrix_row: "Bounded own-account onboarding progress",
      maximum_count: 20,
      worst_case_eur_per_action: 0,
      maximum_reserved_eur: 0,
      allowed_effects: "bound-route onboarding progress only",
      reservation_rule: "reserve zero and settle zero per bound-route action"
    });
    await privateJson(ledgerPath, ledger);

    // A second, owner-declared destination -- exactly the shape adding a marketing origin
    // to explorer_navigation.allow takes -- must become a legal exploration target.
    const originPath = join(fixture.ownerDirectory, "origin-allowlist.json");
    const origin = JSON.parse(await readFile(originPath, "utf8"));
    origin.explorer_navigation = { allow: ["https://app.example.test", "https://marketing.example.test"] };
    origin.browser_request_dispatch.allow.push({ origin: "https://marketing.example.test", purpose: "Public marketing site document and static assets." });
    await privateJson(originPath, origin);

    // Anonymous never reads the account's Clerk identity at all -- prove it by making the
    // account deliberately not Clerk-shaped.
    const accountPath = join(fixture.ownerDirectory, "account.json");
    await privateJson(accountPath, { status: "pass" });

    const manifestPath = join(fixture.runDirectory, "input-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.owner_input_hashes["action-and-app-cost-ledger.json"] = createHash("sha256").update(await readFile(ledgerPath)).digest("hex");
    manifest.owner_input_hashes["origin-allowlist.json"] = createHash("sha256").update(await readFile(originPath)).digest("hex");
    manifest.owner_input_hashes["account.json"] = createHash("sha256").update(await readFile(accountPath)).digest("hex");
    await privateJson(manifestPath, manifest);

    await prepareTargetRun({
      repository: fixture.repository,
      ownerDirectory: fixture.ownerDirectory,
      runId: RUN_ID,
      mode: "source-blind-bounded-onboarding-v1",
      targetOriginOverride: "https://marketing.example.test",
      anonymous: true
    });
    const config = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal(config.target.origin, "https://marketing.example.test");
    assert.ok(config.target.allowed_request_origins.includes("https://marketing.example.test"));
    assert.equal(Object.hasOwn(config, "clerk_auth"), false);
    assert.equal(Object.hasOwn(config, "test_only_local_fixture"), false);

    const verified = await preflightTargetRuntime({ repository: fixture.repository, configPath: fixture.configPath });
    assert.equal(verified.clerkUserId, null);
    assert.equal(Object.hasOwn(verified, "clerkIdentity"), false);
    assert.equal(verified.boundedOnboarding, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("preflight returns the verified Clerk identity and later account replacement cannot change it", async () => {
  const fixture = await targetRuntimeFixture("https://app.example.test");
  try {
    await prepareTargetRun({ repository: fixture.repository, ownerDirectory: fixture.ownerDirectory, runId: RUN_ID, registryPath: fixture.registryPath });
    const verified = await preflightTargetRuntime({ repository: fixture.repository, configPath: fixture.configPath });
    assert.equal(verified.clerkUserId, "user_fixture");
    const substitute = join(fixture.ownerDirectory, "substitute-account.json");
    await privateJson(substitute, { status: "pass", identity: { provider: "Clerk", provider_user_id: "user_substitute" } });
    await rm(join(fixture.ownerDirectory, "account.json"));
    await symlink(substitute, join(fixture.ownerDirectory, "account.json"));
    assert.equal(verified.clerkUserId, "user_fixture");
    await assert.rejects(
      () => preflightTargetRuntime({ repository: fixture.repository, configPath: fixture.configPath }),
      /ordinary file|symlink|changed/i
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fixture-only target runner refuses production before minting or opening a browser", async () => {
  const fixture = await targetRuntimeFixture("https://app.example.test");
  process.env.CLERK_SECRET_KEY = "sk_live_must-remain-unused";
  try {
    await prepareTargetRun({ repository: fixture.repository, ownerDirectory: fixture.ownerDirectory, runId: RUN_ID, registryPath: fixture.registryPath });
    const config = JSON.parse(await readFile(fixture.configPath, "utf8"));
    await assert.rejects(
      () => runTargetIsolationSession({ configPath: fixture.configPath, repositoryRoot: fixture.repository }),
      /disabled until the real explorer runner owns it/
    );
    assert.equal(process.env.CLERK_SECRET_KEY, "sk_live_must-remain-unused");
    for (const path of [config.outputs.browser_config_path, config.outputs.target_run_directory, config.outputs.browser_profile_directory]) {
      await assert.rejects(() => stat(path), (error) => error?.code === "ENOENT");
    }
  } finally {
    delete process.env.CLERK_SECRET_KEY;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a planted browser profile is refused and never consumed or deleted", async () => {
  const fixture = await targetRuntimeFixture();
  process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE = "1";
  process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL = `fixture-auth-${"p".repeat(32)}`;
  try {
    await prepareTargetRun({ repository: fixture.repository, ownerDirectory: fixture.ownerDirectory, runId: RUN_ID, registryPath: fixture.registryPath, targetOriginOverride: "http://127.0.0.1:45678", testOnlyLocalFixture: true });
    const config = JSON.parse(await readFile(fixture.configPath, "utf8"));
    await mkdir(config.outputs.browser_profile_directory, { recursive: false });
    const marker = join(config.outputs.browser_profile_directory, "not-owned-by-run.txt");
    await writeFile(marker, "planted\n");
    await assert.rejects(
      () => runTargetIsolationSession({ configPath: fixture.configPath, repositoryRoot: fixture.repository }),
      /output path already exists|already exists|EEXIST/i
    );
    assert.equal(await readFile(marker, "utf8"), "planted\n");
  } finally {
    delete process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE;
    delete process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, mutate, error] of [
  ["public pack drift", async (fixture) => writeFile(join(fixture.packDirectory, "public-pack.json"), "{}\n"), /public pack changed/i],
  ["private owner drift", async (fixture) => writeFile(join(fixture.ownerDirectory, "account.json"), "{}\n"), /account\.json changed/i],
  ["cap drift", async (fixture) => { const cap = JSON.parse(await readFile(fixture.capPath)); cap.model.actual_eur += 0.001; await privateJson(fixture.capPath, cap); }, /cap state changed/i]
]) {
  test(`target preflight refuses ${label}`, async () => {
    const fixture = await targetRuntimeFixture();
    process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE = "1";
    try {
      await prepareTargetRun({ repository: fixture.repository, ownerDirectory: fixture.ownerDirectory, runId: RUN_ID, registryPath: fixture.registryPath, targetOriginOverride: "http://127.0.0.1:45678", testOnlyLocalFixture: true });
      await mutate(fixture);
      await assert.rejects(() => preflightTargetRuntime({ repository: fixture.repository, configPath: fixture.configPath }), error);
    } finally {
      delete process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE;
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("source-blind fixture session keeps auth private and blocks an unregistered mutation before dispatch", async () => {
  const sentinel = `fixture-auth-${"s".repeat(32)}`;
  const target = await startAuthenticatedTargetFixture({ sentinel });
  const fixture = await targetRuntimeFixture(target.origin);
  process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE = "1";
  process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL = sentinel;
  try {
    await prepareTargetRun({ repository: fixture.repository, ownerDirectory: fixture.ownerDirectory, runId: RUN_ID, registryPath: fixture.registryPath, targetOriginOverride: target.origin, testOnlyLocalFixture: true });
    const report = await runTargetIsolationSession({ configPath: fixture.configPath, repositoryRoot: fixture.repository });
    assert.equal(report.pass, true, JSON.stringify(report, null, 2));
    assert.equal(report.transient_auth_consumed_by_supervisor, true);
    assert.equal(report.transient_auth_absent_from_config_trace_screenshots_and_history, true);
    assert.equal(report.cap_abort.code, "unknown_mutation_request");
    assert.equal(target.requests.filter((request) => request.path === "/api/progress").length, 1);
    assert.equal(target.requests.filter((request) => request.path === "/api/progress" && request.search === "?dangerous=true").length, 0);
    assert.equal(target.requests.filter((request) => request.path === "/api/progress/another-record").length, 0);
    assert.equal(target.requests.every((request) => request.authenticated), true);
    assert.equal(target.requests.filter((request) => request.bootstrap_header_used).length, 1);
    assert.equal(report.sandbox_checks.every((check) => check.pass), true);
    const ids = new Set(report.sandbox_checks.map((check) => check.id));
    for (const id of ["unknown_visible_button_denied_without_token", "registered_reversible_action_uses_observation_bound_token", "registered_listed_action_uses_observation_bound_token", "mutation_mismatch_fails_closed"]) assert.equal(ids.has(id), true);
    const cap = JSON.parse(await readFile(fixture.capPath, "utf8"));
    assert.equal(cap.app.one_way_actions, 2);
    const prepared = JSON.parse(await readFile(fixture.configPath, "utf8"));
    assert.equal((await stat(prepared.outputs.browser_config_path)).mode & 0o777, 0o600);
    assert.equal((await stat(prepared.outputs.sandbox_input_path)).mode & 0o777, 0o600);
    await assert.rejects(() => stat(prepared.outputs.browser_profile_directory), (error) => error?.code === "ENOENT");
    const retainedTrace = await readFile(join(prepared.outputs.target_run_directory, "observations.jsonl"), "utf8");
    assert.doesNotMatch(retainedTrace, /complete-step|mismatch-step|toggle-preference|expected_request|authorization_token/);
  } finally {
    delete process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE;
    delete process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL;
    await target.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("browser RPCs fail closed on crash, wrong IDs, and silence", async () => {
  const root = await mkdtemp(join(tmpdir(), "target-rpc-deadlines-"));
  const configPath = join(root, "unused.json");
  await writeFile(configPath, "{}\n");
  try {
    const crashScript = join(root, "crash.mjs");
    await writeFile(crashScript, "process.exit(2);\n");
    const crash = new BrokerProcess(crashScript, configPath, Date.now() + 1500);
    await assert.rejects(() => crash.ready, /exited|deadline/);
    await crash.stop();

    const wrongIdScript = join(root, "wrong-id.mjs");
    await writeFile(wrongIdScript, `process.stdout.write('{"ready":true}\\n');process.stdin.on('data',()=>process.stdout.write('{"rpc_id":999,"response":{"ok":true}}\\n'));setInterval(()=>{},1000);\n`);
    const wrongId = new BrokerProcess(wrongIdScript, configPath, Date.now() + 1500);
    await wrongId.ready;
    await assert.rejects(() => wrongId.call({ method: "ping" }), /unknown RPC id|deadline/);
    await wrongId.stop();

    const silentScript = join(root, "silent.mjs");
    await writeFile(silentScript, "setInterval(()=>{},1000);\n");
    const silent = new BrokerProcess(silentScript, configPath, Date.now() + 200);
    await assert.rejects(() => silent.ready, /deadline/);
    await silent.stop();

    const midCallCrashScript = join(root, "mid-call-crash.mjs");
    await writeFile(midCallCrashScript, `process.stdout.write('{"ready":true}\\n');process.stdin.once('data',()=>process.exit(3));\n`);
    const midCallCrash = new BrokerProcess(midCallCrashScript, configPath, Date.now() + 1500);
    await midCallCrash.ready;
    await assert.rejects(() => midCallCrash.call({ method: "ping" }), /exited/);
    await midCallCrash.stop();

    const malformedReadyScript = join(root, "malformed-ready.mjs");
    await writeFile(malformedReadyScript, "process.stdout.write('not-json\\n');setInterval(()=>{},1000);\n");
    const malformedReady = new BrokerProcess(malformedReadyScript, configPath, Date.now() + 1500);
    await assert.rejects(() => malformedReady.ready, /malformed JSONL/);
    await malformedReady.stop();

    const malformedCallScript = join(root, "malformed-call.mjs");
    await writeFile(malformedCallScript, `process.stdout.write('{"ready":true}\\n');process.stdin.once('data',()=>process.stdout.write('not-json\\n'));setInterval(()=>{},1000);\n`);
    const malformedCall = new BrokerProcess(malformedCallScript, configPath, Date.now() + 1500);
    await malformedCall.ready;
    await assert.rejects(() => malformedCall.call({ method: "ping" }), /malformed JSONL/);
    await malformedCall.stop();

    const repeatedReadyScript = join(root, "repeated-ready.mjs");
    await writeFile(repeatedReadyScript, `process.stdout.write('{"ready":true}\\n{"ready":true}\\n');setInterval(()=>{},1000);\n`);
    const repeatedReady = new BrokerProcess(repeatedReadyScript, configPath, Date.now() + 1500);
    await repeatedReady.ready;
    await assert.rejects(() => repeatedReady.call({ method: "ping" }), /repeated readiness/);
    await repeatedReady.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hard process-tree stop kills an ignore-SIGTERM broker and its browser child", async () => {
  const root = await mkdtemp(join(tmpdir(), "target-hard-stop-"));
  try {
    const browserScript = join(root, "browser.mjs");
    await writeFile(browserScript, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n");
    const brokerScript = join(root, "broker.mjs");
    await writeFile(brokerScript, `import{spawn}from'node:child_process';process.on('SIGTERM',()=>{});const browser=spawn(process.execPath,[${JSON.stringify(browserScript)}],{stdio:'ignore'});process.stdout.write(String(browser.pid)+'\\n');setInterval(()=>{},1000);\n`);
    const broker = spawn(process.execPath, [brokerScript], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const browserPid = await new Promise((resolvePid) => broker.stdout.once("data", (chunk) => resolvePid(Number(String(chunk).trim()))));
    await stopProcessTree(broker, 50);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    for (const pid of [broker.pid, browserPid]) {
      assert.throws(() => process.kill(pid, 0), (error) => error?.code === "ESRCH");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
