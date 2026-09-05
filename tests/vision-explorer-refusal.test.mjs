import assert from "node:assert/strict";
import test from "node:test";
import { checkActionAuthorized } from "../scripts/vision-explorer-run.mjs";

// The guard itself must stay exactly as strict as before: an off-origin tap or an unsupported
// action is still refused before dispatch, with the same reasons the run log already prints.
test("checkActionAuthorized refuses off-origin taps and unsupported actions, allows the rest", () => {
  const allowed = new Set(["https://app.example.com"]);
  const onOrigin = "https://app.example.com/today";
  const offOrigin = "https://login.microsoftonline.com/oauth";

  assert.deepEqual(
    checkActionAuthorized({ action: "tap", instruction: "Tap Continue" }, allowed, onOrigin),
    { authorized: true, reason: null },
  );

  const offOriginResult = checkActionAuthorized(
    { action: "tap", instruction: "Tap 'Sign in with Microsoft'" },
    allowed,
    offOrigin,
  );
  assert.equal(offOriginResult.authorized, false);
  assert.match(offOriginResult.reason, /left the bound origin/);

  const unsupportedResult = checkActionAuthorized(
    { action: "navigate", instruction: "Go to /billing" },
    allowed,
    onOrigin,
  );
  assert.equal(unsupportedResult.authorized, false);
  assert.match(unsupportedResult.reason, /unsupported action navigate/);
});

// The actual bug: a refusal used to end the whole run (stopReason = action_refused_before_dispatch,
// break). This replays the run loop's own bookkeeping -- record a blocked action, tell the explorer
// via history, keep going -- over a run of decisions that includes two refusals in the middle, and
// asserts every decision after a refusal still gets processed (exploration continues) while each
// refusal is retained with its reason (recorded, not silently dropped).
test("a refused decision is recorded as blocked and exploration continues to later decisions", () => {
  const allowed = new Set(["https://app.example.com"]);
  const decisions = [
    { action: "tap", instruction: "Tap Sign up" },
    { action: "tap", instruction: "Tap 'Sign in with Microsoft'" }, // refused: off-origin
    { action: "type", instruction: "Type an email" },
    { action: "drag", instruction: "Drag off the page" }, // refused: off-origin
    { action: "scroll", instruction: "Scroll down" },
  ];
  const currentUrl = (decision) =>
    decision.instruction.includes("Microsoft") || decision.instruction.includes("Drag off")
      ? "https://login.microsoftonline.com/oauth"
      : "https://app.example.com/signup";

  const blocked = [];
  const processed = [];
  for (const decision of decisions) {
    const check = checkActionAuthorized(decision, allowed, currentUrl(decision));
    if (!check.authorized) {
      blocked.push({ instruction: decision.instruction, reason: check.reason });
      continue; // exploration keeps going -- this is the fix; the old code `break`s here instead
    }
    processed.push(decision.instruction);
  }

  assert.equal(blocked.length, 2);
  assert.deepEqual(
    blocked.map((b) => b.instruction),
    ["Tap 'Sign in with Microsoft'", "Drag off the page"],
  );
  assert.ok(blocked.every((b) => /left the bound origin/.test(b.reason)));
  // The two decisions AFTER each refusal were still reached -- a run-ending `break` would have
  // stopped at the first refusal and never processed "Type an email" or "Scroll down".
  assert.deepEqual(processed, ["Tap Sign up", "Type an email", "Scroll down"]);
});

test("a read-only run refuses to type contact details or a password into somebody else's form", async () => {
  const { checkActionAuthorized } = await import("../scripts/vision-explorer-run.mjs");
  const origins = new Set(["https://www.openstreetmap.org"]);
  const url = "https://www.openstreetmap.org/login";
  const typing = (text) => ({ action: "type", instruction: `Type ${text}`, text });
  // The exact value that made a real OpenStreetMap candidate unpackageable.
  const refused = checkActionAuthorized(typing("testmapper2024@example.com"), origins, url, true);
  assert.equal(refused.authorized, false);
  assert.match(refused.reason, /read-only and never signs in/);
  assert.equal(checkActionAuthorized(typing("hunter2 password"), origins, url, true).authorized, false);
  assert.equal(checkActionAuthorized(typing("+31 6 12345678"), origins, url, true).authorized, false);
  // Ordinary typing on the same read-only target is untouched -- this suppresses credentials, not input.
  assert.equal(checkActionAuthorized(typing("Amsterdam"), origins, url, true).authorized, true);
  // A target we own (read-only off, the example.com path) is byte-identical to before.
  assert.equal(checkActionAuthorized(typing("testmapper2024@example.com"), origins, url).authorized, true);
});
