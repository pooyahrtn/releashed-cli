import { lstat, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { sha256File, sha256Text } from "./scaffold.mjs";
import { validatePublicPack } from "./public-pack-runtime.mjs";

export const TARGET_RUNTIME_ID = "spike-a-source-blind-target-runtime-v1";
export const TARGET_REGISTRY_KIND = "spike-a-target-action-registry";
export const LEGACY_TARGET_RUNTIME_MODE = "source-blind-target-isolation";
export const BOUNDED_ONBOARDING_RUNTIME_MODE = "source-blind-bounded-onboarding-v1";
export const BOUNDED_ONBOARDING_ACTION_CLASS = "Bounded own-account bound-route progress";
const BOUNDED_ONBOARDING_LEDGER_ROW = "Bounded own-account onboarding progress";
export const PRIVATE_OWNER_FILES = [
  "authority-and-start.json",
  "origin-allowlist.json",
  "account.json",
  "action-and-app-cost-ledger.json",
  "retention.json"
];

const ACTION_CLASSES = new Set(["Reversible own-account", "Listed own-account progress"]);
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const FROZEN_SPIKE_CAPS = {
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

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function exactOrigin(raw) {
  const url = new URL(raw);
  requireCondition(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, "Target origin must be a normalized HTTP(S) origin");
  return url.origin;
}

function clerkFrontendApiOrigin(originPolicy) {
  const candidates = originPolicy?.browser_request_dispatch?.allow?.filter(
    (entry) => typeof entry?.purpose === "string" && /Clerk frontend\/auth session transport only/i.test(entry.purpose)
  ) ?? [];
  requireCondition(candidates.length === 1, "Owner origin policy must identify one Clerk frontend API origin");
  return exactOrigin(candidates[0].origin);
}

async function requireOrdinaryFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(`${label} is missing`);
  }
  requireCondition(metadata.isFile(), `${label} must be an ordinary file`);
  requireCondition(!metadata.isSymbolicLink(), `${label} must not be a symlink`);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function ownerCaps(authority) {
  const limits = authority?.limits;
  requireCondition(limits && Object.entries(FROZEN_SPIKE_CAPS).every(([key, value]) => limits[key] === value), "Owner authority does not contain the exact frozen Spike A caps");
  return structuredClone(FROZEN_SPIKE_CAPS);
}

async function readJsonSnapshot(path, label) {
  await requireOrdinaryFile(path, label);
  const bytes = await readFile(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
  return { value, sha256: sha256Text(bytes) };
}

async function readTextSnapshot(path, label) {
  await requireOrdinaryFile(path, label);
  const bytes = await readFile(path);
  return { bytes, text: bytes.toString("utf8"), sha256: sha256Text(bytes) };
}

// The bounded row is a reserved, bounded-mode-only entry: legacy mode must
// tolerate it sitting in the same shared ledger without admitting it into the
// legacy registry class map.
function isStrictBoundedOnboardingRow(entry) {
  return (
    !!entry &&
    typeof entry.id === "string" && entry.id.length > 0 &&
    entry.action_matrix_row === BOUNDED_ONBOARDING_LEDGER_ROW &&
    entry.maximum_count === 20 &&
    entry.worst_case_eur_per_action === 0 &&
    entry.maximum_reserved_eur === 0 &&
    typeof entry.allowed_effects === "string" && entry.allowed_effects.trim().length > 0 &&
    typeof entry.reservation_rule === "string" && entry.reservation_rule.trim().length > 0
  );
}

export function validateActionLedger(ledger, authority, { targetOrigin = null, ignoreAuthBootstrapAdmissions = false } = {}) {
  requireCondition(ledger?.schema_version === 1 && ledger.record_kind === "spike-a-action-and-app-cost-ledger" && ledger.status === "pass", "Private app-action ledger is invalid");
  const caps = ownerCaps(authority);
  requireCondition(
    ledger.caps?.listed_one_way_actions_total === caps.listed_one_way_actions_total &&
      ledger.caps?.app_side_actual_plus_outstanding_reservations_eur === caps.app_side_cost_cap_eur &&
      ledger.caps?.combined_model_and_app_actual_plus_outstanding_reservations_eur === caps.combined_actual_plus_reserved_cap_eur,
    "Private app-action ledger caps do not match owner authority"
  );
  requireCondition(Array.isArray(ledger.allowed_one_way_classes) && ledger.allowed_one_way_classes.length > 0, "Private app-action ledger has no allowed classes");
  const classes = new Map();
  const ids = new Set();
  let boundedRowSeen = false;
  for (const entry of ledger.allowed_one_way_classes) {
    requireCondition(typeof entry?.id === "string" && entry.id && !ids.has(entry.id), "Private app-action ledger contains a duplicate or invalid class id");
    ids.add(entry.id);
    if (entry.action_matrix_row === BOUNDED_ONBOARDING_LEDGER_ROW) {
      requireCondition(!boundedRowSeen, "Private app-action ledger contains a duplicate bound-route class");
      requireCondition(isStrictBoundedOnboardingRow(entry), "Private app-action ledger's reserved bound-route class is malformed");
      boundedRowSeen = true;
      continue;
    }
    requireCondition(
      entry.action_matrix_row === "Listed own-account progress" && Number.isSafeInteger(entry.maximum_count) && entry.maximum_count >= 0 && finiteNonnegative(entry.worst_case_eur_per_action),
      "Private app-action ledger contains an invalid allowed class"
    );
    classes.set(entry.id, entry);
  }
  // These admissions exist only to allow a handful of same-origin mutations that a target
  // fires automatically during the private-auth-start window, before any session is bound
  // (see boundedPrivateAuthStart in the browser broker). An anonymous bounded run never
  // enters that window at all, so a learner-app-scoped admission is inert -- and irrelevant
  // to whatever unrelated origin the run is actually exploring -- rather than a mismatch.
  if (!ignoreAuthBootstrapAdmissions && ledger.auth_bootstrap_admissions !== undefined) {
    // Bare-minimum guard for the bounded private-auth-start allowance: each entry's
    // URL must be an exact, already-normalized, same-origin URL. A legacy/full-mode
    // ledger has no targetOrigin here, so `url.origin === null` always fails closed.
    requireCondition(Array.isArray(ledger.auth_bootstrap_admissions), "Bounded auth-bootstrap admissions must be an array");
    for (const entry of ledger.auth_bootstrap_admissions) {
      let url;
      try {
        url = new URL(entry.url);
      } catch {
        throw new Error("Bounded auth-bootstrap admission URL is invalid");
      }
      requireCondition(url.href === entry.url && url.origin === targetOrigin, "Bounded auth-bootstrap admission URL must be an exact, same-origin URL");
    }
  }
  return classes;
}

export function validateBoundedOnboardingLedger(ledger, authority, { targetOrigin = null, ignoreAuthBootstrapAdmissions = false } = {}) {
  validateActionLedger(ledger, authority, { targetOrigin, ignoreAuthBootstrapAdmissions });
  const boundedRows = (ledger.allowed_one_way_classes ?? []).filter((entry) => entry?.action_matrix_row === BOUNDED_ONBOARDING_LEDGER_ROW);
  requireCondition(boundedRows.length === 1, "Private app-action ledger must contain exactly one zero-cost bound-route class with maximum 20");
}

function normalizedSemanticText(...parts) {
  return parts.join(" ").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// This is deliberately a fixed, product-neutral deny list. It is not a policy
// input and therefore cannot leak target-specific safety classifications.
const BOUNDED_FORBIDDEN_SEMANTICS = /\b(?:upgrade|premium|checkout|pay(?:ment)?|betalen|betaling|billing|purchase|buy|subscribe|subscription|trial|proef(?:periode)?|invite|invitation|uitnodig(?:en|ing)?|refer|referral|share|delen|publish|post|send|message|bericht|verstuur|delete|verwijder(?:en)?|remove|erase|upload|attach|import|bestand|file|bijlage|choose|select|permission|toestaan|allow|camera|microphone|microfoon|location|locatie|notify|notification|notifications|melding(?:en)?|contact|email|mail|security|beveiliging|password|wachtwoord|credential|settings?|instellingen|account\s+(?:delete|remove|close|settings?|verwijder(?:en)?|sluiten))\b/i;

export function isBoundedOnboardingForbiddenSemantic({ name, visible_state_summary = "" } = {}) {
  // The retained summary contains neighbouring controls, so it must not make a
  // safe control guilty by association. The accessible name is the exact bound
  // semantic surface for this click.
  return BOUNDED_FORBIDDEN_SEMANTICS.test(normalizedSemanticText(String(name ?? "")));
}

export function classifyBoundedOnboardingControl({ scopeHref, requested, observed }) {
  if (!exactKeys(requested, ["ref", "observation_hash"]) || typeof requested.ref !== "string" || typeof requested.observation_hash !== "string") {
    return { ok: false, refusal: { code: "control_request_invalid", message: "A current visible control reference is required" } };
  }
  if (!observed || requested.ref !== observed.ref || requested.observation_hash !== observed.observation_hash || observed.url !== scopeHref) {
    return { ok: false, refusal: { code: "control_observation_stale", message: "The requested control is not bound to the current route" } };
  }
  if (!["button", "checkbox", "radio"].includes(observed.role)) {
    return { ok: false, refusal: { code: "unknown_visible_control", message: "Only controls currently observed on the bound route may be used" } };
  }
  if (isBoundedOnboardingForbiddenSemantic(observed)) {
    return { ok: false, refusal: { code: "bounded_forbidden_semantic", message: "This control is outside the bound route action boundary" } };
  }
  return { ok: true, classification: { action_class: BOUNDED_ONBOARDING_ACTION_CLASS, bounded_progress_mutation_requests: 1 } };
}

export function validateTargetActionRegistry(registry, { targetOrigin, actionLedger, authority }) {
  const origin = exactOrigin(targetOrigin);
  requireCondition(
    exactKeys(registry, ["schema_version", "record_kind", "status", "target_origin", "entries"]) &&
      registry.schema_version === 1 &&
      registry.record_kind === TARGET_REGISTRY_KIND &&
      registry.status === "pass" &&
      registry.target_origin === origin &&
      Array.isArray(registry.entries),
    "Private target-action registry schema is invalid"
  );
  const oneWayClasses = validateActionLedger(actionLedger, authority);
  const controlKeys = new Set();
  const effectIds = new Set();
  for (const entry of registry.entries) {
    requireCondition(
      exactKeys(entry, ["visible_control", "action_class", "effect_id", "effect_class_id", "expected_request"]) &&
        exactKeys(entry.visible_control, ["url", "role", "accessible_name", "required_visible_text"]) &&
        typeof entry.visible_control.url === "string" && new URL(entry.visible_control.url).origin === origin && new URL(entry.visible_control.url).href === entry.visible_control.url && !new URL(entry.visible_control.url).search && !new URL(entry.visible_control.url).hash &&
        ["button", "link", "checkbox", "radio"].includes(entry.visible_control.role) &&
        typeof entry.visible_control.accessible_name === "string" && entry.visible_control.accessible_name.trim() === entry.visible_control.accessible_name && entry.visible_control.accessible_name.length > 0 && entry.visible_control.accessible_name.length <= 160 &&
        Array.isArray(entry.visible_control.required_visible_text) && entry.visible_control.required_visible_text.length > 0 && entry.visible_control.required_visible_text.length <= 3 && entry.visible_control.required_visible_text.every((text) => typeof text === "string" && text.trim() === text && text.length > 0 && text.length <= 160) &&
        ACTION_CLASSES.has(entry.action_class) && typeof entry.effect_id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(entry.effect_id) && !effectIds.has(entry.effect_id) &&
        typeof entry.effect_class_id === "string" && /^[a-z][a-z0-9-]{0,95}$/.test(entry.effect_class_id),
      "Private target-action registry contains an invalid entry"
    );
    const controlKey = `${entry.visible_control.url}\n${entry.visible_control.role}\n${entry.visible_control.accessible_name}\n${JSON.stringify(entry.visible_control.required_visible_text)}`;
    requireCondition(!controlKeys.has(controlKey), "Private target-action registry ambiguously classifies one visible control");
    if (entry.action_class === "Reversible own-account") {
      requireCondition(entry.expected_request === null && entry.effect_class_id === "reversible-own-account", "Reversible registry entries must not authorize a mutation request");
    } else {
      requireCondition(oneWayClasses.has(entry.effect_class_id), "Listed registry entry is not admitted by the private app-action ledger");
      requireCondition(exactKeys(entry.expected_request, ["method", "url"]), "Listed registry entry must bind exactly one mutation request");
      const method = String(entry.expected_request.method).toUpperCase();
      requireCondition(MUTATION_METHODS.has(method), "Listed registry entry uses a non-mutation method");
      const requestUrl = new URL(entry.expected_request.url);
      requireCondition(requestUrl.origin === origin && requestUrl.href === entry.expected_request.url && !requestUrl.hash, "Listed registry entry mutation must be an exact same-origin URL without a fragment");
      entry.expected_request = { method, url: requestUrl.href };
    }
    controlKeys.add(controlKey);
    effectIds.add(entry.effect_id);
  }
  return registry;
}

export function classifyObservedControl({ registry, requested, observed }) {
  if (!exactKeys(requested, ["ref", "observation_hash"]) || typeof requested.ref !== "string" || typeof requested.observation_hash !== "string") {
    return { ok: false, refusal: { code: "control_request_invalid", message: "A current visible control reference is required" } };
  }
  if (!observed || requested.ref !== observed.ref || requested.observation_hash !== observed.observation_hash || new URL(observed.url).origin !== registry.target_origin) {
    return { ok: false, refusal: { code: "control_observation_stale", message: "The requested control is not bound to the current retained observation" } };
  }
  const observedUrl = new URL(observed.url);
  observedUrl.search = "";
  observedUrl.hash = "";
  const entries = registry.entries.filter((candidate) => candidate.visible_control.url === observedUrl.href && candidate.visible_control.role === observed.role && candidate.visible_control.accessible_name === observed.name && candidate.visible_control.required_visible_text.every((text) => observed.visible_state_summary.includes(text)));
  if (entries.length !== 1) return { ok: false, refusal: { code: entries.length > 1 ? "ambiguous_visible_control" : "unknown_visible_control", message: "This visible control does not have one exact private safety classification" } };
  const [entry] = entries;
  return {
    ok: true,
    classification: {
      action_class: entry.action_class,
      effect_id: entry.effect_id,
      effect_class_id: entry.effect_class_id,
      expected_request: entry.expected_request
    }
  };
}

function parseJsonl(body, label) {
  try {
    return body.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    throw new Error(`${label} is invalid JSONL`);
  }
}

function validateCurrentCap({ cap, authority, ledgerRows, runId }) {
  const caps = ownerCaps(authority);
  requireCondition(cap?.run_id === runId && cap.abort === null, "Current cap state is not usable for this run");
  requireCondition(Number.isFinite(Date.parse(cap.working_day_deadline)) && Date.parse(cap.working_day_deadline) > Date.now(), "Original working-day deadline has expired");
  requireCondition(Object.entries(caps).every(([key, value]) => cap.caps?.[key] === value), "Current cap state does not retain every original owner cap");
  const reconciliations = ledgerRows.filter((row) => row.phase === "reconciliation");
  const reservations = ledgerRows.filter((row) => row.phase === "reservation");
  const refused = ledgerRows.filter((row) => row.outcome === "refused-before-provider-dispatch");
  const actual = reconciliations.reduce((sum, row) => sum + Number(row.actual_eur), 0);
  requireCondition(reconciliations.every((row) => finiteNonnegative(row.actual_eur) && row.reservation_within_bound === true && row.credential_exposed === false), "Model ledger has an unsafe reconciliation");
  requireCondition(reservations.length === reconciliations.length && cap.model?.calls === reconciliations.length && cap.model?.refused_before_dispatch === refused.length && cap.model?.outstanding_reservations_eur === 0, "Current model call ledger is not fully reconciled");
  requireCondition(Math.abs(cap.model.actual_eur - actual) < 1e-12 && finiteNonnegative(cap.model.actual_eur) && cap.model.actual_eur <= caps.model_cost_cap_eur, "Current model cost does not match its ledger");
  requireCondition(cap.app?.actual_eur === 0 && cap.app?.outstanding_reservations_eur === 0 && cap.app?.one_way_actions === 0, "Target app budget was already consumed");
  requireCondition(cap.model.actual_eur + cap.app.actual_eur <= caps.combined_actual_plus_reserved_cap_eur, "Current combined cost exceeds the original cap");
  return {
    working_day_deadline: cap.working_day_deadline,
    caps,
    model: {
      calls: cap.model.calls,
      refused_before_dispatch: cap.model.refused_before_dispatch,
      actual_eur: cap.model.actual_eur,
      outstanding_reservations_eur: 0
    },
    app: { one_way_actions: 0, actual_eur: 0, outstanding_reservations_eur: 0 }
  };
}

export async function buildTargetRuntimeConfig({ repository, ownerDirectory, runId, registryPath = null, mode = LEGACY_TARGET_RUNTIME_MODE, targetOriginOverride = null, testOnlyLocalFixture = false, anonymous = false, savedSessionPath = null }) {
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(runId), "Run id is invalid");
  const repo = resolve(repository);
  const owner = resolve(ownerDirectory);
  const runtimeDirectory = join(repo, ".runtime", runId);
  const sourceRunDirectory = join(repo, "runs", runId);
  const capStatePath = join(runtimeDirectory, "cap-state.json");
  const modelLedgerPath = join(sourceRunDirectory, "model-ledger.jsonl");
  const inputManifestPath = join(sourceRunDirectory, "input-manifest.json");
  const packDirectory = join(repo, "packs", `public-pack-${runId}`);
  const publicPackPath = join(packDirectory, "public-pack.json");
  const packContentManifestPath = join(packDirectory, "public-pack-content-manifest.json");
  requireCondition([LEGACY_TARGET_RUNTIME_MODE, BOUNDED_ONBOARDING_RUNTIME_MODE].includes(mode), "Target runtime mode is invalid");
  const boundedOnboarding = mode === BOUNDED_ONBOARDING_RUNTIME_MODE;
  requireCondition(!(anonymous && savedSessionPath), "Cannot request both anonymous and saved-session modes");
  requireCondition(!savedSessionPath || boundedOnboarding, "A saved session requires bounded-onboarding mode");
  const actionRegistryPath = boundedOnboarding ? null : resolve(registryPath ?? "");
  // Bring-your-own-session: a human logged in by hand and a trusted capture step (see
  // scripts/capture-session.mjs) saved the resulting cookies/storage to this private,
  // mode-0600 file outside the repo. Only its path and hash travel through this config --
  // the browser broker is the sole reader of the raw file, at start() time.
  const savedSession = savedSessionPath
    ? await (async () => {
        const sessionPath = resolve(savedSessionPath);
        await requireOrdinaryFile(sessionPath, "Saved session file");
        requireCondition(((await stat(sessionPath)).mode & 0o777) === 0o600, "Saved session file is not private");
        return { path: sessionPath, sha256: await sha256File(sessionPath) };
      })()
    : null;
  const ownerSnapshots = Object.fromEntries(await Promise.all(PRIVATE_OWNER_FILES.map(async (file) => [file, await readJsonSnapshot(join(owner, file), `owner ${file}`)])));
  const [capSnapshot, registrySnapshot, inputManifestSnapshot, contentManifestSnapshot, publicPackSnapshot, modelLedgerSnapshot] = await Promise.all([
    readJsonSnapshot(capStatePath, "cap state"),
    boundedOnboarding ? Promise.resolve(null) : readJsonSnapshot(actionRegistryPath, "action registry"),
    readJsonSnapshot(inputManifestPath, "input manifest"),
    readJsonSnapshot(packContentManifestPath, "public-pack content manifest"),
    readJsonSnapshot(publicPackPath, "public pack"),
    readTextSnapshot(modelLedgerPath, "model ledger")
  ]);
  const cap = capSnapshot.value;
  const authority = ownerSnapshots["authority-and-start.json"].value;
  const originPolicy = ownerSnapshots["origin-allowlist.json"].value;
  const account = ownerSnapshots["account.json"].value;
  const actionLedger = ownerSnapshots["action-and-app-cost-ledger.json"].value;
  const retention = ownerSnapshots["retention.json"].value;
  const registry = registrySnapshot?.value ?? null;
  const inputManifest = inputManifestSnapshot.value;
  const contentManifest = contentManifestSnapshot.value;
  const publicPack = publicPackSnapshot.value;
  requireCondition(authority.status === "pass" && originPolicy.status === "pass" && account.status === "pass" && retention.status === "pass", "A frozen private owner input is not approved");
  const ownerInputHashes = {};
  for (const file of PRIVATE_OWNER_FILES) {
    const digest = ownerSnapshots[file].sha256;
    requireCondition(inputManifest?.owner_input_hashes?.[file] === digest, `Private owner input ${file} changed after the run was sealed`);
    ownerInputHashes[file] = digest;
  }
  // explorer_navigation.allow is the owner-authored destination allowlist; fall back to the
  // legacy single learner-app origin when it is absent, so every existing fixture/config that
  // predates this field keeps working unchanged.
  const approvedTargetOrigins = (originPolicy.explorer_navigation?.allow ?? [originPolicy.deployed_origins?.learner_app]).map(exactOrigin);
  const permittedTargetOrigin = approvedTargetOrigins[0];
  const targetOrigin = targetOriginOverride ? exactOrigin(targetOriginOverride) : permittedTargetOrigin;
  const fixtureAllowed = testOnlyLocalFixture && process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE === "1";
  requireCondition(approvedTargetOrigins.includes(targetOrigin) || (fixtureAllowed && targetOrigin.startsWith("http://127.0.0.1:")), "Target origin is not an owner-approved explorer navigation origin");
  if (boundedOnboarding) validateBoundedOnboardingLedger(actionLedger, authority, { targetOrigin, ignoreAuthBootstrapAdmissions: anonymous || Boolean(savedSession) });
  else {
    validateTargetActionRegistry(registry, { targetOrigin, actionLedger, authority });
    if (!fixtureAllowed) requireCondition(registry.entries.length > 0, "Production target exploration requires a nonempty frozen action registry");
  }
  validatePublicPack(publicPack);
  requireCondition(contentManifest?.schema_version === 1 && Array.isArray(contentManifest.files), "Public-pack content manifest is invalid");
  const publicPackHash = publicPackSnapshot.sha256;
  const packRows = contentManifest.files.filter((entry) => entry?.path === "public-pack.json");
  requireCondition(packRows.length === 1 && packRows[0].sha256 === publicPackHash, "public-pack.json does not match its sealed content manifest");
  const capBinding = validateCurrentCap({ cap, authority, ledgerRows: parseJsonl(modelLedgerSnapshot.text, "Model ledger"), runId });

  const targetRunDirectory = join(sourceRunDirectory, "target-session-1");
  const targetProfileDirectory = join(runtimeDirectory, "target-profile-1");
  const generated = {
    browser_config_path: join(runtimeDirectory, "target-browser-config.json"),
    sandbox_input_path: join(runtimeDirectory, "target-sandbox-input.json"),
    target_run_directory: targetRunDirectory,
    browser_profile_directory: targetProfileDirectory
  };
  requireCondition(!(await Promise.all(Object.values(generated).map(pathExists))).some(Boolean), "A target-session output path already exists");
  return {
    schema_version: 1,
    runtime_identity: TARGET_RUNTIME_ID,
    mode,
    run_id: runId,
    public_pack: { path: publicPackPath, sha256: publicPackHash },
    private_owner_inputs: Object.fromEntries(PRIVATE_OWNER_FILES.map((file) => [file, { path: join(owner, file), sha256: ownerInputHashes[file] }])),
    ...(boundedOnboarding ? {} : { target_action_registry: { path: actionRegistryPath, sha256: registrySnapshot.sha256 } }),
    cap_state: { path: capStatePath, sha256: capSnapshot.sha256, binding: capBinding },
    model_ledger: { path: modelLedgerPath, sha256: modelLedgerSnapshot.sha256 },
    target: {
      origin: targetOrigin,
      initial_url: `${targetOrigin}/`,
      allowed_navigation_origins: [targetOrigin],
      allowed_request_origins: fixtureAllowed ? [targetOrigin] : originPolicy.browser_request_dispatch.allow.map((entry) => entry.origin),
      suppressed_request_origins: fixtureAllowed ? [] : originPolicy.browser_request_dispatch.recognized_but_suppress_before_dispatch.map((entry) => entry.origin)
    },
    outputs: generated,
    ...(fixtureAllowed
      ? { test_only_local_fixture: true, transient_auth: { mode: "header", header_name: "x-flow-map-fixture-auth", origin: targetOrigin } }
      // A bounded-onboarding caller may explicitly ask for no authentication at all — the
      // absence of clerk_auth is itself the signal the browser broker reads to skip the whole
      // private-auth phase and explore as an anonymous visitor.
      : anonymous && boundedOnboarding
        ? {}
        // Bring-your-own-session: the human already authenticated by hand, so the browser
        // broker loads this exact private file instead of ever touching Clerk.
        : savedSession && boundedOnboarding
          ? { saved_session: savedSession }
          : { clerk_auth: { mode: "one-use-ticket", frontend_api_origin: clerkFrontendApiOrigin(originPolicy) } })
  };
}

export async function preflightTargetRuntime({ repository, configPath }) {
  const repo = resolve(repository);
  await requireOrdinaryFile(configPath, "Target runtime configuration");
  requireCondition(((await stat(configPath)).mode & 0o777) === 0o600, "Target runtime configuration is not private");
  const config = (await readJsonSnapshot(configPath, "Target runtime configuration")).value;
  const boundedOnboarding = config?.mode === BOUNDED_ONBOARDING_RUNTIME_MODE;
  // A bounded-onboarding config may omit clerk_auth entirely to explore as an anonymous
  // visitor; its absence (and no local fixture either) is itself the signal.
  const anonymousBounded = boundedOnboarding && config.test_only_local_fixture !== true && config.clerk_auth === undefined;
  // A saved-session config carries the same "no clerk_auth" signal as anonymousBounded plus
  // one extra private-file binding; it is still routed through every anonymousBounded check
  // below (they gate on clerk_auth's absence, which is true for both).
  const savedSessionBounded = anonymousBounded && config.saved_session !== undefined;
  const expectedKeys = ["schema_version", "runtime_identity", "mode", "run_id", "public_pack", "private_owner_inputs", ...(boundedOnboarding ? [] : ["target_action_registry"]), "cap_state", "model_ledger", "target", "outputs", ...(config.test_only_local_fixture ? ["test_only_local_fixture", "transient_auth"] : savedSessionBounded ? ["saved_session"] : anonymousBounded ? [] : ["clerk_auth"])];
  requireCondition(exactKeys(config, expectedKeys) && config.schema_version === 1 && config.runtime_identity === TARGET_RUNTIME_ID && [LEGACY_TARGET_RUNTIME_MODE, BOUNDED_ONBOARDING_RUNTIME_MODE].includes(config.mode), "Target runtime configuration schema is invalid");
  if (savedSessionBounded) requireCondition(exactKeys(config.saved_session, ["path", "sha256"]) && /^[0-9a-f]{64}$/.test(config.saved_session.sha256), "Saved-session binding is invalid");
  const fixtureAllowed = config.test_only_local_fixture === true && process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE === "1";
  requireCondition(config.test_only_local_fixture !== true || fixtureAllowed, "Local target fixture mode is test-only");
  requireCondition(exactKeys(config.public_pack, ["path", "sha256"]) && /^[0-9a-f]{64}$/.test(config.public_pack.sha256), "Target public-pack binding is invalid");
  requireCondition(exactKeys(config.private_owner_inputs, PRIVATE_OWNER_FILES), "Target private-owner binding set is invalid");
  for (const file of PRIVATE_OWNER_FILES) requireCondition(exactKeys(config.private_owner_inputs[file], ["path", "sha256"]) && /^[0-9a-f]{64}$/.test(config.private_owner_inputs[file].sha256), `Target private-owner binding for ${file} is invalid`);
  if (!boundedOnboarding) requireCondition(exactKeys(config.target_action_registry, ["path", "sha256"]) && /^[0-9a-f]{64}$/.test(config.target_action_registry.sha256), "Target registry binding is invalid");
  requireCondition(exactKeys(config.cap_state, ["path", "sha256", "binding"]) && /^[0-9a-f]{64}$/.test(config.cap_state.sha256), "Target cap binding is invalid");
  requireCondition(exactKeys(config.model_ledger, ["path", "sha256"]) && /^[0-9a-f]{64}$/.test(config.model_ledger.sha256), "Target model-ledger binding is invalid");
  requireCondition(exactKeys(config.target, ["origin", "initial_url", "allowed_navigation_origins", "allowed_request_origins", "suppressed_request_origins"]), "Target origin policy binding is invalid");
  requireCondition(exactKeys(config.outputs, ["browser_config_path", "sandbox_input_path", "target_run_directory", "browser_profile_directory"]), "Target output binding is invalid");
  if (fixtureAllowed) requireCondition(exactKeys(config.transient_auth, ["mode", "header_name", "origin"]) && config.transient_auth.mode === "header" && config.transient_auth.header_name === "x-flow-map-fixture-auth" && config.transient_auth.origin === config.target.origin, "Synthetic fixture auth policy is invalid");
  if (!fixtureAllowed && !anonymousBounded) {
    const clerkKeys = boundedOnboarding
      ? ["mode", "frontend_api_origin", "approved_disposable_identity"]
      : ["mode", "frontend_api_origin"];
    requireCondition(exactKeys(config.clerk_auth, clerkKeys) && config.clerk_auth.mode === "one-use-ticket", "Production Clerk auth policy is invalid");
  }
  const packPath = resolve(config.public_pack.path);
  requireCondition(relative(join(repo, "packs"), packPath) === join(`public-pack-${config.run_id}`, "public-pack.json"), "Target runtime is not bound to the exact run public-pack.json");
  const [publicPackSnapshot, capSnapshot, modelLedgerSnapshot, ...privateSnapshots] = await Promise.all([
    readTextSnapshot(packPath, "Target public pack"),
    readJsonSnapshot(config.cap_state.path, "Target cap state"),
    readTextSnapshot(config.model_ledger.path, "Target model ledger"),
    ...PRIVATE_OWNER_FILES.map((file) => readJsonSnapshot(config.private_owner_inputs[file].path, `Private owner input ${file}`)),
    ...(boundedOnboarding ? [] : [readJsonSnapshot(config.target_action_registry.path, "Private target-action registry")])
  ]);
  requireCondition(publicPackSnapshot.sha256 === config.public_pack.sha256, "Target public pack changed after preparation");
  let publicPack;
  try {
    publicPack = JSON.parse(publicPackSnapshot.text);
  } catch {
    throw new Error("Target public pack is invalid JSON");
  }
  validatePublicPack(publicPack);
  if (savedSessionBounded) {
    // Defense in depth: this process re-reads and re-hashes the saved-session file itself
    // rather than trusting the path+hash binding alone. The raw bytes never leave this
    // function -- only the pass/fail of the hash comparison does.
    const sessionPath = resolve(config.saved_session.path);
    await requireOrdinaryFile(sessionPath, "Saved session file");
    requireCondition(((await stat(sessionPath)).mode & 0o777) === 0o600, "Saved session file is not private");
    requireCondition((await sha256File(sessionPath)) === config.saved_session.sha256, "Saved session file changed after preparation");
  }
  const cap = capSnapshot.value;
  requireCondition(capSnapshot.sha256 === config.cap_state.sha256, "Target cap state changed after preparation");
  requireCondition(modelLedgerSnapshot.sha256 === config.model_ledger.sha256, "Target model ledger changed after preparation");
  for (let index = 0; index < PRIVATE_OWNER_FILES.length; index += 1) requireCondition(privateSnapshots[index].sha256 === config.private_owner_inputs[PRIVATE_OWNER_FILES[index]].sha256, `Private owner input ${PRIVATE_OWNER_FILES[index]} changed after target preparation`);
  const registrySnapshot = boundedOnboarding ? null : privateSnapshots.at(-1);
  if (!boundedOnboarding) requireCondition(registrySnapshot.sha256 === config.target_action_registry.sha256, "Private target-action registry changed after preparation");
  const privateValues = Object.fromEntries(PRIVATE_OWNER_FILES.map((file, index) => [file, privateSnapshots[index].value]));
  const authority = privateValues["authority-and-start.json"];
  const originPolicy = privateValues["origin-allowlist.json"];
  const account = privateValues["account.json"];
  const actionLedger = privateValues["action-and-app-cost-ledger.json"];
  const registry = registrySnapshot?.value ?? null;
  const currentCapBinding = validateCurrentCap({ cap, authority, ledgerRows: parseJsonl(modelLedgerSnapshot.text, "Target model ledger"), runId: config.run_id });
  requireCondition(JSON.stringify(currentCapBinding) === JSON.stringify(config.cap_state.binding), "Current deadline, caps, or model cost no longer match target preparation");
  if (boundedOnboarding) validateBoundedOnboardingLedger(actionLedger, authority, { targetOrigin: config.target.origin, ignoreAuthBootstrapAdmissions: anonymousBounded });
  else {
    validateTargetActionRegistry(registry, { targetOrigin: config.target.origin, actionLedger, authority });
    if (!fixtureAllowed) requireCondition(registry.entries.length > 0, "Production target exploration requires a nonempty frozen action registry");
  }
  const approvedTargetOrigins = (originPolicy.explorer_navigation?.allow ?? [originPolicy.deployed_origins?.learner_app]).map(exactOrigin);
  requireCondition(approvedTargetOrigins.includes(config.target.origin) || (fixtureAllowed && config.target.origin.startsWith("http://127.0.0.1:")), "Target origin no longer matches the private owner policy");
  requireCondition(config.target.initial_url === `${config.target.origin}/` && JSON.stringify(config.target.allowed_navigation_origins) === JSON.stringify([config.target.origin]), "Target navigation policy is not exact");
  const expectedRequestOrigins = fixtureAllowed ? [config.target.origin] : originPolicy.browser_request_dispatch.allow.map((entry) => entry.origin);
  const expectedSuppressedOrigins = fixtureAllowed ? [] : originPolicy.browser_request_dispatch.recognized_but_suppress_before_dispatch.map((entry) => entry.origin);
  requireCondition(JSON.stringify(config.target.allowed_request_origins) === JSON.stringify(expectedRequestOrigins) && JSON.stringify(config.target.suppressed_request_origins) === JSON.stringify(expectedSuppressedOrigins), "Target request policy no longer matches the private owner policy");
  if (!fixtureAllowed && !anonymousBounded) {
    requireCondition(account?.identity?.provider === "Clerk" && typeof account.identity.provider_user_id === "string", "Private account is not an approved Clerk identity");
    requireCondition(config.clerk_auth.frontend_api_origin === clerkFrontendApiOrigin(originPolicy) && config.target.allowed_request_origins.includes(config.clerk_auth.frontend_api_origin), "Production Clerk origin is not bound to the owner request policy");
    if (boundedOnboarding) {
      const identity = config.clerk_auth.approved_disposable_identity;
      requireCondition(
        exactKeys(identity, ["provider_user_id", "username"]) &&
          identity.provider_user_id === account.identity.provider_user_id &&
          identity.username === account.identity.username &&
          typeof identity.username === "string",
        "Bounded Clerk identity is not bound to the approved disposable account"
      );
    }
  }
  const runtimeDirectory = join(repo, ".runtime", config.run_id);
  const sourceRunDirectory = join(repo, "runs", config.run_id);
  requireCondition(config.cap_state.path === join(runtimeDirectory, "cap-state.json") && config.model_ledger.path === join(sourceRunDirectory, "model-ledger.jsonl"), "Target cost bindings are not the exact source-run artifacts");
  requireCondition(JSON.stringify(config.outputs) === JSON.stringify({ browser_config_path: join(runtimeDirectory, "target-browser-config.json"), sandbox_input_path: join(runtimeDirectory, "target-sandbox-input.json"), target_run_directory: join(sourceRunDirectory, "target-session-1"), browser_profile_directory: join(runtimeDirectory, "target-profile-1") }), "Target output paths are not the fixed exclusive paths");
  requireCondition(!(await Promise.all(Object.values(config.outputs).map(pathExists))).some(Boolean), "A target-session output path already exists");
  return {
    config,
    authority,
    actionLedger,
    registry,
    boundedOnboarding,
    fixtureAllowed,
    publicPackText: publicPackSnapshot.text,
    clerkUserId: fixtureAllowed || anonymousBounded ? null : account.identity.provider_user_id,
    ...(fixtureAllowed || !boundedOnboarding || anonymousBounded
      ? {}
      : { clerkIdentity: {
          providerUserId: config.clerk_auth.approved_disposable_identity.provider_user_id,
          username: config.clerk_auth.approved_disposable_identity.username
        } })
  };
}
