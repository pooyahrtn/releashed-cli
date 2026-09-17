import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";
import { BOUNDED_MUTATION_DISCLOSURE } from "../renderer/render-map.mjs";
import { validateGateAEvaluation } from "./gate-a-evaluation.mjs";

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const EVENT_ID = /^event-[0-9]{4}$/;
const REVIEW_ID = /^review-[0-9a-f-]{36}$/;
const MAX_EVALUATION_BYTES = 512 * 1024;
const MAX_REVIEW_BYTES = 512 * 1024;
const REVIEW_WINDOW_MS = 10 * 60 * 1_000;
const BOUNDED_ROUTE_ACTION_CLASS = "Bounded own-account bound-route progress";
const INPUT_MANIFEST_RECORD_KIND = "spike-a-fresh-bounded-run-input-manifest";
const REQUIRED_FILES = new Set(["map.html", "observations.jsonl", "explorer-result.json", "production-run-report.json", "input-manifest.json"]);
const REQUIRED_CONDITIONS = [
  "one_coherent_fresh_user_journey",
  "zero_unsupported_solid_transitions",
  "facts_claims_inferences_unmistakable",
  "html_screenshots_readable",
  "visible_scope_and_gaps",
  "caps_within_limits"
];
const QUALITATIVE_KEYS = ["communicates_public_promises", "adds_useful_or_valid_novel_paths", "exposes_gaps", "misleads"];
const QUALITATIVE_VALUES = new Set(["yes", "partial", "no"]);
const SECRET_OR_PII = [
  /(?:OPENAI|CLERK|API|AUTH|ACCESS|SECRET|PRIVATE)[_-]?(?:KEY|TOKEN|SECRET)?\s*[=:]\s*[^\s,}"']{8,}/i,
  /\b(?:sk|pk|sess|user|ticket|sit)_(?:live|test)?[A-Za-z0-9_-]{8,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i,
  /(?:^|[\s"'])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/)[^\s"']+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:\+\d[\d ()-]{7,}\d|\b\d{3}[ -]\d{3}[ -]\d{4}\b)/
];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalJson = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function fail(message) { throw new Error(`Gate A review refused: ${message}`); }

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function scanSensitive(value, label) {
  if (typeof value !== "string" || value.length > MAX_REVIEW_BYTES || SECRET_OR_PII.some((pattern) => pattern.test(value))) fail(`${label} contains credential or private-data-shaped text`);
}

async function ordinary(path, label) {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata || metadata.isSymbolicLink()) fail(`${label} must not be a symlink`);
  return metadata;
}

async function canonicalExisting(path, label, { directory = false } = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || path !== resolve(path)) fail(`${label} must be an absolute canonical path`);
  const metadata = await ordinary(path, label);
  if (directory ? !metadata.isDirectory() : !metadata.isFile()) fail(`${label} has the wrong type`);
  const canonical = await realpath(path);
  if (canonical !== path) fail(`${label} is a path alias`);
  return canonical;
}

async function canonicalDestination(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || path !== resolve(path)) fail(`${label} must be an absolute canonical path`);
  const parent = await canonicalExisting(dirname(path), `${label} parent`, { directory: true });
  const destination = join(parent, path.slice(dirname(path).length + 1));
  if (destination !== path) fail(`${label} is a path alias`);
  if (await lstat(path).catch(() => null)) fail(`${label} already exists`);
  return destination;
}

function contained(root, raw, label) {
  if (typeof raw !== "string" || !raw || raw.includes("\\")) fail(`${label} is invalid`);
  const absolute = resolve(root, raw);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).some((part) => !part || part === "." || part === "..")) fail(`${label} escapes its root`);
  const normalized = rel.split(sep).join("/");
  if (raw !== normalized) fail(`${label} is a path alias`);
  return normalized;
}

function isPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  const crc32 = (value) => {
    let crc = 0xffffffff;
    for (const byte of value) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  let offset = 8;
  let header = null;
  let paletteEntries = null;
  let idat = [];
  let idatEnded = false;
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return false;
    const length = bytes.readUInt32BE(offset);
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type) || length > 16 * 1024 * 1024 || offset + 12 + length > bytes.length) return false;
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const actualCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([typeBytes, data])) !== actualCrc) return false;
    offset += length + 12;
    if (!header && type !== "IHDR") return false;
    if (type === "IHDR") {
      if (header || length !== 13) return false;
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      const validDepth = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 10_000 || height > 10_000 || !validDepth[colorType]?.includes(bitDepth) || compression !== 0 || filter !== 0 || interlace !== 0) return false;
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
      const rowBytes = Math.ceil(width * channels * bitDepth / 8);
      const decodedBytes = (rowBytes + 1) * height;
      if (!Number.isSafeInteger(decodedBytes) || decodedBytes > 64 * 1024 * 1024) return false;
      header = { width, height, bitDepth, colorType, channels, rowBytes, decodedBytes };
    } else if (!header || type === "IEND" && ended) return false;
    if (type === "PLTE") {
      if (idat.length || length === 0 || length % 3 !== 0 || length > 256 * 3) return false;
      paletteEntries = length / 3;
    } else if (type === "IDAT") {
      if (idatEnded || length === 0 || header.colorType === 3 && paletteEntries === null) return false;
      idat.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || !idat.length || ended) return false;
      ended = true;
    } else {
      if (idat.length) idatEnded = true;
      if (type[0] === type[0].toUpperCase()) {
        if (!["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) return false;
      }
    }
    if (ended) break;
  }
  if (!header || !idat.length || !ended || offset !== bytes.length || header.colorType === 3 && paletteEntries === null) return false;
  let decoded;
  try { decoded = inflateSync(Buffer.concat(idat), { maxOutputLength: header.decodedBytes + 1 }); } catch { return false; }
  if (decoded.length !== header.decodedBytes) return false;
  const bytesPerPixel = Math.max(1, Math.ceil(header.channels * header.bitDepth / 8));
  let previous = Buffer.alloc(header.rowBytes);
  for (let row = 0; row < header.height; row++) {
    const start = row * (header.rowBytes + 1);
    const filter = decoded[start];
    if (filter > 4) return false;
    const filtered = decoded.subarray(start + 1, start + 1 + header.rowBytes);
    const current = Buffer.alloc(header.rowBytes);
    for (let index = 0; index < header.rowBytes; index++) {
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
      const above = previous[index] ?? 0;
      const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;
      const predictor = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? (left + above - upperLeft < 0 ? left : left + above - upperLeft > 255 ? above : left + above - upperLeft) : 0;
      current[index] = (filtered[index] + predictor) & 0xff;
    }
    if (header.colorType === 3) {
      for (let x = 0; x < header.width; x++) {
        const bit = x * header.bitDepth;
        const paletteIndex = (current[Math.floor(bit / 8)] >> (8 - header.bitDepth - (bit % 8))) & ((1 << header.bitDepth) - 1);
        if (paletteIndex >= paletteEntries) return false;
      }
    }
    previous = current;
  }
  return true;
}

/** Derive only the internal citation requirements a review needs; never return rubric text. */
function reviewRequirements(evaluation) {
  return evaluation.questions.map((question) => ({
    id: question.id,
    minimum_citations: Math.max(1, question.evidenceRequirements.minimumDirectObservedTransitions),
    required_types: ["event", "screenshot"],
  }));
}

function validateInputManifest(value, runId) {
  if (
    !exactKeys(value, ["schema_version", "record_kind", "run_id", "owner_input_hashes", "owner_inputs_sealed_before_broker_start", "public_pack", "private_control_contents_disclosed", "private_identifiers_disclosed", "gate_a_evaluation_mounted_in_model_sandboxes", "product_state_authority"]) ||
    value.schema_version !== 1 ||
    value.record_kind !== INPUT_MANIFEST_RECORD_KIND ||
    value.run_id !== runId ||
    value.owner_inputs_sealed_before_broker_start !== true ||
    value.private_control_contents_disclosed !== false ||
    value.private_identifiers_disclosed !== false ||
    value.gate_a_evaluation_mounted_in_model_sandboxes !== false ||
    value.product_state_authority !== "first-retained-browser-observation" ||
    !exactKeys(value.public_pack, ["sha256"]) ||
    !HASH.test(value.public_pack.sha256 ?? "") ||
    !value.owner_input_hashes ||
    typeof value.owner_input_hashes !== "object" ||
    Array.isArray(value.owner_input_hashes) ||
    !HASH.test(value.owner_input_hashes["gate-a-evaluation.json"] ?? "") ||
    !Object.entries(value.owner_input_hashes).every(([key, hash]) => typeof key === "string" && key.trim() && HASH.test(hash ?? ""))
  ) fail("candidate input manifest shape is invalid");
  return value;
}

async function allFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail("candidate contains a symlink");
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await allFiles(root, path)));
    else if (entry.isFile()) files.push(contained(root, relative(root, path), "candidate file"));
    else fail("candidate contains an unsupported filesystem entry");
  }
  return files;
}

function evidenceShape(evidence, eventId, candidateRoot, snapshot, manifestFiles, screenshots) {
  if (!evidence || !exactKeys(evidence, ["url", "origin", "visible_state_summary", "observation_hash", "screenshot_path", "screenshot_sha256"]) || typeof evidence.url !== "string" || typeof evidence.origin !== "string" || typeof evidence.visible_state_summary !== "string" || !HASH.test(evidence.observation_hash ?? "") || !HASH.test(evidence.screenshot_sha256 ?? "")) fail(`event evidence is incomplete at ${eventId}`);
  const screenshotPath = contained(candidateRoot, evidence.screenshot_path, `screenshot at ${eventId}`);
  if (!screenshotPath.startsWith("screenshots/")) fail(`screenshot at ${eventId} is outside screenshots`);
  const bytes = snapshot.get(screenshotPath);
  if (!bytes || !isPng(bytes) || digest(bytes) !== evidence.screenshot_sha256 || manifestFiles.get(screenshotPath)?.sha256 !== evidence.screenshot_sha256 || manifestFiles.get(screenshotPath)?.bytes !== bytes.byteLength) fail(`screenshot hash or PNG validation failed at ${eventId}`);
  screenshots.add(screenshotPath);
  return screenshotPath;
}

function validateTrace(candidate, manifestFiles, runId) {
  const bytes = candidate._snapshot.get("observations.jsonl");
  const lines = bytes?.toString("utf8").split("\n").filter(Boolean) ?? [];
  if (lines.length === 0) fail("candidate trace is empty");
  const events = [];
  const ids = new Set();
  const screenshots = new Set();
  let previous = null;
  for (const [index, line] of lines.entries()) {
    let event;
    try { event = JSON.parse(line); } catch { fail(`candidate trace line ${index + 1} is invalid JSON`); }
    const required = ["run_id", "event_id", "timestamp", "current_url", "current_origin", "visible_state_summary", "before", "after", "intended_action", "effect_evidence", "action_matrix_class", "observed_outcome", "outcome_detail", "screenshot_path", "evidence_provenance", "transition_kind", "elapsed_browser_seconds", "cumulative_browser_actions", "cumulative_browser_requests", "cumulative_app_actual_eur", "cumulative_model_actual_eur", "outstanding_cost_reservation_eur"];
    if (!event || !exactKeys(event, required) || event.run_id !== runId || !EVENT_ID.test(event.event_id ?? "") || ids.has(event.event_id) || event.event_id !== `event-${String(index + 1).padStart(4, "0")}` || !Number.isFinite(Date.parse(event.timestamp)) || (previous && Date.parse(event.timestamp) < Date.parse(previous.timestamp)) || typeof event.visible_state_summary !== "string" || !event.visible_state_summary.trim() || !["current_url", "current_origin"].every((key) => event[key] === null || typeof event[key] === "string") || !["solid", "dashed", "none", "unknown-terminal"].includes(event.transition_kind) || !["Observe", "Reversible own-account", "Listed own-account progress", BOUNDED_ROUTE_ACTION_CLASS].includes(event.action_matrix_class) || typeof event.observed_outcome !== "string" || !event.observed_outcome.trim() || !["elapsed_browser_seconds", "cumulative_browser_actions", "cumulative_browser_requests", "cumulative_app_actual_eur", "cumulative_model_actual_eur", "outstanding_cost_reservation_eur"].every((key) => Number.isFinite(event[key]) && event[key] >= 0)) fail(`candidate trace event schema/order is invalid at line ${index + 1}`);
    if (!event.intended_action || typeof event.intended_action !== "object" || Array.isArray(event.intended_action) || !["navigate", "observe", "click", "type", "scroll", "wait"].includes(event.intended_action.method)) fail(`candidate trace action schema is invalid at ${event.event_id}`);
    if (event.outcome_detail !== null && typeof event.outcome_detail !== "string") fail(`candidate trace outcome detail is invalid at ${event.event_id}`);
    if (previous?.transition_kind === "unknown-terminal") fail("unknown terminal must be final");
    ids.add(event.event_id);
    const before = event.before ? evidenceShape(event.before, event.event_id, candidate.candidate, candidate._snapshot, manifestFiles, screenshots) : null;
    const after = event.after ? evidenceShape(event.after, event.event_id, candidate.candidate, candidate._snapshot, manifestFiles, screenshots) : null;
    if (previous?.after && event.before?.observation_hash !== previous.after.observation_hash) fail(`trace continuity is broken at ${event.event_id}`);
    if (event.screenshot_path !== (after ?? before)) fail(`top-level screenshot path is inconsistent at ${event.event_id}`);
    const method = event.intended_action?.method;
    // "Solid" means something observably changed -- either the accessibility tree or the pixels. Requiring only the tree hash to differ missed transitions this app makes purely visually (a word filling the answer box, a scroll repainting the viewport).
    if (event.transition_kind === "solid" && (!before || !after || (event.before.observation_hash === event.after.observation_hash && event.before.screenshot_sha256 === event.after.screenshot_sha256) || !["navigate", "click", "type", "scroll", "wait"].includes(method) || event.observed_outcome === "unknown-terminal" || event.evidence_provenance !== "direct-browser-observation")) fail(`solid event is invalid at ${event.event_id}`);
    // A click or type can legitimately turn out to be a no-op (e.g. a control that does nothing
    // observable in this run), exactly like a scroll that hits the bottom of the page -- both are
    // a genuine "nothing changed" finding, not a broken trace. Matches renderer/render-map.mjs's
    // validateTrace, which the packager reuses directly.
    // Genuinely no effect requires BOTH the tree AND the pixels to be unchanged.
    if (event.transition_kind === "none" && (!before || !after || event.before.observation_hash !== event.after.observation_hash || event.before.screenshot_sha256 !== event.after.screenshot_sha256 || !["observe", "scroll", "click", "type", "wait"].includes(method) || event.evidence_provenance !== "direct-browser-observation")) fail(`no-transition event is invalid at ${event.event_id}`);
    if (event.action_matrix_class === BOUNDED_ROUTE_ACTION_CLASS) {
      const effect = event.effect_evidence;
      if (event.intended_action.method !== "click" || !effect || !exactKeys(effect, ["supervisor_authorized", "authorization_consumed_once", "mutation_window", "mutation_association", "same_origin_mutation_requests_dispatched", "outside_window_mutation_policy"]) || effect.supervisor_authorized !== true || effect.authorization_consumed_once !== true || effect.mutation_window !== "input-dispatch-through-after-evidence" || effect.mutation_association !== "temporal-only" || ![0, 1].includes(effect.same_origin_mutation_requests_dispatched) || effect.outside_window_mutation_policy !== "block-and-abort") fail(`bound-route effect evidence is invalid at ${event.event_id}`);
    } else if (["Reversible own-account", "Listed own-account progress"].includes(event.action_matrix_class)) {
      const effect = event.effect_evidence;
      if (!effect || !exactKeys(effect, ["supervisor_authorized", "mutation_request_match"]) || effect.supervisor_authorized !== true || (effect.mutation_request_match !== null && typeof effect.mutation_request_match !== "boolean") || (event.action_matrix_class === "Listed own-account progress" && effect.mutation_request_match !== true)) fail(`redacted effect evidence is invalid at ${event.event_id}`);
    } else if (event.effect_evidence !== null) fail(`unexpected effect evidence is invalid at ${event.event_id}`);
    if (event.transition_kind === "unknown-terminal" && event.evidence_provenance !== "broker-refusal-or-unknown") fail(`unknown event provenance is invalid at ${event.event_id}`);
    if (event.transition_kind === "dashed" && !["public-claim", "inference"].includes(event.evidence_provenance)) fail(`dashed event provenance is invalid at ${event.event_id}`);
    if (event.observed_outcome === "route-scope-exit" && (index !== lines.length - 1 || event.transition_kind !== "solid" || event.action_matrix_class !== BOUNDED_ROUTE_ACTION_CLASS || method !== "click" || !before || !after || before.url === after.url || before.origin !== after.origin || event.current_url !== after.url || event.current_origin !== after.origin)) fail(`bound-route exit is invalid at ${event.event_id}`);
    events.push(event);
    previous = event;
  }
  for (const [path, bytesValue] of candidate._snapshot) if (path.startsWith("screenshots/") && (!isPng(bytesValue) || !screenshots.has(path))) fail(`screenshot ${path} is not valid retained evidence`);
  return events;
}

export async function snapshotCandidate(candidatePath) {
  const candidate = await canonicalExisting(candidatePath, "candidate", { directory: true });
  const manifestPath = join(candidate, "manifest.json");
  await canonicalExisting(manifestPath, "candidate manifest");
  const manifestBytes = await readFile(manifestPath);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { fail("candidate manifest is invalid JSON"); }
  if (!exactKeys(manifest, ["schema_version", "run_id", "files", "candidate_sha256"]) || manifest.schema_version !== 1 || !ID.test(manifest.run_id ?? "") || !Array.isArray(manifest.files) || !HASH.test(manifest.candidate_sha256 ?? "")) fail("candidate manifest schema is invalid");
  if (manifest.files.some((file, index) => index > 0 && (typeof file?.path !== "string" || typeof manifest.files[index - 1]?.path !== "string" || file.path <= manifest.files[index - 1].path))) fail("candidate manifest files are not in deterministic order");
  if (manifest.candidate_sha256 !== digest(canonicalJson({ schema_version: manifest.schema_version, run_id: manifest.run_id, files: manifest.files }))) fail("candidate manifest hash does not match");
  const manifestFiles = new Map();
  const snapshot = new Map([["manifest.json", manifestBytes]]);
  for (const file of manifest.files) {
    if (!exactKeys(file, ["path", "bytes", "sha256"]) || !HASH.test(file.sha256 ?? "") || !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail("candidate manifest file entry is invalid");
    const path = contained(candidate, file.path, "candidate manifest path");
    if (path === "manifest.json" || manifestFiles.has(path)) fail("candidate manifest has duplicate paths");
    await canonicalExisting(join(candidate, path), `candidate file ${path}`);
    const bytes = await readFile(join(candidate, path));
    if (bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256) fail(`candidate file hash mismatch for ${path}`);
    manifestFiles.set(path, { bytes: file.bytes, sha256: file.sha256 });
    snapshot.set(path, bytes);
  }
  const actual = (await allFiles(candidate)).sort();
  const expected = ["manifest.json", ...manifestFiles.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("candidate contains unmanifested or missing files");
  for (const required of REQUIRED_FILES) if (!manifestFiles.has(required)) fail(`candidate is missing required ${required}`);
  let report;
  try { report = JSON.parse(snapshot.get("production-run-report.json").toString("utf8")); } catch { fail("production report is invalid JSON"); }
  if (report?.schema_version !== 1 || report.run_id !== manifest.run_id || report.candidate_eligible !== true) fail("production report is not eligible for review");
  let inputManifestValue;
  try { inputManifestValue = JSON.parse(snapshot.get("input-manifest.json").toString("utf8")); } catch { fail("candidate input manifest is invalid JSON"); }
  const inputManifest = validateInputManifest(inputManifestValue, manifest.run_id);
  for (const [path, bytes] of snapshot) if (!path.startsWith("screenshots/")) scanSensitive(bytes.toString("utf8"), `candidate ${path}`);
  const map = snapshot.get("map.html").toString("utf8");
  const embedded = [...map.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/gi)].map((match) => Buffer.from(match[1], "base64"));
  const screenshotHashes = new Set([...manifestFiles].filter(([path]) => path.startsWith("screenshots/")).map(([, file]) => file.sha256));
  if (!/^\s*<!doctype html>/i.test(map) || !/<html(?:\s|>)/i.test(map) || embedded.length === 0 || embedded.some((bytes) => !isPng(bytes) || !screenshotHashes.has(digest(bytes))) || [...screenshotHashes].some((hash) => !embedded.some((bytes) => digest(bytes) === hash)) || /(?:href|src)=["'][^"']*screenshots\//i.test(map)) fail("map.html is not a standalone embedded artifact");
  const candidateData = { candidate, manifest, manifestBytes, snapshot, manifestFiles };
  candidateData._snapshot = snapshot;
  const events = validateTrace(candidateData, manifestFiles, manifest.run_id);
  for (const event of events) if (!map.includes(event.event_id)) fail(`map.html omits trace event ${event.event_id}`);
  if (events.some((event) => event.action_matrix_class === BOUNDED_ROUTE_ACTION_CLASS) && !map.includes(BOUNDED_MUTATION_DISCLOSURE)) fail("map.html omits the bounded mutation temporal-only disclosure");
  return { ...candidateData, events, candidate_sha256: manifest.candidate_sha256, inputManifest };
}

async function readEvaluation(evaluationPath) {
  const path = await canonicalExisting(evaluationPath, "sealed evaluation");
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_EVALUATION_BYTES) fail("sealed evaluation is too large");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("sealed evaluation is invalid JSON"); }
  validateGateAEvaluation(value);
  return { path, bytes, evaluation_sha256: digest(bytes), questions: reviewRequirements(value) };
}

async function writePrivateExclusive(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function publishExclusive(path, bytes) {
  await canonicalExisting(dirname(path), "receipt parent", { directory: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writePrivateExclusive(temporary, bytes);
    const { link } = await import("node:fs/promises");
    await link(temporary, path);
    await unlink(temporary);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readBoundedStdin({ deadline, monotonicNow, input }) {
  const chunks = [];
  let size = 0;
  return new Promise((resolvePromise, reject) => {
    const finish = (error, value = null) => {
      clearInterval(timer);
      input.off("data", onData); input.off("end", onEnd); input.off("error", onError); input.off("close", onClose);
      if (error) reject(error); else resolvePromise(value);
    };
    const timer = setInterval(() => { if (monotonicNow() >= deadline) finish(new Error("Gate A review refused: review window elapsed")); }, 50);
    const onData = (chunk) => { const bytes = Buffer.from(chunk); size += bytes.byteLength; if (size > MAX_REVIEW_BYTES) finish(new Error("Gate A review refused: reviewer input is too large")); else chunks.push(bytes); };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onError = () => finish(new Error("Gate A review refused: reviewer input failed"));
    const onClose = () => { if (!input.readableEnded) finish(new Error("Gate A review refused: reviewer input closed")); };
    input.on("data", onData); input.once("end", onEnd); input.once("error", onError); input.once("close", onClose);
  });
}

function validateReview(value, questions, candidate, reviewId, candidateHash, evaluationHash) {
  if (!exactKeys(value, ["schema_version", "kind", "review_id", "candidate_sha256", "evaluation_sha256", "answers", "necessary_conditions", "qualitative_judgments"]) || value.schema_version !== 1 || value.kind !== "gate-a-review" || value.review_id !== reviewId || value.candidate_sha256 !== candidateHash || value.evaluation_sha256 !== evaluationHash || !Array.isArray(value.answers) || value.answers.length !== questions.length) fail("review JSON shape or hash binding is invalid");
  const byQuestion = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set();
  const answers = value.answers.map((answer) => {
    if (!exactKeys(answer, ["question_id", "score", "answer", "citations"]) || !byQuestion.has(answer.question_id) || seen.has(answer.question_id) || ![0, 1, 2].includes(answer.score) || typeof answer.answer !== "string" || !answer.answer.trim() || answer.answer.length > 4_000 || !Array.isArray(answer.citations)) fail("review question answer is invalid");
    seen.add(answer.question_id);
    const question = byQuestion.get(answer.question_id);
    if (answer.citations.length < question.minimum_citations) fail(`review question ${answer.question_id} lacks citations`);
    const citationKeys = new Set();
    const citations = answer.citations.map((citation) => {
      if (!exactKeys(citation, ["event_id", "screenshot_path"]) || !EVENT_ID.test(citation.event_id ?? "") || typeof citation.screenshot_path !== "string") fail(`review question ${answer.question_id} has an invalid citation`);
      const event = candidate.events.find((item) => item.event_id === citation.event_id);
      if (!event) fail(`review question ${answer.question_id} cites an unknown event`);
      const path = contained(candidate.candidate, citation.screenshot_path, "review screenshot citation");
      const key = `${citation.event_id}\n${path}`;
      if (citationKeys.has(key) || !candidate.manifestFiles.has(path) || ![event.before?.screenshot_path, event.after?.screenshot_path].includes(path)) fail(`review question ${answer.question_id} cites the wrong screenshot`);
      citationKeys.add(key);
      return { event_id: citation.event_id, screenshot_path: path };
    });
    for (const type of question.required_types) if (type === "event" && citations.length === 0) fail(`review question ${answer.question_id} lacks event evidence`);
    scanSensitive(answer.answer, `review answer ${answer.question_id}`);
    return { question_id: answer.question_id, score: answer.score, answer: answer.answer, citations };
  });
  if (!exactKeys(value.necessary_conditions, REQUIRED_CONDITIONS) || REQUIRED_CONDITIONS.some((key) => typeof value.necessary_conditions[key] !== "boolean")) fail("review necessary conditions are invalid");
  if (!exactKeys(value.qualitative_judgments, QUALITATIVE_KEYS) || QUALITATIVE_KEYS.some((key) => !QUALITATIVE_VALUES.has(value.qualitative_judgments[key]))) fail("review qualitative judgments are invalid");
  return { answers, necessary_conditions: value.necessary_conditions, qualitative_judgments: value.qualitative_judgments };
}

export async function runGateAReview({ candidatePath, evaluationPath, reviewerInputPath, receiptPath, input = process.stdin, output = process.stdout, wallNow = Date.now, monotonicNow = () => performance.now() }) {
  const candidate = await snapshotCandidate(candidatePath);
  const candidateRoot = candidate.candidate;
  const evaluationPathCanonical = await canonicalExisting(evaluationPath, "sealed evaluation");
  const reviewerInput = await canonicalDestination(reviewerInputPath, "reviewer input");
  const receipt = await canonicalDestination(receiptPath, "receipt");
  if (evaluationPathCanonical.startsWith(`${candidateRoot}${sep}`) || reviewerInput.startsWith(`${candidateRoot}${sep}`) || receipt.startsWith(`${candidateRoot}${sep}`)) fail("control paths must be outside candidate");
  const evaluation = await readEvaluation(evaluationPathCanonical);
  if (candidate.inputManifest.owner_input_hashes["gate-a-evaluation.json"] !== evaluation.evaluation_sha256) fail("candidate input manifest is not bound to the sealed evaluation");
  if (reviewerInput === evaluation.path || receipt === evaluation.path || reviewerInput === receipt) fail("control paths must be pairwise distinct");
  await writePrivateExclusive(reviewerInput, evaluation.bytes);
  const reviewId = `review-${randomUUID()}`;
  const startedAt = wallNow();
  const deadline = monotonicNow() + REVIEW_WINDOW_MS;
  output.write(`${JSON.stringify({ schema_version: 1, kind: "gate-a-session-ready", review_id: reviewId, candidate_sha256: candidate.candidate_sha256, evaluation_sha256: evaluation.evaluation_sha256, started_at: new Date(startedAt).toISOString(), deadline_at: new Date(startedAt + REVIEW_WINDOW_MS).toISOString() })}\n`);
  try {
    const reviewBytes = await readBoundedStdin({ deadline, monotonicNow, input });
    if (monotonicNow() >= deadline) fail("review window elapsed");
    scanSensitive(reviewBytes.toString("utf8"), "review input");
    let review;
    try { review = JSON.parse(reviewBytes.toString("utf8")); } catch { fail("review input is not strict JSON"); }
    const currentCandidate = await snapshotCandidate(candidateRoot);
    if (!currentCandidate.manifestBytes.equals(candidate.manifestBytes) || currentCandidate.candidate_sha256 !== candidate.candidate_sha256) fail("candidate changed during review");
    await canonicalExisting(evaluation.path, "sealed evaluation");
    await canonicalExisting(dirname(reviewerInput), "reviewer input parent", { directory: true });
    await canonicalExisting(dirname(receipt), "receipt parent", { directory: true });
    const currentEvaluation = await readFile(evaluation.path);
    if (!currentEvaluation.equals(evaluation.bytes) || digest(currentEvaluation) !== evaluation.evaluation_sha256) fail("sealed evaluation changed during review");
    const normalized = validateReview(review, evaluation.questions, candidate, reviewId, candidate.candidate_sha256, evaluation.evaluation_sha256);
    const passed = normalized.answers.every((answer) => answer.score === 2) && Object.values(normalized.necessary_conditions).every(Boolean);
    const receiptBody = canonicalJson({ schema_version: 1, kind: "gate-a-receipt", review_id: reviewId, candidate_sha256: candidate.candidate_sha256, evaluation_sha256: evaluation.evaluation_sha256, started_at: new Date(startedAt).toISOString(), reviewed_at: new Date(wallNow()).toISOString(), status: passed ? "pass" : "fail", answers: normalized.answers, necessary_conditions: normalized.necessary_conditions, qualitative_judgments: normalized.qualitative_judgments });
    await publishExclusive(receipt, receiptBody);
    output.write(`${JSON.stringify({ schema_version: 1, kind: "gate-a-receipt-published", review_id: reviewId, status: passed ? "pass" : "fail", candidate_sha256: candidate.candidate_sha256, evaluation_sha256: evaluation.evaluation_sha256 })}\n`);
    return { review_id: reviewId, status: passed ? "pass" : "fail", candidate_sha256: candidate.candidate_sha256, evaluation_sha256: evaluation.evaluation_sha256 };
  } finally {
    await unlink(reviewerInput).catch(() => {});
  }
}
