import assert from "node:assert/strict";
import test from "node:test";
import { classifyRequest } from "../scripts/vision-explorer-spike.mjs";

// Owner mode (--mine): the second dogfood failure. Every same-origin mutating request was refused
// on principle, so submitting an answer and seeing the feedback screen was impossible even though
// the run owns the product. Owner mode allows that -- except money and DELETE, which stay refused
// exactly like a stranger run.
test("owner mode allows a same-origin POST that read-only mode would refuse", () => {
  const ownOrigins = new Set(["https://app.example.com"]);
  const result = classifyRequest(
    { method: "POST", url: "https://app.example.com/api/onboarding/answer" },
    { readOnly: true, ownOrigins, mine: true },
  );
  assert.equal(result.verdict, "allow");
});

test("owner mode still refuses a same-origin POST to a billing-shaped path", () => {
  const ownOrigins = new Set(["https://app.example.com"]);
  const result = classifyRequest(
    { method: "POST", url: "https://app.example.com/api/billing/checkout" },
    { readOnly: true, ownOrigins, mine: true },
  );
  assert.equal(result.verdict, "refuse");
  assert.match(result.reason, /money-shaped path/);
});

test("owner mode still refuses a same-origin DELETE", () => {
  const ownOrigins = new Set(["https://app.example.com"]);
  const result = classifyRequest(
    { method: "DELETE", url: "https://app.example.com/api/account/settings" },
    { readOnly: true, ownOrigins, mine: true },
  );
  assert.equal(result.verdict, "refuse");
  assert.match(result.reason, /DELETE/);
});

test("stranger mode (mine unset) refuses both the ordinary POST and the billing POST", () => {
  const ownOrigins = new Set(["https://app.example.com"]);
  assert.equal(
    classifyRequest(
      { method: "POST", url: "https://app.example.com/api/onboarding/answer" },
      { readOnly: true, ownOrigins },
    ).verdict,
    "refuse",
  );
  assert.equal(
    classifyRequest(
      { method: "POST", url: "https://app.example.com/api/billing/checkout" },
      { readOnly: true, ownOrigins },
    ).verdict,
    "refuse",
  );
});

test("owner mode leaves a third-party mutating request refused, unchanged", () => {
  const ownOrigins = new Set(["https://app.example.com"]);
  const result = classifyRequest(
    { method: "POST", url: "https://analytics.example.com/collect-and-checkout" },
    { readOnly: true, ownOrigins, mine: true },
  );
  // Not the product's own origin, so owner mode's allowance never applies; it falls through to the
  // ordinary denylist, which refuses this one because the path matches ONE_WAY_PATH ("checkout").
  assert.equal(result.verdict, "refuse");
});

test("owner mode leaves an ordinary third-party mutating request allowed, unchanged", () => {
  const ownOrigins = new Set(["https://app.example.com"]);
  const result = classifyRequest(
    { method: "POST", url: "https://analytics.example.com/collect" },
    { readOnly: true, ownOrigins, mine: true },
  );
  assert.equal(result.verdict, "allow");
});

test("without mine, byte-identical to before this change (default off)", () => {
  const ownOrigins = new Set(["https://app.example.com"]);
  const result = classifyRequest(
    { method: "POST", url: "https://app.example.com/api/onboarding/answer" },
    { readOnly: true, ownOrigins },
  );
  assert.equal(result.verdict, "refuse");
  assert.match(result.reason, /read-only target/);
});
