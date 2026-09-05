import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageCandidate, scanText } from "../lib/candidate-packager.mjs";
import { renderMap } from "../renderer/render-map.mjs";

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function cleanup(root) {
  for (const name of ["artifact-one", "artifact-two", "artifact-race"]) {
    await chmod(join(root, name, "screenshots"), 0o700).catch(() => {});
    await chmod(join(root, name), 0o700).catch(() => {});
  }
  await rm(root, { recursive: true, force: true });
}

async function fixture({ runId = "run-fixture", reportRunId = runId } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-map-candidate-")));
  const run = join(root, runId);
  await mkdir(join(run, "screenshots"), { recursive: true });
  const before = join(run, "screenshots/event-0001-before.png");
  const after = join(run, "screenshots/event-0001-after.png");
  await writeFile(before, PIXEL);
  await writeFile(after, PIXEL);
  const evidence = (path) => ({ url: "https://example.test/", origin: "https://example.test", visible_state_summary: "A visible page", observation_hash: sha(JSON.stringify({ url: "https://example.test/", visible_state_summary: "A visible page" })), screenshot_path: `screenshots/${path.split("/").at(-1)}`, screenshot_sha256: sha(PIXEL) });
  const event = {
    run_id: runId, event_id: "event-0001", timestamp: "2026-09-03T12:00:00.000Z", current_url: "https://example.test/", current_origin: "https://example.test",
    before: evidence(before), after: { ...evidence(after), visible_state_summary: "A changed page", observation_hash: sha(JSON.stringify({ url: "https://example.test/", visible_state_summary: "A changed page" })) }, intended_action: { method: "click", ref: "e1" },
    effect_evidence: { supervisor_authorized: true, mutation_request_match: null }, action_matrix_class: "Reversible own-account", observed_outcome: "clicked",
    evidence_provenance: "direct-browser-observation", transition_kind: "solid"
  };
  await writeFile(join(run, "observations.jsonl"), `${JSON.stringify(event)}\n`);
  const publicPack = { schema_version: 1, product_summary: "Public product", claims: [{ id: "claim", kind: "promise", text: "A bounded public claim.", source_ids: ["source-001"] }], sources: [{ source_id: "source-001", initial_url: "https://public.example/", final_url: "https://public.example/", retrieved_at: "2026-09-03T00:00:00.000Z", status: 200, content_type: "text/html", redirect_chain: ["https://public.example/"], raw_sha256: "a".repeat(64), raw_bytes: 1, derived_text_sha256: "b".repeat(64), derived_text_bytes: 1 }] };
  const publicPackBytes = Buffer.from(`${JSON.stringify(publicPack)}\n`);
  const publicPackPath = join(root, "public-pack.json");
  await writeFile(publicPackPath, publicPackBytes);
  const publicPackSha256 = sha(publicPackBytes);
  await writeFile(join(run, "production-run-report.json"), `${JSON.stringify({
    schema_version: 1,
    run_id: reportRunId,
    public_pack_sha256: publicPackSha256,
    auth_cleanup_complete: true,
    identity_retirement_confirmed: true,
    cleanup_complete: true,
    candidate_eligible: true
  })}\n`);
  return { root, run, event, before, after, publicPackPath, publicPackSha256 };
}

test("production-redacted classified click renders with visibly embedded screenshots", async () => {
  const value = await fixture();
  try {
    const output = join(value.root, "map.html");
    await renderMap({ tracePath: join(value.run, "observations.jsonl"), outputPath: output });
    const html = await readFile(output, "utf8");
    assert.match(html, /data:image\/png;base64,/);
    assert.doesNotMatch(html, /href="screenshots/);
  } finally { await cleanup(value.root); }
});

test("renderer rejects unapproved redacted effects and provenance-only dashed edges", async () => {
  const value = await fixture();
  try {
    const trace = JSON.parse(await readFile(join(value.run, "observations.jsonl"), "utf8"));
    trace.effect_evidence = { mutation_request_match: true };
    await writeFile(join(value.run, "observations.jsonl"), `${JSON.stringify(trace)}\n`);
    await assert.rejects(() => renderMap({ tracePath: join(value.run, "observations.jsonl"), outputPath: join(value.root, "bad.html") }), /supervisor authorization/);
    trace.effect_evidence = { supervisor_authorized: true, mutation_request_match: null };
    trace.transition_kind = "dashed";
    trace.evidence_provenance = "public-claim";
    await writeFile(join(value.run, "observations.jsonl"), `${JSON.stringify(trace)}\n`);
    await assert.rejects(() => renderMap({ tracePath: join(value.run, "observations.jsonl"), outputPath: join(value.root, "bad-dashed.html") }), /source evidence/);
  } finally { await cleanup(value.root); }
});

test("bound-route traces disclose temporal-only mutation assurance and make route exit final", async () => {
  const value = await fixture();
  try {
    const tracePath = join(value.run, "observations.jsonl");
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    trace.action_matrix_class = "Bounded own-account bound-route progress";
    trace.effect_evidence = {
      supervisor_authorized: true,
      authorization_consumed_once: true,
      mutation_window: "input-dispatch-through-after-evidence",
      mutation_association: "temporal-only",
      same_origin_mutation_requests_dispatched: 1,
      outside_window_mutation_policy: "block-and-abort"
    };
    trace.observed_outcome = "route-scope-exit";
    trace.before.url = "https://example.test/bound-route";
    trace.after.url = "https://example.test/next";
    trace.before.observation_hash = sha(JSON.stringify({ url: trace.before.url, visible_state_summary: trace.before.visible_state_summary }));
    trace.after.observation_hash = sha(JSON.stringify({ url: trace.after.url, visible_state_summary: trace.after.visible_state_summary }));
    trace.current_url = trace.after.url;
    await writeFile(tracePath, `${JSON.stringify(trace)}\n`);
    const output = join(value.root, "bounded.html");
    await renderMap({ tracePath, outputPath: output });
    const rendered = await readFile(output, "utf8");
    assert.match(rendered, /Mutation association: temporal-only/);
    assert.match(rendered, /CDP cannot establish click causality/);
    assert.doesNotMatch(rendered, /onboarding/i);

    await writeFile(tracePath, `${JSON.stringify(trace)}\n${JSON.stringify({ ...trace, event_id: "event-0002" })}\n`);
    await assert.rejects(() => renderMap({ tracePath, outputPath: join(value.root, "not-final.html") }), /bound-route exit/);
  } finally { await cleanup(value.root); }
});

test("renderer preserves an honest final unknown terminal with retained after evidence", async () => {
  const value = await fixture();
  try {
    const trace = JSON.parse(await readFile(join(value.run, "observations.jsonl"), "utf8"));
    trace.transition_kind = "unknown-terminal";
    trace.observed_outcome = "unknown-terminal";
    trace.effect_evidence = null;
    await writeFile(join(value.run, "observations.jsonl"), `${JSON.stringify(trace)}\n`);
    const output = join(value.root, "unknown.html");
    await renderMap({ tracePath: join(value.run, "observations.jsonl"), outputPath: output });
    assert.match(await readFile(output, "utf8"), /terminal|data:image\/png;base64,/);
    await writeFile(join(value.run, "observations.jsonl"), `${JSON.stringify(trace)}\n${JSON.stringify({ ...trace, event_id: "event-0002" })}\n`);
    await assert.rejects(() => renderMap({ tracePath: join(value.run, "observations.jsonl"), outputPath: join(value.root, "later.html") }), /Unknown terminal/);
  } finally { await cleanup(value.root); }
});

test("candidate packaging tolerates hex digests and float seconds that merely look card-shaped", async () => {
  const value = await fixture();
  try {
    // A sha256 hex digest and a long decimal expansion both routinely contain 13-19 unbroken digits;
    // neither is a real card number (they fail the Luhn check the scanner now requires).
    await writeFile(join(value.run, "explorer-result.json"), JSON.stringify({
      screenshot_sha256: "9a1182657145621ab3f8c0d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5",
      elapsed_browser_seconds: 12.345678901234567
    }));
    const output = join(value.root, "artifact-hex-float");
    await packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: output, publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 });
  } finally {
    await chmod(join(value.root, "artifact-hex-float", "screenshots"), 0o700).catch(() => {});
    await chmod(join(value.root, "artifact-hex-float"), 0o700).catch(() => {});
    await rm(value.root, { recursive: true, force: true });
  }
});

test("candidate packaging still refuses a real card number", async () => {
  const value = await fixture();
  try {
    // Standard Visa test PAN: 16 digits, passes the Luhn checksum, not embedded in a longer token.
    await writeFile(join(value.run, "explorer-result.json"), JSON.stringify({ reason: "card 4111111111111111 declined" }));
    await assert.rejects(() => packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: join(value.root, "artifact-card"), publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 }), /PII-shaped/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("allowExactStrings exempts only the exact listed benign text, never a broader class", async () => {
  const value = await fixture();
  try {
    // A target's own real public support address plus a literal docs placeholder -- exactly the
    // shape a source-blind run of someone else's real site turns up (see cal.com's own captured
    // trace), never actual leaked PII.
    await writeFile(join(value.run, "explorer-result.json"), JSON.stringify({ reason: "contact support@cal.com or use Bearer YOUR_API_KEY" }));
    const output = join(value.root, "artifact-allowed");
    const result = await packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: output, publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256, allowExactStrings: ["support@cal.com", "Bearer YOUR_API_KEY"] });
    assert.equal(result.run_id, "run-fixture");
    const report = JSON.parse(await readFile(join(output, "explorer-result.json"), "utf8"));
    // The allow-list only redacts the SCAN COPY -- the retained file keeps the real, untouched text.
    assert.equal(report.reason, "contact support@cal.com or use Bearer YOUR_API_KEY");
  } finally {
    await chmod(join(value.root, "artifact-allowed", "screenshots"), 0o700).catch(() => {});
    await chmod(join(value.root, "artifact-allowed"), 0o700).catch(() => {});
    await rm(value.root, { recursive: true, force: true });
  }
  // The same allow-list does nothing for a DIFFERENT email/token it wasn't given -- proves this
  // isn't a general loosening of the email/Bearer patterns.
  const other = await fixture();
  try {
    await writeFile(join(other.run, "explorer-result.json"), JSON.stringify({ reason: "contact someone-else@cal.com" }));
    await assert.rejects(() => packageCandidate({ runId: "run-fixture", runPath: other.run, outputPath: join(other.root, "artifact-still-blocked"), publicPackPath: other.publicPackPath, publicPackSha256: other.publicPackSha256, allowExactStrings: ["support@cal.com"] }), /PII-shaped/);
  } finally { await rm(other.root, { recursive: true, force: true }); }
});

test("candidate packaging fails closed on tampering, run mismatch, and credential-shaped text", async () => {
  const tampered = await fixture();
  try {
    await writeFile(tampered.after, Buffer.from("tampered"));
    await assert.rejects(() => packageCandidate({ runId: "run-fixture", runPath: tampered.run, outputPath: join(tampered.root, "artifact"), publicPackPath: tampered.publicPackPath, publicPackSha256: tampered.publicPackSha256 }), /hash mismatch/);
  } finally { await rm(tampered.root, { recursive: true, force: true }); }
  const mismatched = await fixture({ reportRunId: "other-run" });
  try {
    await assert.rejects(() => packageCandidate({ runId: "run-fixture", runPath: mismatched.run, outputPath: join(mismatched.root, "artifact"), publicPackPath: mismatched.publicPackPath, publicPackSha256: mismatched.publicPackSha256 }), /run id/);
  } finally { await rm(mismatched.root, { recursive: true, force: true }); }
  const pii = await fixture();
  try {
    await writeFile(join(pii.run, "explorer-result.json"), JSON.stringify({ reason: "contact learner@example.com" }));
    await assert.rejects(() => packageCandidate({ runId: "run-fixture", runPath: pii.run, outputPath: join(pii.root, "artifact"), publicPackPath: pii.publicPackPath, publicPackSha256: pii.publicPackSha256 }), /PII-shaped/);
  } finally { await rm(pii.root, { recursive: true, force: true }); }
});

test("candidate packaging requires separate confirmed auth cleanup and identity retirement", async () => {
  for (const field of ["auth_cleanup_complete", "identity_retirement_confirmed", "cleanup_complete"]) {
    const value = await fixture();
    try {
      const reportPath = join(value.run, "production-run-report.json");
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      report[field] = false;
      await writeFile(reportPath, `${JSON.stringify(report)}\n`);
      await assert.rejects(
        () => packageCandidate({
          runId: "run-fixture",
          runPath: value.run,
          outputPath: join(value.root, `artifact-${field}`),
          publicPackPath: value.publicPackPath,
          publicPackSha256: value.publicPackSha256
        }),
        /not candidate-eligible/
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("candidate manifest is sorted and deterministic, and the output is exclusive", async () => {
  const value = await fixture();
  try {
    const first = await packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: join(value.root, "artifact-one"), publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 });
    const second = await packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: join(value.root, "artifact-two"), publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 });
    assert.equal(first.candidate_sha256, second.candidate_sha256);
    assert.deepEqual(await readFile(join(value.root, "artifact-one", "manifest.json")), await readFile(join(value.root, "artifact-two", "manifest.json")));
    const manifest = JSON.parse(await readFile(join(value.root, "artifact-one", "manifest.json"), "utf8"));
    assert.deepEqual(manifest.files.map((file) => file.path), [...manifest.files].map((file) => file.path).sort());
    await assert.rejects(() => packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: join(value.root, "artifact-one"), publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 }), /already exists/);
  } finally { await cleanup(value.root); }
});

test("sanitized request-events.jsonl is approved and copied into the candidate", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.run, "request-events.jsonl"), `${JSON.stringify({ timestamp: "2026-09-04T11:33:09.505Z", outcome: "allowed-dispatched", url: "https://example.test/", method: "GET", resource_type: "Document" })}\n`);
    const output = join(value.root, "artifact-request-events");
    const result = await packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: output, publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 });
    assert.ok(result.files.some((file) => file.path === "request-events.jsonl"));
    assert.deepEqual(await readFile(join(output, "request-events.jsonl")), await readFile(join(value.run, "request-events.jsonl")));
  } finally {
    await chmod(join(value.root, "artifact-request-events", "screenshots"), 0o700).catch(() => {});
    await chmod(join(value.root, "artifact-request-events"), 0o700).catch(() => {});
    await rm(value.root, { recursive: true, force: true });
  }
});

test("candidate packaging rejects an output parent symlink", async () => {
  const value = await fixture();
  try {
    const realParent = join(value.root, "real-artifacts");
    const linkParent = join(value.root, "linked-artifacts");
    await mkdir(realParent);
    await symlink(realParent, linkParent);
    await assert.rejects(() => packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: join(linkParent, "artifact"), publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 }), /symlink/);
  } finally { await cleanup(value.root); }
});

test("dashed evidence requires and records the exact public-pack binding", async () => {
  const value = await fixture();
  try {
    const tracePath = join(value.run, "observations.jsonl");
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    trace.transition_kind = "dashed";
    trace.evidence_provenance = "public-claim";
    trace.citation = { claim_id: "claim", source_id: "source-001", source_url: "https://public.example/", excerpt: "A bounded public claim." };
    await writeFile(tracePath, `${JSON.stringify(trace)}\n`);
    const substitutedPackPath = join(value.root, "substituted-pack.json");
    const substitutedPackBytes = Buffer.from((await readFile(value.publicPackPath, "utf8")).replace("Public product", "Substituted product"));
    await writeFile(substitutedPackPath, substitutedPackBytes);
    await assert.rejects(() => packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: join(value.root, "substituted-artifact"), publicPackPath: substitutedPackPath, publicPackSha256: sha(substitutedPackBytes) }), /public-pack binding/);
    trace.citation.excerpt = "Fabricated statement.";
    await writeFile(tracePath, `${JSON.stringify(trace)}\n`);
    await assert.rejects(() => packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: join(value.root, "fabricated-artifact"), publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 }), /bounded public-pack claim/);
    trace.citation.excerpt = "A bounded public claim.";
    await writeFile(tracePath, `${JSON.stringify(trace)}\n`);
    const output = join(value.root, "artifact");
    const result = await packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: output, publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 });
    assert.equal(result.candidate_sha256.length, 64);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.public_pack.sha256, value.publicPackSha256);
  } finally {
    await chmod(join(value.root, "artifact", "screenshots"), 0o700).catch(() => {});
    await chmod(join(value.root, "artifact"), 0o700).catch(() => {});
    await rm(value.root, { recursive: true, force: true });
  }
});

test("concurrent packaging serializes the final output name", async () => {
  const value = await fixture();
  try {
    const options = { runId: "run-fixture", runPath: value.run, outputPath: join(value.root, "artifact-race"), publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 };
    const results = await Promise.allSettled([packageCandidate(options), packageCandidate(options)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && /reserved|already exists/.test(result.reason.message)).length, 1);
    const leftovers = (await readdir(value.root)).filter((name) => name.includes("candidate-staging") || name.endsWith(".lock"));
    assert.deepEqual(leftovers, []);
  } finally { await cleanup(value.root); }
});

test("a screenshot no event references still refuses, naming the file and what to do", async () => {
  const value = await fixture();
  try {
    // A leaked screenshot from a step that captured evidence but never recorded an event for it --
    // exactly the shape lib/explore-mcp.mjs's act()/record() leak used to leave behind.
    await writeFile(join(value.run, "screenshots/state-0099.png"), PIXEL);
    const output = join(value.root, "artifact-leaked");
    await assert.rejects(
      () => packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: output, publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 }),
      (error) => {
        assert.match(error.message, /unreferenced retained screenshot state-0099\.png/);
        // The rule stays exactly as strict (still refuses), but the message says what is wrong and
        // what an operator can do about it, rather than looking like a transient failure.
        assert.match(error.message, /no event in observations\.jsonl points to it/);
        assert.match(error.message, /remove this file|add the event/);
        return true;
      },
    );
    const leftovers = (await readdir(value.root)).filter((name) => name === "artifact-leaked.lock" || name.includes("candidate-staging"));
    assert.deepEqual(leftovers, []);
  } finally { await cleanup(value.root); }
});

test("pre-stage root validation leaves no lock or staging directory and permits retry", async () => {
  const value = await fixture();
  const output = join(value.root, "artifact-retry");
  try {
    await writeFile(join(value.run, "unapproved-private-log.jsonl"), "private\n");
    await assert.rejects(() => packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: output, publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 }), /unapproved retained file/);
    const leftovers = (await readdir(value.root)).filter((name) => name === "artifact-retry.lock" || name.includes("candidate-staging"));
    assert.deepEqual(leftovers, []);
    await rm(join(value.run, "unapproved-private-log.jsonl"));
    await packageCandidate({ runId: "run-fixture", runPath: value.run, outputPath: output, publicPackPath: value.publicPackPath, publicPackSha256: value.publicPackSha256 });
  } finally {
    await chmod(join(output, "screenshots"), 0o700).catch(() => {});
    await chmod(output, 0o700).catch(() => {});
    await rm(value.root, { recursive: true, force: true });
  }
});

test("the credential scan ignores base64 image payloads but still reads everything around them", () => {

  // The exact fragments that refused two real candidates: both are stretches of a PNG inlined in
  // the rendered map, not anything a person wrote or could read.
  const png = "3fddVfkFKtXr66rq7v//vuLiz1fkIZjyubm5lhODJ87dy6ijTlz+6777677767rq7vAAA=";
  assert.doesNotThrow(() => scanText(Buffer.from(`<img src="data:image/png;base64,${png}">`), "map.html"));
  // The same run outside a payload is still a phone number, and the gate still fires.
  assert.throws(() => scanText(Buffer.from("call me on +6777677767 today"), "map.html"), /credential or PII-shaped/);
  // Text sitting next to a payload is scanned exactly as before -- only the payload is dropped.
  assert.throws(
    () => scanText(Buffer.from(`<img src="data:image/png;base64,${png}"> owner@example.com`), "map.html"),
    /credential or PII-shaped/,
  );
  // A data: URI that is not an image payload keeps being scanned in full.
  assert.throws(
    () => scanText(Buffer.from('data:text/plain;charset=utf8,CLERK_SECRET_KEY=sk_live_abcdefghijkl'), "map.html"),
    /credential or PII-shaped/,
  );
});

test("the credential scan tells a product's own /users route from a real local filesystem path", () => {
  // marker.io's own front end requests "/users/me". Case-insensitive matching read that as macOS's
  // /Users/ home root and refused the whole candidate.
  assert.doesNotThrow(() => scanText(Buffer.from('{"path":"/users/me"}'), "request-events.jsonl"));
  assert.doesNotThrow(() => scanText(Buffer.from('{"path":"/private-beta/signup"}'), "request-events.jsonl"));
  // A real leaked path still fails, in every root the scan knows.
  assert.throws(
    () => scanText(Buffer.from('at "/Users/someone/Projects/lab/run.mjs" line 4'), "observations.jsonl"),
    /credential or PII-shaped/,
  );
  assert.throws(
    () => scanText(Buffer.from('at "/var/folders/xy/T/midscene/cache.json"'), "observations.jsonl"),
    /credential or PII-shaped/,
  );
});

test("the credential scan tells a real key from the word API in a sentence", () => {
  // DebugBear's own blog title. "API: Discover" read as a key assignment and refused the candidate.
  assert.doesNotThrow(() =>
    scanText(Buffer.from("Blog > PageSpeed Insights API: Discover Web Performance Insights"), "observations.jsonl"),
  );
  assert.doesNotThrow(() => scanText(Buffer.from("Access: Everyone on your team"), "observations.jsonl"));
  // A value that actually looks like a secret still fails, in each shape it really appears in.
  assert.throws(
    () => scanText(Buffer.from('"apiKey": "9f2ca41beed3"'), "observations.jsonl"),
    /credential or PII-shaped/,
  );
  assert.throws(
    () => scanText(Buffer.from("https://x.test/v1?api_key=9f2ca41beed3"), "request-events.jsonl"),
    /credential or PII-shaped/,
  );
  assert.throws(
    () => scanText(Buffer.from("CLERK_SECRET_KEY=sk_live_abcdefghijkl"), "observations.jsonl"),
    /credential or PII-shaped/,
  );
});

test("the credential scan tells a retina asset name from an email address", () => {
  // DebugBear requests /public/title-bear@2x.png, which parses as title-bear @ 2x . png.
  assert.doesNotThrow(() =>
    scanText(Buffer.from('{"method":"GET","path":"/public/title-bear@2x.png"}'), "request-events.jsonl"),
  );
  assert.doesNotThrow(() => scanText(Buffer.from("/img/logo@3x.webp"), "request-events.jsonl"));
  assert.throws(
    () => scanText(Buffer.from("write to owner@example.com"), "observations.jsonl"),
    /credential or PII-shaped/,
  );
});
