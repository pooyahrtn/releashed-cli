import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repository = resolve(new URL("..", import.meta.url).pathname);

test("broker refuses the 7.2M/16 over-budget probe before provider dispatch", async () => {
  let bodies = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      bodies.push(JSON.parse(body));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "stub", model: "gpt-5.6-terra", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 32, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } }));
    });
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const root = await mkdtemp(join(tmpdir(), "spike-a-model-stub-"));
  const cap = join(root, "cap.json");
  const run = join(root, "run");
  await writeFile(cap, JSON.stringify({ abort: null, working_day_deadline: new Date(Date.now() + 60_000).toISOString(), model: { actual_eur: 0, outstanding_reservations_eur: 0, refused_before_dispatch: 0, calls: 0 }, app: { actual_eur: 0, outstanding_reservations_eur: 0 }, caps: { model_cost_cap_eur: 18, combined_actual_plus_reserved_cap_eur: 20 } }));
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ run_directory: run, cap_state_path: cap, model: "gpt-5.6-terra", minimum_output_tokens: 16, provider_url: `http://127.0.0.1:${server.address().port}/responses`, approved_model_identity_policy: { approved_alias: "gpt-5.6-terra", approved_snapshots: [] }, pricing: { input_per_million_tokens: 2, cached_input_per_million_tokens: 0.2, output_per_million_tokens: 12, cache_write_reservation_multiplier_on_uncached_input: 1.25, accounting_rate: { usd: 1, eur: 1 }, source_url: "fixture", retrieved_date: "today", price_version: "fixture" }, allowed_content_classifications: ["generic"] }));
  const child = spawn(process.execPath, [join(repository, "supervisor", "model-broker.mjs"), "--config", config], { env: { PATH: process.env.PATH, OPENAI_API_KEY: "stub-key" }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let complete;
  const completeResponse = new Promise((resolvePromise, reject) => {
    complete = resolvePromise;
    setTimeout(() => reject(new Error("stub broker did not answer both requests")), 2_000);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    lines.push(...chunk.trim().split("\n").filter(Boolean).map(JSON.parse));
    if (lines.some((line) => line.rpc_id === 1) && lines.some((line) => line.rpc_id === 2)) complete();
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  child.stdin.write(`${JSON.stringify({ rpc_id: 1, payload: { method: "request", content: "Reply with exactly OK.", content_classification: "generic", maximum_input_tokens: 7_200_000, maximum_output_tokens: 16 } })}\n`);
  child.stdin.write(`${JSON.stringify({ rpc_id: 2, payload: { method: "request", content: "Reply with exactly OK.", content_classification: "generic", maximum_input_tokens: 64, maximum_output_tokens: 16 } })}\n`);
  await completeResponse;
  child.kill();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  const first = lines.find((line) => line.rpc_id === 1)?.response;
  const second = lines.find((line) => line.rpc_id === 2)?.response;
  assert.equal(first.refusal.code, "model_cost_cap");
  assert.equal(second.ok, true);
  assert.deepEqual(bodies.map((body) => body.max_output_tokens), [16]);
});
