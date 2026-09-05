import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownTable, measure, packDoors, ruleCandidate } from "../scripts/explorer-ruler.mjs";

const state = (hash, path) => ({
  url: `https://example.com${path}`,
  origin: "https://example.com",
  observation_hash: hash,
});

// Three steps: home -> /a (new), /a -> /a?q=1 (same address, same screen: a revisit), /a -> home
// (a screen already seen). Two of the three steps land somewhere already seen.
const EVENTS = [
  { before: state("h", "/"), after: state("a", "/a"), transition_kind: "solid", intended_action: { target_identification: "named", ref: "e1" } },
  { before: state("a", "/a"), after: state("a", "/a"), transition_kind: "none", intended_action: { target_identification: "positional" } },
  { before: state("a", "/a"), after: state("h", "/"), transition_kind: "solid", intended_action: { target_identification: "named", ref: "e2" } },
];
const RESULT = { stop_reason: "explicit_done", decisions: 5, unexecutable_instructions: [{}], blocked_actions: [{}, {}] };
const METRICS = { run_id: "r1", explorer_model: "claude-sonnet-5", model_cost_eur: 0.5 };
const PACK = {
  claims: [
    { kind: "entry-point", text: 'links are labelled: "Home", "A", "Donate".' },
    { kind: "capability", text: 'buttons are labelled: "Go".' },
    { kind: "promise", text: 'the title is "Ignored".' },
  ],
};

test("the pack's door inventory is its own quoted link and button labels", () => {
  assert.equal(packDoors(PACK), 4, "promise claims are not doors");
  assert.equal(packDoors({ claims: [] }), 0);
});

test("the ruler counts screens, addresses, revisits and imprecise steps", () => {
  const row = measure({ events: EVENTS, result: RESULT, metrics: METRICS, pack: PACK });
  assert.equal(row.screens, 2, "two distinct observation hashes");
  assert.equal(row.paths, 2, "the query string is not a new address");
  assert.equal(row.revisits, 2, "steps 2 and 3 both land on an already-seen screen");
  assert.equal(row.address_revisits, 2, "and on an address already visited");
  assert.equal(row.transitions, 2);
  assert.equal(row.positional, 1);
  assert.equal(row.unexecutable, 1);
  assert.equal(row.blocked, 2);
  assert.equal(row.steps, 5, "steps are the explorer's decisions, not the recorded events");
  assert.equal(row.pack_doors, 4);
  assert.equal(row.coverage, 0.5);
  assert.equal(measure({ events: EVENTS, result: RESULT, metrics: METRICS, pack: null }).coverage, null);
});

test("a candidate directory on disk measures the same, and renders as one markdown row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ruler-"));
  await writeFile(join(dir, "observations.jsonl"), EVENTS.map((e) => JSON.stringify(e)).join("\n"));
  await writeFile(join(dir, "explorer-result.json"), JSON.stringify(RESULT));
  await writeFile(join(dir, "metrics.json"), JSON.stringify(METRICS));
  await writeFile(join(dir, "public-pack.json"), JSON.stringify(PACK));
  const row = await ruleCandidate(dir);
  assert.equal(row.origin, "https://example.com");
  assert.equal(row.revisits, 2);
  const table = markdownTable([row]).split("\n");
  assert.equal(table.length, 3);
  assert.match(table[2], /claude-sonnet-5/);
  assert.match(table[2], /0\.5000/);
});
