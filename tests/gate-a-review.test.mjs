import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import test from "node:test";
import { validateGateAEvaluation } from "../lib/gate-a-evaluation.mjs";
import { runGateAReview } from "../lib/gate-a-review.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
// A second, genuinely distinct valid PNG (a solid green pixel instead of PNG's default), for
// proving a transition_kind decision follows the SCREENSHOT hash, not only the accessibility-tree
// hash: same visible_state_summary (so observation_hash matches) but a different retained image.
function onePixelPng([r, g, b]) {
  const chunk = (type, data) => {
    const typeData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData) >>> 0, 0);
    return Buffer.concat([length, typeData, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const idat = deflateSync(Buffer.from([0, r, g, b]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const OTHER_PNG = onePixelPng([0, 200, 0]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
function gateEvaluation(version = "fixture.1") {
  const question = (id) => ({
    id,
    kind: "direct-observation-multi-step-journey",
    distinctLearnerGoal: `Goal for ${id}`,
    prompt: `Prompt for ${id}`,
    expectedAnswerElements: [{ id: `${id}-E1`, required: true, answer: "Expected answer.", sourceRefs: ["S-ONE"] }],
    evidenceRequirements: { minimumDirectObservedTransitions: 1, requiredSequence: ["before to after"], requiredArtifacts: ["event and screenshot"], notAccepted: ["unsupported answer"] },
    scoring: { "0": "Wrong", "1": "Partial", "2": "Complete" }
  });
  return {
    schema: "external-flow-map.hidden-artifact-evaluation",
    schemaVersion: 1,
    evaluationVersion: version,
    sealed: true,
    author: { role: "gate owner" },
    sealingContract: {
      visibility: "private",
      mustNotBeShownTo: ["public-pack author", "explorer", "map builder"],
      candidateHashBeforeUnseal: true,
      candidateMutationAfterUnsealInvalidatesReview: true,
      reviewMode: "artifact-only; no live product and no explorer conversation",
      reviewTimeLimitMinutes: 10
    },
    target: { private: true },
    reachabilityAndBudget: { private: true },
    questions: [question("journey-one"), question("journey-two"), question("honesty")],
    globalScoringRubric: {
      questionScale: { "0": "Wrong", "1": "Partial", "2": "Complete" },
      maximumScore: 6,
      passingScore: 6,
      perQuestionFloor: 2,
      necessaryPassConditions: ["All questions pass."],
      automaticFailure: ["A solid edge is unsupported."],
      qualitativeReview: ["Is it useful?"]
    },
    sourceSnapshot: [{ id: "S-ONE", sha256: "a".repeat(64) }]
  };
}
const evidence = (path, text) => ({ url: "https://example.test/", origin: "https://example.test", visible_state_summary: text, observation_hash: sha(JSON.stringify({ url: "https://example.test/", visible_state_summary: text })), screenshot_path: path, screenshot_sha256: sha(PNG) });
const necessaryConditions = {
  one_coherent_fresh_user_journey: true,
  zero_unsupported_solid_transitions: true,
  facts_claims_inferences_unmistakable: true,
  html_screenshots_readable: true,
  visible_scope_and_gaps: true,
  caps_within_limits: true
};

async function fixture({ invalidImage = false, invalidEvent = false, invalidScreenshotHash = false, privateText = false, fakePng = false, badPngCrc = false, truncatedPng = false, noIdatPng = false, omitInputManifest = false, boundEvaluationSha256 = null, evaluationBytes = null, noEffect = null, sameAxDifferentScreenshot = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-map-gate-a-")));
  const candidate = join(root, "candidate");
  await mkdir(join(candidate, "screenshots"), { recursive: true });
  const beforePath = "screenshots/event-0001-before.png";
  const afterPath = "screenshots/event-0001-after.png";
  let malformedPng = null;
  if (fakePng) {
    malformedPng = Buffer.alloc(40);
    PNG.subarray(0, 8).copy(malformedPng, 0);
    malformedPng.writeUInt32BE(13, 8);
    malformedPng.write("IHDR", 12, "ascii");
    malformedPng.writeUInt32BE(1, 16);
    malformedPng.writeUInt32BE(1, 20);
    malformedPng.write("IEND", 28, "ascii");
  } else if (badPngCrc) {
    malformedPng = Buffer.from(PNG);
    malformedPng[malformedPng.length - 1] ^= 0xff;
  } else if (truncatedPng) malformedPng = PNG.subarray(0, PNG.length - 5);
  else if (noIdatPng) malformedPng = Buffer.concat([PNG.subarray(0, 33), PNG.subarray(PNG.length - 12)]);
  const afterBytes = noEffect?.screenshot ?? (sameAxDifferentScreenshot ? OTHER_PNG : PNG);
  await writeFile(join(candidate, beforePath), invalidImage ? Buffer.from("x") : malformedPng ?? PNG);
  await writeFile(join(candidate, afterPath), afterBytes);
  const before = evidence(beforePath, privateText ? "Contact alice@example.test" : "Starting page");
  // noEffect drives the transition_kind "none" (no-effect-action) fixture family: `method` sets the
  // action that produced no change, `afterText` optionally makes before/after genuinely differ (to
  // prove a false "nothing changed" claim is still refused), and `screenshot` optionally gives the
  // after state a genuinely different retained image while the text stays put (same proof, other
  // channel). `sameAxDifferentScreenshot` is the solid-side mirror: text unchanged (so the
  // accessibility hash matches) but the screenshot legitimately differs -- a real transition.
  const after = noEffect
    ? { ...evidence(afterPath, noEffect.afterText ?? (privateText ? "Contact alice@example.test" : "Starting page")), screenshot_sha256: sha(afterBytes) }
    : sameAxDifferentScreenshot
      ? { ...evidence(afterPath, privateText ? "Contact alice@example.test" : "Starting page"), screenshot_sha256: sha(afterBytes) }
      : evidence(afterPath, "Changed page");
  if (invalidScreenshotHash) after.screenshot_sha256 = "0".repeat(64);
  const event = {
    run_id: "run-fixture", event_id: "event-0001", timestamp: "2026-09-03T12:00:00.000Z", current_url: "https://example.test/", current_origin: "https://example.test", visible_state_summary: noEffect ? (noEffect.afterText ?? "Starting page") : "Changed page", before, after,
    intended_action: { method: noEffect ? noEffect.method ?? "click" : "click", ref: "e1" }, effect_evidence: null, action_matrix_class: "Observe", observed_outcome: noEffect ? "no visible effect" : "clicked", outcome_detail: null, screenshot_path: afterPath, evidence_provenance: "direct-browser-observation", transition_kind: noEffect ? "none" : invalidEvent ? "solid" : "solid",
    elapsed_browser_seconds: 1, cumulative_browser_actions: 1, cumulative_browser_requests: 1, cumulative_app_actual_eur: 0, cumulative_model_actual_eur: 0, outstanding_cost_reservation_eur: 0
  };
  await writeFile(join(candidate, "observations.jsonl"), `${JSON.stringify(event)}\n`);
  await writeFile(join(candidate, "explorer-result.json"), JSON.stringify({ status: "done", stop_reason: "explicit_done" }));
  await writeFile(join(candidate, "production-run-report.json"), JSON.stringify({ schema_version: 1, run_id: "run-fixture", candidate_eligible: true }));
  await writeFile(join(candidate, "map.html"), `<!doctype html><html><body><img src="data:image/png;base64,${(malformedPng ?? PNG).toString("base64")}"><img src="data:image/png;base64,${afterBytes.toString("base64")}"><code>event-0001</code></body></html>`);

  const evaluation = join(root, "sealed-evaluation.json");
  await writeFile(evaluation, evaluationBytes ?? JSON.stringify(gateEvaluation()));
  const evaluationSha256 = sha(await readFile(evaluation));
  const inputManifest = {
    schema_version: 1,
    record_kind: "spike-a-fresh-bounded-run-input-manifest",
    run_id: "run-fixture",
    owner_input_hashes: { "gate-a-evaluation.json": boundEvaluationSha256 ?? evaluationSha256 },
    owner_inputs_sealed_before_broker_start: true,
    public_pack: { sha256: "b".repeat(64) },
    private_control_contents_disclosed: false,
    private_identifiers_disclosed: false,
    gate_a_evaluation_mounted_in_model_sandboxes: false,
    product_state_authority: "first-retained-browser-observation"
  };
  if (!omitInputManifest) await writeFile(join(candidate, "input-manifest.json"), JSON.stringify(inputManifest));

  const files = [];
  for (const path of ["map.html", "observations.jsonl", "explorer-result.json", "production-run-report.json", beforePath, afterPath, ...(omitInputManifest ? [] : ["input-manifest.json"])]) {
    const bytes = await readFile(join(candidate, path));
    files.push({ path, bytes: bytes.byteLength, sha256: sha(bytes) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const core = { schema_version: 1, run_id: "run-fixture", files };
  await writeFile(join(candidate, "manifest.json"), `${JSON.stringify({ ...core, candidate_sha256: sha(`${JSON.stringify(core, null, 2)}\n`) }, null, 2)}\n`);
  return { root, candidate, evaluation, now: Date.parse("2026-09-03T12:00:00.000Z") };
}

async function run(value, { mutate = null, score = 2, conditions = necessaryConditions, monotonicNow = (() => { let n = 0; return () => n += 1; })(), reviewerInputPath = join(value.root, "reviewer-input.json"), receiptPath = join(value.root, "receipt.json") } = {}) {
  const input = new PassThrough();
  const outputChunks = [];
  let review;
  const output = { write(chunk) {
    outputChunks.push(String(chunk));
    if (!review) {
      const ready = JSON.parse(String(chunk));
      review = { schema_version: 1, kind: "gate-a-review", review_id: ready.review_id, candidate_sha256: ready.candidate_sha256, evaluation_sha256: ready.evaluation_sha256, answers: ["journey-one", "journey-two", "honesty"].map((question_id) => ({ question_id, score, answer: "Supported by the artifact.", citations: [{ event_id: "event-0001", screenshot_path: "screenshots/event-0001-after.png" }] })), necessary_conditions: conditions, qualitative_judgments: { communicates_public_promises: "yes", adds_useful_or_valid_novel_paths: "partial", exposes_gaps: "yes", misleads: "no" } };
      if (mutate) mutate();
      input.end(`${JSON.stringify(review)}\n`);
    }
  } };
  const result = await runGateAReview({ candidatePath: value.candidate, evaluationPath: value.evaluation, reviewerInputPath, receiptPath, input, output, wallNow: () => value.now, monotonicNow });
  return { result, receiptPath, output: outputChunks.join(""), review };
}

test("one process snapshots candidate before private evaluation input, then publishes a bound receipt", async () => {
  const value = await fixture();
  try {
    const result = await run(value);
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
    assert.equal(result.result.status, "pass");
    assert.equal(receipt.status, "pass");
    assert.equal(receipt.candidate_sha256, result.review.candidate_sha256);
    assert.equal(receipt.evaluation_sha256, result.review.evaluation_sha256);
    assert.match(result.output, /gate-a-session-ready/);
    assert.match(result.output, /gate-a-receipt-published/);
    assert.doesNotMatch(result.output, /sealed-evaluation|journey-one|\/private\/|\/var\/folders\//);
    await assert.rejects(() => readFile(join(value.root, "reviewer-input.json")));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("requires exactly the fresh-user necessary-condition contract", async (context) => {
  await context.test("the six revised conditions pass when all are true", async () => {
    const value = await fixture();
    try {
      const result = await run(value);
      assert.equal(result.result.status, "pass");
      assert.deepEqual(result.review.necessary_conditions, necessaryConditions);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  await context.test("the legacy two-journey condition is rejected", async () => {
    const value = await fixture();
    try {
      const legacyConditions = { two_distinct_meaningful_journeys: true, zero_unsupported_solid_transitions: true, facts_claims_inferences_unmistakable: true, html_screenshots_readable: true, caps_within_limits: true };
      await assert.rejects(() => run(value, { conditions: legacyConditions }), /necessary conditions are invalid/);
      await assert.rejects(() => readFile(join(value.root, "receipt.json")));
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  for (const condition of Object.keys(necessaryConditions)) {
    await context.test(`${condition} fails the gate when false`, async () => {
      const value = await fixture();
      try {
        const result = await run(value, { conditions: { ...necessaryConditions, [condition]: false } });
        assert.equal(result.result.status, "fail");
      } finally { await rm(value.root, { recursive: true, force: true }); }
    });
  }
});

test("review judgment emits fail, while candidate/evaluation changes during review emit no receipt", async (context) => {
  const value = await fixture();
  try {
    const changed = await fixture();
    try { await assert.rejects(() => run(changed, { mutate: () => writeFileSync(join(changed.candidate, "map.html"), "changed") }), /candidate changed|hash mismatch/); await assert.rejects(() => readFile(join(changed.root, "receipt.json"))); } finally { await rm(changed.root, { recursive: true, force: true }); }
    const evalChanged = await fixture();
    try { await assert.rejects(() => run(evalChanged, { mutate: () => writeFileSync(evalChanged.evaluation, "changed") }), /evaluation changed|invalid JSON/); await assert.rejects(() => readFile(join(evalChanged.root, "receipt.json"))); } finally { await rm(evalChanged.root, { recursive: true, force: true }); }
    await context.test("a valid low score produces a fail receipt", async () => {
      const low = await fixture();
      try {
        const lowRun = await run(low, { score: 1 });
        const body = JSON.parse(await readFile(lowRun.receiptPath, "utf8"));
        assert.equal(body.status, "fail");
      } finally { await rm(low.root, { recursive: true, force: true }); }
    });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("a sealed evaluation swapped for different, still-valid rich content mid-review is drift and is refused", async () => {
  const value = await fixture();
  try {
    const swapped = Buffer.from(JSON.stringify(gateEvaluation("drifted.2")));
    assert.doesNotThrow(() => validateGateAEvaluation(JSON.parse(swapped)));
    await assert.rejects(() => run(value, { mutate: () => writeFileSync(value.evaluation, swapped) }), /evaluation changed/);
    await assert.rejects(() => readFile(join(value.root, "receipt.json")));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("the same rich evaluation that satisfies validateGateAEvaluation also drives a passing runGateAReview", async () => {
  const evaluation = gateEvaluation("integration.1");
  assert.doesNotThrow(() => validateGateAEvaluation(evaluation));
  const value = await fixture({ evaluationBytes: JSON.stringify(evaluation) });
  try {
    const result = await run(value);
    assert.equal(result.result.status, "pass");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("a no-effect click or type is a legitimate finding, matching what the packager and renderer already accept", async (context) => {
  for (const method of ["click", "type", "observe", "scroll"]) {
    await context.test(`method ${method} with identical before/after passes`, async () => {
      const value = await fixture({ noEffect: { method } });
      try {
        const result = await run(value);
        assert.equal(result.result.status, "pass");
      } finally { await rm(value.root, { recursive: true, force: true }); }
    });
  }

  await context.test("a no-effect claim whose before/after actually differ is still refused", async () => {
    const value = await fixture({ noEffect: { method: "click", afterText: "Changed page" } });
    try {
      await assert.rejects(() => run(value), /no-transition event is invalid/);
      await assert.rejects(() => readFile(join(value.root, "receipt.json")));
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  await context.test("a no-effect claim on an unsupported method (navigate) is still refused", async () => {
    const value = await fixture({ noEffect: { method: "navigate" } });
    try {
      await assert.rejects(() => run(value), /no-transition event is invalid/);
      await assert.rejects(() => readFile(join(value.root, "receipt.json")));
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  // The accessibility tree can stay identical while the screen visibly changes (an answer box
  // filling in, a scroll repainting the viewport) -- the real bug this fixture family guards
  // against. A "no effect" claim must look at BOTH channels, not just the accessibility hash.
  await context.test("a no-effect claim whose screenshot actually changed is still refused", async () => {
    const value = await fixture({ noEffect: { method: "click", screenshot: OTHER_PNG } });
    try {
      await assert.rejects(() => run(value), /no-transition event is invalid/);
      await assert.rejects(() => readFile(join(value.root, "receipt.json")));
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});

test("a solid transition is accepted on a screenshot-only change (accessibility tree unchanged)", async () => {
  const value = await fixture({ sameAxDifferentScreenshot: true });
  try {
    const result = await run(value);
    assert.equal(result.result.status, "pass");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

for (const [name, setup] of [
  ["skeletal event", async () => { const value = await fixture({ invalidEvent: true }); const trace = JSON.parse(await readFile(join(value.candidate, "observations.jsonl"))); delete trace.before; await writeFile(join(value.candidate, "observations.jsonl"), `${JSON.stringify(trace)}\n`); return value; }],
  ["one-byte image", async () => fixture({ invalidImage: true })],
  ["40-byte fake PNG", async () => fixture({ fakePng: true })],
  ["bad PNG CRC", async () => fixture({ badPngCrc: true })],
  ["truncated PNG", async () => fixture({ truncatedPng: true })],
  ["PNG without IDAT", async () => fixture({ noIdatPng: true })],
  ["wrong screenshot hash", async () => fixture({ invalidScreenshotHash: true })],
  ["text PII", async () => fixture({ privateText: true })],
  ["missing rubric fields", async () => { const value = await fixture(); await writeFile(value.evaluation, JSON.stringify({ schema_version: 1, questions: [{ id: "q1" }] })); return value; }],
  ["missing candidate input-manifest.json", async () => fixture({ omitInputManifest: true })],
  ["input manifest bound to the wrong evaluation hash", async () => fixture({ boundEvaluationSha256: "f".repeat(64) })],
  ["legacy compact evaluation schema", async () => fixture({ evaluationBytes: JSON.stringify({ schema_version: 1, questions: [{ id: "journey-one", expectedAnswerElements: ["evidence"], evidenceRequirements: { minimumCitations: 1, requiredTypes: ["event", "screenshot"] }, scoring: { "0": "wrong", "1": "partial", "2": "correct" } }] }) })]
]) {
  test(`refuses ${name} before reviewer input`, async () => {
    const value = await setup();
    try { await assert.rejects(() => run(value)); await assert.rejects(() => readFile(join(value.root, "receipt.json"))); } finally { await rm(value.root, { recursive: true, force: true }); }
  });
}

test("monotonic deadline, overwrite, receipt-inside-candidate, and path alias all fail closed", async () => {
  const late = await fixture();
  try { let calls = 0; await assert.rejects(() => run(late, { monotonicNow: () => calls++ === 0 ? 0 : 600_001 }), /window elapsed/); await assert.rejects(() => readFile(join(late.root, "receipt.json"))); } finally { await rm(late.root, { recursive: true, force: true }); }
  const value = await fixture();
  try {
    await writeFile(join(value.root, "receipt.json"), "existing");
    await assert.rejects(() => run(value), /already exists/);
    await assert.rejects(() => runGateAReview({ candidatePath: value.candidate, evaluationPath: value.evaluation, reviewerInputPath: join(value.root, "input.json"), receiptPath: join(value.candidate, "receipt.json"), input: new PassThrough(), output: { write() {} } }), /outside candidate/);
    await symlink(value.root, join(value.root, "alias"));
    await assert.rejects(() => runGateAReview({ candidatePath: value.candidate, evaluationPath: value.evaluation, reviewerInputPath: join(value.root, "alias", "input.json"), receiptPath: join(value.root, "alias", "receipt2.json"), input: new PassThrough(), output: { write() {} } }), /alias|symlink/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("a control-directory symlink swap is refused before receipt publication", async () => {
  const value = await fixture();
  const control = join(value.root, "control");
  await mkdir(control);
  try {
    await assert.rejects(() => run(value, {
      reviewerInputPath: join(control, "reviewer-input.json"),
      receiptPath: join(control, "receipt.json"),
      mutate: () => { rmSync(control, { recursive: true, force: true }); symlinkSync(value.candidate, control); }
    }), /symlink|alias/);
    await assert.rejects(() => readFile(join(value.root, "control", "receipt.json")));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
