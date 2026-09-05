import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchFrozenPublicSources, validateFrozenPublicFetchPolicy } from "../lib/public-pack-fetch.mjs";

function policy(origin) {
  return { schema_version: 1, record_kind: "spike-a-frozen-public-pack-fetch-policy", policy_id: "fixture-v1", initial_urls: [`${origin}/start`], permitted_final_urls: [`${origin}/ready`, `${origin}/www-ready`], maximum_redirects: 3, timeout_ms: 20_000, maximum_raw_bytes_per_source: 524_288, allowed_content_types: ["text/html", "text/plain"], maximum_derived_text_bytes_total: 28_672, content_classification: "public-only", note: "localhost fixture only" };
}

test("frozen retrieval preserves raw provenance and gives the author bounded derived text", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/start") { response.writeHead(302, { location: "/ready" }); response.end(); return; }
    if (request.url === "/ready") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end("<h1>Public <em>claim</em></h1><script>secret()</script>"); return; }
    response.writeHead(404); response.end();
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), "spike-a-public-fetch-"));
  const result = await fetchFrozenPublicSources({ policy: policy(origin), outputDirectory: join(directory, "receipt"), allowInsecureFixture: true });
  const manifest = JSON.parse(await readFile(join(directory, "receipt", "author-input", "public-input-manifest.json"), "utf8"));
  assert.equal(result.sources[0].redirect_chain.length, 2);
  assert.equal(manifest.sources[0].raw_bytes > 0, true);
  assert.match(await readFile(join(directory, "receipt", "author-input", "source-001.txt"), "utf8"), /Public claim/);
  assert.doesNotMatch(await readFile(join(directory, "receipt", "author-input", "source-001.txt"), "utf8"), /secret/);
  await new Promise((resolvePromise) => server.close(resolvePromise));
});

test("off-policy redirect fails closed and leaves no published partial receipt", async () => {
  const server = createServer((request, response) => { response.writeHead(302, { location: "http://localhost.invalid/no" }); response.end(); });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), "spike-a-public-fetch-"));
  const output = join(directory, "receipt");
  await assert.rejects(() => fetchFrozenPublicSources({ policy: policy(origin), outputDirectory: output, allowInsecureFixture: true }), /frozen permitted final URL/);
  await assert.rejects(() => access(output));
  await new Promise((resolvePromise) => server.close(resolvePromise));
});

test("production policy rejects arbitrary URL and origin values", () => {
  const invalid = policy("https://example.invalid");
  assert.throws(() => validateFrozenPublicFetchPolicy(invalid), /sole approved public source/);
});
