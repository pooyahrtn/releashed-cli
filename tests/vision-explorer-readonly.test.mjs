import assert from "node:assert/strict";
import test from "node:test";
import { classifyRequest } from "../scripts/vision-explorer-spike.mjs";

// The actual safety property Task 1 asks for: with read-only mode on, a non-GET/HEAD request to
// the target's own origin is refused BY DEFAULT -- not because it matched a money-ish path, but
// because it isn't a read at all. This is the one runnable check proving that.
test("read-only mode refuses a non-GET/HEAD request to the target's own origin, with no denylist match needed", () => {
  const ownOrigins = new Set(["https://www.booking.com"]);
  const result = classifyRequest(
    { method: "POST", url: "https://www.booking.com/api/some/harmless-looking/endpoint" },
    { readOnly: true, ownOrigins },
  );
  assert.equal(result.verdict, "refuse");
  assert.match(result.reason, /read-only target/);
});

test("read-only mode still allows GET and HEAD to the target's own origin", () => {
  const ownOrigins = new Set(["https://www.booking.com"]);
  for (const method of ["GET", "HEAD", "get", "head"]) {
    const result = classifyRequest(
      { method, url: "https://www.booking.com/searchresults.html" },
      { readOnly: true, ownOrigins },
    );
    assert.equal(result.verdict, "allow", `${method} should be allowed`);
  }
});

test("read-only mode does not touch a third-party origin (falls back to the ordinary denylist)", () => {
  const ownOrigins = new Set(["https://www.booking.com"]);
  const result = classifyRequest(
    { method: "POST", url: "https://analytics.example.com/collect" },
    { readOnly: true, ownOrigins },
  );
  // Not on the ONE_WAY_PATH denylist and not the target's own origin -> ordinary "allow".
  assert.equal(result.verdict, "allow");
  assert.equal(result.reason, "mutating but reversible");
});

test("read-only mode still refuses a target-origin request already on the ONE_WAY_PATH denylist", () => {
  const ownOrigins = new Set(["https://www.booking.com"]);
  const result = classifyRequest(
    { method: "POST", url: "https://www.booking.com/checkout/confirm" },
    { readOnly: true, ownOrigins },
  );
  assert.equal(result.verdict, "refuse");
});

// Default OFF is unchanged: a caller that passes no options (every existing caller, and any
// target-config that never sets readOnly) sees byte-identical behavior to before this change --
// a mutating request is allowed unless it matches the ONE_WAY_PATH denylist.
test("without readOnly, an ordinary mutating request to any origin is unaffected (old behavior)", () => {
  const result = classifyRequest({
    method: "POST",
    url: "https://www.booking.com/api/some/harmless-looking/endpoint",
  });
  assert.equal(result.verdict, "allow");
  assert.equal(result.reason, "mutating but reversible");
});

test("a read-only run redacts third-party contact details out of retained evidence", async () => {
  const { redactContactDetails } = await import("../scripts/vision-explorer-run.mjs");
  // The shape of value that made a complete OpenStreetMap candidate unpackageable: a real
  // business's contact details, read off a map place panel.
  const seen = "e12 [link] info@example-wellness-clinic.test\ne13 [link] 555-123-4567\ne14 [text] +31 6 12345678";
  const redacted = redactContactDetails(seen);
  assert.equal(redacted.includes("example-wellness-clinic"), false);
  assert.equal(redacted.includes("555-123-4567"), false);
  assert.equal(redacted.includes("+31 6 12345678"), false);
  assert.match(redacted, /<email>/);
  assert.match(redacted, /<phone>/);
  // The line structure the renderer parses survives, so a redacted screen still titles itself.
  assert.equal(redacted.split("\n").length, 3);
  assert.match(redacted, /^e12 \[link\] /);
  // Ordinary product text is untouched.
  assert.equal(redactContactDetails("e1 [button] Get directions"), "e1 [button] Get directions");
});

test("a read-only run masks long digit runs, the shape the packager reads as a card number", async () => {
  const { redactContactDetails } = await import("../scripts/vision-explorer-run.mjs");
  // The real OpenStreetMap link that refused a candidate: a Mapillary photo key that satisfies Luhn.
  assert.equal(
    redactContactDetails("focus=photo&pKey=1490658108241563&x=0.51"),
    "focus=photo&pKey=<number>&x=0.51",
  );
  // A genuine card number is masked by the same rule -- on somebody else's page we retain neither.
  assert.equal(redactContactDetails("4111 1111 1111 1111"), "<number>");
  // Short numbers -- a year, a page number, a price, a zoom level -- are left alone.
  assert.equal(redactContactDetails("z=17 in 2026, 12 results, EUR 1499"), "z=17 in 2026, 12 results, EUR 1499");
});
