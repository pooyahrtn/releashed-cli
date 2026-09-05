import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { renderMap, validateTrace } from "../renderer/render-map.mjs";
import { validatePublicPack } from "./public-pack-schema.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TEXT_FILES = ["production-run-report.json", "explorer-result.json", "input-manifest.json", "metrics.json", "supervision.jsonl", "request-events.jsonl"];
const ALLOWED_ENTRIES = new Set(["observations.jsonl", ...TEXT_FILES, "screenshots"]);
const PRIVATE_SEGMENTS = new Set([".runtime", "private", "secrets", "credentials", "flow-map-lab-private"]);
const SECRET_OR_PII = [
  // The value must carry a digit, underscore or hyphen. Without that, ordinary English prose after
  // one of these words is a credential: DebugBear's own blog title, "PageSpeed Insights API:
  // Discover Web Performance Insights", refused the whole candidate on "API: Discover". A real
  // secret (sk_live_..., abc123..., ?api_key=9f2c) always has one; an English word does not.
  // The optional quote lets a JSON-shaped assignment match at all: the value class excludes quotes,
  // so `"apiKey": "9f2ca41beed3"` used to slip past this pattern entirely.
  /(?:OPENAI|CLERK|API|AUTH|ACCESS|SECRET|PRIVATE)[_-]?(?:KEY|TOKEN|SECRET)?["']?\s*[=:]\s*["']?(?=[^\s,}"']*[0-9_-])[^\s,}"']{8,}/i,
  /\b(?:sk|pk|sess|user|ticket|sit)_(?:live|test)?[A-Za-z0-9_-]{8,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i,
  // Case-SENSITIVE on purpose: these are the literal roots of a real local filesystem path. Case
  // insensitivity made the product's own web routes match -- marker.io logs a request to "/users/me",
  // which is not a macOS home directory, and no candidate whose product has a /users route could
  // ever be packaged.
  /(?:^|[\s"'])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/)[^\s"']+/,
  // "@2x" / "@3x" is the retina asset convention, not a mailbox: DebugBear requests
  // /public/title-bear@2x.png, which parses as title-bear @ 2x . png and refused the candidate.
  /\b[A-Z0-9._%+-]+@(?!\d+x\.)[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:\+\d[\d ()-]{7,}\d|\b\d{3}[ -]\d{3}[ -]\d{4}\b)/
];
// Card numbers only, not embedded in a longer hex/alnum token (a hex digest has letters on either side).
const CARD_NUMBER_RUN = /(?<![0-9A-Za-z])(?:\d[ -]?){13,19}(?![0-9A-Za-z])/g;

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
function fail(message) { throw new Error(`Candidate packaging refused: ${message}`); }

// Standard mod-10 check every real payment card number satisfies; random hex/float digit runs pass it only by chance (~1/10).
function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function hasCardNumber(body) {
  for (const match of body.matchAll(CARD_NUMBER_RUN)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

async function ordinaryFile(path, label) {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) fail(`${label} must be an ordinary file`);
  return path;
}

async function ordinaryDirectory(path, label, { create = false } = {}) {
  const resolved = resolve(path);
  const root = resolve(resolved).startsWith(sep) ? sep : "";
  let current = root || dirname(resolved);
  const pieces = resolved.slice(current.length).split(sep).filter(Boolean);
  for (const piece of pieces) {
    current = join(current, piece);
    let metadata = await lstat(current).catch((error) => {
      if (error?.code !== "ENOENT" || !create) throw error;
      return null;
    });
    if (!metadata && create) {
      await mkdir(current, { mode: 0o700 });
      metadata = await lstat(current);
    }
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) fail(`${label} contains a symlink or non-directory component`);
  }
  try { return await realpath(resolved); } catch { fail(`${label} cannot be canonicalized`); }
}

function assertContained(root, path, label) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`${label} escapes the exact run directory`);
  return rel.split(sep).join("/");
}

function rejectPrivatePath(path, label) {
  const segments = resolve(path).split(sep).filter(Boolean);
  if (segments.some((segment, index) => (index > 0 && PRIVATE_SEGMENTS.has(segment)) || segment.endsWith("-private"))) fail(`${label} points into a private input area`);
}

export function scanText(bytes, label, allowExactStrings = []) {
  let body = Buffer.from(bytes).toString("utf8");
  // A rendered map inlines every screenshot as a base64 data URI, and base64's alphabet is digits,
  // letters, "+" and "/" -- so a long payload reliably contains runs that look like a phone number
  // or a card number by pure chance. Two candidates were refused on "+6777677767" and "+655567774",
  // both of them fragments of a PNG (same false-positive class as the sha256 digests fixed earlier,
  // just in the image payload rather than the trace). The payload bytes are already written to the
  // candidate as their own screenshot files, which are binary and deliberately never scanned, so
  // dropping them from the SCAN COPY removes the whole class without weakening the gate over a
  // single character a person could actually read. The declaration itself is kept, so a data URI
  // carrying something other than base64 image bytes is still scanned in full.
  body = body.replace(/(data:[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+;base64,)[A-Za-z0-9+/=]+/gi, "$1");
  // Exact, pre-approved benign strings (e.g. a target's own published support address, or a literal
  // doc placeholder like "Bearer YOUR_API_KEY") are blanked out of the SCAN COPY only, by exact
  // substring, before the regexes run -- the bytes actually written to the candidate are untouched,
  // so evidence fidelity is unaffected. Anything not on this explicit, per-call list still fails
  // exactly as before; this is not a way to weaken the gate in general.
  for (const allowed of allowExactStrings) {
    if (typeof allowed === "string" && allowed) body = body.split(allowed).join("\u0000".repeat(allowed.length));
  }
  for (const pattern of SECRET_OR_PII) if (pattern.test(body)) fail(`credential or PII-shaped value found in ${label}`);
  if (hasCardNumber(body)) fail(`credential or PII-shaped value found in ${label}`);
}

async function snapshotFile(source, stage, rel, { text = true, allowExactStrings = [] } = {}) {
  const bytes = await readFile(await ordinaryFile(source, rel));
  if (text) scanText(bytes, rel, allowExactStrings);
  const destination = join(stage, rel);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  return { bytes, entry: { path: rel, bytes: bytes.byteLength, sha256: digest(bytes) } };
}

async function restoreWritable(path) {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) await restoreWritable(join(path, entry.name));
    await chmod(path, 0o700).catch(() => {});
  } else if (info.isFile()) await chmod(path, 0o600).catch(() => {});
}

function parseStagedEvents(bytes) {
  return Buffer.from(bytes).toString("utf8").split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { fail(`staged trace line ${index + 1} is not JSON`); }
  });
}

export async function packageCandidate({
  runId,
  runPath,
  outputPath,
  publicPackPath = null,
  publicPackSha256 = null,
  // Pass-through to renderMap for a trace captured before it could record a real per-element
  // on-screen flag (see renderer/render-map.mjs). Empty for every ordinary packaging call --
  // default behavior is unchanged, including every call this repo already makes.
  titleOverrides = {},
  // Pass-through to renderMap for the screen-description sidecar (see scripts/caption-screens.mjs):
  // { [observation_hash]: description }. Descriptions are a renderer-side reading aid, never
  // evidence, so they are never written into the retained run or the sealed trace -- the candidate's
  // observations.jsonl stays byte-for-byte what the run produced.
  captions = {},
  // Exact benign strings to exempt from the PII/secret scan for THIS packaging call only (see
  // scanText above) -- e.g. a target's own public support email or a literal docs placeholder.
  // Empty for every ordinary call, including every call this repo already makes.
  allowExactStrings = [],
}) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) fail("run id is invalid");
  if (typeof runPath !== "string" || typeof outputPath !== "string" || !runPath || !outputPath) fail("exact run and output paths are required");
  const run = await ordinaryDirectory(runPath, "run path");
  rejectPrivatePath(outputPath, "output");
  const outputParent = await ordinaryDirectory(dirname(resolve(outputPath)), "output parent", { create: true });
  const output = resolve(outputParent, resolve(outputPath).split(sep).at(-1));
  rejectPrivatePath(output, "output");
  if (output === run || output.startsWith(`${run}${sep}`)) fail("output must be outside the exact run directory");
  const existing = await lstat(output).catch(() => null);
  if (existing) fail("output directory already exists; candidates are exclusive");
  if (typeof publicPackPath !== "string" || typeof publicPackSha256 !== "string") fail("the exact public pack file and SHA-256 binding are required");
  if (!/^[0-9a-f]{64}$/.test(publicPackSha256)) fail("public pack binding must be a SHA-256 digest");
  const reportPath = join(run, "production-run-report.json");
  const tracePath = join(run, "observations.jsonl");
  const rootEntries = await readdir(run, { withFileTypes: true });
  for (const entry of rootEntries) if (!ALLOWED_ENTRIES.has(entry.name)) fail(`unapproved retained file ${entry.name}`);
  const outputLock = `${output}.lock`;
  try { await mkdir(outputLock, { recursive: false, mode: 0o700 }); } catch { fail("output name is already reserved"); }
  let lockOwned = true;
  const stage = join(outputParent, `.candidate-staging-${runId}-${process.pid}-${randomUUID()}`);
  try { await mkdir(stage, { recursive: false, mode: 0o700 }); } catch { await rm(outputLock, { recursive: true, force: true }).catch(() => {}); fail("candidate staging directory could not be created"); }
  let stageOwned = true;
  try {
    const reportSnapshot = await snapshotFile(reportPath, stage, "production-run-report.json", { allowExactStrings });
    const traceSnapshot = await snapshotFile(tracePath, stage, "observations.jsonl", { allowExactStrings });
    for (const name of TEXT_FILES.slice(1)) {
      const source = join(run, name);
      const info = await lstat(source).catch(() => null);
      if (info) {
        if (!info.isFile() || info.isSymbolicLink()) fail(`${name} must be an ordinary file`);
        await snapshotFile(source, stage, name, { allowExactStrings });
      }
    }
    const report = JSON.parse(reportSnapshot.bytes.toString("utf8"));
    if (report.schema_version !== 1 || report.run_id !== runId || report.public_pack_sha256 !== publicPackSha256) fail("production report schema, run id, or public-pack binding does not match the exact requested run");
    if (
      report.candidate_eligible !== true ||
      report.auth_cleanup_complete !== true ||
      report.identity_retirement_confirmed !== true ||
      report.cleanup_complete !== true
    ) fail("production report is not candidate-eligible");
    const stagedEvents = parseStagedEvents(traceSnapshot.bytes);
    for (const event of stagedEvents) if (event.run_id !== runId) fail(`trace run id mismatch at ${event.event_id}`);
    const screenshotRefs = new Map();
    for (const event of stagedEvents) for (const evidence of [event.before, event.after].filter(Boolean)) {
      const rel = assertContained(run, resolve(run, evidence.screenshot_path), `screenshot for ${event.event_id}`);
      if (!rel.startsWith("screenshots/")) fail(`screenshot for ${event.event_id} is outside screenshots`);
      screenshotRefs.set(rel, evidence.screenshot_sha256);
    }
    const screenshotSourceDirectory = join(run, "screenshots");
    const screenshotDirInfo = await lstat(screenshotSourceDirectory).catch(() => null);
    if (screenshotRefs.size > 0 && (!screenshotDirInfo?.isDirectory() || screenshotDirInfo.isSymbolicLink())) fail("screenshots must be an ordinary directory");
    if (screenshotDirInfo) {
      if (!screenshotDirInfo.isDirectory() || screenshotDirInfo.isSymbolicLink()) fail("screenshots must be an ordinary directory");
      for (const entry of await readdir(screenshotSourceDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) fail(`screenshots contains an unsupported entry ${entry.name}`);
        const rel = `screenshots/${entry.name}`;
        if (!screenshotRefs.has(rel))
          fail(
            `unreferenced retained screenshot ${entry.name} -- no event in observations.jsonl points to it. ` +
              `The run's other evidence at ${run} is untouched: either remove this file (it belongs to no ` +
              `recorded step) or add the event that should have referenced it, then package again.`,
          );
      }
    }
    for (const rel of [...screenshotRefs.keys()].sort()) await snapshotFile(join(run, rel), stage, rel, { text: false });
    const stagedTracePath = join(stage, "observations.jsonl");
    const stagedTrace = await validateTrace({ tracePath: stagedTracePath });
    for (const event of stagedTrace.events) if (event.run_id !== runId) fail(`trace run id mismatch at ${event.event_id}`);
    const dashed = stagedTrace.events.some((event) => event.transition_kind === "dashed");
    const packPath = await ordinaryFile(resolve(publicPackPath), "public pack");
    const packBytes = await readFile(packPath);
    if (digest(packBytes) !== publicPackSha256) fail("public pack hash does not match the supplied binding");
    let pack;
    try { pack = JSON.parse(packBytes.toString("utf8")); } catch { fail("public pack is invalid JSON"); }
    try { validatePublicPack(pack); } catch { fail("public pack schema is invalid"); }
    const publicPack = { path: "public-pack.json", sha256: publicPackSha256 };
    await writeFile(join(stage, "public-pack.json"), packBytes, { flag: "wx", mode: 0o600 });
    scanText(packBytes, "public-pack.json", allowExactStrings);
    if (dashed) {
      for (const event of stagedTrace.events.filter((item) => item.transition_kind === "dashed")) {
        const citation = event.citation ?? event.source_evidence;
        const source = pack.sources.find((item) => item.source_id === citation.source_id);
        if (!source || source.final_url !== (citation.source_url ?? citation.url)) fail(`dashed citation does not match public pack for ${event.event_id}`);
        const statement = pack.claims.find((claim) => claim.id === citation.claim_id);
        const excerpt = citation.excerpt ?? citation.quote ?? citation.text;
        if (!statement || typeof excerpt !== "string" || !excerpt.trim() || !statement.text.includes(excerpt.trim()) || !statement.source_ids.includes(citation.source_id)) fail(`dashed citation does not match a bounded public-pack claim for ${event.event_id}`);
      }
    }
    const rendered = await renderMap({ tracePath: stagedTracePath, outputPath: join(stage, "map.html"), publicPackPath: publicPack ? join(stage, "public-pack.json") : null, publicPackSha256: publicPack?.sha256 ?? null, titleOverrides, captions });
    const mapBytes = await readFile(join(stage, "map.html"));
    scanText(mapBytes, "map.html", allowExactStrings);
    // The same graph as data, on the schema in docs/map-schema.md. Scanned like every other text
    // file in the candidate, and hashed into the manifest with them.
    const mapJsonBytes = Buffer.from(json(rendered.map));
    scanText(mapJsonBytes, "map.json", allowExactStrings);
    await writeFile(join(stage, "map.json"), mapJsonBytes, { flag: "wx", mode: 0o600 });
    const entries = [];
    for (const path of ["observations.jsonl", ...TEXT_FILES, ...(publicPack ? ["public-pack.json"] : []), "map.html", "map.json"]) {
      const info = await lstat(join(stage, path)).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) {
        const bytes = await readFile(join(stage, path));
        entries.push({ path, bytes: bytes.byteLength, sha256: digest(bytes) });
      }
    }
    for (const rel of [...screenshotRefs.keys()].sort()) {
      const bytes = await readFile(join(stage, rel));
      entries.push({ path: rel, bytes: bytes.byteLength, sha256: digest(bytes) });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifestCore = { schema_version: 1, run_id: runId, ...(publicPack ? { public_pack: publicPack } : {}), files: entries };
    const candidateSha256 = digest(Buffer.from(json(manifestCore)));
    const manifestBytes = Buffer.from(json({ ...manifestCore, candidate_sha256: candidateSha256 }));
    scanText(manifestBytes, "manifest.json", allowExactStrings);
    await writeFile(join(stage, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 });
    for (const path of ["observations.jsonl", ...TEXT_FILES, ...(publicPack ? ["public-pack.json"] : []), "map.html", "map.json", "manifest.json", ...[...screenshotRefs.keys()]]) {
      const info = await lstat(join(stage, path)).catch(() => null);
      if (info?.isFile()) await chmod(join(stage, path), 0o444);
    }
    await chmod(join(stage, "screenshots"), 0o555).catch(() => {});
    await chmod(stage, 0o555);
    if (await lstat(output).catch(() => null)) fail("output directory appeared after reservation");
    await rename(stage, output);
    stageOwned = false;
    return { run_id: runId, output_path: output, candidate_sha256: candidateSha256, files: [...entries, { path: "manifest.json", bytes: manifestBytes.byteLength, sha256: digest(manifestBytes) }] };
  } finally {
    if (stageOwned) {
      await restoreWritable(stage).catch(() => {});
      await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
    if (lockOwned) await rm(outputLock, { recursive: true, force: true }).catch(() => {});
  }
}
