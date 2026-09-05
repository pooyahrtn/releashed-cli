import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authorSandboxEnvironment, createExclusivePackOutput, finalizeExclusivePackOutput, preflightPublicPackAuthorRuntime, RUNTIME_SCHEMA, validateForwardedAuthorRpc, validatePublicPack, validatePublicPackAuthorCompletion } from "../lib/public-pack-runtime.mjs";
import { validateConsumedPublicSource } from "../sandbox/public-input-integrity.mjs";

function owner(origin = "https://inburgering.coach/") {
  const finals = origin === "https://inburgering.coach/" ? ["https://inburgering.coach/", "https://www.inburgering.coach/"] : [`${origin}ready`, `${origin}www-ready`];
  return { authority: { status: "pass", limits: { model_cost_cap_eur: 18, combined_actual_plus_reserved_cap_eur: 20 }, model_broker_approval: { public_pack_author: { content_classification: "public-only", broker: "spike-a-openai-model-broker-v1", provider: "OpenAI", api: "Responses API", model: "gpt-5.6-terra", maximum_calls: 1, maximum_input_tokens: 32_000, maximum_output_tokens: 2_000, worst_case_reserved_eur: 0.104, reservation_breakdown_eur: { input: 0.08, output: 0.024 }, status: "approved-not-called" } } }, origin: { status: "pass", public_pack_fetch_policy: { schema_version: 1, record_kind: "spike-a-frozen-public-pack-fetch-policy", policy_id: "policy-v1", initial_urls: [origin], permitted_final_urls: finals, maximum_redirects: 3, timeout_ms: 20_000, maximum_raw_bytes_per_source: 524_288, allowed_content_types: ["text/html", "text/plain"], maximum_derived_text_bytes_total: 28_672, content_classification: "public-only", note: "test policy" } } };
}

async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "spike-a-pack-runtime-")); const inputs = join(repository, "public-inputs"); const packs = join(repository, "packs"); const runtime = join(repository, "runtime");
  await Promise.all([mkdir(inputs), mkdir(packs), mkdir(runtime)]);
  const policies = owner(); const authorityPath = join(runtime, "authority.json"); const originPath = join(runtime, "origin.json");
  await Promise.all([writeFile(authorityPath, JSON.stringify(policies.authority)), writeFile(originPath, JSON.stringify(policies.origin))]);
  const source = "public source\n"; const sourceRecord = { source_id: "source-001", initial_url: "https://inburgering.coach/", final_url: "https://inburgering.coach/", retrieved_at: "2026-09-03T14:00:00.000Z", status: 200, content_type: "text/html", redirect_chain: ["https://inburgering.coach/"], raw_sha256: "a".repeat(64), raw_bytes: 1, derived_text_sha256: createHash("sha256").update(source).digest("hex"), derived_text_bytes: Buffer.byteLength(source), derived_path: "source-001.txt" };
  await Promise.all([writeFile(join(inputs, "source-001.txt"), source), writeFile(join(inputs, "public-input-manifest.json"), JSON.stringify({ schema_version: 1, content_classification: "public-only", policy_id: "policy-v1", policy_sha256: createHash("sha256").update(JSON.stringify(policies.origin.public_pack_fetch_policy)).digest("hex"), sources: [sourceRecord] }))]);
  const cap = join(runtime, "cap-state.json"); await writeFile(cap, JSON.stringify({ run_id: "run-1", abort: null, model: { actual_eur: 0, outstanding_reservations_eur: 0 }, app: { actual_eur: 0, outstanding_reservations_eur: 0 }, caps: { model_cost_cap_eur: 18, combined_actual_plus_reserved_cap_eur: 20 } }));
  const config = join(runtime, "author.json"); await writeFile(config, JSON.stringify({ schema_version: 1, runtime_identity: RUNTIME_SCHEMA, mode: "one-shot-public-pack-author", run_id: "run-1", cap_state_path: cap, owner_authority_path: authorityPath, owner_origin_allowlist_path: originPath, model_broker_identity: "spike-a-openai-model-broker-v1", public_input_mount: inputs, output_directory: join(packs, "pack-1"), pack_id: "pack-1" }));
  return { repository, config, output: join(packs, "pack-1") };
}

test("runtime binds public input and policy hash without retaining private paths", async () => {
  const value = await fixture(); const runtime = await preflightPublicPackAuthorRuntime({ repository: value.repository, configPath: value.config });
  assert.equal(runtime.public_source_policy.policy_id, "policy-v1"); assert.doesNotMatch(JSON.stringify(runtime), /cap-state|authority\.json|origin\.json/);
  await createExclusivePackOutput({ outputDirectory: value.output, runtimeManifest: runtime });
  await writeFile(join(value.output, "public-pack.json"), JSON.stringify({ schema_version: 1, product_summary: "Summary", claims: [{ id: "claim", kind: "promise", text: "Claim", source_ids: ["source-001"] }], sources: [{ source_id: "source-001", initial_url: "https://inburgering.coach/", final_url: "https://inburgering.coach/", retrieved_at: "2026-09-03T14:00:00.000Z", status: 200, content_type: "text/html", redirect_chain: ["https://inburgering.coach/"], raw_sha256: "a".repeat(64), raw_bytes: 1, derived_text_sha256: "b".repeat(64), derived_text_bytes: 1 }] }));
  const final = await finalizeExclusivePackOutput({ outputDirectory: value.output }); assert.match(final.manifest_sha256, /^[0-9a-f]{64}$/); assert.equal(JSON.parse(await readFile(final.manifest_path, "utf8")).files.length, 2);
});

test("public-pack validation rejects unresolved citations and private artifacts", () => {
  assert.throws(() => validatePublicPack({ schema_version: 1, product_summary: "x", claims: [{ id: "x", kind: "promise", text: "x", source_ids: ["missing"] }], sources: [] }), /invalid|citable/);
});

test("author sandbox has a clean bounded environment", () => {
  assert.deepEqual(Object.keys(authorSandboxEnvironment({ configPath: "/config", inputPath: "/inputs", outputDirectory: "/output" })).sort(), ["LANG", "SPIKE_A_AUTHOR_CONFIG", "SPIKE_A_AUTHOR_INPUT", "SPIKE_A_AUTHOR_OUTPUT"]);
});

test("forwarded author RPC is allowed exactly once and refuses repeats and mismatches", () => {
  const allocation = { maximum_input_tokens: 32_000, maximum_output_tokens: 2_000 };
  const expectedPublicInputManifestSha256 = "a".repeat(64);
  const goodMessage = { kind: "rpc", broker: "model", rpc_id: "public-pack-author-1", public_input_manifest_sha256: expectedPublicInputManifestSha256, payload: { method: "request", content_classification: "public-pack-text", maximum_input_tokens: 32_000, maximum_output_tokens: 2_000 } };
  const validate = (message, alreadyForwarded = false) => validateForwardedAuthorRpc({ message, allocation, alreadyForwarded, expectedPublicInputManifestSha256 });
  assert.equal(validate(goodMessage).ok, true);
  assert.equal(validate(goodMessage, true).ok, false);
  assert.equal(validate({ ...goodMessage, rpc_id: "" }).ok, false);
  assert.equal(validate({ ...goodMessage, rpc_id: "public-pack-author-2" }).ok, false);
  assert.equal(validate({ ...goodMessage, public_input_manifest_sha256: "b".repeat(64) }).ok, false);
  assert.equal(validate({ ...goodMessage, payload: { ...goodMessage.payload, method: "other" } }).ok, false);
  assert.equal(validate({ ...goodMessage, payload: { ...goodMessage.payload, content_classification: "generic-synthetic-non-target" } }).ok, false);
  assert.equal(validate({ ...goodMessage, payload: { ...goodMessage.payload, maximum_input_tokens: 1 } }).ok, false);
  assert.equal(validate({ ...goodMessage, payload: { ...goodMessage.payload, maximum_output_tokens: 1 } }).ok, false);
  assert.equal(validate({ ...goodMessage, broker: "browser" }).ok, false);
});

test("author completion refuses a public input manifest hash changed after preflight", () => {
  const expectedPublicInputManifestSha256 = "a".repeat(64);
  const message = { kind: "public_pack_author_complete", clean_environment: true, canary_blocked: true, public_input_manifest_sha256: "b".repeat(64) };
  assert.deepEqual(validatePublicPackAuthorCompletion({ message, expectedPublicInputManifestSha256 }), { ok: false, reason: "Public-pack author completion is not bound to the frozen public input" });
});

test("author refuses consumed source bytes whose hash or size differs from the manifest", () => {
  const sourceBytes = Buffer.from("public source\n");
  const source = { derived_text_sha256: createHash("sha256").update(sourceBytes).digest("hex"), derived_text_bytes: sourceBytes.byteLength };
  assert.equal(validateConsumedPublicSource({ sourceBytes, source }).ok, true);
  assert.equal(validateConsumedPublicSource({ sourceBytes, source: { ...source, derived_text_sha256: "b".repeat(64) } }).ok, false);
  assert.equal(validateConsumedPublicSource({ sourceBytes, source: { ...source, derived_text_bytes: sourceBytes.byteLength + 1 } }).ok, false);
});
