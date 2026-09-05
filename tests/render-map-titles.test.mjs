import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Text } from "../lib/scaffold.mjs";
import { cleanCaption } from "../scripts/caption-screens.mjs";
import { renderMap } from "../renderer/render-map.mjs";

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const URL_BASE = "https://example.test/onboarding";

// One retained state: an accessibility summary (parsed the same way the renderer does, "eN [role]
// name" per line) plus a screenshot, hashed exactly like the real producer does. Each state gets
// its own screenshot bytes (the shared 1x1 PIXEL plus its own name) -- these fixtures exercise
// title derivation, not screenshot dedup, and a byte-identical screenshot across states now
// correctly merges them into one card (see tests/render-map-duplicate-screens.test.mjs).
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

test("card titles never fall back to the tab title and never repeat a title another card already carries", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-map-titles-")));
  try {
    const run = join(root, "run");
    await mkdir(join(run, "screenshots"), { recursive: true });

    // Screen 1: nothing but the app shell -- no heading, no radiogroup, no long caption. Its only
    // "name" anywhere is the RootWebArea's own text, which is the browser tab title and must never
    // be used as a card title.
    const screen1 = await state(run, "state-1", ["e1 [RootWebArea] Coach | Inburgering Coach", "e2 [button] Menu"]);
    // Screen 2: a real question appears.
    const screen2 = await state(run, "state-2", [
      "e1 [RootWebArea] Coach | Inburgering Coach",
      "e2 [button] Menu",
      "e3 [heading] Question one, which exam are you working toward?",
    ]);
    // Screen 3: screen 2's heading STAYS MOUNTED (this app's chat surface keeps old turns visible)
    // and no new heading/radiogroup is added -- only a new long caption. The title must come from
    // that new caption, not from re-finding the old, already-used heading.
    const screen3 = await state(run, "state-3", [
      "e1 [RootWebArea] Coach | Inburgering Coach",
      "e2 [button] Menu",
      "e3 [heading] Question one, which exam are you working toward?",
      "e4 [StaticText] Good choice -- here is the very next instruction for this new screen.",
    ]);

    const events = [event(1, screen1, screen2), event(2, screen2, screen3)];
    await writeFile(join(run, "observations.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const outputPath = join(root, "map.html");
    await renderMap({ tracePath: join(run, "observations.jsonl"), outputPath });
    const html = await readFile(outputPath, "utf8");
    // Node captions are rendered client-side from an embedded JSON model, not as static HTML.
    const modelJson = html.match(/const model = (\{.*\});\n/)?.[1];
    assert.ok(modelJson, "expected an embedded model in the rendered map");
    const titles = JSON.parse(modelJson).nodes.map((node) => node.title);

    assert.equal(titles.length, 3, "expected one card per distinct screen");
    for (const title of titles) assert.notEqual(title, "Coach | Inburgering Coach");
    assert.equal(new Set(titles).size, titles.length, `titles must be distinct, got ${JSON.stringify(titles)}`);
    assert.ok(
      titles.some((title) => title.includes("Question one")),
      "screen 2's own heading should title its card",
    );
    assert.ok(
      titles.some((title) => title.includes("very next instruction")),
      "screen 3's new caption should title its card, not screen 2's stale heading",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("a stale, off-screen line never titles a card when an on-screen candidate exists", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-map-titles-offscreen-")));
  try {
    const run = join(root, "run");
    await mkdir(join(run, "screenshots"), { recursive: true });

    // Screen 1: a heading, fully on screen. Its own card should still use it.
    const screen1 = await state(run, "state-1", [
      "e1 [RootWebArea] Coach | Inburgering Coach",
      "e2 [heading] First: which exam are you working toward?",
      "e3 [StaticText] Put this in the right order -- a brand new on-screen instruction.",
    ]);
    // Screen 2: that SAME heading is still mounted (this app's chat surface never unmounts old
    // turns) but has scrolled off screen -- marked "offscreen" exactly as the producer now records
    // it. The only thing actually visible is the StaticText from before, plus a short new button
    // that is too short to title a card on its own, so the algorithm must fall back to the whole
    // page and, critically, must NOT let the higher-priority (but off-screen) heading win just
    // because heading beats StaticText in the normal ranking.
    const screen2 = await state(run, "state-2", [
      "e1 [RootWebArea] Coach | Inburgering Coach",
      "e2 [heading offscreen] First: which exam are you working toward?",
      "e3 [StaticText] Put this in the right order -- a brand new on-screen instruction.",
      "e4 [button] SUBMIT",
    ]);

    const events = [event(1, screen1, screen2)];
    await writeFile(join(run, "observations.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const outputPath = join(root, "map.html");
    await renderMap({ tracePath: join(run, "observations.jsonl"), outputPath });
    const html = await readFile(outputPath, "utf8");
    const modelJson = html.match(/const model = (\{.*\});\n/)?.[1];
    assert.ok(modelJson, "expected an embedded model in the rendered map");
    const titles = JSON.parse(modelJson).nodes.map((node) => node.title);

    assert.equal(titles.length, 2, "expected one card per distinct screen");
    assert.equal(titles[0], "First: which exam are you working toward?", "screen 1's own on-screen heading titles its own card");
    assert.equal(
      titles[1],
      "Put this in the right order -- a brand new on-screen instruction.",
      `screen 2's card must come from what is still on screen, not the now-scrolled-off heading, got ${JSON.stringify(titles)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a screen description titles its card, and anything that would mislead falls back to the on-screen text", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-map-captions-")));
  try {
    const run = join(root, "run");
    await mkdir(join(run, "screenshots"), { recursive: true });

    const screen1 = await state(run, "state-1", [
      "e1 [RootWebArea] Coach | Inburgering Coach",
      "e2 [heading] First: which exam are you working toward?",
    ]);
    const screen2 = await state(run, "state-2", [
      "e1 [RootWebArea] Coach | Inburgering Coach",
      "e2 [heading] What do you want to practise? Untick anything you do not need.",
    ]);
    const screen3 = await state(run, "state-3", [
      "e1 [RootWebArea] Coach | Inburgering Coach",
      "e2 [heading] Write your answer to the letter below in Dutch.",
    ]);

    const events = [event(1, screen1, screen2), event(2, screen2, screen3)];
    await writeFile(join(run, "observations.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const outputPath = join(root, "map.html");
    await renderMap({
      tracePath: join(run, "observations.jsonl"),
      outputPath,
      captions: {
        // An honest description of the picture: this titles the card.
        [screen1.observation_hash]: "Exam choice question.",
        // Claims an effect -- that is what an arrow reports, never a description of a picture.
        [screen2.observation_hash]: "Opens the practice picker",
        // A URL path, which is exactly the sort of title captions exist to replace.
        [screen3.observation_hash]: "/onboarding-coach",
      },
    });
    const html = await readFile(outputPath, "utf8");
    const model = JSON.parse(html.match(/const model = (\{.*\});\n/)?.[1] ?? "null");
    assert.ok(model, "expected an embedded model in the rendered map");
    const nodes = model.nodes;

    assert.equal(nodes[0].title, "Exam choice question", "a usable description titles the card");
    assert.equal(nodes[0].caption, "Exam choice question");
    assert.equal(
      nodes[0].observedTitle,
      "First: which exam are you working toward?",
      "the text read off the screen is kept alongside the description",
    );
    assert.equal(
      nodes[1].title,
      "What do you want to practise? Untick anything you do not need.",
      "a description that claims an effect is refused; the card keeps its on-screen text",
    );
    assert.equal(nodes[1].caption, null);
    assert.equal(
      nodes[2].title,
      "Write your answer to the letter below in Dutch.",
      "a URL-shaped description is refused; the card keeps its on-screen text",
    );

    // Descriptions are a reading aid in the map only -- the evidence file stays exactly what the
    // run produced.
    const trace = await readFile(join(run, "observations.jsonl"), "utf8");
    assert.ok(!trace.includes("Exam choice question"), "a description must never enter the trace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a description keeps the phrase the model wrote and drops its commentary about itself", () => {
  assert.equal(cleanCaption("Word lookup sheet open over the lesson"), "Word lookup sheet open over the lesson");
  assert.equal(cleanCaption("Exam plan summary screen."), "Exam plan summary screen");
  assert.equal(cleanCaption('Noun phrase: Daily check-in time selection'), "Daily check-in time selection");
  assert.equal(cleanCaption('"Speaking lesson menu with Start button" -> wait, is that sentence case?'), "Speaking lesson menu with Start button");
  assert.equal(cleanCaption('Exam plan summary screen" (5 words) or "Exam plan with skills'), "Exam plan summary screen");
  // An apostrophe inside the phrase is part of the phrase, not the model quoting itself.
  assert.equal(cleanCaption("Translation question answered I don't know"), "Translation question answered I don't know");
  // Nothing usable left: the screen keeps the title read off it instead.
  assert.equal(cleanCaption(":"), null);
  assert.equal(cleanCaption("   "), null);
  // The model working through the instructions out loud is not a description of anything.
  assert.equal(cleanCaption("\n  *  Wait, counting: Word (1) order (2) question (3)"), null);
  assert.equal(cleanCaption('" -> 6 words.\n * Sentence case? Yes.'), null);
  assert.equal(cleanCaption("Speaking [1] exercise [2] for [3] Kunt [4] u"), null);
  // ...but a phrase it merely labelled still is.
  assert.equal(
    cleanCaption('Sentence case: "Practice skill selection with all options ticked"\n * No full stop.'),
    "Practice skill selection with all options ticked",
  );
});
