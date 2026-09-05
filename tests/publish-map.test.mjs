import { test } from "node:test";
import assert from "node:assert/strict";
import { findRelativeAssets, injectNoindex, hashCandidate } from "../lib/publish-map.mjs";

test("injectNoindex adds the meta tag right after charset", () => {
  const html = '<html><head><meta charset="utf-8"><title>x</title></head></html>';
  const { html: out, injected } = injectNoindex(html);
  assert.equal(injected, true);
  assert.match(out, /<meta charset="utf-8"><meta name="robots" content="noindex, nofollow, noarchive">/);
});

test("injectNoindex is a no-op when a robots meta already exists", () => {
  const html = '<head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>x</title></head>';
  const { html: out, injected } = injectNoindex(html);
  assert.equal(injected, false);
  assert.equal(out, html);
});

test("findRelativeAssets picks relative src/href and ignores data:, http(s), and #", () => {
  const html = `
    <img src="screenshots/state-0001.png">
    <img src="data:image/png;base64,AAAA">
    <a href="https://example.com/x.png">
    <a href="#section">
    <img src="../evidence/shot.png">
  `;
  assert.deepEqual(findRelativeAssets(html), ["../evidence/shot.png", "screenshots/state-0001.png"]);
});

test("hashCandidate is deterministic and changes when content changes", () => {
  const a = hashCandidate(Buffer.from("<html>a</html>"));
  const b = hashCandidate(Buffer.from("<html>a</html>"));
  const c = hashCandidate(Buffer.from("<html>b</html>"));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("hashCandidate folds in asset bytes and paths", () => {
  const html = Buffer.from("<html></html>");
  const withAsset = hashCandidate(html, [{ relPath: "s.png", buffer: Buffer.from("img") }]);
  const withoutAsset = hashCandidate(html);
  const differentAssetPath = hashCandidate(html, [{ relPath: "other.png", buffer: Buffer.from("img") }]);
  assert.notEqual(withAsset, withoutAsset);
  assert.notEqual(withAsset, differentAssetPath);
});
