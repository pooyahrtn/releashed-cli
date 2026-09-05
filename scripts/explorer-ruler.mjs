// A ruler for explorer runs: deterministic, no model, no browser.
//
// It reads only what a run already retains -- observations.jsonl, explorer-result.json,
// metrics.json and the target's public pack -- and prints one row per candidate, so a change to the
// explorer can be judged by numbers instead of by reading a map.
//
// Screen identity is the renderer's own: a screen is one `observation_hash` (renderer/render-map.mjs
// keys its nodes on exactly that), and a page address is origin + pathname with the query string
// dropped, the same `pageAddress` the run script shows the explorer.
//
// COVERAGE IS A LOWER-BOUND PROXY, and the denominator is weaker than it sounds. A public pack is
// authored by scripts/author-target-pack.mjs from the target's LANDING PAGE MARKUP ALONE: it quotes
// the labels of that one page's own links and buttons and never learns a route, a journey or any
// deeper page. So "doors known to the pack" counts front-door controls, some of which lead off-site
// and several of which lead to the same address, while every page the product has that is not
// linked from its front door is missing entirely. Coverage above 1.0 is therefore normal and means
// the run went past the front door -- it is a comparison number between runs on the SAME target,
// never a statement about how much of a product exists.
//
// Usage:
//   node scripts/explorer-ruler.mjs artifacts/w1-2-* runs/vision-prod-20260905T110236Z
//   node scripts/explorer-ruler.mjs --json out.json artifacts/w1-2-openstreetmap
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const pageAddress = (url) => {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
};

// Every quoted "label" in the pack's entry-point and capability claims -- the landing page's own
// links and buttons, which is the only door inventory a markup-derived pack has.
export function packDoors(pack) {
  const doors = new Set();
  for (const claim of pack?.claims ?? []) {
    if (claim.kind !== "entry-point" && claim.kind !== "capability") continue;
    for (const [, label] of claim.text.matchAll(/"([^"]+)"/g)) doors.add(label);
  }
  return doors.size;
}

// The whole measurement, over already-parsed inputs so it can be tested without a run on disk.
export function measure({ events, result, metrics, pack }) {
  const seenScreens = new Set();
  const seenPaths = new Set();
  let revisits = 0;
  let addressRevisits = 0;
  let positional = 0;
  let transitions = 0;
  for (const [index, event] of events.entries()) {
    if (index === 0 && event.before?.observation_hash) {
      seenScreens.add(event.before.observation_hash);
      seenPaths.add(pageAddress(event.before.url));
    }
    if (event.transition_kind === "solid") transitions += 1;
    if (event.intended_action?.target_identification === "positional") positional += 1;
    const hash = event.after?.observation_hash;
    if (!hash) continue;
    if (seenScreens.has(hash)) revisits += 1;
    seenScreens.add(hash);
    const address = pageAddress(event.after.url);
    // A screen fingerprint is exact, so a repainted map tile or a moved caret makes a "new" screen
    // out of the same page; the address is the coarser, more honest breadth signal.
    if (seenPaths.has(address)) addressRevisits += 1;
    seenPaths.add(address);
  }
  const doors = packDoors(pack);
  return {
    model: metrics?.explorer_model ?? null,
    stop_reason: result?.stop_reason ?? null,
    steps: result?.decisions ?? events.length,
    transitions,
    screens: seenScreens.size,
    paths: seenPaths.size,
    revisits,
    address_revisits: addressRevisits,
    positional,
    unexecutable: result?.unexecutable_instructions?.length ?? 0,
    blocked: result?.blocked_actions?.length ?? 0,
    cost_eur: metrics?.model_cost_eur ?? null,
    pack_doors: doors,
    coverage: doors ? Number((seenPaths.size / doors).toFixed(2)) : null,
  };
}

// A packaged candidate keeps everything side by side; a raw run keeps it under target-session-1/
// and has no public pack, so the pack is looked up from the target config whose URL shares the
// run's own first origin.
async function resolveSession(dir) {
  const entries = await readdir(dir);
  return entries.includes("observations.jsonl") ? dir : join(dir, "target-session-1");
}

async function packFor(session, origin) {
  try {
    return await readJson(join(session, "public-pack.json"));
  } catch {}
  const targets = resolve(import.meta.dirname, "..", "targets");
  for (const file of await readdir(targets)) {
    const config = await readJson(join(targets, file));
    const origins = [config.url, ...(config.additionalOrigins ?? [])].filter(Boolean);
    if (!origins.some((candidate) => new URL(candidate).origin === origin)) continue;
    if (config.publicPackPath) return readJson(resolve(targets, config.publicPackPath));
  }
  return null;
}

export async function ruleCandidate(dir) {
  const session = await resolveSession(dir);
  const events = (await readFile(join(session, "observations.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const [result, metrics] = await Promise.all([
    readJson(join(session, "explorer-result.json")),
    readJson(join(session, "metrics.json")),
  ]);
  const origin = events[0]?.before?.origin ?? events[0]?.current_origin ?? null;
  const pack = origin ? await packFor(session, origin) : null;
  return {
    candidate: basename(dir),
    run_id: metrics?.run_id ?? result?.run_id ?? null,
    origin,
    ...measure({ events, result, metrics, pack }),
  };
}

const COLUMNS = [
  ["candidate", "Candidate"],
  ["origin", "Target"],
  ["model", "Model"],
  ["steps", "Steps"],
  ["transitions", "Transitions"],
  ["screens", "Screens"],
  ["paths", "Paths"],
  ["revisits", "Revisits"],
  ["address_revisits", "Stale-address steps"],
  ["positional", "Positional"],
  ["unexecutable", "Unexecutable"],
  ["blocked", "Blocked doors"],
  ["cost_eur", "Cost EUR"],
  ["pack_doors", "Pack doors"],
  ["coverage", "Coverage"],
  ["stop_reason", "Stopped by"],
];

export function markdownTable(rows) {
  const cell = (row, key) => {
    const value = row[key];
    if (value === null || value === undefined) return "—";
    if (key === "cost_eur") return value.toFixed(4);
    if (key === "origin") return String(value).replace(/^https:\/\//, "");
    return String(value);
  };
  return [
    `| ${COLUMNS.map(([, title]) => title).join(" | ")} |`,
    `|${COLUMNS.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${COLUMNS.map(([key]) => cell(row, key)).join(" | ")} |`),
  ].join("\n");
}

if (process.argv[1]?.endsWith("explorer-ruler.mjs")) {
  const argv = process.argv.slice(2);
  const jsonIndex = argv.indexOf("--json");
  const jsonPath = jsonIndex >= 0 ? argv[jsonIndex + 1] : null;
  // Guarded on jsonIndex >= 0: without --json, indexOf returns -1 and "index !== jsonIndex + 1"
  // silently swallowed the FIRST candidate directory.
  const dirs = argv.filter((value, index) => jsonIndex < 0 || (index !== jsonIndex && index !== jsonIndex + 1));
  if (!dirs.length) throw new Error("Usage: node scripts/explorer-ruler.mjs [--json out.json] <candidate dir>...");
  const rows = [];
  for (const dir of dirs) {
    try {
      rows.push(await ruleCandidate(resolve(dir)));
    } catch (error) {
      console.error(`skipped ${dir}: ${error?.message ?? error}`);
    }
  }
  console.log(markdownTable(rows));
  if (jsonPath) await writeFile(resolve(jsonPath), `${JSON.stringify(rows, null, 2)}\n`);
}
