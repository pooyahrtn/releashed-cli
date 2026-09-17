// Product notebook: customer-authored, evidence-backed flow notes over sealed captures.
//
// One canonical JSON file per flow at <store>/knowledge/<sha256(origin)>/<flow-id>.json,
// where <store> is dirname(resolve(mapsRoot)). Reads never create, lock or write.
// Writes are explicit (rememberFlow), atomic (temp file + rename) and guarded by an
// expected-revision check inside an exclusive per-note filesystem lock.
//
// A note is an agent-authored interpretation, never verified truth and never a
// certification of product behavior. The author declares an evidence-only
// basis up front (author_context, required, bounded, stored verbatim and
// labelled unverified); source/owner-derived context is rejected for V1.
// Every claim must cite at least one retained
// selected original; the runtime binds each citation to immutable evidence
// (manifest digest, image digest, exact trace event + side, side URL at that
// observation) and revalidates on every read and write.
//
// Semantic limits of runtime validation (not proofs): the secret/identifier
// patterns below are heuristics over obvious shapes. They do not prove the
// absence of personal data, and they do not judge whether a claim is true,
// fresh, ready or complete. Review note text before relying on it.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findCapture, findCaptures } from "./capture-memory.mjs";
import { assertRunId } from "./capture-metadata.mjs";
import { digest, sealedFile } from "./capture-selection.mjs";
export const NOTE_SCHEMA_VERSION = 1;
export const MAX_NOTE_INPUT_BYTES = 64 * 1024;
const MAX_STORED_NOTE_BYTES = 256 * 1024;
// The server never invents an author context: the caller declares it, the
// runtime only checks that the declaration is present, bounded, and
// explicitly evidence-only (source/owner-derived context is rejected for
// V1). Stored declarations are labelled unverified: nothing checks that the
// author actually inspected the cited originals or stayed evidence-only.
const FLOW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLAIM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID = 64;
const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const MAX_CONDITIONS = 2000;
const MAX_REASON = 1000;
const MAX_CLAIMS = 20;
const MAX_REFS_PER_CLAIM = 8;
const MAX_RETIRE = 20;
const MAX_AUTHOR_CONTEXT = 500;
// An acceptable declaration names its evidence-only basis outright
// (e.g. which retained originals were inspected). Anything naming a
// source/owner-derived basis is excluded context for V1, not a judgment
// that the text is otherwise true or safe: heuristics, not proof.
const EVIDENCE_ONLY_DECLARATION = /evidence-only/i;
const EXCLUDED_CONTEXT = /source[\s_-]*(derived|based|seeded|route|review)|owner[\s_-]*(derived|claims|route|sequence)|review sequence|diagnosis sequence|expected score/i;
const MAX_FLOWS_PER_ORIGIN = 200;
const MAX_ORIGINS_SCANNED = 50;
const MAX_QUERY = 500;
const DISPLAY_TRUNCATE = 500;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
// Heuristic only: obvious credential/session-shaped content is rejected, but a
// passing note is still untrusted data and may contain personal or sensitive
// text these patterns miss. Do not treat validation as a PII or truth guarantee.
const SECRET_SHAPES = [
    { name: "private-key block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
    { name: "aws access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: "api secret", pattern: /\bsk-(live|test)-[A-Za-z0-9_-]{8,}\b/ },
    { name: "chat token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/ },
    { name: "password assignment", pattern: /\bpassword\s*[:=]\s*\S+/i },
    { name: "api-key assignment", pattern: /\bapi[_-]?key\s*[:=]\s*['"]?\S+/i },
    { name: "bearer token", pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{10,}=*/i },
    { name: "session cookie", pattern: /\b(sessionid|connect\.sid|sid)\s*=\s*[A-Fa-f0-9]{16,}/i },
];
function fail(message) {
    throw new Error(message);
}
function assertPlainObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail(`${label} must be a JSON object`);
}
function rejectExtra(value, allowed, label) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key))
            fail(`${label} has unsupported field ${JSON.stringify(key)}`);
    }
}
function cleanText(value, label, max, { allowEmpty = false } = {}) {
    if (typeof value !== "string")
        fail(`${label} must be a string`);
    const text = value.trim();
    if (!allowEmpty && !text)
        fail(`${label} must be non-empty`);
    if (text.length > max)
        fail(`${label} is too long (${text.length} chars; limit ${max})`);
    if (CONTROL_CHARS.test(text))
        fail(`${label} contains control characters`);
    for (const shape of SECRET_SHAPES) {
        if (shape.pattern.test(text))
            fail(`${label} looks like it contains ${shape.name}; only generalized product behavior belongs in notes`);
    }
    return text;
}
function cleanId(value, label, pattern) {
    if (typeof value !== "string" || !pattern.test(value) || value.length > MAX_ID)
        fail(`${label} must be 1-${MAX_ID} chars of lowercase letters, digits and dashes`);
    return value;
}
/** The deployed product origin. Only http(s), never credentials, query or fragment. */
export function assertOrigin(url) {
    if (typeof url !== "string")
        fail("url must be a string");
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        fail("url must be an http(s) product URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
        fail("url must be an http(s) product URL without credentials");
    return parsed.origin;
}
const originKey = (origin) => createHash("sha256").update(origin).digest("hex");
const storeRoot = (mapsRoot) => dirname(resolve(mapsRoot));
function knowledgeDir(mapsRoot, origin) {
    return join(storeRoot(mapsRoot), "knowledge", originKey(origin));
}
/** Deepest existing ancestor, fully resolved, with missing tail reattached. */
async function realDir(path) {
    let existing = resolve(path);
    const rest = [];
    for (;;) {
        try {
            return join(await realpath(existing), ...rest.reverse());
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const parent = dirname(existing);
            if (parent === existing)
                throw error;
            rest.push(existing.slice(parent.length + 1));
            existing = parent;
        }
    }
}
/** Real-filesystem containment anchored at the knowledge base: every existing
 *  component (including a symlinked origin dir or note file) is resolved and the
 *  final path must stay inside the resolved base. Reads and writes share this
 *  check. No promise against a malicious root owner. */
async function containedUnder(base, segments) {
    const label = segments.join("/");
    const realBase = await realDir(base);
    let current = realBase;
    for (const segment of segments) {
        if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || isAbsolute(segment))
            fail(`path escapes the store: ${label}`);
        current = join(current, segment);
        try {
            current = await realpath(current);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    const within = relative(realBase, current);
    if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
        fail(`symlink escapes the store: ${label}`);
    return current;
}
async function notePathFor(mapsRoot, origin, flowId, suffix = ".json") {
    // Anchored at the real store root (not at knowledge/): a symlinked
    // knowledge dir or origin dir pointing outside the store is rejected.
    return containedUnder(await realDir(storeRoot(mapsRoot)), ["knowledge", originKey(origin), `${flowId}${suffix}`]);
}
async function readStoredNote(notePath) {
    let raw;
    try {
        const info = await stat(notePath);
        if (!info.isFile() || info.size > MAX_STORED_NOTE_BYTES)
            fail(`stored note must be a file of at most ${MAX_STORED_NOTE_BYTES} bytes: ${notePath}`);
        raw = await readFile(notePath, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        fail(`stored note is not valid JSON: ${notePath}`);
    }
    assertPlainObject(parsed, "stored note");
    return parsed;
}
const HEX64 = /^[a-f0-9]{64}$/;
/** Deep validation of a stored note: bounds, identifiers, states and bound
 *  reference shapes. A hand-edited or corrupt note fails here with an
 *  explicit reason instead of breaking callers downstream. */
function assertStoredNote(note, notePath) {
    if (!note || typeof note !== "object" || Array.isArray(note))
        fail(`stored note is invalid: ${notePath}`);
    if (note.schema_version !== 1)
        fail(`stored note has unsupported schema: ${notePath}`);
    if (typeof note.flow_id !== "string" || !FLOW_ID.test(note.flow_id) || note.flow_id.length > MAX_ID)
        fail(`stored note flow_id is invalid: ${notePath}`);
    if (typeof note.origin !== "string")
        fail(`stored note origin is invalid: ${notePath}`);
    try {
        assertOrigin(note.origin);
    }
    catch {
        fail(`stored note origin is invalid: ${notePath}`);
    }
    if (typeof note.title !== "string" || !note.title.trim() || note.title.length > MAX_TITLE)
        fail(`stored note title is invalid: ${notePath}`);
    if (!Number.isInteger(note.revision) || note.revision < 1)
        fail(`stored note revision is invalid: ${notePath}`);
    if (typeof note.modified_at !== "string" || Number.isNaN(Date.parse(note.modified_at)))
        fail(`stored note modified_at is invalid: ${notePath}`);
    if (typeof note.author_context !== "string" || !note.author_context.trim() || note.author_context.length > MAX_AUTHOR_CONTEXT)
        fail(`stored note author_context is invalid: ${notePath}`);
    if (note.author_context_verified !== false)
        fail(`stored note author_context_verified is invalid: ${notePath}`);
    if (!Array.isArray(note.claims) || note.claims.length > MAX_CLAIMS)
        fail(`stored note claims are invalid: ${notePath}`);
    const ids = new Set();
    for (const [index, claim] of note.claims.entries()) {
        const label = `stored note claims[${index}]`;
        if (!claim || typeof claim !== "object" || Array.isArray(claim))
            fail(`${label} is invalid: ${notePath}`);
        if (typeof claim.id !== "string" || !CLAIM_ID.test(claim.id) || claim.id.length > MAX_ID)
            fail(`${label} id is invalid: ${notePath}`);
        if (ids.has(claim.id))
            fail(`${label} duplicates id ${JSON.stringify(claim.id)}: ${notePath}`);
        ids.add(claim.id);
        if (typeof claim.text !== "string" || !claim.text.trim() || claim.text.length > MAX_TEXT)
            fail(`${label} text is invalid: ${notePath}`);
        if (typeof claim.conditions !== "string" || !claim.conditions.trim() || claim.conditions.length > MAX_CONDITIONS)
            fail(`${label} conditions are invalid: ${notePath}`);
        if (claim.state !== "current" && claim.state !== "uncertain" && claim.state !== "retired")
            fail(`${label} state is invalid: ${notePath}`);
        if (!Array.isArray(claim.references) || claim.references.length === 0 || claim.references.length > MAX_REFS_PER_CLAIM)
            fail(`${label} references are invalid: ${notePath}`);
        for (const [refIndex, ref] of claim.references.entries()) {
            const refLabel = `${label} references[${refIndex}]`;
            if (!ref || typeof ref !== "object" || Array.isArray(ref))
                fail(`${refLabel} is invalid: ${notePath}`);
            try {
                assertRunId(ref.run_id, "stored reference run_id");
            }
            catch {
                fail(`${refLabel} run_id is invalid: ${notePath}`);
            }
            if (typeof ref.manifest_sha256 !== "string" || !HEX64.test(ref.manifest_sha256))
                fail(`${refLabel} manifest digest is invalid: ${notePath}`);
            if (typeof ref.screenshot_path !== "string" || !ref.screenshot_path.startsWith("screenshots/") || isAbsolute(ref.screenshot_path) || ref.screenshot_path.split(/[\\/]/).includes(".."))
                fail(`${refLabel} path is invalid: ${notePath}`);
            if (typeof ref.screenshot_sha256 !== "string" || !HEX64.test(ref.screenshot_sha256))
                fail(`${refLabel} image digest is invalid: ${notePath}`);
            if (ref.event_id !== null && typeof ref.event_id !== "string")
                fail(`${refLabel} event_id is invalid: ${notePath}`);
            if (ref.side !== "before" && ref.side !== "after")
                fail(`${refLabel} side is invalid: ${notePath}`);
            if (ref.captured_at !== null && (typeof ref.captured_at !== "string" || Number.isNaN(Date.parse(ref.captured_at))))
                fail(`${refLabel} captured_at is invalid: ${notePath}`);
            if (typeof ref.cited_url !== "string" || !ref.cited_url)
                fail(`${refLabel} cited_url is invalid: ${notePath}`);
        }
        for (const key of ["supersedes", "superseded_by", "retired_reason"]) {
            const value = claim[key];
            if (value !== undefined && (typeof value !== "string" || !value))
                fail(`${label} ${key} is invalid: ${notePath}`);
        }
    }
}
/** The run directory itself must live under the resolved maps root. A
 *  symlinked maps/<run> (or screenshots dir) pointing at an external run
 *  is not retained store evidence, even when that external run is
 *  internally consistent. Static containment only; it does not defend
 *  against swaps between check and use. */
async function containedRunDir(mapsRoot, runId) {
    const base = await realpath(resolve(mapsRoot)).catch(() => resolve(mapsRoot));
    const dir = await realpath(join(resolve(mapsRoot), runId)).catch(() => null);
    if (!dir)
        return null;
    const within = relative(base, dir);
    if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
        return null;
    return dir;
}
/** Bind one proposed citation to immutable sealed evidence. Only exact-run
 *  selected originals are eligible: never raw map listings, never the stop
 *  screenshot fallback, never unselected observations. */
async function bindReference(mapsRoot, origin, ref) {
    assertRunId(ref.run_id, "reference run_id");
    if (typeof ref.screenshot_path !== "string" || !ref.screenshot_path)
        fail("reference screenshot_path must be a string");
    const candidateDir = join(resolve(mapsRoot), ref.run_id);
    if (!await containedRunDir(mapsRoot, ref.run_id))
        fail(`reference run ${ref.run_id} is outside the product store; only retained runs may be cited`);
    let rel;
    if (isAbsolute(ref.screenshot_path)) {
        const root = await realpath(resolve(mapsRoot)).catch(() => resolve(mapsRoot));
        const file = await realpath(resolve(ref.screenshot_path)).catch(() => null);
        if (!file)
            fail(`reference image is not retained: ${ref.run_id} ${ref.screenshot_path}`);
        const within = relative(join(root, ref.run_id), file);
        if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`) || within.split(sep).includes(".."))
            fail(`reference image is outside run ${ref.run_id}; only retained originals may be cited`);
        rel = within.split(sep).join("/");
    }
    else {
        if (ref.screenshot_path.split(/[\\/]/).includes(".."))
            fail(`reference image escapes run ${ref.run_id}`);
        rel = ref.screenshot_path;
    }
    const found = await findCapture({ mapsRoot, runId: ref.run_id }).catch(() => null);
    if (!found)
        fail(`reference run is not a retained sealed capture: ${ref.run_id}`);
    if (!found.selection)
        fail(`reference run ${ref.run_id} has no verified selected originals; a stop-image fallback cannot support a note`);
    const eligible = new Set(found.goal_screenshots.map((shot) => resolve(found.candidate_path, shot.screenshot_path)));
    if (!eligible.has(resolve(candidateDir, rel)))
        fail(`reference image is not a selected original of run ${ref.run_id}; unselected observations cannot support a note`);
    const manifestBytes = await readFile(join(candidateDir, "manifest.json")).catch(() => null);
    if (!manifestBytes)
        fail(`reference manifest is unavailable: ${ref.run_id}`);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const manifestSha = digest(manifestBytes);
    const imageBytes = await sealedFile(candidateDir, manifest, rel);
    if (!imageBytes)
        fail(`reference image is missing or changed after sealing: ${ref.run_id} ${rel}`);
    const imageSha = digest(imageBytes);
    const traceBytes = await sealedFile(candidateDir, manifest, "observations.jsonl");
    if (!traceBytes)
        fail(`reference trace is unavailable: ${ref.run_id}`);
    const matches = [];
    for (const line of String(traceBytes).split("\n").filter(Boolean)) {
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            continue;
        }
        for (const side of ["before", "after"]) {
            if (event[side]?.screenshot_path === rel) {
                matches.push({ event_id: typeof event.event_id === "string" ? event.event_id : null, side, url: event[side]?.url, timestamp: event.timestamp });
            }
        }
    }
    if (matches.length === 0)
        fail(`reference image has no retained observation event: ${ref.run_id} ${rel}`);
    for (const match of matches) {
        if (typeof match.url !== "string" || !match.url)
            fail(`reference observation has no usable origin: ${ref.run_id} ${rel}`);
    }
    const origins = new Set(matches.map((match) => {
        try {
            return new URL(match.url).origin;
        }
        catch {
            return null;
        }
    }));
    if (origins.size !== 1 || origins.has(null))
        fail(`reference observation origin is missing or ambiguous: ${ref.run_id} ${rel}`);
    const citedUrl = matches[0].url;
    if (!origins.has(origin))
        fail(`reference observation url ${citedUrl} is outside the note origin ${origin}; unrelated map screens are never valid supports`);
    const stamp = matches[0].timestamp;
    const capturedAt = typeof stamp === "string" && stamp.trim() && !Number.isNaN(Date.parse(stamp))
        ? new Date(stamp).toISOString()
        : null;
    return {
        run_id: ref.run_id,
        manifest_sha256: manifestSha,
        screenshot_path: rel,
        screenshot_sha256: imageSha,
        event_id: matches[0].event_id,
        side: matches[0].side,
        captured_at: capturedAt,
        cited_url: citedUrl,
    };
}
const refIdentity = (ref) => `${ref.run_id}|${ref.manifest_sha256}|${ref.screenshot_path}|${ref.screenshot_sha256}`;
/** Revalidate a retained bound reference. Reports integrity; never throws. */
async function revalidateReference(mapsRoot, origin, ref) {
    const absolute = resolve(resolve(mapsRoot), ref.run_id, ref.screenshot_path);
    const unavailable = (detail) => ({
        ...ref, integrity: "unavailable", detail, screenshot_absolute_path: absolute,
    });
    const candidateDir = join(resolve(mapsRoot), ref.run_id);
    if (!await containedRunDir(mapsRoot, ref.run_id))
        return unavailable("run directory is outside the product store");
    const manifestBytes = await readFile(join(candidateDir, "manifest.json")).catch(() => null);
    if (!manifestBytes)
        return unavailable("manifest is missing");
    if (digest(manifestBytes) !== ref.manifest_sha256)
        return unavailable("manifest changed after the note cited it");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const imageBytes = await sealedFile(candidateDir, manifest, ref.screenshot_path);
    if (!imageBytes)
        return unavailable("image is missing or no longer matches the sealed manifest");
    if (digest(imageBytes) !== ref.screenshot_sha256)
        return unavailable("image bytes changed after the note cited them");
    const traceBytes = await sealedFile(candidateDir, manifest, "observations.jsonl");
    if (!traceBytes)
        return unavailable("observation trace is unavailable");
    // Stored provenance is not trusted: the exact retained event+side for
    // this path must still exist, the cited url must equal that side's url,
    // and the date is re-derived from the matching event, never from storage.
    const matches = [];
    for (const line of String(traceBytes).split("\n").filter(Boolean)) {
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            continue;
        }
        for (const side of ["before", "after"]) {
            if (event[side]?.screenshot_path === ref.screenshot_path) {
                matches.push({ event_id: typeof event.event_id === "string" ? event.event_id : null, side, url: event[side]?.url, timestamp: event.timestamp });
            }
        }
    }
    const exact = matches.filter((match) => match.side === ref.side && match.event_id === ref.event_id);
    if (exact.length === 0)
        return unavailable("cited observation event and side are no longer retained");
    const observed = exact[0];
    let eventOrigin = null;
    try {
        eventOrigin = typeof observed.url === "string" ? new URL(observed.url).origin : null;
    }
    catch {
        eventOrigin = null;
    }
    if (eventOrigin !== origin) {
        return { ...ref, integrity: "origin_mismatch", detail: `observation url ${String(observed.url)} is outside ${origin}`, screenshot_absolute_path: absolute };
    }
    if (observed.url !== ref.cited_url)
        return unavailable("cited url does not match the retained observation");
    const stamp = observed.timestamp;
    const derived = typeof stamp === "string" && stamp.trim() && !Number.isNaN(Date.parse(stamp))
        ? new Date(stamp).toISOString()
        : null;
    if (derived !== ref.captured_at)
        return unavailable("cited capture date does not match the retained observation");
    return { ...ref, integrity: "ok", detail: "matches the sealed evidence", screenshot_absolute_path: absolute };
}
function validateProposal(note) {
    const inputBytes = Buffer.byteLength(JSON.stringify(note ?? null), "utf8");
    if (inputBytes > MAX_NOTE_INPUT_BYTES)
        fail(`note proposal is too large (${inputBytes} bytes; limit ${MAX_NOTE_INPUT_BYTES})`);
    assertPlainObject(note, "note");
    rejectExtra(note, ["flow_id", "title", "author_context", "claims", "retire"], "note");
    const flowId = cleanId(note.flow_id, "flow_id", FLOW_ID);
    const title = cleanText(note.title, "title", MAX_TITLE);
    const authorContext = cleanText(note.author_context, "author_context", MAX_AUTHOR_CONTEXT);
    if (!EVIDENCE_ONLY_DECLARATION.test(authorContext))
        fail("author_context must explicitly declare an evidence-only basis (name the retained originals inspected as evidence-only); " +
            "a bare title or claim restatement is not a declaration");
    if (EXCLUDED_CONTEXT.test(authorContext))
        fail("author_context declares source/owner-derived context (source route, review sequence, expected score); " +
            "only evidence-only declarations are accepted in V1");
    const claimsRaw = note.claims ?? [];
    if (!Array.isArray(claimsRaw))
        fail("claims must be a list");
    const retireRaw = note.retire ?? [];
    if (!Array.isArray(retireRaw))
        fail("retire must be a list");
    if (claimsRaw.length === 0 && retireRaw.length === 0)
        fail("note must add, support or retire at least one claim");
    if (claimsRaw.length > MAX_CLAIMS)
        fail(`too many proposed claims (${claimsRaw.length}; limit ${MAX_CLAIMS})`);
    if (retireRaw.length > MAX_RETIRE)
        fail(`too many retirements (${retireRaw.length}; limit ${MAX_RETIRE})`);
    const claims = claimsRaw.map((item, index) => {
        assertPlainObject(item, `claims[${index}]`);
        rejectExtra(item, ["id", "text", "conditions", "state", "references", "supersedes", "reason"], `claims[${index}]`);
        const id = cleanId(item.id, `claims[${index}].id`, CLAIM_ID);
        const text = cleanText(item.text, `claims[${index}].text`, MAX_TEXT);
        const conditions = item.conditions === undefined ? "unknown" : cleanText(item.conditions, `claims[${index}].conditions`, MAX_CONDITIONS);
        const state = item.state ?? "current";
        if (state !== "current" && state !== "uncertain")
            fail(`claims[${index}].state must be current or uncertain`);
        if (!Array.isArray(item.references) || item.references.length === 0 || item.references.length > MAX_REFS_PER_CLAIM)
            fail(`claims[${index}].references must list 1-${MAX_REFS_PER_CLAIM} citations`);
        const references = item.references.map((entry, refIndex) => {
            assertPlainObject(entry, `claims[${index}].references[${refIndex}]`);
            rejectExtra(entry, ["run_id", "screenshot_path"], `claims[${index}].references[${refIndex}]`);
            const record = entry;
            assertRunId(record.run_id, "reference run_id");
            if (typeof record.screenshot_path !== "string" || !record.screenshot_path)
                fail(`claims[${index}].references[${refIndex}].screenshot_path must be a string`);
            return { run_id: record.run_id, screenshot_path: record.screenshot_path };
        });
        let supersedes;
        let reason;
        if (item.supersedes !== undefined) {
            supersedes = cleanId(item.supersedes, `claims[${index}].supersedes`, CLAIM_ID);
            if (supersedes === id)
                fail(`claims[${index}] cannot supersede itself`);
            if (item.reason === undefined)
                fail(`claims[${index}].reason is required when superseding ${supersedes}`);
        }
        if (item.reason !== undefined)
            reason = cleanText(item.reason, `claims[${index}].reason`, MAX_REASON);
        return { id, text, conditions, state: state, references, supersedes, reason };
    });
    const seen = new Set();
    for (const claim of claims) {
        if (seen.has(claim.id))
            fail(`duplicate claim id ${JSON.stringify(claim.id)} in one proposal`);
        seen.add(claim.id);
    }
    const retire = retireRaw.map((item, index) => {
        assertPlainObject(item, `retire[${index}]`);
        rejectExtra(item, ["id", "reason"], `retire[${index}]`);
        return { id: cleanId(item.id, `retire[${index}].id`, CLAIM_ID), reason: cleanText(item.reason, `retire[${index}].reason`, MAX_REASON) };
    });
    return { flow_id: flowId, title, author_context: authorContext, claims, retire };
}
/** Remember one flow note. expected_revision 0 creates; higher revisions update.
 *  The revision is checked inside the per-note lock; stale writers fail. */
export async function rememberFlow({ mapsRoot, url, expected_revision, note }) {
    if (!Number.isInteger(expected_revision) || expected_revision < 0)
        fail("expected_revision must be a non-negative whole number");
    const origin = assertOrigin(url);
    const proposal = validateProposal(note);
    const flowId = proposal.flow_id;
    const notePath = await notePathFor(mapsRoot, origin, flowId);
    await mkdir(dirname(notePath), { recursive: true });
    const lockPath = await notePathFor(mapsRoot, origin, flowId, ".json.lock");
    let lock = null;
    try {
        try {
            await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
            lock = lockPath;
        }
        catch (error) {
            if (error.code === "EEXIST") {
                let holder = "another writer";
                try {
                    holder = (await readFile(lockPath, "utf8")).trim().slice(0, 200) || holder;
                }
                catch {
                    /* lock vanished; still report busy */
                }
                fail(`note ${flowId} is busy (${holder}); wait for the other writer to finish, then retry with a fresh expected_revision. ` +
                    `If no writer is running, remove the stale lock at ${lockPath} yourself and retry.`);
            }
            throw error;
        }
        const stored = await readStoredNote(notePath);
        if (stored)
            assertStoredNote(stored, notePath);
        if (expected_revision === 0) {
            if (stored)
                fail(`note ${flowId} already exists at revision ${stored.revision}; reread it and retry with expected_revision ${stored.revision}`);
        }
        else {
            if (!stored)
                fail(`note ${flowId} does not exist; create it with expected_revision 0`);
            if (stored.revision !== expected_revision)
                fail(`note ${flowId} is at revision ${stored.revision}, not ${expected_revision}; reread it and retry`);
            if (stored.origin !== origin || stored.flow_id !== flowId)
                fail(`stored note identity changed under ${flowId}; refusing to write`);
            if (stored.author_context !== proposal.author_context)
                fail(`note author context is immutable; restate the same declaration or leave the note to its author`);
        }
        const existing = new Map((stored?.claims ?? []).map((claim) => [claim.id, claim]));
        const addedClaims = [];
        const retiredClaims = [];
        const addedReferences = [];
        const duplicateReferences = [];
        // Retirements first, so a broken old claim can be retired without its
        // unavailable supports blocking the write.
        const retiring = new Set();
        for (const entry of proposal.retire ?? []) {
            const old = existing.get(entry.id);
            if (!old)
                fail(`cannot retire unknown claim ${JSON.stringify(entry.id)}`);
            if (old.state === "retired")
                fail(`claim ${JSON.stringify(entry.id)} is already retired; terminal retirement never revives`);
            retiring.add(entry.id);
            old.state = "retired";
            old.retired_reason = entry.reason;
            retiredClaims.push(entry.id);
        }
        for (const claim of proposal.claims ?? []) {
            const old = existing.get(claim.id);
            if (old) {
                if (old.state === "retired")
                    fail(`claim ${JSON.stringify(claim.id)} is retired; terminal retirement never revives under the same id`);
                if (retiring.has(claim.id))
                    fail(`claim ${JSON.stringify(claim.id)} is retired by this note and cannot gain new supports in the same write`);
                if (old.text !== claim.text)
                    fail(`claim ${JSON.stringify(claim.id)} text is immutable; propose a correction that supersedes it instead`);
                if (old.conditions !== claim.conditions)
                    fail(`claim ${JSON.stringify(claim.id)} conditions are immutable; propose a correction that supersedes it instead`);
                if (claim.supersedes !== undefined)
                    fail(`existing claim ${JSON.stringify(claim.id)} cannot supersede; a correction needs a new claim id`);
                if (claim.reason !== undefined)
                    fail(`claims[${JSON.stringify(claim.id)}].reason needs supersedes; plain support updates carry no reason`);
                old.state = claim.state;
                const known = new Set(old.references.map(refIdentity));
                for (const ref of claim.references) {
                    const bound = await bindReference(mapsRoot, origin, ref);
                    if (known.has(refIdentity(bound))) {
                        duplicateReferences.push(`${claim.id}:${bound.run_id}:${bound.screenshot_path}`);
                        continue;
                    }
                    known.add(refIdentity(bound));
                    old.references.push(bound);
                    addedReferences.push(`${claim.id}:${bound.run_id}:${bound.screenshot_path}`);
                }
                continue;
            }
            // A brand-new claim id.
            if ((proposal.retire ?? []).some((entry) => entry.id === claim.id))
                fail(`claim ${JSON.stringify(claim.id)} is retired by this note and cannot be re-added`);
            let supersedes;
            if (claim.supersedes !== undefined) {
                const target = existing.get(claim.supersedes);
                if (!target)
                    fail(`correction target ${JSON.stringify(claim.supersedes)} does not exist`);
                if (target.state === "retired")
                    fail(`correction target ${JSON.stringify(claim.supersedes)} is already retired`);
                if (retiring.has(claim.supersedes))
                    fail(`correction target ${JSON.stringify(claim.supersedes)} is retired by this note; reference it instead of superseding`);
                supersedes = claim.supersedes;
            }
            const bound = [];
            const seen = new Set();
            for (const ref of claim.references) {
                const item = await bindReference(mapsRoot, origin, ref);
                const identity = refIdentity(item);
                if (seen.has(identity)) {
                    duplicateReferences.push(`${claim.id}:${item.run_id}:${item.screenshot_path}`);
                    continue;
                }
                seen.add(identity);
                bound.push(item);
                addedReferences.push(`${claim.id}:${item.run_id}:${item.screenshot_path}`);
            }
            const stored = {
                id: claim.id, text: claim.text, conditions: claim.conditions, state: claim.state, references: bound,
            };
            if (supersedes !== undefined) {
                const target = existing.get(supersedes);
                target.state = "retired";
                target.retired_reason = claim.reason;
                target.superseded_by = claim.id;
                retiredClaims.push(supersedes);
                stored.supersedes = supersedes;
                stored.retired_reason = undefined;
            }
            if (claim.reason !== undefined && supersedes === undefined)
                fail(`claims reason needs supersedes; plain claims carry no reason`);
            existing.set(claim.id, stored);
            addedClaims.push(claim.id);
        }
        // Revalidate every retained live claim. Unavailable supports fail the
        // write explicitly; retire the broken claim (above) instead.
        const unavailable = [];
        for (const claim of existing.values()) {
            if (claim.state === "retired" || retiring.has(claim.id))
                continue;
            for (const ref of claim.references) {
                const check = await revalidateReference(mapsRoot, origin, ref);
                if (check.integrity !== "ok")
                    unavailable.push(`${claim.id}:${ref.run_id}:${ref.screenshot_path} (${check.detail})`);
            }
        }
        if (unavailable.length > 0) {
            fail(`retained supports are unavailable: ${unavailable.join("; ")}. ` +
                `Retire the affected claim(s) with an explicit reason instead of rewriting them.`);
        }
        const next = {
            schema_version: NOTE_SCHEMA_VERSION,
            flow_id: flowId,
            origin,
            title: proposal.title,
            revision: (stored?.revision ?? 0) + 1,
            modified_at: new Date().toISOString(),
            author_context: proposal.author_context,
            author_context_verified: false,
            claims: [...existing.values()],
        };
        if (next.claims.length > MAX_CLAIMS)
            fail(`note would hold ${next.claims.length} claims; limit ${MAX_CLAIMS}`);
        for (const claim of next.claims) {
            if (claim.references.length === 0)
                fail(`claim ${JSON.stringify(claim.id)} has no supports`);
            if (claim.references.length > MAX_REFS_PER_CLAIM)
                fail(`claim ${JSON.stringify(claim.id)} has too many supports`);
        }
        const bytes = `${JSON.stringify(next, null, 2)}\n`;
        if (Buffer.byteLength(bytes, "utf8") > MAX_STORED_NOTE_BYTES)
            fail(`stored note would exceed ${MAX_STORED_NOTE_BYTES} bytes; keep claims and references bounded`);
        const temporary = join(dirname(notePath), `${flowId}.${randomUUID()}.tmp`);
        await writeFile(temporary, bytes, { mode: 0o600 });
        await rename(temporary, notePath);
        return {
            flow_id: flowId, origin, revision: next.revision, modified_at: next.modified_at,
            added_claims: addedClaims, retired_claims: retiredClaims,
            added_references: addedReferences, duplicate_references: duplicateReferences,
            note_path: notePath,
        };
    }
    finally {
        if (lock)
            await rm(lock, { force: true });
    }
}
const normalTerms = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((term) => term.length > 1);
/** Reads return the full already-bounded title/text/conditions in JSON;
 *  only the human-readable summary truncates for display. */
async function readNote(mapsRoot, origin, flowId, queryTerms) {
    const notePath = await notePathFor(mapsRoot, origin, flowId);
    const stored = await readStoredNote(notePath);
    if (!stored)
        return null;
    assertStoredNote(stored, notePath);
    if (stored.origin !== origin || stored.flow_id !== flowId)
        return null;
    const haystack = [stored.title, ...stored.claims.flatMap((claim) => [claim.text, claim.conditions])].join(" ").toLowerCase();
    const matched = queryTerms.filter((term) => haystack.includes(term)).length;
    if (queryTerms.length > 0 && matched === 0)
        return null;
    const unavailable = [];
    const claims = [];
    for (const claim of stored.claims) {
        const references = [];
        for (const ref of claim.references) {
            const check = await revalidateReference(mapsRoot, stored.origin, ref);
            if (check.integrity !== "ok" && claim.state !== "retired")
                unavailable.push(`${claim.id}:${ref.run_id}:${ref.screenshot_path} (${check.detail})`);
            references.push(check);
        }
        claims.push({
            id: claim.id, text: claim.text, conditions: claim.conditions,
            state: claim.state,
            ...(claim.supersedes ? { supersedes: claim.supersedes } : {}),
            ...(claim.superseded_by ? { superseded_by: claim.superseded_by } : {}),
            ...(claim.retired_reason ? { retired_reason: claim.retired_reason } : {}),
            references,
        });
    }
    return {
        flow_id: stored.flow_id, origin: stored.origin,
        title: stored.title,
        revision: stored.revision, modified_at: stored.modified_at,
        author_context: stored.author_context, author_context_verified: stored.author_context_verified, claims,
        supports_ok: unavailable.length === 0,
        unavailable_supports: unavailable,
        match: { matched_terms: matched, of_terms: queryTerms.length },
    };
}
// Compact consultation projection. Not a new store, model call or index:
// findNotes reuses findMemory (same matching, same revalidation) and only
// projects each note down. Raw cited_url strings are dropped because a
// cited observation url can carry encoded application state (long query
// payloads) that bloats combined memory output; every compact reference
// keeps the dated absolute original path plus the immutable
// run/manifest/image/event/side bindings needed to inspect the evidence.
// Retired claims are excluded and fully retired notes are omitted: this is
// an active-claim view. Similar claims are never merged, and an ok
// integrity check only means the bytes still match the seal, never that a
// claim is true. Full history, including retired claims, author context and
// cited urls, remains available through findMemory.
export async function findMemory({ mapsRoot, url = null, query = "", ...options }) {
    const origin = url ? assertOrigin(url) : null;
    const trimmedQuery = String(query ?? "");
    if (trimmedQuery.length > MAX_QUERY)
        fail(`query is too long (${trimmedQuery.length} chars; limit ${MAX_QUERY})`);
    const queryTerms = normalTerms(trimmedQuery);
    // The query passes through verbatim so the capture half stays exactly
    // what a direct findCaptures call returns.
    const captures = await findCaptures({ mapsRoot, goal: trimmedQuery, origin, ...options });
    const realStore = await realDir(storeRoot(mapsRoot));
    const realKnowledge = await realpath(join(realStore, "knowledge")).catch(() => null);
    if (realKnowledge) {
        const withinStore = relative(realStore, realKnowledge);
        if (!withinStore || isAbsolute(withinStore) || withinStore === ".." || withinStore.startsWith(`..${sep}`)) {
            return {
                ...captures,
                product_notes: [],
                notes_guidance: NOTES_GUIDANCE,
                notes_errors: ["knowledge store escapes the product store; notes withheld"],
                notes_scope: { origins_scanned: 0, origins_capped: false, flows_capped: false },
            };
        }
    }
    const roots = [];
    let originsScanned = 0;
    let originsCapped = false;
    if (origin) {
        roots.push({ dir: join(realStore, "knowledge", originKey(origin)), key: originKey(origin) });
        originsScanned = 1;
    }
    else if (realKnowledge) {
        let entries = [];
        try {
            entries = await readdir(realKnowledge);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        originsCapped = entries.length > MAX_ORIGINS_SCANNED;
        const sliced = entries.slice(0, MAX_ORIGINS_SCANNED);
        originsScanned = sliced.length;
        for (const entry of sliced)
            roots.push({ dir: join(realKnowledge, entry), key: entry });
    }
    const productNotes = [];
    const notesErrors = [];
    let flowsCapped = false;
    for (const root of roots) {
        let files = [];
        try {
            const real = await realpath(root.dir).catch(() => null);
            if (!real)
                continue;
            const within = relative(realStore, real);
            if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
                notesErrors.push(`${root.key}: origin directory escapes the product store; notes withheld`);
                continue;
            }
            const all = (await readdir(real)).filter((name) => name.endsWith(".json"));
            if (all.length > MAX_FLOWS_PER_ORIGIN)
                flowsCapped = true;
            files = all.slice(0, MAX_FLOWS_PER_ORIGIN);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                notesErrors.push(`${root.key}: ${error.message}`);
            continue;
        }
        for (const file of files) {
            const flowId = file.slice(0, -".json".length);
            if (!FLOW_ID.test(flowId))
                continue;
            try {
                const safePath = await containedUnder(realStore, ["knowledge", root.key, file]);
                const noteOrigin = origin ?? (await originOfNote(safePath));
                if (!noteOrigin)
                    continue;
                // The origin directory name is a key, not an identity: confirm the
                // note's own origin before attributing it.
                const read = await readNote(mapsRoot, noteOrigin, flowId, queryTerms);
                if (read)
                    productNotes.push(read);
            }
            catch (error) {
                notesErrors.push(`${flowId}: ${error.message}`);
            }
        }
    }
    productNotes.sort((a, b) => b.match.matched_terms - a.match.matched_terms || a.flow_id.localeCompare(b.flow_id));
    return {
        ...captures,
        product_notes: productNotes,
        notes_guidance: NOTES_GUIDANCE,
        notes_errors: notesErrors,
        notes_scope: { origins_scanned: originsScanned, origins_capped: originsCapped, flows_capped: flowsCapped },
    };
}
const NOTES_GUIDANCE = "Product notes are customer interpretations of cited sealed originals, not verified coverage. " +
    "Inspect the supporting originals before relying on a claim. Notes never change candidate selection, freshness or next_step. " +
    "Old notes describe past observations, not current deployment or account readiness.";
const NOTES_COMPACT_GUIDANCE = "Compact active-claim view of customer product notes: retired claims are excluded and " +
    "fully retired notes are omitted. These notes are customer interpretations of the cited sealed originals, not " +
    "verified truth or certification; similar claims are never merged. Inspect each dated supporting original before " +
    "relying on a claim: an ok integrity check only means the bytes still match the seal, not that the claim is true. " +
    "Full claim history, including retired claims, author context and cited urls, remains available through memory.";
/** Notes-only compact consultation for one explicit customer evidence
 *  question. Read-only: same findMemory lookup underneath (same matching,
 *  same per-read revalidation, same error isolation), projected down with no
 *  capture candidates and no raw cited_url strings. Canonical stored notes
 *  are never created, locked or written by this call. */
export async function findNotes({ mapsRoot, url, query }) {
    if (typeof url !== "string" || !url.trim())
        fail("notes needs a product url");
    const origin = assertOrigin(url);
    if (typeof query !== "string")
        fail("notes needs --goal '<customer evidence question>' as text; objects and other payloads are not questions");
    const question = query.trim();
    if (!question)
        fail("notes needs --goal '<customer evidence question>' naming what the notes should answer; " +
            "without an explicit question there is no purpose-specific consultation");
    if (question.length > MAX_QUERY)
        fail(`query is too long (${question.length} chars; limit ${MAX_QUERY})`);
    const full = await findMemory({ mapsRoot, url: origin, query: question });
    const productNotes = [];
    for (const note of full.product_notes) {
        const active = note.claims.filter((claim) => claim.state !== "retired");
        if (active.length === 0)
            continue;
        // Matching runs across retired claims inside findMemory, so recompute it
        // over the active-claim subset: a question matching only a retired claim
        // must not surface unrelated active claims. Memory matching is unchanged.
        const terms = normalTerms(question);
        const haystack = [note.title, ...active.flatMap((claim) => [claim.text, claim.conditions])].join(" ").toLowerCase();
        const matched = terms.filter((term) => haystack.includes(term)).length;
        if (terms.length > 0 && matched === 0)
            continue;
        const unavailable = active.length === note.claims.length
            ? [...note.unavailable_supports]
            : note.unavailable_supports.filter((entry) => active.some((claim) => entry.startsWith(`${claim.id}:`)));
        productNotes.push({
            flow_id: note.flow_id,
            origin: note.origin,
            title: note.title,
            revision: note.revision,
            modified_at: note.modified_at,
            claims: active.map((claim) => ({
                id: claim.id,
                text: claim.text,
                conditions: claim.conditions,
                state: claim.state,
                ...(claim.supersedes ? { supersedes: claim.supersedes } : {}),
                ...(claim.superseded_by ? { superseded_by: claim.superseded_by } : {}),
                references: claim.references.map((ref) => ({
                    run_id: ref.run_id,
                    screenshot_path: ref.screenshot_path,
                    screenshot_absolute_path: ref.screenshot_absolute_path,
                    screenshot_sha256: ref.screenshot_sha256,
                    manifest_sha256: ref.manifest_sha256,
                    event_id: ref.event_id,
                    side: ref.side,
                    captured_at: ref.captured_at,
                    integrity: ref.integrity,
                    detail: ref.detail,
                })),
            })),
            supports_ok: unavailable.length === 0,
            unavailable_supports: unavailable,
            match: { matched_terms: matched, of_terms: terms.length },
        });
    }
    productNotes.sort((a, b) => b.match.matched_terms - a.match.matched_terms || a.flow_id.localeCompare(b.flow_id));
    return {
        product_notes: productNotes,
        notes_guidance: NOTES_COMPACT_GUIDANCE,
        notes_errors: full.notes_errors,
        notes_scope: full.notes_scope,
    };
}
async function originOfNote(path) {
    const note = await readStoredNote(path);
    if (!note)
        return null;
    assertStoredNote(note, path);
    return assertOrigin(note.origin);
}
export function formatCompactNotes(notes) {
    if (notes.length === 0)
        return "No product notes for this question. This is a compact active-claim view; full history, including retired claims, remains available through memory.";
    const lines = [];
    for (const note of notes) {
        lines.push(`Note ${note.flow_id} (revision ${note.revision}, modified ${note.modified_at}): ${summarize(note.title)}`);
        for (const claim of note.claims) {
            lines.push(`  [${claim.state}] ${claim.id}: ${summarize(claim.text)}`);
            lines.push(`    conditions: ${summarize(claim.conditions)}`);
            if (claim.supersedes)
                lines.push(`    corrects: ${claim.supersedes}`);
            for (const ref of claim.references) {
                lines.push(`    - ${ref.integrity === "ok" ? "supported" : ref.integrity} ${ref.screenshot_absolute_path} (run ${ref.run_id}, captured ${ref.captured_at ?? "date unknown"}): ${ref.detail}`);
            }
        }
        if (!note.supports_ok)
            lines.push(`  Unavailable supports: ${note.unavailable_supports.join("; ")}`);
    }
    lines.push("Compact active-claim view: retired claims excluded, fully retired notes omitted. " +
        "Notes are customer interpretations of the cited originals, not verified truth or certification; " +
        "an ok integrity check only means the bytes still match the seal.");
    return lines.join("\n");
}
/** Visible errors and scan caps for human consultation output, so a
 *  malformed note, unavailable evidence or a capped scan is never presented
 *  as a clean absence. Returns "" when there is nothing to report. */
export function formatNotesNotices(result) {
    const lines = [];
    for (const error of result.notes_errors)
        lines.push(`  note error: ${error}`);
    if (result.notes_scope.origins_capped)
        lines.push("  scan capped: only the first origins were consulted; narrow to one product url for full coverage");
    if (result.notes_scope.flows_capped)
        lines.push("  scan capped: not all flow files were consulted; coverage is partial and changing the question does not increase the scan limit");
    if (lines.length === 0)
        return "";
    return ["Notices (consultation is partial until these are resolved):", ...lines].join("\n");
}
/** Human-readable rendering. Canonical JSON lives only on disk. */
export function formatRememberResult(result) {
    const lines = [
        `Remembered flow ${result.flow_id} at revision ${result.revision} (${result.origin}).`,
        `Modified: ${result.modified_at}. Stored: ${result.note_path}.`,
    ];
    if (result.added_claims.length > 0)
        lines.push(`New claims: ${result.added_claims.join(", ")}.`);
    if (result.retired_claims.length > 0)
        lines.push(`Retired claims: ${result.retired_claims.join(", ")}.`);
    if (result.added_references.length > 0)
        lines.push(`New supports: ${result.added_references.join("; ")}.`);
    if (result.duplicate_references.length > 0)
        lines.push(`Already cited (not duplicated): ${result.duplicate_references.join("; ")}.`);
    lines.push("Notes are caller-declared interpretations of the cited originals (declaration unverified), not verified truth or certification.");
    return lines.join("\n");
}
const summarize = (text) => text.length <= DISPLAY_TRUNCATE ? text : `${text.slice(0, DISPLAY_TRUNCATE)} [truncated; full text in JSON]`;
export function formatNotes(notes) {
    if (notes.length === 0)
        return "No product notes for this query. Only sealed capture candidates above (if any) apply.";
    const lines = [];
    for (const note of notes) {
        lines.push(`Note ${note.flow_id} (revision ${note.revision}, modified ${note.modified_at}): ${summarize(note.title)}`);
        lines.push(`  author context (caller-declared, unverified): ${summarize(note.author_context)}`);
        for (const claim of note.claims) {
            lines.push(`  [${claim.state}] ${claim.id}: ${summarize(claim.text)}`);
            lines.push(`    conditions: ${summarize(claim.conditions)}`);
            if (claim.retired_reason)
                lines.push(`    retired: ${claim.retired_reason}${claim.superseded_by ? ` (superseded by ${claim.superseded_by})` : ""}`);
            if (claim.supersedes)
                lines.push(`    corrects: ${claim.supersedes}`);
            for (const ref of claim.references) {
                lines.push(`    - ${ref.integrity === "ok" ? "supported" : ref.integrity} ${ref.screenshot_absolute_path} (run ${ref.run_id}, captured ${ref.captured_at ?? "date unknown"}): ${ref.detail}`);
            }
        }
        if (!note.supports_ok)
            lines.push(`  Unavailable supports: ${note.unavailable_supports.join("; ")}`);
    }
    lines.push("Notes are caller-declared interpretations of the cited originals (declaration unverified), not verified truth or certification.");
    return lines.join("\n");
}
