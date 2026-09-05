import assert from "node:assert/strict";
import test from "node:test";
import { reanchorLastEvent } from "../scripts/vision-explorer-run.mjs";

// An off-site drift is noticed at the top of the NEXT step, after the previous step's post-action
// screenshot was already written. Walking back re-reads the screen; if that re-read only replaced
// the runner's working state, the next event's `before` would no longer be the previous event's
// `after` and the renderer refuses the whole trace ("Trace evidence continuity is broken").
const evidence = (hash, index) => ({
  url: "https://www.example.com/",
  origin: "https://www.example.com",
  visible_state_summary: `summary ${hash}`,
  observation_hash: hash,
  screenshot_path: `screenshots/state-${String(index).padStart(4, "0")}.png`,
  screenshot_sha256: `png-${hash}`,
});

const event = () => ({
  before: evidence("a", 1),
  after: evidence("b", 2),
  current_url: "https://www.example.com/",
  current_origin: "https://www.example.com",
  visible_state_summary: "summary b",
  screenshot_path: "screenshots/state-0002.png",
  intended_action: { method: "click", target_identification: "named" },
  observed_outcome: "clicked",
  outcome_detail: null,
  transition_kind: "solid",
});

test("the recovered observation becomes the last event's after, so the chain stays unbroken", () => {
  const events = [event()];
  assert.equal(reanchorLastEvent(events, evidence("cc", 3)), "screenshots/state-0002.png");
  assert.equal(events[0].after.observation_hash, "cc");
  assert.equal(events[0].current_url, "https://www.example.com/");
  assert.equal(events[0].visible_state_summary, "summary cc");
  assert.equal(events[0].screenshot_path, "screenshots/state-0003.png");
  assert.equal(events[0].transition_kind, "solid");
  assert.equal(events[0].observed_outcome, "clicked");
});

test("a recovery that lands back on the before-screen is recorded as no visible effect", () => {
  const events = [event()];
  reanchorLastEvent(events, evidence("a", 3));
  assert.equal(events[0].transition_kind, "none");
  assert.equal(events[0].observed_outcome, "no-visible-effect");
  assert.equal(events[0].outcome_detail, "The action ran but the visible state did not change.");
});

test("a drift before any action has nothing to re-anchor and is left alone", () => {
  assert.equal(reanchorLastEvent([], evidence("cc", 3)), null);
});
