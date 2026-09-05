import assert from "node:assert/strict";
import test from "node:test";
import { classifyRequest, maskOpaqueIds } from "../scripts/vision-explorer-spike.mjs";

// The network action boundary is the one piece of the vision-explorer spike that must survive a
// change of executor, so it is the one piece with a check: it decides from method + URL alone and
// never looks at what the clicked control was.
test("the action boundary refuses a mutating one-way request and allows the rest", () => {
  assert.equal(
    classifyRequest({ method: "GET", url: "http://localhost:8423/api/billing/checkout" }).verdict,
    "allow",
  );
  assert.equal(
    classifyRequest({ method: "POST", url: "http://localhost:8423/api/onboarding/answer" }).verdict,
    "allow",
  );
  assert.equal(
    classifyRequest({ method: "POST", url: "http://localhost:8423/api/billing/checkout" }).verdict,
    "refuse",
  );
  assert.equal(
    classifyRequest({ method: "delete", url: "http://localhost:8423/api/account/delete" }).verdict,
    "refuse",
  );
  assert.equal(classifyRequest({ method: "POST", url: "not a url" }).verdict, "refuse");
});

test("the retained boundary log masks opaque object ids in request paths", () => {
  assert.equal(
    maskOpaqueIds("/v1/client/sessions/sess_EXAMPLEsessionIDnotarealone/tokens"),
    "/v1/client/sessions/<id>/tokens",
  );
  assert.equal(maskOpaqueIds("/api/onboarding/answer"), "/api/onboarding/answer");
});

test("onBoundOrigin answers false for a page Chrome's own error page committed, not throw", async () => {
  const { onBoundOrigin, checkActionAuthorized } = await import("../scripts/vision-explorer-run.mjs");
  const origins = new Set(["https://www.openstreetmap.org"]);
  assert.equal(onBoundOrigin("https://www.openstreetmap.org/about", origins), true);
  // What a refused off-site top-level navigation actually leaves the tab on. Answering this
  // honestly is what lets the run walk itself back instead of refusing every later instruction.
  assert.equal(onBoundOrigin("chrome-error://chromewebdata/", origins), false);
  assert.equal(onBoundOrigin("about:blank", origins), false);
  assert.equal(onBoundOrigin("not a url at all", origins), false);
  assert.equal(onBoundOrigin("https://supporting.openstreetmap.org/donate/", origins), false);
  // The pre-dispatch guard reads the same answer, so the two can never disagree.
  assert.equal(
    checkActionAuthorized({ action: "tap", instruction: "click x" }, origins, "chrome-error://chromewebdata/").authorized,
    false,
  );
});

test("maskOpaqueIds masks a long numeric path segment, which the card check reads as a card number", () => {
  // The three real ad-host paths that made a w3schools candidate unpackageable: 13-digit ids that
  // happen to satisfy Luhn. The boundary log says which KIND of request was seen, never which one.
  assert.equal(maskOpaqueIds("/1960765662469/js"), "/<id>/js");
  assert.equal(maskOpaqueIds("/9289732628110/js"), "/<id>/js");
  assert.equal(maskOpaqueIds("/pagead/1752042980354"), "/pagead/<id>");
  // Embedded in a filename, not only as a whole segment -- the shape that refused an OSM candidate.
  assert.equal(maskOpaqueIds("/uploads/Logopit_1788281408665.jpg"), "/uploads/Logopit_<id>.jpg");
  // Ordinary paths, and short numbers that name a version or a page, are untouched.
  assert.equal(maskOpaqueIds("/api/onboarding/answer"), "/api/onboarding/answer");
  assert.equal(maskOpaqueIds("/v1/items/42"), "/v1/items/42");
});
