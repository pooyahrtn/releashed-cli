import assert from "node:assert/strict";
import test from "node:test";
import { loadPublicEntry } from "../scripts/vision-explorer-run.mjs";

// A stranger's marketing site may never reach "networkidle" (analytics beacons, chat widgets,
// autoplaying video). brandfetch.com does not, and a hard networkidle gate threw
// "page.goto: Timeout 30000ms exceeded" before the run's first screenshot.
const fakePage = (idleBehaviour) => {
  const calls = [];
  return {
    calls,
    async goto(url, options) {
      calls.push(["goto", url, options.waitUntil]);
    },
    async waitForLoadState(state, options) {
      calls.push(["waitForLoadState", state, options?.timeout ?? null]);
      if (idleBehaviour === "never") throw new Error("Timeout 10000ms exceeded");
    },
    async waitForTimeout(ms) {
      calls.push(["waitForTimeout", ms]);
    },
  };
};

test("a public entry lands on a state every page reaches, not on network idle", async () => {
  const page = fakePage("idle");
  await loadPublicEntry(page, "https://brandfetch.com");
  assert.deepEqual(page.calls[0], ["goto", "https://brandfetch.com", "domcontentloaded"]);
});

test("a site that never goes idle still loads, and still gets its settle wait", async () => {
  const page = fakePage("never");
  await loadPublicEntry(page, "https://brandfetch.com");
  assert.deepEqual(page.calls, [
    ["goto", "https://brandfetch.com", "domcontentloaded"],
    ["waitForLoadState", "networkidle", 10_000],
    ["waitForTimeout", 3_000],
  ]);
});
