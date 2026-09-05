import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authorPublicPack } from "../lib/public-pack-author.mjs";
import { createExclusivePackOutput } from "../lib/public-pack-runtime.mjs";

test("brokered author writes a compact claim-citable public pack", async () => {
  const root = await mkdtemp(join(tmpdir(), "spike-a-author-"));
  const mount = join(root, "mount"); const output = join(root, "output"); const source = "Public document\n";
  await mkdir(mount); await writeFile(join(mount, "source-001.txt"), source);
  await writeFile(join(mount, "public-input-manifest.json"), JSON.stringify({ sources: [{ source_id: "source-001", initial_url: "https://inburgering.coach/", final_url: "https://inburgering.coach/", retrieved_at: "2026-09-03T14:00:00.000Z", status: 200, content_type: "text/html", redirect_chain: ["https://inburgering.coach/"], raw_sha256: "a".repeat(64), raw_bytes: 15, derived_text_sha256: createHash("sha256").update(source).digest("hex"), derived_text_bytes: Buffer.byteLength(source), derived_path: "source-001.txt" }] }));
  await createExclusivePackOutput({ outputDirectory: output, runtimeManifest: { runtime_identity: "test" } });
  const result = await authorPublicPack({ mountDirectory: mount, outputDirectory: output, limits: { maximum_input_tokens: 32_000, maximum_output_tokens: 2_000 }, requestModel: async () => ({ ok: true, output: JSON.stringify({ product_summary: "A public brief.", claims: [{ id: "public-promise", kind: "promise", text: "A public promise.", source_ids: ["source-001"] }] }), usage: { input_tokens: 20, output_tokens: 10 }, actual_eur: 0.001, model_identity: { approved: true } }) });
  assert.equal(result.pack.claims[0].source_ids[0], "source-001");
  assert.equal(result.pack.sources[0].derived_path, undefined);
  await assert.rejects(() => authorPublicPack({ mountDirectory: mount, outputDirectory: output, limits: { maximum_input_tokens: 1, maximum_output_tokens: 1 }, requestModel: async () => ({ ok: true, output: "{}", usage: {}, actual_eur: 0, model_identity: { approved: true } }) }));
});
