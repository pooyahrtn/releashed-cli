import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { startAuthenticatedTargetFixture } from "../fixture/authenticated-target.mjs";
import { prepareTargetRun } from "../scripts/prepare-target-run.mjs";
import { runLocalExplorerFixtureSession } from "../supervisor/explorer-session.mjs";
import { targetRuntimeFixture } from "./target-runtime-fixture.mjs";

const codeRepository = resolve(new URL("..", import.meta.url).pathname);

function currentAccessibility(prompt) {
  const match = prompt.match(/BEGIN_UNTRUSTED_CURRENT_PAGE_JSON\n(.+)\nEND_UNTRUSTED_CURRENT_PAGE_JSON/);
  assert.ok(match, "scripted responder receives one current-page object");
  return JSON.parse(match[1]).accessibility;
}

function visibleRef(prompt, role, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = currentAccessibility(prompt).match(new RegExp(`^(e\\d+) \\[${role}\\] ${escaped}$`, "m"));
  assert.ok(match, `visible ${role} ${name} exists`);
  return match[1];
}

function decision(value) {
  return JSON.stringify({ schema_version: 1, ...value });
}

async function preparedFixture(target, sentinel) {
  const fixture = await targetRuntimeFixture(target.origin);
  process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE = "1";
  process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL = sentinel;
  await prepareTargetRun({
    repository: fixture.repository,
    ownerDirectory: fixture.ownerDirectory,
    runId: "source-blind-target-test",
    registryPath: fixture.registryPath,
    targetOriginOverride: target.origin,
    testOnlyLocalFixture: true
  });
  return fixture;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

test("real sandbox, pure bridge, browser fixture, and scripted model complete one evidence-backed action", async () => {
  const sentinel = `fixture-auth-${"e".repeat(32)}`;
  const target = await startAuthenticatedTargetFixture({ sentinel });
  const fixture = await preparedFixture(target, sentinel);
  let modelCall = 0;
  try {
    const report = await runLocalExplorerFixtureSession({
      configPath: fixture.configPath,
      repositoryRoot: fixture.repository,
      isolationSourcePath: join(codeRepository, "supervisor", "browser-broker.mjs"),
      scriptedModelResponder: async (payload) => {
        modelCall += 1;
        if (modelCall === 1) {
          return decision({ kind: "act", reason: "Exercise one safe visible control", action: { type: "click", ref: visibleRef(payload.content, "button", "Toggle preference") } });
        }
        assert.match(currentAccessibility(payload.content), /\[button\] Preference restored/);
        assert.match(payload.content, /completed with retained before-and-after browser evidence/);
        return decision({ kind: "done", reason: "The scripted local journey is complete" });
      }
    });

    assert.equal(report.result.status, "done");
    assert.equal(report.result.stop_reason, "explicit_done");
    assert.equal(report.result.decisions, 2);
    assert.equal(report.result.run_history.action_attempts[0].result, "observed-change");
    assert.equal(report.model_requests.length, 2);
    assert.equal(report.transient_auth_absent, true);
    assert.equal(report.isolation.source_and_private_file_read_denied, true);
    assert.equal(report.isolation.direct_network_denied, true);
    assert.equal(target.requests.some((request) => request.path === "/explorer-network-canary"), false);
    assert.equal(target.requests.every((request) => request.authenticated), true);
    assert.equal(target.requests.filter((request) => request.bootstrap_header_used).length, 1);

    const events = (await readFile(join(report.target_run_directory, "observations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const action = events.find((event) => event.intended_action.method === "click");
    assert.equal(action.transition_kind, "solid");
    assert.match(action.before.visible_state_summary, /\[button\] Toggle preference/);
    assert.match(action.after.visible_state_summary, /\[button\] Preference restored/);
    for (const evidence of [action.before, action.after]) {
      const screenshot = join(report.target_run_directory, evidence.screenshot_path);
      assert.equal((await readFile(screenshot)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(await sha256(screenshot), evidence.screenshot_sha256);
    }

    const explorerView = JSON.stringify(report.transcript);
    assert.doesNotMatch(explorerView, new RegExp(sentinel));
    assert.doesNotMatch(explorerView, /user_fixture|toggle-preference|reversible-own-account|own-account-state|expected_request|authorization_token|api\/progress|target-action-registry/i);
  } finally {
    delete process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE;
    delete process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL;
    await target.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("retained-observation drift is refused before a visible link is followed", async () => {
  const sentinel = `fixture-auth-${"h".repeat(32)}`;
  const target = await startAuthenticatedTargetFixture({ sentinel, pollDomDrift: true });
  const fixture = await preparedFixture(target, sentinel);
  let modelCall = 0;
  try {
    const report = await runLocalExplorerFixtureSession({
      configPath: fixture.configPath,
      repositoryRoot: fixture.repository,
      isolationSourcePath: join(codeRepository, "supervisor", "browser-broker.mjs"),
      scriptedModelResponder: async (payload) => {
        modelCall += 1;
        if (modelCall === 1) {
          const ref = visibleRef(payload.content, "link", "Open next state");
          target.triggerDomDrift();
          await new Promise((resolveWait) => setTimeout(resolveWait, 200));
          return decision({ kind: "act", reason: "Follow the visible link", action: { type: "click", ref } });
        }
        return decision({ kind: "done", reason: "The stale action was safely refused" });
      }
    });

    assert.equal(report.result.stop_reason, "explicit_done");
    assert.equal(report.result.run_history.action_attempts[0].result, "rejected");
    assert.equal(target.requests.some((request) => request.path === "/next"), false);
    const events = (await readFile(join(report.target_run_directory, "observations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const refused = events.find((event) => event.outcome_detail === "The page changed before the action reached the product");
    assert.ok(refused);
    assert.equal(refused.transition_kind, "none");
  } finally {
    delete process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE;
    delete process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL;
    await target.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the explorer composition refuses production before opening browser outputs", async () => {
  const fixture = await targetRuntimeFixture("https://app.example.test");
  process.env.CLERK_SECRET_KEY = "sk_live_must-remain-unused";
  try {
    await prepareTargetRun({ repository: fixture.repository, ownerDirectory: fixture.ownerDirectory, runId: "source-blind-target-test", registryPath: fixture.registryPath });
    await assert.rejects(
      () => runLocalExplorerFixtureSession({ configPath: fixture.configPath, repositoryRoot: fixture.repository, isolationSourcePath: join(codeRepository, "supervisor", "browser-broker.mjs"), scriptedModelResponder: async () => "{}" }),
      /Production explorer execution remains disabled/
    );
    const config = JSON.parse(await readFile(fixture.configPath, "utf8"));
    await assert.rejects(() => stat(config.outputs.browser_config_path), (error) => error?.code === "ENOENT");
    assert.equal(process.env.CLERK_SECRET_KEY, "sk_live_must-remain-unused");
  } finally {
    delete process.env.CLERK_SECRET_KEY;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("isolation probes must name existing distinct ordinary files before the browser opens", async () => {
  const sentinel = `fixture-auth-${"i".repeat(32)}`;
  const target = await startAuthenticatedTargetFixture({ sentinel });
  const fixture = await preparedFixture(target, sentinel);
  try {
    await assert.rejects(
      () => runLocalExplorerFixtureSession({
        configPath: fixture.configPath,
        repositoryRoot: fixture.repository,
        isolationSourcePath: join(fixture.root, "missing-source.mjs"),
        scriptedModelResponder: async () => "{}"
      }),
      (error) => error?.code === "ENOENT"
    );
    assert.equal(target.requests.length, 0);
  } finally {
    delete process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE;
    delete process.env.SPIKE_A_TRANSIENT_AUTH_SENTINEL;
    await target.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
