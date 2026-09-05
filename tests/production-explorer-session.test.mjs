import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { appendFile, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { OWNER_BUNDLE_RETIREMENT_RECEIPT } from "../lib/completed-owner-bundle-retirement.mjs";
import { createImmutableOwnerBundle } from "../lib/owner-bundle.mjs";
import { filesBelow } from "../lib/scaffold.mjs";
import { prepareExplorerModelRuntime } from "../lib/explorer-model-runtime.mjs";
import { runProductionExplorerCli } from "../scripts/run-production-explorer.mjs";
import { prepareTargetRun } from "../scripts/prepare-target-run.mjs";
import {
  productionExplorerTimeoutMs,
  runProductionExplorerSession,
  runProductionExplorerSessionForTest
} from "../supervisor/explorer-session.mjs";
import { BrokerProcess } from "../supervisor/browser-broker-process.mjs";
import { announceBrowserBrokerReadiness, BrowserBroker } from "../supervisor/browser-broker.mjs";
import { privateJson, RUN_ID, targetRuntimeFixture } from "./target-runtime-fixture.mjs";

const PRICING = {
  currency: "USD",
  input_per_million_tokens: 2,
  cached_input_per_million_tokens: 0.2,
  output_per_million_tokens: 12,
  cache_write_reservation_multiplier_on_uncached_input: 1.25,
  accounting_rate: { usd: 1, eur: 1, reason: "Conservative test accounting." },
  source_url: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
  retrieved_date: "2026-09-03",
  price_version: "retrieved-2026-09-03"
};

const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const FRESH_USERNAME = `flowmap_${"a".repeat(32)}`;

async function productionFixture({ bounded = false } = {}) {
  const fixture = await targetRuntimeFixture("https://app.example.test");
  const authorityPath = `${fixture.ownerDirectory}/authority-and-start.json`;
  const authority = JSON.parse(await readFile(authorityPath, "utf8"));
  authority.model_broker_approval = {
    status: "approved-not-called",
    provider: "OpenAI",
    api: "Responses API",
    model: "gpt-5.6-terra",
    pricing: PRICING
  };
  await privateJson(authorityPath, authority);
  const inputManifestPath = `${fixture.runDirectory}/input-manifest.json`;
  const inputManifest = JSON.parse(await readFile(inputManifestPath, "utf8"));
  inputManifest.owner_inputs_sealed_before_broker_start = true;
  if (bounded) {
    const ledgerPath = `${fixture.ownerDirectory}/action-and-app-cost-ledger.json`;
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.allowed_one_way_classes.push({
      id: "bounded-onboarding",
      action_matrix_row: "Bounded own-account onboarding progress",
      maximum_count: 20,
      worst_case_eur_per_action: 0,
      maximum_reserved_eur: 0,
      allowed_effects: "bound-route progress only",
      reservation_rule: "reserve zero and settle zero per bound-route action"
    });
    await privateJson(ledgerPath, ledger);
    await privateJson(`${fixture.ownerDirectory}/gate-a-evaluation.json`, { status: "pass" });
    const baseOwnerDirectory = await realpath(fixture.ownerDirectory);
    const bundleParent = await realpath(dirname(fixture.ownerDirectory));
    await createImmutableOwnerBundle({
      baseOwnerDirectory,
      bundleParent,
      runId: RUN_ID,
      secretKey: "sk_live_owner_bundle_fixture",
      dependencies: {
        provisionIdentity: async ({ onRecoveryMaterial }) => {
          await onRecoveryMaterial({
            state: "creation-pending",
            external_id: `flowmap_cal_${"a".repeat(32)}`,
            user_id: null
          });
          await onRecoveryMaterial({
            state: "identity-bound",
            external_id: `flowmap_cal_${"a".repeat(32)}`,
            user_id: "user_fixture"
          });
          return { userId: "user_fixture", cleanup: async () => ({ cleanup_complete: true }) };
        }
      }
    });
    fixture.ownerDirectory = join(bundleParent, RUN_ID);
  }
  for (const name of Object.keys(inputManifest.owner_input_hashes)) {
    inputManifest.owner_input_hashes[name] = sha256(await readFile(`${fixture.ownerDirectory}/${name}`));
  }
  await privateJson(inputManifestPath, inputManifest);
  await privateJson(`${fixture.runtimeDirectory}/model-config.json`, {
    run_id: RUN_ID,
    run_directory: fixture.runDirectory,
    cap_state_path: fixture.capPath,
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
  await prepareTargetRun({
    repository: fixture.repository,
    ownerDirectory: fixture.ownerDirectory,
    runId: RUN_ID,
    ...(bounded
      ? { mode: "source-blind-bounded-onboarding-v1" }
      : { registryPath: fixture.registryPath })
  });
  if (bounded) {
    const targetConfig = JSON.parse(await readFile(fixture.configPath, "utf8"));
    targetConfig.clerk_auth.approved_disposable_identity = {
      provider_user_id: "user_fixture",
      username: FRESH_USERNAME
    };
    await privateJson(fixture.configPath, targetConfig);
  }
  await prepareExplorerModelRuntime({
    repository: fixture.repository,
    ownerDirectory: fixture.ownerDirectory,
    runId: RUN_ID
  });
  fixture.targetConfig = JSON.parse(await readFile(fixture.configPath, "utf8"));
  return fixture;
}

async function withTestRunner(work) {
  const before = process.env.SPIKE_A_TEST_ONLY_PRODUCTION_RUNNER;
  process.env.SPIKE_A_TEST_ONLY_PRODUCTION_RUNNER = "1";
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.SPIKE_A_TEST_ONLY_PRODUCTION_RUNNER;
    else process.env.SPIKE_A_TEST_ONLY_PRODUCTION_RUNNER = before;
  }
}

function browserStub(order, { stopFails = false, privateAuthHandoff = false, initialNavigationRefusal = false } = {}) {
  return {
    ready: Promise.resolve().then(() => order.push("browser-ready")),
    async call(payload) {
      order.push(`browser-${payload.method}`);
      if (payload.method === "navigate") {
        if (initialNavigationRefusal) return { ok: false, refusal: { code: "run_aborted" }, failure_point: "load_wait" };
        return privateAuthHandoff ? { ok: true, private_auth_handoff: true } : { ok: true };
      }
      if (payload.method === "observe") {
        return {
          ok: true,
          event: {
            event_id: "observation-1",
            transition_kind: "solid",
            after: {
              url: "https://app.example.test/",
              observation_hash: "a".repeat(64),
              visible_state_summary: "e1 [button] Continue"
            }
          }
        };
      }
      throw new Error("unexpected browser call");
    },
    async stop() {
      order.push("browser-stop");
      if (stopFails) throw new Error("simulated stop failure");
    }
  };
}

function modelStub(fixture, order, { delayMs = 30 } = {}) {
  return {
    ready: Promise.resolve().then(() => order.push("model-ready")),
    async call(payload) {
      order.push(`model-${payload.method}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
      const cap = JSON.parse(await readFile(fixture.capPath, "utf8"));
      cap.model.calls += 1;
      cap.model.actual_eur += 0.001;
      await appendFile(fixture.targetConfig.model_ledger.path, `${JSON.stringify({ phase: "reservation", reserved_eur: 0.066144 })}\n${JSON.stringify({ phase: "reconciliation", actual_eur: 0.001, reservation_within_bound: true, credential_exposed: false })}\n`);
      await privateJson(fixture.capPath, cap);
      return { ok: true, output: JSON.stringify({ schema_version: 1, kind: "done", reason: "The useful reachable surface is exhausted" }) };
    },
    async stop() {
      order.push("model-stop");
    }
  };
}

function successfulAuth(order, cleanupResult = { cleanup_complete: true, session_reconciled: true, run_session_revoked: true, unused_sign_in_token_revoked: false }) {
  let cleanups = 0;
  return {
    authenticate: async ({ expectedFrontendOrigin }) => {
      assert.equal(expectedFrontendOrigin, "https://clerk.example.test");
      order.push("auth-landing-confirmed");
      return {
        authenticated: true,
        cleanup: async () => {
          cleanups += 1;
          order.push("clerk-cleanup");
          return cleanupResult;
        }
      };
    },
    cleanups: () => cleanups
  };
}

function rejectedAuthBrowser(order, outcome) {
  return {
    ready: Promise.resolve(),
    async call(payload) {
      order.push(`browser-${payload.method}`);
      if (payload.method === "navigate") return { ok: true };
      if (payload.method === "authenticate_clerk_ticket") {
        if (outcome === "timeout") throw new Error("simulated timeout");
        return {
          ok: false,
          refusal: {
            code: outcome === "landing" ? "clerk_auth_landing_unconfirmed" : "clerk_auth_state_invalid",
            message: outcome === "landing" ? "private auth landing detail" : undefined
          }
        };
      }
      throw new Error("unexpected browser call");
    },
    async stop() {
      order.push("browser-stop");
    }
  };
}

function clerkFailureFetch(order, outcome, orderLog = null) {
  let inventories = 0;
  return async (url) => {
    const href = String(url);
    if (href === "https://api.clerk.com/v1/domains") {
      return Response.json({ data: [{ frontend_api_url: "https://clerk.example.test" }], total_count: 1 });
    }
    if (href.startsWith("https://api.clerk.com/v1/sessions?")) {
      inventories += 1;
      const event = inventories === 1 ? "clerk-inventory-before" : "clerk-inventory-after";
      order.push(event);
      if (orderLog) await appendFile(orderLog, `${event}\n`);
      if (["timeout", "landing"].includes(outcome)) {
        return Response.json(inventories === 1
          ? [{ id: "sess_preexisting" }]
          : [{ id: "sess_preexisting" }, { id: "sess_run_new" }]);
      }
      return Response.json([]);
    }
    if (href.endsWith("/v1/sign_in_tokens")) {
      order.push("clerk-mint");
      if (orderLog) await appendFile(orderLog, "clerk-mint\n");
      return Response.json({ id: "sit_run_new", token: "ticket_private" });
    }
    if (href.endsWith("/v1/sessions/sess_run_new/revoke")) {
      order.push("clerk-session-revoke");
      if (orderLog) await appendFile(orderLog, "clerk-session-revoke\n");
    }
    if (href.endsWith("/v1/sign_in_tokens/sit_run_new/revoke")) {
      order.push("clerk-token-revoke");
      if (orderLog) await appendFile(orderLog, "clerk-token-revoke\n");
    }
    return Response.json({});
  };
}

function freshPreflightFetch(order, { frontendOrigin = "https://clerk.example.test", userId = "user_fixture", username = FRESH_USERNAME, sessions = [] } = {}) {
  return async (url, init) => {
    const href = String(url);
    assert.equal(init?.method, "GET");
    if (href === "https://api.clerk.com/v1/domains") {
      order.push("preflight-instance");
      return Response.json({ data: [{ frontend_api_url: frontendOrigin }], total_count: 1 });
    }
    if (href === "https://api.clerk.com/v1/users/user_fixture") {
      order.push("preflight-identity");
      return Response.json({ id: userId, username });
    }
    if (href.startsWith("https://api.clerk.com/v1/sessions?")) {
      order.push("preflight-inventory");
      return Response.json({ data: sessions, total_count: sessions.length });
    }
    assert.fail(`read-only preflight dispatched an unexpected request: ${href}`);
  };
}

for (const [label, provider] of [
  ["wrong Clerk instance", { frontendOrigin: "https://wrong-clerk.example.test" }],
  ["wrong sealed user id", { userId: "user_other" }],
  ["wrong sealed username", { username: "flowmap_wrong" }],
  ["an existing session", { sessions: [{ id: "sess_existing" }] }]
]) {
  test(`fresh production preflight rejects ${label}, retires the bound identity, and reports safely`, async () => {
    const fixture = await productionFixture({ bounded: true });
    const failedOrder = [];
    const environment = { CLERK_SECRET_KEY: "sk_test_private_preflight" };
    let browserCreations = 0;
    let modelCreations = 0;
    let authenticationCalls = 0;
    try {
      const report = await withTestRunner(() => runProductionExplorerSessionForTest({
        runId: RUN_ID,
        repositoryRoot: fixture.repository,
        environment,
        clerkFetch: freshPreflightFetch(failedOrder, provider),
        runtimeDependencies: {
          createBrowser: () => { browserCreations += 1; },
          createModel: () => { modelCreations += 1; },
          bootstrapClerkAuthentication: async () => { authenticationCalls += 1; },
          retireCompletedOwnerBundle: async ({ bundleDirectory, runId, environment: retirementEnvironment }) => {
            failedOrder.push("identity-retire");
            assert.equal(bundleDirectory, fixture.ownerDirectory);
            assert.equal(runId, RUN_ID);
            assert.deepEqual(retirementEnvironment, { CLERK_SECRET_KEY: "sk_test_private_preflight" });
            return { status: "retired" };
          }
        }
      }));

      assert.equal(browserCreations, 0);
      assert.equal(modelCreations, 0);
      assert.equal(authenticationCalls, 0);
      assert.equal(environment.CLERK_SECRET_KEY, undefined);
      assert.equal(report.failure_stage, "pre-authentication");
      assert.equal(report.failure_code, "clerk_auth_preflight_failed");
      assert.equal(report.auth_cleanup_complete, false);
      assert.equal(report.identity_retirement_confirmed, true);
      assert.equal(report.cleanup_complete, false);
      assert.equal(report.candidate_eligible, false);
      assert.ok(report.non_publishable_reasons.includes("clerk-cleanup-incomplete"));
      assert.equal(failedOrder.at(-1), "identity-retire");
      assert.doesNotMatch(JSON.stringify(report), /wrong-clerk|flowmap_wrong|sess_existing|user_fixture|user_other|sk_test_private_preflight/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { name: "pre-authentication", failureStage: "pre-authentication" },
  { name: "browser-start", failureStage: "browser-start" },
  { name: "model-start", failureStage: "model-start" },
  { name: "initial-navigation", failureStage: "initial-navigation" },
  { name: "authentication", failureStage: "authentication" },
  { name: "exploration", failureStage: "exploration" },
  { name: "success", failureStage: null, eligible: true },
  { name: "retirement-failure", failureStage: null, retirementFails: true },
  { name: "unconfirmed-browser-stop", failureStage: null, browserStopFails: true }
]) {
  test(`completed owner retirement follows broker and auth cleanup at ${scenario.name}`, async () => {
    const fixture = await productionFixture({ bounded: true });
    const order = [];
    const environment = {
      HOME: "/safe-home",
      OPENAI_API_KEY: "model-fixture-key",
      CLERK_SECRET_KEY: "clerk-fixture-secret"
    };
    const auth = successfulAuth(order);
    try {
      const report = await withTestRunner(() => runProductionExplorerSessionForTest({
        runId: RUN_ID,
        repositoryRoot: fixture.repository,
        environment,
        runtimeDependencies: {
          preflightFreshClerkAuthentication: async () => {
            order.push("pre-authentication");
            if (scenario.name === "pre-authentication") throw new Error("private preflight detail");
          },
          createBrowser: (_configPath, _deadline, options) => {
            order.push("browser-create");
            assert.equal(Object.keys(options.environment).some((key) => /CLERK/i.test(key)), false);
            if (scenario.name === "browser-start") {
              return {
                ready: Promise.reject(new Error("private browser startup detail")),
                async stop() { order.push("browser-stop"); }
              };
            }
            return browserStub(order, {
              initialNavigationRefusal: scenario.name === "initial-navigation",
              stopFails: scenario.browserStopFails === true
            });
          },
          createModel: (_configPath, _deadline, options) => {
            order.push("model-create");
            assert.equal(Object.keys(options.environmentSource).some((key) => /CLERK/i.test(key)), false);
            return {
              ready: scenario.name === "model-start"
                ? Promise.reject(new Error("private model startup detail"))
                : Promise.resolve().then(() => order.push("model-ready")),
              async stop() { order.push("model-stop"); }
            };
          },
          bootstrapClerkAuthentication: scenario.name === "authentication"
            ? async () => {
                order.push("authentication");
                const error = new Error("private authentication detail");
                error.cleanup = async () => {
                  order.push("clerk-cleanup");
                  return { cleanup_complete: true, session_reconciled: true };
                };
                throw error;
              }
            : auth.authenticate,
          runSandboxedExplorer: async () => {
            order.push("exploration");
            if (scenario.name === "exploration") throw new Error("private exploration detail");
            return {
              completion: { result: { status: "done", stop_reason: "explicit_done" } },
              modelRequestCount: 0
            };
          },
          retireCompletedOwnerBundle: async ({ bundleDirectory, runId, environment: retirementEnvironment }) => {
            order.push("identity-retirement");
            assert.equal(bundleDirectory, fixture.ownerDirectory);
            assert.equal(runId, RUN_ID);
            assert.deepEqual(retirementEnvironment, { CLERK_SECRET_KEY: "clerk-fixture-secret" });
            if (scenario.retirementFails) throw new Error("private retirement detail");
            return { status: "retired" };
          }
        }
      }));

      assert.equal(environment.CLERK_SECRET_KEY, undefined);
      assert.equal(report.failure_stage, scenario.failureStage);
      if (scenario.name === "initial-navigation") assert.equal(report.failure_point, "load_wait");
      assert.equal(report.identity_retirement_confirmed, !scenario.retirementFails);
      assert.equal(report.candidate_eligible, scenario.eligible === true);
      assert.equal(report.cleanup_complete, report.auth_cleanup_complete && report.identity_retirement_confirmed);
      assert.equal(order.at(-1), "identity-retirement");
      if (order.includes("clerk-cleanup")) {
        assert.ok(order.indexOf("browser-stop") < order.indexOf("clerk-cleanup"));
        assert.ok(order.indexOf("clerk-cleanup") < order.indexOf("identity-retirement"));
      }
      if (scenario.retirementFails) {
        assert.ok(report.non_publishable_reasons.includes("identity-retirement-incomplete"));
      }
      if (scenario.browserStopFails) {
        assert.equal(report.browser_stopped, false);
        assert.equal(report.profile_deleted, false);
        assert.equal(report.identity_retirement_confirmed, true);
        assert.ok(report.non_publishable_reasons.includes("teardown-incomplete"));
      }
      const retained = await readFile(`${fixture.targetConfig.outputs.target_run_directory}/production-run-report.json`, "utf8");
      assert.doesNotMatch(
        retained,
        /clerk-fixture-secret|model-fixture-key|user_fixture|flowmap_[0-9a-f]+|app\.example\.test|private\/|private (?:preflight|browser|model|authentication|exploration|retirement) detail/i
      );
      assert.equal(retained.includes(fixture.ownerDirectory), false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("a successful bounded run retains the real retirement receipt before becoming eligible", async () => {
  const fixture = await productionFixture({ bounded: true });
  const order = [];
  let identityPresent = true;
  const retirementFetch = async (raw, init = {}) => {
    order.push("retirement-provider");
    const url = new URL(raw);
    const method = init.method ?? "GET";
    if (url.href === "https://api.clerk.com/v1/domains") {
      return Response.json({ data: [{ frontend_api_url: "https://clerk.example.test" }], total_count: 1 });
    }
    if (url.pathname === "/v1/users/user_fixture" && method === "GET") {
      return identityPresent
        ? Response.json({
            id: "user_fixture",
            username: FRESH_USERNAME,
            external_id: `flowmap_cal_${"a".repeat(32)}`
          })
        : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/v1/users" && method === "GET") {
      const rows = identityPresent
        ? [{ id: "user_fixture", external_id: `flowmap_cal_${"a".repeat(32)}` }]
        : [];
      return Response.json({ data: rows, total_count: rows.length });
    }
    if (url.pathname === "/v1/users/user_fixture" && method === "DELETE") {
      identityPresent = false;
      return Response.json({});
    }
    assert.fail(`unexpected retirement request: ${method} ${url.href}`);
  };
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      environment: { CLERK_SECRET_KEY: "clerk-retirement-fixture" },
      clerkFetch: retirementFetch,
      runtimeDependencies: {
        preflightFreshClerkAuthentication: async () => {},
        createBrowser: () => browserStub(order),
        createModel: () => ({ ready: Promise.resolve(), async stop() { order.push("model-stop"); } }),
        bootstrapClerkAuthentication: successfulAuth(order).authenticate,
        runSandboxedExplorer: async () => ({
          completion: { result: { status: "done", stop_reason: "explicit_done" } },
          modelRequestCount: 0
        })
      }
    }));

    assert.equal(report.auth_cleanup_complete, true);
    assert.equal(report.identity_retirement_confirmed, true);
    assert.equal(report.cleanup_complete, true);
    assert.equal(report.candidate_eligible, true);
    assert.ok(order.indexOf("browser-stop") < order.indexOf("clerk-cleanup"));
    assert.ok(order.indexOf("clerk-cleanup") < order.indexOf("retirement-provider"));
    const receipt = await readFile(join(fixture.ownerDirectory, OWNER_BUNDLE_RETIREMENT_RECEIPT), "utf8");
    assert.equal(JSON.parse(receipt).status, "retired");
    assert.doesNotMatch(receipt, /user_fixture|flowmap_|clerk-retirement-fixture|app\.example\.test/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production accepts the private initial auth handoff, then waits for confirmed landing before exploration", async () => {
  const now = Date.now();
  const timeoutConfig = { cap_state: { binding: { working_day_deadline: new Date(now + 45_000).toISOString(), caps: { browser_active_seconds: 7_200 } } } };
  assert.ok(productionExplorerTimeoutMs(timeoutConfig, now) > 15_000);
  timeoutConfig.cap_state.binding.working_day_deadline = new Date(now + 9_000_000).toISOString();
  assert.equal(productionExplorerTimeoutMs(timeoutConfig, now), 7_200_000);
  const fixture = await productionFixture();
  const order = [];
  const auth = successfulAuth(order);
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      environment: { CLERK_SECRET_KEY: "private-fixture-key" },
      clerkFetch: async () => { throw new Error("must not be called by injected auth"); },
      runtimeDependencies: {
        createBrowser: () => {
          order.push("browser-create");
          return browserStub(order, { privateAuthHandoff: true });
        },
        createModel: () => {
          order.push("model-create");
          return modelStub(fixture, order);
        },
        bootstrapClerkAuthentication: auth.authenticate
      }
    }));

    assert.deepEqual(order, [
      "browser-create",
      "browser-ready",
      "model-create",
      "model-ready",
      "browser-navigate",
      "auth-landing-confirmed",
      "browser-observe",
      "model-request",
      "model-stop",
      "browser-stop",
      "clerk-cleanup"
    ]);
    assert.equal(auth.cleanups(), 1);
    assert.equal(report.candidate_eligible, false);
    assert.equal(report.public_pack_sha256, fixture.targetConfig.public_pack.sha256);
    assert.equal(report.cleanup_complete, false);
    assert.equal(report.identity_retirement_confirmed, false);
    assert.equal(report.model_calls, 1);
    assert.equal(report.model_actual_eur, 0.001);
    assert.equal(report.profile_deleted, true);
    assert.equal(report.failure_stage, null);
    assert.equal(report.failure_code, null);
    assert.equal(report.failure_substage, null);
    assert.equal(report.failure_subcode, null);
    const reportPath = `${fixture.targetConfig.outputs.target_run_directory}/production-run-report.json`;
    const retained = await readFile(reportPath, "utf8");
    assert.deepEqual(JSON.parse(retained), report);
    assert.doesNotMatch(retained, /private-fixture-key|user_fixture|prompt|transcript|ticket|session|registry|provider|authorization/i);
    await assert.rejects(() => stat(fixture.targetConfig.outputs.browser_profile_directory), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a refused private handoff stops production before Clerk ticket mint or exploration", async () => {
  const fixture = await productionFixture();
  const order = [];
  let authenticationCalls = 0;
  let explorerCalls = 0;
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      environment: { CLERK_SECRET_KEY: "unused-private-key" },
      clerkFetch: async () => {
        throw new Error("ticket mint must not be attempted");
      },
      runtimeDependencies: {
        createBrowser: () => browserStub(order, { initialNavigationRefusal: true }),
        createModel: () => ({
          ready: Promise.resolve().then(() => order.push("model-ready")),
          async stop() { order.push("model-stop"); }
        }),
        bootstrapClerkAuthentication: async () => {
          authenticationCalls += 1;
          throw new Error("ticket mint must not be attempted");
        },
        runSandboxedExplorer: async () => {
          explorerCalls += 1;
          throw new Error("exploration must not start");
        }
      }
    }));

    assert.equal(authenticationCalls, 0);
    assert.equal(explorerCalls, 0);
    assert.deepEqual(order, ["browser-ready", "model-ready", "browser-navigate", "model-stop", "browser-stop"]);
    assert.equal(report.candidate_eligible, false);
    assert.deepEqual(report.non_publishable_reasons, ["run-failed", "exploration-incomplete", "identity-retirement-incomplete"]);
    assert.doesNotMatch(JSON.stringify(report), /unused-private-key|ticket_private|sign-in|next=|sess_|user_/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production failures still stop both brokers, clean Clerk once after browser stop, and stay non-publishable", async () => {
  const fixture = await productionFixture();
  const order = [];
  const auth = successfulAuth(order);
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      environment: { CLERK_SECRET_KEY: "unused-fixture-key" },
      runtimeDependencies: {
        createBrowser: () => browserStub(order),
        createModel: () => ({ ready: Promise.resolve().then(() => order.push("model-ready")), call: async () => { throw new Error("unused"); }, stop: async () => order.push("model-stop") }),
        bootstrapClerkAuthentication: auth.authenticate,
        runSandboxedExplorer: async () => {
          order.push("explorer-failure");
          throw new Error("private provider body must not escape");
        }
      }
    }));
    assert.equal(report.candidate_eligible, false);
    assert.deepEqual(report.non_publishable_reasons, ["run-failed", "exploration-incomplete", "identity-retirement-incomplete"]);
    assert.equal(auth.cleanups(), 1);
    assert.ok(order.indexOf("browser-stop") < order.indexOf("clerk-cleanup"));
    assert.equal(report.model_stopped, true);
    assert.equal(report.browser_stopped, true);
    assert.equal(report.profile_deleted, true);
    assert.doesNotMatch(JSON.stringify(report), /private provider body|unused-fixture-key/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a failed browser startup is attributed before model creation and removes its confirmed-stopped owned profile", async () => {
  const fixture = await productionFixture({ bounded: true });
  const brokerScript = `${fixture.root}/failed-browser-start.mjs`;
  let modelCreations = 0;
  await writeFile(brokerScript, `process.stdout.write(JSON.stringify({ready:false,error:'initial CDP session configuration failed'})+'\\n');process.exitCode=1;\n`);
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      runtimeDependencies: {
        preflightFreshClerkAuthentication: async () => {},
        createBrowser: (configPath, deadline) => new BrokerProcess(brokerScript, configPath, deadline, {
          environment: { PATH: "/usr/bin:/bin" },
          readyTimeoutMs: 500
        }),
        createModel: () => { modelCreations += 1; }
      }
    }));

    assert.equal(modelCreations, 0);
    assert.equal(report.failure_stage, "browser-start");
    assert.equal(report.failure_code, "browser_start_failed");
    assert.equal(report.browser_stopped, true);
    assert.equal(report.profile_deleted, true);
    assert.equal(report.non_publishable_reasons.includes("teardown-incomplete"), false);
    await assert.rejects(() => stat(fixture.targetConfig.outputs.browser_profile_directory), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the real browser startup path persists a delayed CDP timeout and never becomes ready or creates a model", async () => {
  const fixture = await productionFixture({ bounded: true });
  const readiness = [];
  let modelCreations = 0;
  let fakeChrome;

  class FakeCdpSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send(raw) {
      const command = JSON.parse(raw);
      if (command.method === "Accessibility.enable") {
        setTimeout(() => {
          fakeChrome.exitCode = 1;
          fakeChrome.emit("exit", 1, null);
        }, 300);
        return;
      }
      const result = command.method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "page-target", type: "page" }] }
        : command.method === "Target.attachToTarget"
          ? { sessionId: "page-session" }
          : command.method === "Page.getFrameTree"
            ? { frameTree: { frame: { id: "top-frame", loaderId: "top-loader" } } }
            : {};
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ id: command.id, result })
      })));
    }

    close() {
      this.dispatchEvent(new Event("close"));
    }
  }

  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      runtimeDependencies: {
        preflightFreshClerkAuthentication: async () => {},
        createBrowser: (configPath, deadline) => {
          const config = JSON.parse(readFileSync(configPath, "utf8"));
          config.operation_deadline_ms = deadline;
          fakeChrome = new EventEmitter();
          fakeChrome.stderr = new PassThrough();
          fakeChrome.exitCode = null;
          fakeChrome.signalCode = null;
          fakeChrome.kill = (signal) => {
            fakeChrome.signalCode = signal;
            queueMicrotask(() => fakeChrome.emit("exit", null, signal));
            return true;
          };
          const broker = new BrowserBroker(config, {
            startupBudgetMs: 250,
            findChromiumImpl: async () => "/fake/chromium",
            spawnBrowserImpl: () => fakeChrome,
            waitForDevToolsPortImpl: async () => 9_222,
            fetchImpl: async () => ({ json: async () => ({ webSocketDebuggerUrl: "ws://fake-cdp" }) }),
            WebSocketImpl: FakeCdpSocket
          });
          return {
            ready: announceBrowserBrokerReadiness(broker, {
              write(line) { readiness.push(JSON.parse(line)); }
            }).then((result) => {
              if (!result.ok) throw result.error;
              return result.message;
            }),
            async stop() {
              if (await broker.shutdown() !== true) throw new Error("fake browser did not stop");
            }
          };
        },
        createModel: () => { modelCreations += 1; }
      }
    }));

    const cap = JSON.parse(await readFile(fixture.capPath, "utf8"));
    assert.equal(readiness.length, 1);
    assert.equal(readiness[0].ready, false);
    assert.equal(readiness.some((message) => message.ready === true), false);
    assert.equal(cap.abort.code, "cdp_session_configuration_failed");
    assert.equal(modelCreations, 0);
    assert.equal(report.failure_stage, "browser-start");
    assert.equal(report.failure_code, "browser_start_failed");
    assert.equal(report.browser_stopped, true);
    assert.equal(report.profile_deleted, true);
    assert.equal(report.non_publishable_reasons.includes("teardown-incomplete"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Clerk rejection defers reconciliation until model and browser teardown", async () => {
  const fixture = await productionFixture();
  const order = [];
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      environment: { CLERK_SECRET_KEY: "sk_test_private" },
      clerkFetch: clerkFailureFetch(order, "rejection"),
      runtimeDependencies: {
        createBrowser: () => rejectedAuthBrowser(order, "rejection"),
        createModel: () => ({
          ready: Promise.resolve(),
          async stop() { order.push("model-stop"); }
        })
      }
    }));
    assert.equal(report.candidate_eligible, false);
    assert.equal(report.cleanup_complete, false);
    assert.ok(order.indexOf("model-stop") < order.indexOf("browser-stop"));
    assert.ok(order.indexOf("browser-stop") < order.indexOf("clerk-inventory-after"));
    assert.equal(order.filter((step) => step === "clerk-inventory-after").length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an unconfirmed auth landing blocks production exploration and reconciles only after browser stop", async () => {
  const fixture = await productionFixture();
  const order = [];
  let explorerCalls = 0;
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      environment: { CLERK_SECRET_KEY: "sk_test_private_landing" },
      clerkFetch: clerkFailureFetch(order, "landing"),
      runtimeDependencies: {
        createBrowser: () => rejectedAuthBrowser(order, "landing"),
        createModel: () => ({
          ready: Promise.resolve(),
          async stop() { order.push("model-stop"); }
        }),
        runSandboxedExplorer: async () => {
          explorerCalls += 1;
          throw new Error("exploration must not start before an exact auth landing");
        }
      }
    }));

    assert.equal(explorerCalls, 0);
    assert.equal(report.candidate_eligible, false);
    assert.equal(report.cleanup_complete, false);
    assert.equal(report.explorer_status, "not-started");
    assert.equal(report.failure_stage, "authentication");
    assert.equal(report.failure_code, "clerk_auth_landing_unconfirmed");
    assert.ok(order.indexOf("browser-stop") < order.indexOf("clerk-inventory-after"));
    assert.ok(order.indexOf("clerk-inventory-after") < order.indexOf("clerk-session-revoke"));
    assert.equal(order.filter((step) => step === "clerk-session-revoke").length, 1);
    const retainedPaths = [
      fixture.targetConfig.outputs.browser_config_path,
      ...(await filesBelow(fixture.targetConfig.outputs.target_run_directory))
    ];
    for (const path of retainedPaths) {
      const retained = await readFile(path, "utf8");
      assert.doesNotMatch(
        retained,
        /sk_test_private_landing|private auth landing detail|sign-in\?next|%2Ftoday|ticket_private|user_fixture|sess_preexisting|sess_run_new/i
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production report retains only the fixed bounded-route failure subdiagnostic", async () => {
  const fixture = await productionFixture({ bounded: true });
  const order = [];
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      environment: { CLERK_SECRET_KEY: "sk_test_private_subdiagnostic" },
      clerkFetch: freshPreflightFetch(order),
      runtimeDependencies: {
        createBrowser: () => browserStub(order),
        createModel: () => ({ ready: Promise.resolve(), async stop() {} }),
        bootstrapClerkAuthentication: async () => {
          const error = new Error("private route detail");
          Object.defineProperty(error, "calibration_failure_code", { value: "clerk_auth_landing_unconfirmed" });
          Object.defineProperty(error, "calibration_failure_substage", { value: "post_inspection_reseal" });
          Object.defineProperty(error, "calibration_failure_subcode", { value: "clerk_auth_post_inspection_reseal_unconfirmed" });
          Object.defineProperty(error, "calibration_failure_point", { value: "clerk_final_reseal" });
          error.cleanup = async () => ({ cleanup_complete: true, session_reconciled: true, run_session_revoked: true, unused_sign_in_token_revoked: false });
          throw error;
        }
      }
    }));
    assert.equal(report.failure_stage, "authentication");
    assert.equal(report.failure_code, "clerk_auth_landing_unconfirmed");
    assert.equal(report.failure_substage, "post_inspection_reseal");
    assert.equal(report.failure_subcode, "clerk_auth_post_inspection_reseal_unconfirmed");
    assert.equal(report.failure_point, "clerk_final_reseal");
    assert.doesNotMatch(JSON.stringify(report), /private route detail|sk_test_private|user_|sess_|sign-in/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production retries retained Clerk cleanup custody without retrying authentication", async () => {
  const fixture = await productionFixture();
  const order = [];
  let authenticationAttempts = 0;
  let cleanupAttempts = 0;
  let clock = Date.now();
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      environment: { CLERK_SECRET_KEY: "private-runner-key" },
      runtimeDependencies: {
        createBrowser: () => browserStub(order),
        createModel: () => ({ ready: Promise.resolve(), async stop() { order.push("model-stop"); } }),
        bootstrapClerkAuthentication: async () => {
          authenticationAttempts += 1;
          order.push("authenticate");
          const error = new Error("private authentication failure");
          Object.defineProperty(error, "calibration_failure_code", { value: "private_provider_detail" });
          Object.defineProperty(error, "calibration_failure_substage", { value: "candidate_wait" });
          Object.defineProperty(error, "calibration_failure_subcode", { value: "private_route_detail" });
          Object.defineProperty(error, "calibration_failure_point", { value: "private_route_point" });
          error.cleanup = async ({ cleanupDeadlineAt }) => {
            cleanupAttempts += 1;
            order.push(`clerk-cleanup-${cleanupAttempts}`);
            assert(cleanupDeadlineAt > clock);
            return {
              cleanup_complete: cleanupAttempts === 2,
              session_reconciled: cleanupAttempts === 2,
              run_session_revoked: cleanupAttempts === 2,
              unused_sign_in_token_revoked: false
            };
          };
          throw error;
        },
        clerkCleanupTiming: {
          now: () => clock,
          wait: async (milliseconds) => {
            order.push("clerk-cleanup-wait");
            clock += milliseconds;
          }
        }
      }
    }));

    assert.equal(authenticationAttempts, 1);
    assert.equal(cleanupAttempts, 2);
    assert.equal(order.filter((event) => event === "clerk-cleanup-wait").length, 1);
    assert.ok(order.indexOf("model-stop") < order.indexOf("clerk-cleanup-1"));
    assert.ok(order.indexOf("browser-stop") < order.indexOf("clerk-cleanup-1"));
    assert.equal(report.cleanup_complete, false);
    assert.equal(report.candidate_eligible, false);
    assert.equal(report.failure_stage, "authentication");
    assert.equal(report.failure_code, "clerk_auth_failed");
    assert.equal(report.failure_substage, null);
    assert.equal(report.failure_subcode, null);
    assert.equal(report.failure_point, null);
    assert.deepEqual(report.non_publishable_reasons, ["run-failed", "exploration-incomplete", "identity-retirement-incomplete"]);
    const retained = await readFile(`${fixture.targetConfig.outputs.target_run_directory}/production-run-report.json`, "utf8");
    assert.doesNotMatch(retained, /private-runner-key|private authentication failure|private_provider_detail|private_route_detail|sess_retry|user_fixture/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production retries successful-auth session cleanup without replaying authentication or exploration", async () => {
  const fixture = await productionFixture();
  const order = [];
  let authenticationAttempts = 0;
  let explorationAttempts = 0;
  let cleanupAttempts = 0;
  let clock = Date.now();
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      environment: { CLERK_SECRET_KEY: "private-success-key" },
      runtimeDependencies: {
        createBrowser: () => browserStub(order),
        createModel: () => ({ ready: Promise.resolve(), async stop() { order.push("model-stop"); } }),
        bootstrapClerkAuthentication: async () => {
          authenticationAttempts += 1;
          order.push("authenticate");
          return {
            authenticated: true,
            cleanup: async ({ cleanupDeadlineAt }) => {
              cleanupAttempts += 1;
              order.push(`clerk-session-cleanup-${cleanupAttempts}`);
              assert(cleanupDeadlineAt > clock);
              return {
                cleanup_complete: cleanupAttempts === 2,
                session_reconciled: cleanupAttempts === 2,
                run_session_revoked: cleanupAttempts === 2,
                unused_sign_in_token_revoked: true
              };
            }
          };
        },
        runSandboxedExplorer: async () => {
          explorationAttempts += 1;
          order.push("explore");
          return { completion: { result: { status: "done", stop_reason: "explicit_done" } }, modelRequestCount: 0 };
        },
        clerkCleanupTiming: {
          now: () => clock,
          wait: async (milliseconds) => {
            order.push("clerk-cleanup-wait");
            clock += milliseconds;
          }
        }
      }
    }));

    assert.equal(authenticationAttempts, 1);
    assert.equal(explorationAttempts, 1);
    assert.equal(cleanupAttempts, 2);
    assert.equal(order.filter((event) => event === "browser-navigate").length, 1);
    assert.equal(order.filter((event) => event === "explore").length, 1);
    assert.equal(order.filter((event) => event === "clerk-cleanup-wait").length, 1);
    assert.ok(order.indexOf("model-stop") < order.indexOf("clerk-session-cleanup-1"));
    assert.ok(order.indexOf("browser-stop") < order.indexOf("clerk-session-cleanup-1"));
    assert.equal(report.cleanup_complete, false);
    assert.equal(report.candidate_eligible, false);
    assert.deepEqual(report.non_publishable_reasons, ["identity-retirement-incomplete"]);
    const retained = await readFile(`${fixture.targetConfig.outputs.target_run_directory}/production-run-report.json`, "utf8");
    assert.doesNotMatch(retained, /private-success-key|sess_successful_auth_private|session revoke failure/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a real browser RPC timeout fails its process tree closed before deferred Clerk cleanup and blocks publication", async () => {
  const fixture = await productionFixture();
  const order = [];
  const orderLog = `${fixture.root}/timeout-order.log`;
  const brokerScript = `${fixture.root}/timeout-browser-broker.mjs`;
  await writeFile(brokerScript, `import{appendFileSync}from'node:fs';let buffer='';process.stdout.write('{"ready":true}\\n');process.stdin.setEncoding('utf8');process.stdin.on('data',(chunk)=>{buffer+=chunk;for(;;){const newline=buffer.indexOf('\\n');if(newline<0)break;const line=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);if(line.payload?.method==='navigate')process.stdout.write(JSON.stringify({rpc_id:line.rpc_id,response:{ok:true}})+'\\n');}});process.on('SIGTERM',()=>{appendFileSync(process.env.ORDER_LOG,'browser-fail-closed\\n');process.exit(0)});setInterval(()=>{},1000);\n`);
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      environment: { CLERK_SECRET_KEY: "sk_test_private" },
      clerkFetch: clerkFailureFetch(order, "timeout", orderLog),
      runtimeDependencies: {
        createBrowser: (configPath, deadline) => new BrokerProcess(brokerScript, configPath, deadline, {
          environment: { PATH: "/usr/bin:/bin", ORDER_LOG: orderLog },
          callTimeoutMs: 25
        }),
        createModel: () => ({
          ready: Promise.resolve(),
          async stop() { await appendFile(orderLog, "model-stop-accounted\n"); }
        })
      }
    }));
    const events = (await readFile(orderLog, "utf8")).trim().split("\n");
    assert.equal(report.candidate_eligible, false);
    assert.equal(report.browser_stopped, true);
    assert.equal(report.model_stopped, true);
    assert.equal(report.cleanup_complete, false);
    assert.ok(events.indexOf("browser-fail-closed") < events.indexOf("clerk-inventory-after"));
    assert.ok(events.indexOf("model-stop-accounted") < events.indexOf("clerk-inventory-after"));
    assert.equal(events.filter((event) => event === "clerk-inventory-after").length, 1);
    assert.equal(events.filter((event) => event === "clerk-session-revoke").length, 1);
    await assert.rejects(() => stat(`${fixture.targetConfig.outputs.target_run_directory}/explorer-result.json`), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("incomplete Clerk cleanup or cost reconciliation makes a completed run explicitly non-publishable", async () => {
  const fixture = await productionFixture();
  const order = [];
  let clock = Date.now();
  const auth = successfulAuth(order, { cleanup_complete: false, session_reconciled: true, run_session_revoked: false, unused_sign_in_token_revoked: false });
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      runtimeDependencies: {
        createBrowser: () => browserStub(order),
        createModel: () => ({ ready: Promise.resolve(), stop: async () => {} }),
        bootstrapClerkAuthentication: auth.authenticate,
        runSandboxedExplorer: async () => {
          const cap = JSON.parse(await readFile(fixture.capPath, "utf8"));
          cap.model.outstanding_reservations_eur = 0.1;
          await privateJson(fixture.capPath, cap);
          return { completion: { result: { status: "done", stop_reason: "explicit_done" } }, modelRequestCount: 0 };
        },
        clerkCleanupTiming: {
          now: () => clock,
          wait: async (milliseconds) => { clock += milliseconds; }
        }
      }
    }));
    assert.equal(report.candidate_eligible, false);
    assert.ok(report.non_publishable_reasons.includes("clerk-cleanup-incomplete"));
    assert.ok(report.non_publishable_reasons.includes("cost-reconciliation-incomplete"));
    assert.equal(report.model_calls, null);
    assert.equal(auth.cleanups(), 3);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an unconfirmed browser stop retains the owned profile and blocks publication", async () => {
  const fixture = await productionFixture();
  const order = [];
  try {
    const report = await withTestRunner(() => runProductionExplorerSessionForTest({
      runId: RUN_ID,
      repositoryRoot: fixture.repository,
      runtimeDependencies: {
        createBrowser: () => browserStub(order, { stopFails: true }),
        createModel: () => ({ ready: Promise.resolve(), stop: async () => {} }),
        bootstrapClerkAuthentication: successfulAuth(order).authenticate,
        runSandboxedExplorer: async () => ({ completion: { result: { status: "done", stop_reason: "explicit_done" } }, modelRequestCount: 0 })
      }
    }));
    assert.equal(report.candidate_eligible, false);
    assert.equal(report.browser_stopped, false);
    assert.equal(report.profile_deleted, false);
    assert.ok(report.non_publishable_reasons.includes("teardown-incomplete"));
    await stat(fixture.targetConfig.outputs.browser_profile_directory);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("real preflights and the exact CLI surface cannot be bypassed before outputs", async () => {
  const fixture = await productionFixture();
  let injected = false;
  try {
    fixture.targetConfig.model_ledger.sha256 = "b".repeat(64);
    await privateJson(fixture.configPath, fixture.targetConfig);
    await assert.rejects(
      () => runProductionExplorerSession({
        runId: RUN_ID,
        repositoryRoot: fixture.repository,
        environment: { CLERK_SECRET_KEY: "caller-key" },
        clerkFetch: async () => { injected = true; },
        runtimeDependencies: { createBrowser: () => { injected = true; } }
      }),
      /ledger changed after preparation/i
    );
    assert.equal(injected, false);
    await assert.rejects(() => stat(fixture.targetConfig.outputs.target_run_directory), { code: "ENOENT" });
    assert.throws(
      () => runProductionExplorerSessionForTest({ runId: RUN_ID, runtimeDependencies: {} }),
      /test dependencies are disabled/
    );
    await assert.rejects(() => runProductionExplorerCli(["--run-id", RUN_ID, "--extra", "value"]), /Usage:/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
