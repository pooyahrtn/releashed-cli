import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runExplorerLoop } from "../lib/explorer-protocol.mjs";

const repository = resolve(new URL("..", import.meta.url).pathname);

function pack() {
  return {
    schema_version: 1,
    product_summary: "A public product summary.",
    claims: [{ id: "guided-practice", kind: "promise", text: "Guided practice is available.", source_ids: ["source-001"] }],
    sources: [{ source_id: "source-001", initial_url: "https://example.com/", final_url: "https://example.com/", retrieved_at: "2026-09-03T00:00:00.000Z", status: 200, content_type: "text/html", redirect_chain: ["https://example.com/"], raw_sha256: "a".repeat(64), raw_bytes: 1, derived_text_sha256: "b".repeat(64), derived_text_bytes: 1 }]
  };
}

async function runSandbox(onRpc) {
  const root = await mkdtemp(join(tmpdir(), "flow-map-explorer-"));
  const packPath = join(root, "public-pack.json");
  const bytes = Buffer.from(`${JSON.stringify(pack())}\n`);
  await writeFile(packPath, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const child = spawn(process.execPath, [join(repository, "sandbox", "explorer.mjs")], { env: { FLOW_MAP_EXPLORER_PUBLIC_PACK: packPath, FLOW_MAP_EXPLORER_PUBLIC_PACK_SHA256: digest }, stdio: ["pipe", "pipe", "pipe"] });
  const transcript = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      transcript.push(message);
      if (message.kind === "rpc") onRpc(message, child);
    }
  });
  let timeout;
  try {
    const exitCode = await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", resolvePromise);
      timeout = setTimeout(() => {
        child.kill();
        reject(new Error("explorer sandbox timed out"));
      }, 2_000);
    });
    return { exitCode, transcript, digest, root };
  } finally {
    clearTimeout(timeout);
  }
}

test("scripted brokers prove observe, decide, act, re-observe, and visited-history memory", async () => {
  const calls = [];
  const observations = [
    { ok: true, observation: { observation_id: "obs-1", url: "https://app.example.com/home", accessibility: "e1 [button] Start practice" } },
    { ok: true, observation: { observation_id: "obs-2", url: "https://app.example.com/practice", accessibility: "e1 [heading] Practice\ne2 [button] Continue" } }
  ];
  const decisions = [
    { ok: true, output: JSON.stringify({ schema_version: 1, kind: "act", reason: "Open the promised practice", action: { type: "click", ref: "e1" } }) },
    { ok: true, output: JSON.stringify({ schema_version: 1, kind: "done", reason: "The promised journey was observed" }) }
  ];
  let outstanding = 0; let peakOutstanding = 0;
  const result = await runExplorerLoop({ publicPack: pack(), rpc: async (broker, payload) => {
    outstanding += 1; peakOutstanding = Math.max(peakOutstanding, outstanding); calls.push({ broker, payload: structuredClone(payload) });
    await Promise.resolve();
    let response;
    if (broker === "model") response = decisions.shift();
    else if (payload.method === "observe") response = observations.shift();
    else response = { ok: true, outcome: { outcome_id: "outcome-1", status: "completed", summary: "Practice opened" } };
    outstanding -= 1;
    return response;
  } });
  assert.equal(result.status, "done");
  assert.equal(result.decisions, 2);
  assert.equal(peakOutstanding, 1);
  assert.deepEqual(calls.map((call) => `${call.broker}:${call.payload.method}`), ["supervisor:observe", "model:request", "supervisor:perform_action", "supervisor:observe", "model:request"]);
  assert.equal(calls[1].payload.maximum_input_tokens, 24_000);
  assert.equal(calls[1].payload.maximum_output_tokens, 512);
  assert.match(calls[4].payload.content, /Practice opened/);
  assert.match(calls[4].payload.content, /s-[0-9a-f]{12}/);
  assert.doesNotMatch(JSON.stringify(calls), /action_class|effect_class|account_record|hidden_eval/);
});

test("loop replans recoverable attempts and halts malformed, unknown, and cap outcomes", async (context) => {
  const current = { ok: true, observation: { observation_id: "obs-1", url: "https://app.example.com/home", accessibility: "e1 [button] Start" } };
  await context.test("normal scroll with unchanged state then alternate action", async () => {
    const same = { ok: true, observation: { observation_id: "obs-2", url: "https://app.example.com/home", accessibility: "e1 [button] Start" } };
    const changed = { ok: true, observation: { observation_id: "obs-3", url: "https://app.example.com/started", accessibility: "e2 [heading] Started" } };
    const queue = [current,
      { ok: true, output: JSON.stringify({ schema_version: 1, kind: "act", reason: "Look below", action: { type: "scroll", direction: "down" } }) },
      { ok: true, outcome: { outcome_id: "out-1", status: "completed", summary: "Page scrolled" } }, same,
      { ok: true, output: JSON.stringify({ schema_version: 1, kind: "act", reason: "Start instead", action: { type: "click", ref: "e1" } }) },
      { ok: true, outcome: { outcome_id: "out-2", status: "completed", summary: "Journey opened" } }, changed,
      { ok: true, output: JSON.stringify({ schema_version: 1, kind: "done", reason: "Useful state observed" }) }
    ];
    const result = await runExplorerLoop({ publicPack: pack(), rpc: async () => queue.shift() });
    assert.equal(result.stop_reason, "explicit_done");
    assert.equal(result.decisions, 3);
    assert.equal(result.run_history.action_attempts[0].result, "no-progress");
  });
  await context.test("supervisor denial then alternate action", async () => {
    const withAlternate = { ok: true, observation: { observation_id: "obs-1", url: "https://app.example.com/home", accessibility: "e1 [button] Delete account\ne2 [button] Browse lessons" } };
    const lessons = { ok: true, observation: { observation_id: "obs-2", url: "https://app.example.com/lessons", accessibility: "e1 [heading] Lessons" } };
    const queue = [withAlternate,
      { ok: true, output: JSON.stringify({ schema_version: 1, kind: "act", reason: "Try visible control", action: { type: "click", ref: "e1" } }) },
      { ok: true, outcome: { outcome_id: "out-1", status: "rejected", summary: "That action is outside this run" } },
      { ok: true, output: JSON.stringify({ schema_version: 1, kind: "act", reason: "Use another visible control", action: { type: "click", ref: "e2" } }) },
      { ok: true, outcome: { outcome_id: "out-2", status: "completed", summary: "Lessons opened" } }, lessons,
      { ok: true, output: JSON.stringify({ schema_version: 1, kind: "done", reason: "Alternate journey observed" }) }
    ];
    const result = await runExplorerLoop({ publicPack: pack(), rpc: async () => queue.shift() });
    assert.equal(result.stop_reason, "explicit_done");
    assert.equal(result.run_history.action_attempts[0].result, "rejected");
    assert.equal(result.run_history.action_attempts[1].result, "observed-change");
  });
  await context.test("malformed model output", async () => {
    const queue = [current, { ok: true, output: "not json" }];
    const result = await runExplorerLoop({ publicPack: pack(), rpc: async () => queue.shift() });
    assert.equal(result.stop_reason, "malformed_output");
  });
  await context.test("unknown outcome", async () => {
    const queue = [current, { ok: true, output: JSON.stringify({ schema_version: 1, kind: "act", reason: "Start", action: { type: "click", ref: "e1" } }) }, { ok: true, outcome: { outcome_id: "out-1", status: "unknown", summary: "The action result could not be observed" } }];
    const result = await runExplorerLoop({ publicPack: pack(), rpc: async () => queue.shift() });
    assert.equal(result.stop_reason, "unknown_outcome");
  });
  await context.test("model cap", async () => {
    const queue = [current, { ok: false, refusal: { code: "model_cost_cap", message: "cap" } }];
    const result = await runExplorerLoop({ publicPack: pack(), rpc: async () => queue.shift() });
    assert.equal(result.stop_reason, "cap");
  });
  await context.test("duplicate proposal is recorded and the model can stop cleanly", async () => {
    const other = { ok: true, observation: { observation_id: "obs-2", url: "https://app.example.com/other", accessibility: "e2 [button] Go back" } };
    const returned = { ok: true, observation: { observation_id: "obs-3", url: "https://app.example.com/home", accessibility: "e1 [button] Start" } };
    const firstDecision = { ok: true, output: JSON.stringify({ schema_version: 1, kind: "act", reason: "Open", action: { type: "click", ref: "e1" } }) };
    const secondDecision = { ok: true, output: JSON.stringify({ schema_version: 1, kind: "act", reason: "Return", action: { type: "click", ref: "e2" } }) };
    const thirdDecision = { ok: true, output: JSON.stringify({ schema_version: 1, kind: "act", reason: "Repeat", action: { type: "click", ref: "e1" } }) };
    const completed = (id) => ({ ok: true, outcome: { outcome_id: id, status: "completed", summary: "A different page opened" } });
    const done = { ok: true, output: JSON.stringify({ schema_version: 1, kind: "done", reason: "Repeated route is exhausted" }) };
    const queue = [current, firstDecision, completed("out-1"), other, secondDecision, completed("out-2"), returned, thirdDecision, done];
    const result = await runExplorerLoop({ publicPack: pack(), rpc: async () => queue.shift() });
    assert.equal(result.stop_reason, "explicit_done");
    assert.equal(result.decisions, 4);
    assert.equal(result.run_history.action_attempts.at(-1).result, "duplicate-proposal");
  });
});

test("loop never asks for more than 24 decisions", async () => {
  let observationSequence = 0;
  let modelCalls = 0;
  const result = await runExplorerLoop({ publicPack: pack(), rpc: async (broker, payload) => {
    if (broker === "model") {
      modelCalls += 1;
      return { ok: true, output: JSON.stringify({ schema_version: 1, kind: "act", reason: "Continue exploring", action: { type: "click", ref: "e1" } }) };
    }
    if (payload.method === "perform_action") return { ok: true, outcome: { outcome_id: `out-${modelCalls}`, status: "completed", summary: "A different visible state opened" } };
    observationSequence += 1;
    return { ok: true, observation: { observation_id: `obs-${observationSequence}`, url: `https://app.example.com/state-${observationSequence}`, accessibility: `e1 [button] Continue ${observationSequence}` } };
  } });
  assert.equal(result.stop_reason, "decision_limit");
  assert.equal(result.decisions, 24);
  assert.equal(modelCalls, 24);
});

test("sandbox speaks the same strict sequential JSONL protocol", async () => {
  const result = await runSandbox((message, child) => {
    const response = message.broker === "supervisor" && message.payload.method === "observe"
      ? { ok: true, observation: { observation_id: "obs-1", url: "https://app.example.com/home", accessibility: "e1 [button] Start" } }
      : { ok: true, output: JSON.stringify({ schema_version: 1, kind: "done", reason: "Enough evidence" }) };
    child.stdin.write(`${JSON.stringify({ rpc_id: message.rpc_id, response })}\n`);
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.transcript.map((message) => message.kind), ["rpc", "rpc", "explorer_complete"]);
  assert.equal(result.transcript.at(-1).result.stop_reason, "explicit_done");
  assert.equal(result.transcript.at(-1).public_pack_sha256, result.digest);
  assert.doesNotMatch(JSON.stringify(result.transcript), new RegExp(result.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("sandbox fails pending RPC immediately on EOF or a mismatched reply without live access", async (context) => {
  await context.test("stdin EOF", async () => {
    let handled = false;
    const result = await runSandbox((_message, child) => {
      if (handled) return;
      handled = true;
      child.stdin.end();
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.transcript.at(-1).kind, "explorer_complete");
    assert.equal(result.transcript.at(-1).result.stop_reason, "broker_abort");
  });
  await context.test("wrong RPC ID", async () => {
    let handled = false;
    const result = await runSandbox((_message, child) => {
      if (handled) return;
      handled = true;
      child.stdin.write(`${JSON.stringify({ rpc_id: "explorer-9999", response: { ok: true } })}\n`);
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.transcript.at(-1).kind, "explorer_complete");
    assert.equal(result.transcript.at(-1).result.stop_reason, "broker_abort");
  });
});
