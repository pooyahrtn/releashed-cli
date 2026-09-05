import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findScreen, findScreens, handleCall, loadMap, screenEdges, screenSummaries, transitionsFrom } from "../scripts/map-mcp.mjs";

// The smallest valid PNG: enough for the width check and the image content block.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// A small synthetic packaged candidate -- not a real run against a real product -- exercising the
// same shapes map-mcp.mjs reads from map.json (docs/map-schema.md): one screen with a screenshot,
// one left twice (the way a list is left both into a detail page and into a theory page), and a
// query that should rank some screens over others.
const SCREENS = [
  { id: "1111111100000000000000000000000000000000", title: "Home screen with a welcome message", url: "https://example.com/", flow: "Home" },
  { id: "2222222200000000000000000000000000000000", title: "Speaking lesson list", url: "https://example.com/speaking", flow: "Speaking" },
  { id: "3333333300000000000000000000000000000000", title: "Speaking lesson detail page", url: "https://example.com/speaking/1", flow: "Speaking" },
  { id: "4444444400000000000000000000000000000000", title: "Speaking lesson theory page", url: "https://example.com/speaking/1/theory", flow: "Speaking" },
  { id: "5555555500000000000000000000000000000000", title: "Settings page", url: "https://example.com/settings", flow: "Settings" },
];
const TRANSITIONS = [
  { from: SCREENS[0].id, to: SCREENS[1].id, action: 'Clicked "Start speaking"' },
  { from: SCREENS[1].id, to: SCREENS[2].id, action: 'Clicked "START"' },
  { from: SCREENS[1].id, to: SCREENS[3].id, action: 'Clicked "Theory"' },
  { from: SCREENS[2].id, to: SCREENS[4].id, action: 'Clicked "Back"' },
];
const short = (id) => id.slice(0, 8);

const CANDIDATE = await mkdtemp(join(tmpdir(), "map-mcp-candidate-"));
after(() => rm(CANDIDATE, { recursive: true, force: true }));
await mkdir(join(CANDIDATE, "screenshots"), { recursive: true });
await writeFile(join(CANDIDATE, "screenshots", "state-0001.png"), PNG_1PX);
await writeFile(
  join(CANDIDATE, "map.json"),
  JSON.stringify({
    schema_version: 1,
    screens: SCREENS.map((screen, index) => ({ ...screen, screenshot: index === 1 ? "screenshots/state-0001.png" : null })),
    transitions: TRANSITIONS,
    findings: [],
  }),
);
const map = await loadMap(CANDIDATE);

test("a packaged candidate loads as screens and transitions", () => {
  assert.equal(map.screens.length, 5);
  assert.equal(map.transitions.length, 4);
  const first = map.screens[0];
  assert.equal(first.id, short(SCREENS[0].id));
  assert.equal(first.title, "Home screen with a welcome message");
  assert.equal(first.url, "https://example.com/");
  assert.equal(first.flow, "Home");
  assert.equal(new Set(map.screens.map((s) => s.id)).size, 5, "short ids stay unique");
});

test("list_screens counts the transitions leaving each screen", () => {
  const summaries = screenSummaries(map);
  assert.equal(summaries[0].outgoing_transitions, 1);
  // The speaking lesson list is left twice: into a lesson, and into its theory page.
  assert.equal(summaries.find((s) => s.id === short(SCREENS[1].id)).outgoing_transitions, 2);
  assert.ok(!("imageData" in summaries[0]), "the list never carries screenshots");
});

test("a screen resolves by its own id and by the map's full hash", () => {
  assert.equal(findScreen(map, short(SCREENS[2].id)).title, "Speaking lesson detail page");
  assert.equal(findScreen(map, SCREENS[2].id).id, short(SCREENS[2].id), "a full hash from the map still finds the screen");
  assert.equal(findScreen(map, "nope"), null);
});

test("transitions read as action-taken plus destination", () => {
  const leaving = transitionsFrom(map, short(SCREENS[0].id));
  assert.deepEqual(leaving, [{ from: short(SCREENS[0].id), to: short(SCREENS[1].id), action: 'Clicked "Start speaking"' }]);
  assert.equal(transitionsFrom(map, null).length, 4, "no id means every transition");
});

test("get_screen returns the screenshot as an image, at most 1280px wide", async () => {
  const { content } = await handleCall(map, "get_screen", { id: short(SCREENS[1].id) });
  const image = content.find((part) => part.type === "image");
  assert.equal(image.mimeType, "image/png");
  const bytes = Buffer.from(image.data, "base64");
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.ok(bytes.readUInt32BE(16) <= 1280);
  assert.match(content[0].text, /Speaking lesson list/);
});

test("an unknown screen is a tool error, not a throw", async () => {
  const result = await handleCall(map, "get_screen", { id: "zzzzzzzz" });
  assert.equal(result.isError, true);
});

test("find_screen ranks by the words a person would use", async () => {
  const hits = findScreens(map, "speaking lesson");
  assert.ok(hits.length > 0);
  assert.ok(hits[0].matched_terms >= 1);
  assert.ok(hits.every((hit) => hit.id.length === 8));
  assert.deepEqual(findScreens(map, "zzzz"), [], "no match is an empty list, not everything");
  assert.deepEqual(findScreens(map, ""), []);
  const { content } = await handleCall(map, "find_screen", { query: "speaking lesson" });
  assert.ok(JSON.parse(content[0].text).length > 0);
});

test("screen_edges answers how you get here and where you can go", async () => {
  const edges = screenEdges(map, short(SCREENS[0].id));
  assert.deepEqual(edges.outgoing, [{ to: short(SCREENS[1].id), to_title: map.screens.find((s) => s.id === short(SCREENS[1].id)).title, action: 'Clicked "Start speaking"' }]);
  assert.ok(edges.incoming.every((edge) => edge.from.length === 8 && edge.action));
  assert.equal(screenEdges(map, "zzzzzzzz"), null);
  assert.equal((await handleCall(map, "screen_edges", { id: "zzzzzzzz" })).isError, true);
});

test("a candidate carrying map.json is read from it, screenshots cited by path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "map-json-"));
  await mkdir(join(dir, "screenshots"), { recursive: true });
  await writeFile(join(dir, "screenshots", "state-0001.png"), PNG_1PX);
  await writeFile(
    join(dir, "map.json"),
    JSON.stringify({
      schema_version: 1,
      screens: [
        { id: "aaaaaaaabbbb", title: "Dashboards list", url: "https://example.com/d", flow: "Dashboards", screenshot: "screenshots/state-0001.png" },
        { id: "ccccccccdddd", title: "One dashboard", url: "https://example.com/d/1", flow: "Dashboards", screenshot: null },
      ],
      transitions: [{ from: "aaaaaaaabbbb", to: "ccccccccdddd", action: 'Clicked "Open"' }],
      findings: [{ kind: "unknown-terminal", instruction: "Click Donate", reason: "led off the product's own site" }],
    }),
  );
  const fromJson = await loadMap(dir);
  assert.equal(fromJson.screens[0].id, "aaaaaaaa");
  assert.equal(fromJson.findings.length, 1);
  assert.deepEqual(screenSummaries(fromJson)[0].outgoing_transitions, 1);
  const { content } = await handleCall(fromJson, "get_screen", { id: "aaaaaaaa" });
  assert.equal(content.find((part) => part.type === "image").mimeType, "image/png");
  const missing = await handleCall(fromJson, "get_screen", { id: "cccccccc" });
  assert.equal(missing.content.length, 1, "a screen with no screenshot still answers, with its text");
  assert.match(missing.content[0].text, /One dashboard/);
  await rm(dir, { recursive: true, force: true });
});
