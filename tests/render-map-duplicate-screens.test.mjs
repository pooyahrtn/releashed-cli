import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Text } from "../lib/scaffold.mjs";
import { renderMap } from "../renderer/render-map.mjs";

// Regression test for the 2026-09-05 dogfood run: a home screen reached at two different addresses
// (a trailing-path variant and the bare root) is one and the same picture, but the renderer used to
// file it as two cards under two flow names because screens are deduped by observation_hash, which
// bakes the URL in. A state's retained screenshot -- not its address -- is what a reader actually
// sees, so two states with byte-identical screenshots must collapse into the first card's identity,
// with every transition that named the discarded card repointed at the survivor.

const sha = (value) => createHash("sha256").update(value).digest("hex");
// One base image reused for the two "same picture, different address" states, and a handful of
// distinct images (base + a trailing byte) for every screen that must stay its own card.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const distinctPixel = (tag) => Buffer.concat([PIXEL, Buffer.from([tag])]);

async function state(run, name, url, imageBytes, summaryLines) {
  const summary = summaryLines.join("\n");
  const path = `screenshots/${name}.png`;
  await writeFile(join(run, path), imageBytes);
  return {
    url,
    origin: new URL(url).origin,
    visible_state_summary: summary,
    observation_hash: sha256Text(JSON.stringify({ url, visible_state_summary: summary })),
    screenshot_path: path,
    screenshot_sha256: sha(imageBytes),
  };
}

function event(index, before, after) {
  return {
    run_id: "run-fixture",
    event_id: `event-${String(index).padStart(4, "0")}`,
    timestamp: `2026-09-03T12:${String(index).padStart(2, "0")}:00.000Z`,
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

// One continuous walk (a trace is always sequential): start -> home ("/today") -> settings ->
// settings-tab (same pathname, distinct screenshot, so same flow as settings) -> other-entry ->
// home again but at "/" with the SAME screenshot bytes as "/today" -> profile. This exercises: a
// merge (the two homes), a same-flow-different-screen pair (settings/settings-tab, so the
// distinct-flow count is provably lower than the screen count), and several screens that must
// never merge (all distinct screenshots).
async function buildFixture(run) {
  const start = await state(run, "start", "https://example.test/start", distinctPixel(1), [
    "e1 [heading] Start",
  ]);
  const home = await state(run, "home-today", "https://example.test/today", distinctPixel(0), [
    "e1 [heading] Home",
  ]);
  const settings = await state(run, "settings", "https://example.test/settings", distinctPixel(2), [
    "e1 [heading] Settings",
  ]);
  const settingsTab = await state(
    run,
    "settings-tab",
    "https://example.test/settings?tab=security",
    distinctPixel(3),
    ["e1 [heading] Settings security tab"],
  );
  const otherEntry = await state(run, "other-entry", "https://example.test/other-start", distinctPixel(4), [
    "e1 [heading] Other entry",
  ]);
  // Byte-identical to `home`, but reached at the bare root instead of "/today".
  const homeAgain = await state(run, "home-root", "https://example.test/", distinctPixel(0), [
    "e1 [heading] Home",
  ]);
  const profile = await state(run, "profile", "https://example.test/profile", distinctPixel(5), [
    "e1 [heading] Profile",
  ]);

  const chain = [start, home, settings, settingsTab, otherEntry, homeAgain, profile];
  const events = chain.slice(1).map((after, index) => event(index + 1, chain[index], after));
  await writeFile(join(run, "observations.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { home, homeAgain, settings, settingsTab, otherEntry, profile, eventCount: events.length };
}

test("two states with identical screenshot SHA-256 but different addresses merge into one screen, with both screens' transitions preserved and repointed at the survivor", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-map-dupe-")));
  try {
    const run = join(root, "run");
    await mkdir(join(run, "screenshots"), { recursive: true });
    const fixture = await buildFixture(run);

    const { map } = await renderMap({
      tracePath: join(run, "observations.jsonl"),
      outputPath: join(root, "map.html"),
    });

    // One card for both homes, not two -- and it kept the FIRST card's identity ("/today"), not the
    // later duplicate's ("/").
    const homeScreens = map.screens.filter((screen) => screen.id === fixture.home.observation_hash);
    assert.equal(homeScreens.length, 1, "the two byte-identical homes must collapse into one screen");
    assert.equal(homeScreens[0].url, fixture.home.url, "the survivor keeps the first card's own address");
    assert.ok(
      !map.screens.some((screen) => screen.id === fixture.homeAgain.observation_hash),
      "the discarded duplicate must not also appear as its own screen",
    );

    // No transition is dropped, and none still names the discarded id -- both the transition INTO
    // the duplicate and the transition OUT of it now point at the survivor.
    assert.equal(map.transitions.length, fixture.eventCount, "no transition may be lost in the merge");
    assert.ok(
      !map.transitions.some(
        (t) => t.from === fixture.homeAgain.observation_hash || t.to === fixture.homeAgain.observation_hash,
      ),
      "no transition may still reference the discarded id",
    );
    assert.ok(
      map.transitions.some(
        (t) => t.from === fixture.otherEntry.observation_hash && t.to === fixture.home.observation_hash,
      ),
      "the transition that used to arrive at the duplicate now arrives at the survivor",
    );
    assert.ok(
      map.transitions.some(
        (t) => t.from === fixture.home.observation_hash && t.to === fixture.profile.observation_hash,
      ),
      "the transition that used to leave the duplicate now leaves the survivor",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a state with a different screenshot stays a separate screen", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-map-dupe-distinct-")));
  try {
    const run = join(root, "run");
    await mkdir(join(run, "screenshots"), { recursive: true });
    const fixture = await buildFixture(run);

    const { map } = await renderMap({
      tracePath: join(run, "observations.jsonl"),
      outputPath: join(root, "map.html"),
    });

    for (const screen of [fixture.settings, fixture.settingsTab, fixture.otherEntry, fixture.profile])
      assert.ok(
        map.screens.some((s) => s.id === screen.observation_hash),
        `screen at ${screen.url} has its own screenshot and must stay its own card`,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every counts field equals the length of the array it counts, including the distinct-flow count", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-map-dupe-counts-")));
  try {
    const run = join(root, "run");
    await mkdir(join(run, "screenshots"), { recursive: true });
    await buildFixture(run);

    const { map } = await renderMap({
      tracePath: join(run, "observations.jsonl"),
      outputPath: join(root, "map.html"),
    });

    // Known shape: 7 states walked, one merge (the two homes) -> 6 screens; 6 transitions, none
    // dropped by the merge; 5 distinct flows (settings and its security tab share one).
    assert.equal(map.screens.length, 6);
    assert.equal(map.transitions.length, 6);
    assert.equal(new Set(map.screens.map((screen) => screen.flow)).size, 5);

    assert.equal(map.counts.screens, map.screens.length);
    assert.equal(map.counts.transitions, map.transitions.length);
    assert.equal(map.counts.flows, new Set(map.screens.map((screen) => screen.flow)).size);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
