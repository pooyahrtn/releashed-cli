import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  EXPLORER_MODEL_CONFIG_NAME,
  preflightExplorerModelConfig,
  prepareExplorerModelRuntime
} from "../lib/explorer-model-runtime.mjs";
import { ModelBroker } from "../supervisor/model-broker.mjs";
import { ExplorerModelBrokerProcess, explorerModelBrokerEnvironment } from "../supervisor/model-broker-process.mjs";

const RUN_ID = "explorer-model-fixture";
const PRICING = {
  currency: "USD",
  input_per_million_tokens: 2,
  cached_input_per_million_tokens: 0.2,
  output_per_million_tokens: 12,
  cache_write_reservation_multiplier_on_uncached_input: 1.25,
  accounting_rate: { usd: 1, eur: 1, reason: "Conservative experiment accounting so conversion cannot understate the EUR cap." },
  source_url: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
  retrieved_date: "2026-09-03",
  price_version: "retrieved-2026-09-03"
};

function digest(body) {
  return createHash("sha256").update(body).digest("hex");
}

async function privateJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function ledgerRows(actuals = [0.005, 0.01], refusals = 1) {
  return [
    ...actuals.flatMap((actual_eur, index) => [
      { phase: "reservation", reserved_eur: 0.1, sequence: index },
      { phase: "reconciliation", actual_eur, reservation_within_bound: true, credential_exposed: false, sequence: index }
    ]),
    ...Array.from({ length: refusals }, () => ({ outcome: "refused-before-provider-dispatch", provider_cost_eur: 0 }))
  ];
}

async function writeLedger(path, rows) {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "explorer-model-runtime-"));
  const repository = join(root, "flow-map-lab");
  const ownerDirectory = join(root, "flow-map-lab-private", "spike-a");
  const runDirectory = join(repository, "runs", RUN_ID);
  const runtimeDirectory = join(repository, ".runtime", RUN_ID);
  await Promise.all([mkdir(runDirectory, { recursive: true }), mkdir(runtimeDirectory, { recursive: true }), mkdir(ownerDirectory, { recursive: true })]);
  const authority = {
    status: "pass",
    limits: { model_cost_cap_eur: 18, combined_actual_plus_reserved_cap_eur: 20 },
    model_broker_approval: {
      status: "approved-not-called",
      provider: "OpenAI",
      api: "Responses API",
      model: "gpt-5.6-terra",
      pricing: PRICING
    }
  };
  const authorityBody = `${JSON.stringify(authority, null, 2)}\n`;
  const authorityPath = join(ownerDirectory, "authority-and-start.json");
  await writeFile(authorityPath, authorityBody, { mode: 0o600 });
  await privateJson(join(runDirectory, "input-manifest.json"), {
    run_id: RUN_ID,
    owner_inputs_sealed_before_broker_start: true,
    owner_input_hashes: { "authority-and-start.json": digest(authorityBody) }
  });
  const capPath = join(runtimeDirectory, "cap-state.json");
  const cap = {
    run_id: RUN_ID,
    working_day_deadline: new Date(Date.now() + 60_000).toISOString(),
    abort: null,
    caps: { model_cost_cap_eur: 18, combined_actual_plus_reserved_cap_eur: 20 },
    model: { calls: 2, refused_before_dispatch: 1, actual_eur: 0.015, outstanding_reservations_eur: 0 },
    app: { actual_eur: 0, outstanding_reservations_eur: 0, one_way_actions: 0, class_counts: {} }
  };
  await privateJson(capPath, cap);
  const ledgerPath = join(runDirectory, "model-ledger.jsonl");
  await writeLedger(ledgerPath, ledgerRows());
  await privateJson(join(runtimeDirectory, "model-config.json"), {
    run_id: RUN_ID,
    run_directory: runDirectory,
    cap_state_path: capPath,
    model: "gpt-5.6-terra",
    minimum_output_tokens: 16,
    approved_model_identity_policy: { approved_alias: "gpt-5.6-terra", approved_snapshots: [] },
    pricing: PRICING,
    allowed_content_classifications: [
      "generic-synthetic-non-target",
      "public-pack-text",
      "Synthetic visible app content from the disposable account after secret and personal-data checks."
    ]
  });
  return {
    root,
    repository,
    ownerDirectory,
    runDirectory,
    runtimeDirectory,
    capPath,
    ledgerPath,
    outputPath: join(runtimeDirectory, EXPLORER_MODEL_CONFIG_NAME)
  };
}

async function prepare(setup) {
  return prepareExplorerModelRuntime({ repository: setup.repository, ownerDirectory: setup.ownerDirectory, runId: RUN_ID });
}

function request(overrides = {}) {
  return {
    method: "request",
    content: "Return one bounded explorer decision.",
    content_classification: "source-blind-explorer-decision",
    maximum_input_tokens: 24_000,
    maximum_output_tokens: 512,
    ...overrides
  };
}

test("prepares one mode-0600 explorer-only model config with the full 24-call reservation", async () => {
  const setup = await fixture();
  try {
    const result = await prepare(setup);
    assert.deepEqual(result, {
      run_id: RUN_ID,
      config_path: `.runtime/${RUN_ID}/${EXPLORER_MODEL_CONFIG_NAME}`,
      maximum_calls: 24,
      worst_case_reserved_eur: 1.587456
    });
    assert.equal((await stat(setup.outputPath)).mode & 0o777, 0o600);
    const config = JSON.parse(await readFile(setup.outputPath, "utf8"));
    assert.deepEqual(config.allowed_content_classifications, ["source-blind-explorer-decision"]);
    assert.equal(config.minimum_output_tokens, 512);
    assert.equal(config.fixed_request_policy.maximum_input_tokens, 24_000);
    assert.equal(config.fixed_request_policy.maximum_output_tokens, 512);
    assert.equal(config.fixed_request_policy.maximum_calls, 24);
    assert.equal(config.fixed_request_policy.initial_model_calls, 2);
    assert.equal(config.fixed_request_policy.per_call_reserved_eur, 0.066144);
    assert.equal(config.retained_model_config_binding.path, join(setup.runtimeDirectory, "model-config.json"));
    assert.match(config.retained_model_config_binding.sha256, /^[0-9a-f]{64}$/);
    assert.equal(config.owner_authority_binding.path, join(setup.ownerDirectory, "authority-and-start.json"));
    assert.match(config.owner_authority_binding.sha256, /^[0-9a-f]{64}$/);
    await preflightExplorerModelConfig(config);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("fails before output on underfunding, retained drift, authority drift, and an existing output", async (t) => {
  await t.test("underfunded", async () => {
    const setup = await fixture();
    try {
      const cap = JSON.parse(await readFile(setup.capPath, "utf8"));
      Object.assign(cap.model, { calls: 1, refused_before_dispatch: 0, actual_eur: 17 });
      await privateJson(setup.capPath, cap);
      await writeLedger(setup.ledgerPath, ledgerRows([17], 0));
      await assert.rejects(() => prepare(setup), /does not fit the remaining model cap/);
      await assert.rejects(() => stat(setup.outputPath), { code: "ENOENT" });
    } finally { await rm(setup.root, { recursive: true, force: true }); }
  });
  await t.test("retained pricing drift", async () => {
    const setup = await fixture();
    try {
      const path = join(setup.runtimeDirectory, "model-config.json");
      const retained = JSON.parse(await readFile(path, "utf8"));
      retained.pricing.output_per_million_tokens = 11;
      await privateJson(path, retained);
      await assert.rejects(() => prepare(setup), /pricing does not match/);
      await assert.rejects(() => stat(setup.outputPath), { code: "ENOENT" });
    } finally { await rm(setup.root, { recursive: true, force: true }); }
  });
  await t.test("retained identity-policy widening", async () => {
    const setup = await fixture();
    try {
      const path = join(setup.runtimeDirectory, "model-config.json");
      const retained = JSON.parse(await readFile(path, "utf8"));
      retained.approved_model_identity_policy.approved_snapshots = ["unfrozen-snapshot"];
      await privateJson(path, retained);
      await assert.rejects(() => prepare(setup), /identity policy has drifted/);
      await assert.rejects(() => stat(setup.outputPath), { code: "ENOENT" });
    } finally { await rm(setup.root, { recursive: true, force: true }); }
  });
  await t.test("sealed authority drift", async () => {
    const setup = await fixture();
    try {
      const authorityPath = join(setup.ownerDirectory, "authority-and-start.json");
      const authority = JSON.parse(await readFile(authorityPath, "utf8"));
      authority.status = "changed";
      await privateJson(authorityPath, authority);
      await assert.rejects(() => prepare(setup), /not bound/);
      await assert.rejects(() => stat(setup.outputPath), { code: "ENOENT" });
    } finally { await rm(setup.root, { recursive: true, force: true }); }
  });
  await t.test("existing output", async () => {
    const setup = await fixture();
    try {
      await writeFile(setup.outputPath, "occupied\n", { mode: 0o600 });
      await assert.rejects(() => prepare(setup), /already exists/);
      assert.equal(await readFile(setup.outputPath, "utf8"), "occupied\n");
    } finally { await rm(setup.root, { recursive: true, force: true }); }
  });
});

test("prepared runtime detects cap or ledger drift before broker readiness", async () => {
  const setup = await fixture();
  try {
    await prepare(setup);
    const config = JSON.parse(await readFile(setup.outputPath, "utf8"));
    const cap = JSON.parse(await readFile(setup.capPath, "utf8"));
    cap.model.actual_eur += 0.001;
    await privateJson(setup.capPath, cap);
    await assert.rejects(() => preflightExplorerModelConfig(config), /changed after preparation/);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("broker startup binds exact authority, retained identity policy, and complete pricing", async (t) => {
  for (const [name, mutate] of [
    ["model alias", (config) => { config.model = "substitute-model"; config.approved_model_identity_policy.approved_alias = "substitute-model"; }],
    ["identity snapshots", (config) => { config.approved_model_identity_policy.approved_snapshots = ["unapproved-snapshot"]; }],
    ["cached price", (config) => { config.pricing.cached_input_per_million_tokens = -0.2; }],
    ["pricing provenance", (config) => { config.pricing.source_url = "https://example.test/substituted-pricing"; }]
  ]) {
    await t.test(name, async () => {
      const setup = await fixture();
      let child;
      try {
        await prepare(setup);
        const config = JSON.parse(await readFile(setup.outputPath, "utf8"));
        mutate(config);
        await privateJson(setup.outputPath, config);
        let rejected = false;
        try {
          child = new ExplorerModelBrokerProcess(setup.outputPath, Date.now() + 1_000, { environmentSource: { OPENAI_API_KEY: "must-not-dispatch" } });
          await child.ready;
        } catch {
          rejected = true;
        }
        assert.equal(rejected, true);
      } finally {
        if (child) await child.stop();
        await rm(setup.root, { recursive: true, force: true });
      }
    });
  }
});

test("broker startup rejects byte drift in its retained policy trust anchors", async () => {
  const setup = await fixture();
  try {
    await prepare(setup);
    const retainedPath = join(setup.runtimeDirectory, "model-config.json");
    const retained = JSON.parse(await readFile(retainedPath, "utf8"));
    await writeFile(retainedPath, `${JSON.stringify(retained)}\n`, { mode: 0o600 });
    const config = JSON.parse(await readFile(setup.outputPath, "utf8"));
    await assert.rejects(() => preflightExplorerModelConfig(config), /retained policy changed/);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("every request rechecks frozen caps and the broker's exact model counters before dispatch", async (t) => {
  for (const [name, mutate] of [
    ["lowered actual cost", (cap) => { cap.model.actual_eur = 0.014; }],
    ["lowered call baseline", (cap) => { cap.model.calls = 1; }],
    ["substituted run", (cap) => { cap.run_id = "another-run"; }],
    ["widened model cap", (cap) => { cap.caps.model_cost_cap_eur = 19; }],
    ["negative refusal counter", (cap) => { cap.model.refused_before_dispatch = -1; }],
    ["negative app cost", (cap) => { cap.app.actual_eur = -1; }]
  ]) {
    await t.test(name, async () => {
      const setup = await fixture();
      try {
        await prepare(setup);
        const config = JSON.parse(await readFile(setup.outputPath, "utf8"));
        let providerDispatches = 0;
        const broker = new ModelBroker(config, {
          apiKey: "stub-key",
          providerFetch: async () => {
            providerDispatches += 1;
            throw new Error("provider must not be reached");
          }
        });
        await broker.preflight();
        const cap = JSON.parse(await readFile(setup.capPath, "utf8"));
        mutate(cap);
        await privateJson(setup.capPath, cap);
        await assert.rejects(() => broker.request(request()), /counter invariants/);
        assert.equal(providerDispatches, 0);
      } finally {
        await rm(setup.root, { recursive: true, force: true });
      }
    });
  }
});

test("model requests preserve the deadline and never accept app-budget rollback", async (t) => {
  for (const [name, beforeReadiness, afterReadiness] of [
    ["outstanding reservation", (cap) => { cap.app.outstanding_reservations_eur = 1; }, (cap) => { cap.app.outstanding_reservations_eur = 0; }],
    ["actual app cost", (cap) => { cap.app.actual_eur = 1; }, (cap) => { cap.app.actual_eur = 0.5; }],
    ["one-way action count", (cap) => { cap.app.one_way_actions = 2; cap.app.class_counts = { lesson: 2 }; }, (cap) => { cap.app.one_way_actions = 1; }],
    ["per-class action count", (cap) => { cap.app.one_way_actions = 2; cap.app.class_counts = { lesson: 2 }; }, (cap) => { cap.app.class_counts.lesson = 1; }],
    ["working-day deadline", () => {}, (cap) => { cap.working_day_deadline = new Date(Date.parse(cap.working_day_deadline) + 60_000).toISOString(); }]
  ]) {
    await t.test(name, async () => {
      const setup = await fixture();
      try {
        const initial = JSON.parse(await readFile(setup.capPath, "utf8"));
        beforeReadiness(initial);
        await privateJson(setup.capPath, initial);
        await prepare(setup);
        const config = JSON.parse(await readFile(setup.outputPath, "utf8"));
        let providerDispatches = 0;
        const broker = new ModelBroker(config, {
          apiKey: "stub-key",
          providerFetch: async () => {
            providerDispatches += 1;
            throw new Error("provider must not be reached");
          }
        });
        await broker.preflight();
        const changed = JSON.parse(await readFile(setup.capPath, "utf8"));
        afterReadiness(changed);
        await privateJson(setup.capPath, changed);
        await assert.rejects(() => broker.request(request()), /counter invariants/);
        assert.equal(providerDispatches, 0);
      } finally {
        await rm(setup.root, { recursive: true, force: true });
      }
    });
  }
});

test("once the broker observes an abort, clearing it cannot revive provider dispatch", async () => {
  const setup = await fixture();
  try {
    await prepare(setup);
    const config = JSON.parse(await readFile(setup.outputPath, "utf8"));
    let providerDispatches = 0;
    const broker = new ModelBroker(config, {
      apiKey: "stub-key",
      providerFetch: async () => {
        providerDispatches += 1;
        throw new Error("provider must not be reached");
      }
    });
    await broker.preflight();
    const aborted = JSON.parse(await readFile(setup.capPath, "utf8"));
    aborted.abort = { code: "browser_abort", timestamp: new Date().toISOString(), detail: "fixture" };
    await privateJson(setup.capPath, aborted);
    const refused = await broker.request(request());
    assert.equal(refused.refusal.code, "run_aborted");
    const cleared = JSON.parse(await readFile(setup.capPath, "utf8"));
    cleared.abort = null;
    await privateJson(setup.capPath, cleared);
    await assert.rejects(() => broker.request(request()), /counter invariants/);
    assert.equal(providerDispatches, 0);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("legitimate app-budget increases between explorer decisions remain usable", async () => {
  const setup = await fixture();
  try {
    await prepare(setup);
    const config = JSON.parse(await readFile(setup.outputPath, "utf8"));
    let providerDispatches = 0;
    const broker = new ModelBroker(config, {
      apiKey: "stub-key",
      providerFetch: async () => {
        providerDispatches += 1;
        return {
          ok: true,
          json: async () => ({
            id: "response-after-app-progress",
            model: "gpt-5.6-terra",
            output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
            usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 }
          })
        };
      }
    });
    await broker.preflight();
    const progressed = JSON.parse(await readFile(setup.capPath, "utf8"));
    progressed.app.actual_eur = 1;
    progressed.app.one_way_actions = 1;
    progressed.app.class_counts = { lesson: 1 };
    await privateJson(setup.capPath, progressed);
    assert.equal((await broker.request(request())).ok, true);
    assert.equal(providerDispatches, 1);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("model child receives only provider credential plus minimum system environment", async () => {
  const setup = await fixture();
  let child;
  try {
    await prepare(setup);
    const broker = join(setup.root, "env-broker.mjs");
    await writeFile(broker, `process.stdout.write(JSON.stringify({ready:true,environment_keys:Object.keys(process.env).sort(),provider_key:process.env.OPENAI_API_KEY})+'\\n');process.stdin.on('data',chunk=>{const request=JSON.parse(String(chunk));process.stdout.write(JSON.stringify({rpc_id:request.rpc_id,response:{ok:true,output:'{}'}})+'\\n')});setInterval(()=>{},1000);\n`);
    const source = { OPENAI_API_KEY: "provider-key", CLERK_SECRET_KEY: "must-not-cross", CHROMIUM_EXECUTABLE: "/private/browser", HOME: "/private/home" };
    assert.deepEqual(Object.keys(explorerModelBrokerEnvironment(source)).sort(), ["LANG", "OPENAI_API_KEY", "PATH"]);
    child = new ExplorerModelBrokerProcess(setup.outputPath, Date.now() + 2_000, { brokerFile: broker, environmentSource: source, callTimeoutMs: 500 });
    const ready = await child.ready;
    assert.deepEqual(ready.environment_keys.filter((key) => key !== "__CF_USER_TEXT_ENCODING"), ["LANG", "OPENAI_API_KEY", "PATH"]);
    assert.equal(ready.environment_keys.every((key) => ["LANG", "OPENAI_API_KEY", "PATH", "__CF_USER_TEXT_ENCODING"].includes(key)), true);
    assert.equal(ready.provider_key, "provider-key");
    assert.equal((await child.call(request())).ok, true);
  } finally {
    if (child) await child.stop();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("model wrapper rejects escaped requests and cleans up malformed or silent children", async (t) => {
  await t.test("escaped request", async () => {
    const setup = await fixture();
    try {
      await prepare(setup);
      const broker = join(setup.root, "valid-broker.mjs");
      await writeFile(broker, `process.stdout.write('{"ready":true}\\n');setInterval(()=>{},1000);\n`);
      const child = new ExplorerModelBrokerProcess(setup.outputPath, Date.now() + 2_000, { brokerFile: broker, callTimeoutMs: 100 });
      await child.ready;
      for (const escaped of [
        { content_classification: "public-pack-text" },
        { maximum_input_tokens: 23_999 },
        { maximum_output_tokens: 511 },
        { content: "x".repeat(23_985) },
        { content: "é".repeat(11_993) }
      ]) {
        await assert.rejects(() => child.call(request(escaped)), /fixed decision contract/);
      }
      await child.stop();
    } finally { await rm(setup.root, { recursive: true, force: true }); }
  });
  for (const [name, body, error] of [
    ["malformed", `process.stdout.write('{"ready":true}\\n');process.stdin.once('data',()=>process.stdout.write('not-json\\n'));setInterval(()=>{},1000);\n`, /malformed JSONL/],
    ["silent", `process.stdout.write('{"ready":true}\\n');setInterval(()=>{},1000);\n`, /deadline/]
  ]) {
    await t.test(name, async () => {
      const setup = await fixture();
      try {
        await prepare(setup);
        const broker = join(setup.root, `${name}-broker.mjs`);
        await writeFile(broker, body);
        const child = new ExplorerModelBrokerProcess(setup.outputPath, Date.now() + 2_000, { brokerFile: broker, callTimeoutMs: 50 });
        await child.ready;
        const pid = child.child.pid;
        await assert.rejects(() => child.call(request()), error);
        await child.stop();
        assert.throws(() => process.kill(pid, 0), (caught) => caught?.code === "ESRCH");
      } finally { await rm(setup.root, { recursive: true, force: true }); }
    });
  }
});

test("production broker refuses a 25th explorer decision before provider dispatch", async () => {
  const setup = await fixture();
  try {
    await prepare(setup);
    const config = JSON.parse(await readFile(setup.outputPath, "utf8"));
    let providerDispatches = 0;
    const broker = new ModelBroker(config, {
      apiKey: "stub-key",
      providerFetch: async () => {
        providerDispatches += 1;
        return {
          ok: true,
          json: async () => ({
            id: `response-${providerDispatches}`,
            model: "gpt-5.6-terra",
            output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
            usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 }
          })
        };
      }
    });
    await broker.preflight();
    for (let index = 0; index < 24; index += 1) assert.equal((await broker.request(request())).ok, true);
    const response = await broker.request(request());
    assert.equal(response.ok, false);
    assert.equal(response.refusal.code, "fixed_request_call_limit");
    assert.equal(providerDispatches, 24);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("production model broker fails closed on oversized JSONL ingress", async () => {
  const setup = await fixture();
  let child;
  try {
    await prepare(setup);
    child = new ExplorerModelBrokerProcess(setup.outputPath, Date.now() + 2_000, {
      environmentSource: { OPENAI_API_KEY: "stub-never-dispatched" },
      callTimeoutMs: 500
    });
    await child.ready;
    child.child.stdin.on("error", () => {});
    const exited = new Promise((resolveExit) => child.child.once("exit", (code, signal) => resolveExit({ code, signal })));
    child.child.stdin.write(`${" ".repeat(1_000_001)}{}\n`);
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("oversized model ingress did not terminate")), 1_000))
    ]);
    assert.notEqual(result.code, 0);
  } finally {
    if (child) await child.stop();
    await rm(setup.root, { recursive: true, force: true });
  }
});
