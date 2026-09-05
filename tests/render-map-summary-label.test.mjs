import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Text } from "../lib/scaffold.mjs";
import { renderMap } from "../renderer/render-map.mjs";

// Regression test for the 2026-09-05 header fix: the summary line used to read "N flows", which a
// reader reasonably takes as "N distinct journeys" -- but the underlying count only ever tallies
// transitions that stay on the exact same URL, so it structurally can't see the (much more common)
// journey that moves between pages. That mismatch is what made the header contradict an independent
// review's honest count of distinct journeys on the Grafana Play map. The fix relabels the number
// instead of retuning it, so this test locks two things: the label no longer claims to count
// "flows"/journeys, and the underlying count (still exact-URL-path repeat interaction) is unchanged.

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
// All three states share this one URL on purpose -- two same-URL transitions is exactly the
// "walked around in the same lane" case countFlows exists to recognize.
const URL_BASE = "https://example.test/one-page-app";

// Each state gets its own screenshot bytes (the shared 1x1 PIXEL plus its own name): this fixture
// exercises the same-URL "repeat interaction" count, not screenshot dedup, and a byte-identical
// screenshot across states now correctly merges them into one card (see
// tests/render-map-duplicate-screens.test.mjs).
async function state(run, name, summaryLines) {
  const summary = summaryLines.join("\n");
  const path = `screenshots/${name}.png`;
  const image = Buffer.concat([PIXEL, Buffer.from(name)]);
  await writeFile(join(run, path), image);
  return {
    url: URL_BASE,
    origin: new URL(URL_BASE).origin,
    visible_state_summary: summary,
    observation_hash: sha256Text(JSON.stringify({ url: URL_BASE, visible_state_summary: summary })),
    screenshot_path: path,
    screenshot_sha256: sha(image),
  };
}

function event(index, before, after) {
  return {
    run_id: "run-fixture",
    event_id: `event-${String(index).padStart(4, "0")}`,
    timestamp: `2026-09-03T12:0${index}:00.000Z`,
    current_url: after.url,
    current_origin: after.origin,
    visible_state_summary: after.visible_state_summary,
    before,
    after,
    intended_action: { method: "click", ref: "e2" },
    effect_evidence: { supervisor_authorized: true, mutation_request_match: null },
    action_matrix_class: "Reversible own-account",
    observed_outcome: "clicked",
    outcome_detail: null,
    screenshot_path: after.screenshot_path,
    evidence_provenance: "direct-browser-observation",
    transition_kind: "solid",
  };
}

test("the header names what the count measures instead of claiming to count journeys", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-map-summary-")));
  try {
    const run = join(root, "run");
    await mkdir(join(run, "screenshots"), { recursive: true });

    const screen1 = await state(run, "state-1", ["e1 [heading] Step one"]);
    const screen2 = await state(run, "state-2", ["e1 [heading] Step two"]);
    const screen3 = await state(run, "state-3", ["e1 [heading] Step three"]);
    const events = [event(1, screen1, screen2), event(2, screen2, screen3)];
    await writeFile(
      join(run, "observations.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const outputPath = join(root, "map.html");
    await renderMap({ tracePath: join(run, "observations.jsonl"), outputPath });
    const html = await readFile(outputPath, "utf8");

    const modelJson = html.match(/const model = (\{.*\});\n/)?.[1];
    assert.ok(modelJson, "expected an embedded model in the rendered map");
    const model = JSON.parse(modelJson);
    // Two transitions, both on the same exact URL -> exactly one lane qualifies. This is the
    // number the header must keep computing; only its label changed.
    assert.equal(model.flowCount, 1, "same-URL repeat interaction should still count as one lane");

    const summaryLine = html.split("\n").find((line) => line.includes("summary.textContent"));
    assert.ok(summaryLine, "expected the client-side summary line in the rendered script");
    assert.match(summaryLine, /repeat interaction/, 'label must say what it measures, not "flow"');
    assert.doesNotMatch(
      summaryLine,
      /'\s*\+\s*model\.flowCount\s*\+\s*'\s*flow/,
      "must not reintroduce the 'N flows' wording that reads as a journey count",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
