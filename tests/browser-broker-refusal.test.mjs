import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordRefusal } from "../supervisor/browser-broker.mjs";

// A refusal (e.g. route_seal_raced, private_identity_exposure) doesn't call abort(), so
// without recordRefusal() it left no durable trace at all -- this is the gap that cost a
// disposable Clerk identity to investigate. Verifies the fix: a refused operation lands a
// sanitised, bounded trace in cap-state.json that production-run-report.json can surface.
test("recordRefusal retains a sanitised, bounded trail of broker refusals", async () => {
  const root = await mkdtemp(join(tmpdir(), "spike-a-refusal-"));
  const capPath = join(root, "cap-state.json");
  await writeFile(capPath, JSON.stringify({ abort: null, browser: { operations: 0 } }));

  await recordRefusal(capPath, "observe", "clerk_auth_landing_unconfirmed");
  await recordRefusal(capPath, "click", "route_seal_raced");

  const state = JSON.parse(await readFile(capPath, "utf8"));
  assert.equal(state.abort, null, "a refusal must not fabricate an abort");
  assert.equal(state.browser.refusals.length, 2);
  assert.deepEqual(Object.keys(state.browser.refusals[1]).sort(), [
    "code",
    "operation",
    "timestamp",
  ]);
  assert.equal(state.browser.refusals[1].code, "route_seal_raced");
  assert.equal(state.browser.refusals[1].operation, "click");
  assert.ok(Number.isFinite(Date.parse(state.browser.refusals[1].timestamp)));

  // Bounded: only the last 10 are retained, oldest first.
  for (let index = 0; index < 12; index += 1)
    await recordRefusal(capPath, "observe", `code-${index}`);
  const bounded = JSON.parse(await readFile(capPath, "utf8"));
  assert.equal(bounded.browser.refusals.length, 10);
  assert.equal(bounded.browser.refusals.at(-1).code, "code-11");
  assert.equal(bounded.browser.refusals[0].code, "code-2");
});
