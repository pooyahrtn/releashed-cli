// @ts-check
// Selection is a claim about retained evidence, never a new capture or a verification verdict.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertRunId } from "./capture-metadata.mjs";

/** @param {import('node:crypto').BinaryLike} bytes */
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** @param {string} candidateDir @param {import('./capture-types.js').ScreenshotManifest} manifest @param {unknown} path */
export async function sealedFile(candidateDir, manifest, path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) return null;
  const entry = manifest?.files?.find((item) => item?.path === path && /^[a-f0-9]{64}$/.test(item.sha256));
  if (!entry) return null;
  try {
    const root = await realpath(candidateDir);
    const file = await realpath(resolve(root, path));
    const within = relative(root, file);
    if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) return null;
    const bytes = await readFile(file);
    return digest(bytes) === entry.sha256 ? bytes : null;
  } catch { return null; }
}

/**
 * @param {import('./capture-types.js').SelectionEvent[]} events
 * @param {string[]} paths
 * @returns {import('./capture-types.js').SelectedScreenshot[]}
 */
export function recordedSelection(events, paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("goal_screenshots must contain at least one recorded screenshot");
  /** @type {Map<string, import('./capture-types.js').SelectedScreenshot & {order: number}>} */
  const observations = new Map();
  for (const [index, event] of events.entries()) {
    for (const side of /** @type {const} */ (["before", "after"])) {
      const path = event[side]?.screenshot_path;
      if (path && !observations.has(path)) observations.set(path, {
        screenshot_path: path, event_id: event.event_id ?? null,
        captured_at: event.timestamp ?? null, screenshot_sha256: event[side]?.screenshot_sha256 ?? null,
        order: index * 2 + Number(side === "after"),
      });
    }
  }
  let previous = -1;
  return paths.map((path) => {
    const observation = observations.get(path);
    if (typeof path !== "string" || !observation) throw new Error(`screenshot ${String(path)} is not retained by the recorded trace`);
    if (observation.order <= previous) throw new Error("goal_screenshots must be unique and in recorded observation order");
    previous = observation.order;
    const { order, ...result } = observation;
    return result;
  });
}

/**
 * @param {string} candidateDir
 * @param {import('./capture-types.js').ScreenshotManifest} manifest
 * @param {string | Buffer} traceBytes
 * @param {string[]} paths
 */
export async function verifySelection(candidateDir, manifest, traceBytes, paths) {
  const events = String(traceBytes).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const selected = recordedSelection(events, paths);
  for (const item of selected) {
    const bytes = await sealedFile(candidateDir, manifest, item.screenshot_path);
    if (!item.screenshot_path.startsWith("screenshots/") || !bytes || (item.screenshot_sha256 && digest(bytes) !== item.screenshot_sha256))
      throw new Error(`selected screenshot ${item.screenshot_path} is missing or does not match the sealed manifest`);
    item.screenshot_sha256 = digest(bytes);
  }
  return selected;
}

/** @param {string} mapsRoot @param {string} runId */
export const selectionPath = (mapsRoot, runId) => join(dirname(resolve(mapsRoot)), "selections", `${assertRunId(runId)}.json`);

/** @param {{mapsRoot: string, runId: string, screenshots: string[], why: string}} options */
export async function selectCapture({ mapsRoot, runId, screenshots, why }) {
  assertRunId(runId);
  if (typeof why !== "string" || !why.trim()) throw new Error("select needs --why explaining the evidence selection");
  const candidateDir = join(mapsRoot, runId);
  const manifestBytes = await readFile(join(candidateDir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const mapBytes = await sealedFile(candidateDir, manifest, "map.json");
  const trace = await sealedFile(candidateDir, manifest, "observations.jsonl");
  if (!mapBytes || !trace) throw new Error(`map.json or observations.jsonl failed verification in ${candidateDir}`);
  const map = JSON.parse(mapBytes.toString("utf8"));
  if (manifest.run_id !== runId || map.run_id !== runId || typeof map.directed_by !== "string")
    throw new Error("select requires a sealed directed capture with matching run IDs");
  const evidence = await verifySelection(candidateDir, manifest, trace, screenshots);
  const record = {
    schema_version: 1, run_id: runId, manifest_sha256: digest(manifestBytes),
    directed_by: map.directed_by, selected_at: new Date().toISOString(), why: why.trim(),
    goal_screenshots: evidence.map((item) => item.screenshot_path),
  };
  const path = selectionPath(mapsRoot, runId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return { selection_path: path, ...record, evidence };
}
