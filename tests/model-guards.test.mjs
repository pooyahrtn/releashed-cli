import assert from "node:assert/strict";
import test from "node:test";
import { approvedModelIdentity, minimumOutputGuard, providerFailureReason, safeProviderFailureMetadata, validateApprovedModelPolicy } from "../lib/model-guards.mjs";

test("provider failure evidence keeps only allowlisted status and category", () => {
  assert.deepEqual(safeProviderFailureMetadata({ response: { status: 429, statusText: "contains a secret" } }), {
    provider_http_status: 429,
    provider_error_category: "http-non-success"
  });
  assert.deepEqual(safeProviderFailureMetadata({ error: new DOMException("key=do-not-log", "TimeoutError") }), {
    provider_http_status: null,
    provider_error_category: "timeout"
  });
});

test("provider reason is closed and never preserves arbitrary provider strings", () => {
  const arbitrary = { param: "super-secret-param", code: "untrusted-provider-code", message: "never retain this" };
  assert.equal(providerFailureReason({ status: 400, error: arbitrary }), "invalid-request-other");
  assert.equal(providerFailureReason({ status: 400, error: { param: "max_output_tokens" } }), "invalid-output-limit");
  assert.equal(providerFailureReason({ status: 429, error: { code: "insufficient_quota" } }), "quota");
  assert.doesNotMatch(JSON.stringify({ provider_reason: providerFailureReason({ status: 400, error: arbitrary }) }), /secret|untrusted|retain/);
});

test("the approved 16-token output floor refuses 8 before dispatch", () => {
  assert.equal(minimumOutputGuard({ maximum_output_tokens: 8 }, 16).ok, false);
  assert.equal(minimumOutputGuard({ maximum_output_tokens: 16 }, 16).ok, true);
});

test("only an explicit alias or named snapshot is an approved returned model", () => {
  const policy = { approved_alias: "gpt-5.6-terra", approved_snapshots: ["gpt-5.6-terra-2026-08-01"] };
  assert.equal(approvedModelIdentity(policy, "gpt-5.6-terra").approved, true);
  assert.equal(approvedModelIdentity(policy, "gpt-5.6-terra-2026-08-01").approved, true);
  assert.equal(approvedModelIdentity(policy, "gpt-5.6-terra-unknown").approved, false);
  assert.throws(() => validateApprovedModelPolicy({ approved_alias: "gpt-5.6-terra", approved_snapshots: ["x", "x"] }));
});
