import assert from "node:assert/strict";
import test from "node:test";
import { diffMaps, formatDiff, hasDisappearance, summarizeDiff } from "../lib/map-diff.mjs";
import { diffCommand } from "../bin/releashed.mjs";

// Small hand-written maps, just enough shape to exercise the matcher (docs/map-schema.md has the
// real fields; only id/title/url/transitions matter to lib/map-diff.mjs).
const screen = (id, title, url) => ({ id, title, url, caption: null, observed_title: title, flow: "F", screenshot: null, terminal: false, out_degree: 0 });

function baseMap() {
  return {
    schema_version: 1,
    run_id: "run-old",
    screens: [
      screen("a1", "Dashboard", "https://x.test/dashboard"),
      screen("b1", "Settings", "https://x.test/settings"),
      screen("c1", "Billing", "https://x.test/billing"),
    ],
    transitions: [
      { from: "a1", to: "b1", action: 'Clicked "Settings"', kind: "solid" },
      { from: "b1", to: "c1", action: 'Clicked "Billing"', kind: "solid" },
    ],
  };
}

test("a screen removed is reported and exits non-zero", () => {
  const oldMap = baseMap();
  const newMap = { ...oldMap, screens: oldMap.screens.filter((s) => s.title !== "Billing"), transitions: oldMap.transitions.filter((t) => t.to !== "c1") };
  const diff = diffMaps(oldMap, newMap);
  assert.equal(diff.screensGone.length, 1);
  assert.equal(diff.screensGone[0].title, "Billing");
  assert.equal(diff.transitionsGone.length, 1);
  assert.equal(hasDisappearance(diff), true);
});

test("a screen added only is reported and exits zero", () => {
  const oldMap = baseMap();
  const newMap = { ...oldMap, screens: [...oldMap.screens, screen("d1", "Reports", "https://x.test/reports")] };
  const diff = diffMaps(oldMap, newMap);
  assert.equal(diff.screensNew.length, 1);
  assert.equal(diff.screensNew[0].title, "Reports");
  assert.equal(diff.screensGone.length, 0);
  assert.equal(diff.transitionsGone.length, 0);
  assert.equal(hasDisappearance(diff), false);
});

test("the same map compared with itself reports nothing changed and exits zero", () => {
  const map = baseMap();
  const diff = diffMaps(map, JSON.parse(JSON.stringify(map)));
  assert.deepEqual(diff, { screensGone: [], screensNew: [], screensChanged: [], transitionsGone: [], transitionsNew: [] });
  assert.equal(summarizeDiff(diff), "nothing changed");
  assert.equal(hasDisappearance(diff), false);
});

test("a screen whose screenshot hash changed is reported as changed, not as gone", () => {
  const oldMap = baseMap();
  const renamed = (id) => (id === "b1" ? "b2" : id);
  const newMap = {
    ...oldMap,
    screens: oldMap.screens.map((s) => (s.title === "Settings" ? { ...s, id: "b2" } : s)),
    transitions: oldMap.transitions.map((t) => ({ ...t, from: renamed(t.from), to: renamed(t.to) })),
  };
  const diff = diffMaps(oldMap, newMap);
  assert.equal(diff.screensChanged.length, 1);
  assert.equal(diff.screensChanged[0].old.id, "b1");
  assert.equal(diff.screensChanged[0].new.id, "b2");
  assert.equal(diff.screensGone.length, 0);
  assert.equal(diff.screensNew.length, 0);
  // Still reported (a real screen the product changed), but never worded like a gone screen.
  assert.equal(hasDisappearance(diff), false);
  assert.match(formatDiff(diff), /Reached in both runs, evidence changed/);
});

test("not-reached is reported distinctly from changed", () => {
  const oldMap = baseMap();
  const newMap = {
    ...oldMap,
    // Billing was never visited this run (no (url,title) match at all, and nothing transitions
    // into it); Settings was visited and looks different (same key, different id). The two must
    // read differently in the output.
    screens: oldMap.screens.filter((s) => s.title !== "Billing").map((s) => (s.title === "Settings" ? { ...s, id: "b2" } : s)),
    transitions: [{ from: "a1", to: "b2", action: 'Clicked "Settings"', kind: "solid" }],
  };
  const diff = diffMaps(oldMap, newMap);
  const text = formatDiff(diff);
  assert.match(text, /Not reached this run \(may be broken, or the walk simply did not visit them\):\n {2}- Billing/);
  const changedSection = text.split("Reached in both runs, evidence changed:")[1].split("\n\n")[0];
  assert.match(changedSection, /Settings/);
  assert.doesNotMatch(changedSection, /Billing/);
  const notReachedSection = text.split("Not reached this run")[1].split("\n\n")[0];
  assert.match(notReachedSection, /Billing/);
  assert.doesNotMatch(notReachedSection, /Settings/);
  // The prose never claims the missing screen broke -- only that it was not reached.
  assert.doesNotMatch(text, /Billing.{0,40}(broke|broken)/s);
});

test("the CLI verb prints a one-line summary and sets the exit code", async (t) => {
  const oldMap = baseMap();
  const newMap = { ...oldMap, screens: oldMap.screens.filter((s) => s.title !== "Billing"), transitions: oldMap.transitions.filter((t) => t.to !== "c1") };
  const lines = [];
  const dirs = { "/old": oldMap, "/new": newMap };
  const result = await diffCommand(
    { oldDir: "/old", newDir: "/new", json: false },
    { readMap: async (dir) => dirs[dir], log: (line) => lines.push(line) },
  );
  assert.equal(result.exitCode, 1);
  assert.match(lines[0], /^1 screen gone, 1 transition gone/);

  const clean = await diffCommand(
    { oldDir: "/old", newDir: "/old", json: false },
    { readMap: async (dir) => dirs[dir] ?? oldMap, log: (line) => lines.push(line) },
  );
  assert.equal(clean.exitCode, 0);
});
