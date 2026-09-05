import assert from "node:assert/strict";
import test from "node:test";
import { classifyRequest } from "../scripts/vision-explorer-spike.mjs";

// The bug this closes: the run stalled once because a click was allowed to navigate the page
// clean off the bound origin(s), and only THEN did the pre-dispatch guard (checkActionAuthorized)
// start refusing every action -- stranding the run somewhere it could act, nor leave. The fix
// moves the check earlier: a top-level (Document) navigation off the bound origin(s) is refused
// before it ever loads, so the page never leaves in the first place.
test("a Document navigation off the bound origin(s) is refused before it loads", () => {
  // app.cal.com is the bound target; a genuine third party (a payment processor here) is what
  // used to be allowed to load -- stranding the run -- and must now be refused before it does.
  const ownOrigins = new Set(["https://app.cal.com"]);
  const result = classifyRequest(
    { method: "GET", url: "https://checkout.stripe.com/pay/cs_test_abc", resourceType: "Document" },
    { ownOrigins },
  );
  assert.equal(result.verdict, "refuse");
  assert.match(result.reason, /would leave the bound origin/);
});

test("a Document navigation to any bound origin (including an additionalOrigins host) is unaffected", () => {
  const ownOrigins = new Set(["https://app.cal.com", "https://cal.com"]);
  for (const url of ["https://app.cal.com/event-types/123", "https://cal.com/some-user/30min"]) {
    const result = classifyRequest({ method: "GET", url, resourceType: "Document" }, { ownOrigins });
    assert.equal(result.verdict, "allow", url);
  }
});

// A non-navigation request (script, image, XHR) to an off-origin host is untouched by this guard --
// it still falls through to the ordinary mutating/denylist handling below, exactly as before.
test("a non-Document request off the bound origin(s) is not touched by the navigation guard", () => {
  const ownOrigins = new Set(["https://app.cal.com"]);
  const result = classifyRequest(
    { method: "GET", url: "https://cal.com/tracking-pixel.gif", resourceType: "Image" },
    { ownOrigins },
  );
  assert.equal(result.verdict, "allow");
});

// No ownOrigins (the original bare-spike caller, and any test that omits options) sees
// byte-identical behavior: the navigation guard never fires without a bound-origin set to check.
test("without ownOrigins, a Document navigation anywhere is unaffected (old behavior)", () => {
  const result = classifyRequest({
    method: "GET",
    url: "https://anywhere.example/page",
    resourceType: "Document",
  });
  assert.equal(result.verdict, "allow");
});
