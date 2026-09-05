import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUNDLE_CONTROL_FILES, createImmutableOwnerBundle } from "../lib/owner-bundle.mjs";
import { validateFreshStartContract } from "../lib/fresh-start-contract.mjs";
import { main } from "../scripts/create-owner-bundle.mjs";
import { verifyDisposableClerkIdentity } from "../supervisor/clerk-bootstrap.mjs";

const RUN = "fresh-run-1";
const ORIGIN = "https://clerk.example.test";
const SECRET = "sk_live_fixture_never_output";
const MARKER = "flowmap_cal_11111111111111111111111111111111";
const USER_ID = "user_new_fixture";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "owner-bundle-test-")));
	const base = join(root, "base");
	const parent = join(root, "bundles");
	await mkdir(base, { mode: 0o700 }); await mkdir(parent, { mode: 0o700 });
	for (const name of BUNDLE_CONTROL_FILES) {
		const value = name === "origin-allowlist.json"
			? { status: "pass", browser_request_dispatch: { allow: [{ origin: ORIGIN, purpose: "Clerk frontend/auth session transport only" }] } }
			: { status: "pass", fixture: name };
		await writeFile(join(base, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
		await chmod(join(base, name), 0o600);
	}
	return { root, base, parent };
}

function successfulProvision(events = []) {
	return async ({ onRecoveryMaterial }) => {
		events.push("provision");
		await onRecoveryMaterial({ state: "creation-pending", external_id: MARKER, user_id: null });
		await onRecoveryMaterial({ state: "identity-bound", external_id: MARKER, user_id: USER_ID });
		return { userId: USER_ID, cleanup: async () => { events.push("delete"); return { cleanup_complete: true }; } };
	};
}

function options(value, dependencies = {}) {
	return { baseOwnerDirectory: value.base, bundleParent: value.parent, runId: RUN, secretKey: SECRET, dependencies: { provisionIdentity: successfulProvision(), now: () => new Date("2026-09-04T12:00:00.000Z"), ...dependencies } };
}

async function interruptedBundle(value) {
	await assert.rejects(createImmutableOwnerBundle(options(value, {
		provisionIdentity: async ({ onRecoveryMaterial }) => {
			await onRecoveryMaterial({ state: "creation-pending", external_id: MARKER, user_id: null });
			throw new Error("simulated crash outcome");
		},
	})), /did not complete/);
	return join(value.parent, RUN);
}

async function recoveryRecord(bundle, fields) {
	const stateBytes = await readFile(join(bundle, "bundle-state.json"));
	return {
		schema_version: 1,
		kind: "spike-a-owner-bundle-recovery",
		run_id: RUN,
		bundle_state_sha256: hash(stateBytes),
		...fields,
	};
}

test("creates one exclusive private bundle with exact control copies and bound account", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	const result = await createImmutableOwnerBundle(options(value));
	assert.deepEqual(result, { schema_version: 1, status: "created", run_id: RUN });
	const bundle = join(value.parent, RUN);
	assert.equal((await lstat(bundle)).mode & 0o777, 0o700);
	for (const name of ["bundle-state.json", ...BUNDLE_CONTROL_FILES, "account.json", "fresh-start-contract.json", "bundle-completion.json"]) {
		assert.equal((await lstat(join(bundle, name))).mode & 0o777, 0o600);
	}
	for (const name of BUNDLE_CONTROL_FILES) assert.deepEqual(await readFile(join(bundle, name)), await readFile(join(value.base, name)));
	const accountBytes = await readFile(join(bundle, "account.json"));
	const account = JSON.parse(accountBytes);
	const contract = JSON.parse(await readFile(join(bundle, "fresh-start-contract.json")));
	assert.equal(contract.approved_account_binding.sha256, createHash("sha256").update(accountBytes).digest("hex"));
	validateFreshStartContract(contract, { runId: RUN, accountSha256: createHash("sha256").update(accountBytes).digest("hex"), account, clerkFrontendApiOrigin: ORIGIN });
	assert.equal(account.record_kind, "spike-a-synthetic-account");
	assert.equal(account.identity.classification, "fresh-disposable-synthetic-non-sensitive");
	assert.equal(account.observed_starting_state.session_created, false);
	assert.equal((await readdir(bundle)).includes("recovery.json"), false);
	assert.equal((await createImmutableOwnerBundle(options(value))).status, "already-created");
});

test("an unrelated destination collision is exclusive and never provisions", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	await mkdir(join(value.parent, RUN), { mode: 0o700 });
	await writeFile(join(value.parent, RUN, "foreign"), "keep");
	let called = false;
	await assert.rejects(createImmutableOwnerBundle(options(value, { provisionIdentity: async () => { called = true; } })), /did not complete/);
	assert.equal(called, false);
	assert.equal(await readFile(join(value.parent, RUN, "foreign"), "utf8"), "keep");
});

test("a crash recovery is reconciled before the clean retry provisions", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	await interruptedBundle(value);
	assert.equal((await lstat(join(value.parent, RUN, "recovery.json"))).mode & 0o777, 0o600);
	const events = [];
	const result = await createImmutableOwnerBundle(options(value, {
		reconcileRecovery: async ({ recovery }) => { events.push(`reconcile:${recovery.state}`); return { cleanup_complete: true }; },
		provisionIdentity: successfulProvision(events),
	}));
	assert.equal(result.status, "created");
	assert.deepEqual(events, ["reconcile:creation-pending", "provision"]);
});

test("an incomplete recovery certificate preserves custody and never provisions", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	const bundle = await interruptedBundle(value);
	const recoveryBefore = await readFile(join(bundle, "recovery.json"));
	let provisions = 0;
	await assert.rejects(createImmutableOwnerBundle(options(value, {
		reconcileRecovery: async () => ({ cleanup_complete: false }),
		provisionIdentity: async () => { provisions += 1; },
	})), /did not complete/);
	assert.equal(provisions, 0);
	assert.deepEqual(await readFile(join(bundle, "recovery.json")), recoveryBefore);
});

test("a durable pre-provision state survives a crash and retries without remote reconciliation", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	let provisions = 0;
	await assert.rejects(createImmutableOwnerBundle(options(value, {
		provisionIdentity: async () => { provisions += 1; throw new Error("stop before recovery"); },
	})), /did not complete/);
	assert.deepEqual(await readdir(join(value.parent, RUN)), ["bundle-state.json"]);
	let reconciles = 0;
	const result = await createImmutableOwnerBundle(options(value, {
		reconcileRecovery: async () => { reconciles += 1; },
		provisionIdentity: successfulProvision(),
	}));
	assert.equal(result.status, "created");
	assert.equal(provisions, 1);
	assert.equal(reconciles, 0);
});

test("an interrupted identity is reconciled from its sealed state after the shared base changes", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	await interruptedBundle(value);
	const changed = Buffer.from(`${JSON.stringify({ status: "pass", fixture: "changed-after-crash" })}\n`);
	await writeFile(join(value.base, "retention.json"), changed, { mode: 0o600 });
	await chmod(join(value.base, "retention.json"), 0o600);
	const events = [];
	const result = await createImmutableOwnerBundle(options(value, {
		reconcileRecovery: async ({ recovery, expectedFrontendOrigin }) => {
			events.push(`reconcile:${recovery.state}`);
			assert.equal(expectedFrontendOrigin, ORIGIN);
			return { cleanup_complete: true };
		},
		provisionIdentity: successfulProvision(events),
	}));
	assert.equal(result.status, "created");
	assert.deepEqual(events, ["reconcile:creation-pending", "provision"]);
	assert.deepEqual(await readFile(join(value.parent, RUN, "retention.json")), changed);
});

test("a complete crash state finalizes only its exact identity-bound recovery", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	await createImmutableOwnerBundle(options(value));
	const bundle = join(value.parent, RUN);
	await writeFile(join(bundle, "recovery.json"), `${JSON.stringify(await recoveryRecord(bundle, {
		state: "identity-bound", external_id: MARKER, user_id: USER_ID,
	}))}\n`, { mode: 0o600 });
	await chmod(join(bundle, "recovery.json"), 0o600);
	let reconciles = 0;
	let verified = null;
	const result = await createImmutableOwnerBundle(options(value, {
		reconcileRecovery: async () => { reconciles += 1; },
		verifyIdentity: async ({ identity, expectedFrontendOrigin }) => {
			verified = { identity, expectedFrontendOrigin };
			return { identity_exact: true };
		},
		provisionIdentity: async () => assert.fail("a complete bundle must not provision"),
	}));
	assert.equal(result.status, "already-created");
	assert.equal(reconciles, 0);
	assert.deepEqual(verified, {
		identity: { user_id: USER_ID, username: `flowmap_${MARKER.slice("flowmap_cal_".length)}`, external_id: MARKER },
		expectedFrontendOrigin: ORIGIN,
	});
	await assert.rejects(() => lstat(join(bundle, "recovery.json")), { code: "ENOENT" });
});

test("a complete crash state preserves custody unless exact remote liveness is proved", async (t) => {
	for (const proof of [async () => ({ identity_exact: false }), async () => { throw new Error("ambiguous provider result"); }]) {
		const value = await fixture();
		try {
			await createImmutableOwnerBundle(options(value));
			const bundle = join(value.parent, RUN);
			const recovery = Buffer.from(`${JSON.stringify(await recoveryRecord(bundle, {
				state: "identity-bound", external_id: MARKER, user_id: USER_ID,
			}))}\n`);
			await writeFile(join(bundle, "recovery.json"), recovery, { mode: 0o600 });
			await chmod(join(bundle, "recovery.json"), 0o600);
			await assert.rejects(createImmutableOwnerBundle(options(value, { verifyIdentity: proof })), /did not complete/);
			assert.deepEqual(await readFile(join(bundle, "recovery.json")), recovery);
		} finally { await rm(value.root, { recursive: true, force: true }); }
	}
});

test("the default liveness verifier binds origin, exact id, username, and unique marker", async () => {
	const environment = { CLERK_SECRET_KEY: SECRET };
	const username = `flowmap_${MARKER.slice("flowmap_cal_".length)}`;
	const calls = [];
	const proof = await verifyDisposableClerkIdentity({
		identity: { user_id: USER_ID, username, external_id: MARKER },
		expectedFrontendOrigin: ORIGIN,
		environment,
		fetchImpl: async (input) => {
			const url = new URL(input);
			calls.push(`${url.pathname}${url.search}`);
			if (url.pathname === "/v1/domains") return Response.json({ data: [{ frontend_api_url: ORIGIN }], total_count: 1 });
			if (url.pathname === `/v1/users/${USER_ID}`) return Response.json({ id: USER_ID, username, external_id: MARKER });
			if (url.pathname === "/v1/users") return Response.json({ data: [{ id: USER_ID, external_id: MARKER }], total_count: 1 });
			assert.fail("unexpected provider request");
		},
	});
	assert.deepEqual(proof, { identity_exact: true });
	assert.deepEqual(calls, ["/v1/domains", `/v1/users/${USER_ID}`, `/v1/users?external_id=${MARKER}&limit=2&offset=0`]);
	assert.equal(Object.hasOwn(environment, "CLERK_SECRET_KEY"), false);
});

test("a complete bundle preserves and rejects mismatched recovery or extra files", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	await createImmutableOwnerBundle(options(value));
	const bundle = join(value.parent, RUN);
	const mismatched = Buffer.from(`${JSON.stringify(await recoveryRecord(bundle, {
		state: "creation-pending",
		external_id: "flowmap_cal_22222222222222222222222222222222",
		user_id: null,
	}))}\n`);
	await writeFile(join(bundle, "recovery.json"), mismatched, { mode: 0o600 });
	await chmod(join(bundle, "recovery.json"), 0o600);
	await assert.rejects(createImmutableOwnerBundle(options(value)), /did not complete/);
	assert.deepEqual(await readFile(join(bundle, "recovery.json")), mismatched);
	const matching = Buffer.from(`${JSON.stringify(await recoveryRecord(bundle, {
		state: "identity-bound", external_id: MARKER, user_id: USER_ID,
	}))}\n`);
	await writeFile(join(bundle, "recovery.json"), matching, { mode: 0o600 });
	await chmod(join(bundle, "recovery.json"), 0o600);
	await writeFile(join(bundle, "foreign.txt"), "keep", { mode: 0o600 });
	let verifications = 0;
	await assert.rejects(createImmutableOwnerBundle(options(value, {
		verifyIdentity: async () => { verifications += 1; return { identity_exact: true }; },
	})), /did not complete/);
	assert.equal(verifications, 0);
	assert.deepEqual(await readFile(join(bundle, "recovery.json")), matching);
	assert.equal(await readFile(join(bundle, "foreign.txt"), "utf8"), "keep");
});

test("an exact partial recovery is reconciled before unrelated entries are preserved", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	const bundle = await interruptedBundle(value);
	await writeFile(join(bundle, "foreign.txt"), "keep", { mode: 0o600 });
	let reconciles = 0;
	let provisions = 0;
	await assert.rejects(createImmutableOwnerBundle(options(value, {
		reconcileRecovery: async ({ recovery }) => {
			reconciles += 1;
			assert.deepEqual(recovery, { state: "creation-pending", external_id: MARKER, user_id: null });
			return { cleanup_complete: true };
		},
		provisionIdentity: async () => { provisions += 1; },
	})), /did not complete/);
	assert.equal(reconciles, 1);
	assert.equal(provisions, 0);
	assert.deepEqual(await readdir(bundle), ["foreign.txt"]);
	assert.equal(await readFile(join(bundle, "foreign.txt"), "utf8"), "keep");
});

test("strict generated schemas and independent completion hashes reject local joint edits", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	await createImmutableOwnerBundle(options(value));
	const bundle = join(value.parent, RUN);
	const accountPath = join(bundle, "account.json");
	const contractPath = join(bundle, "fresh-start-contract.json");
	const account = JSON.parse(await readFile(accountPath));
	const contract = JSON.parse(await readFile(contractPath));
	const replacementMarker = "22222222222222222222222222222222";
	account.identity.provider_user_id = "user_joint_edit";
	account.identity.username = `flowmap_${replacementMarker}`;
	const accountBytes = Buffer.from(`${JSON.stringify(account, null, 2)}\n`);
	contract.approved_account_binding.sha256 = hash(accountBytes);
	contract.approved_account_binding.provider_user_id = account.identity.provider_user_id;
	contract.approved_account_binding.username = account.identity.username;
	await writeFile(accountPath, accountBytes, { mode: 0o600 });
	await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });
	await chmod(accountPath, 0o600);
	await chmod(contractPath, 0o600);
	await assert.rejects(createImmutableOwnerBundle(options(value)), /did not complete/);

	account.unapproved = true;
	const invalidAccountBytes = Buffer.from(`${JSON.stringify(account, null, 2)}\n`);
	contract.approved_account_binding.sha256 = hash(invalidAccountBytes);
	const changedContractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);
	const completionPath = join(bundle, "bundle-completion.json");
	const completion = JSON.parse(await readFile(completionPath));
	completion.account_sha256 = hash(invalidAccountBytes);
	completion.fresh_start_contract_sha256 = hash(changedContractBytes);
	await writeFile(accountPath, invalidAccountBytes, { mode: 0o600 });
	await writeFile(contractPath, changedContractBytes, { mode: 0o600 });
	await writeFile(completionPath, `${JSON.stringify(completion, null, 2)}\n`, { mode: 0o600 });
	await chmod(accountPath, 0o600);
	await chmod(contractPath, 0o600);
	await chmod(completionPath, 0o600);
	await assert.rejects(createImmutableOwnerBundle(options(value)), /did not complete/);
});

test("a replaced bundle ancestor receives no private files and cleanup touches no foreign path", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	const outside = join(value.root, "outside");
	await mkdir(outside, { mode: 0o700 });
	const bundle = join(value.parent, RUN);
	const saved = `${bundle}-saved`;
	let cleanupCalled = false;
	let swapped = false;
	const now = () => ({
		toISOString() {
			if (!swapped) {
				swapped = true;
				renameSync(bundle, saved);
				symlinkSync(outside, bundle);
			}
			return "2026-09-04T12:00:00.000Z";
		},
	});
	await assert.rejects(createImmutableOwnerBundle(options(value, {
		now,
		provisionIdentity: async ({ onRecoveryMaterial }) => {
			await onRecoveryMaterial({ state: "creation-pending", external_id: MARKER, user_id: null });
			await onRecoveryMaterial({ state: "identity-bound", external_id: MARKER, user_id: USER_ID });
			return { userId: USER_ID, cleanup: async () => { cleanupCalled = true; return { cleanup_complete: true }; } };
		},
	})), /did not complete/);
	assert.equal(swapped, true);
	assert.equal(cleanupCalled, true);
	assert.deepEqual(await readdir(outside), []);
	assert.equal((await lstat(bundle)).isSymbolicLink(), true);
	assert.ok((await readdir(saved)).includes("recovery.json"));
});

test("a no-follow source snapshot refuses a symlink before provisioning", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	const source = join(value.base, "retention.json");
	const target = join(value.root, "outside-control.json");
	const targetBytes = Buffer.from('{"status":"pass","private":"keep"}\n');
	await writeFile(target, targetBytes, { mode: 0o600 });
	await rm(source);
	await symlink(target, source);
	let provisions = 0;
	await assert.rejects(createImmutableOwnerBundle(options(value, {
		provisionIdentity: async () => { provisions += 1; },
	})), /did not complete/);
	assert.equal(provisions, 0);
	assert.deepEqual(await readFile(target), targetBytes);
});

test("caught failure deletes the identity but preserves a foreign symlink and target", async (t) => {
	const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
	const outside = join(value.root, "outside.txt"); await writeFile(outside, "keep");
	const events = [];
	await assert.rejects(createImmutableOwnerBundle(options(value, {
		provisionIdentity: successfulProvision(events),
		beforeComplete: async ({ bundle }) => { await symlink(outside, join(bundle, "foreign-link")); throw new Error("stop"); },
	})), /did not complete/);
	assert.equal(events.at(-1), "delete");
	assert.equal(await readFile(outside, "utf8"), "keep");
	assert.equal((await lstat(join(value.parent, RUN, "foreign-link"))).isSymbolicLink(), true);
	assert.deepEqual((await readdir(join(value.parent, RUN))), ["foreign-link"]);
});

test("CLI prints only fixed status and run fields", async () => {
	let stdout = ""; let stderr = "";
	const environment = { CLERK_SECRET_KEY: SECRET };
	const exit = await main({
		argv: ["--run-id", RUN, "--base-owner-directory", "/private/base", "--bundle-parent", "/private/bundles"], environment,
		output: { write: (value) => { stdout += value; } }, errorOutput: { write: (value) => { stderr += value; } },
		create: async () => ({ schema_version: 1, status: "created", run_id: RUN, identity: USER_ID }),
	});
	assert.equal(exit, 0); assert.equal(stderr, "");
	assert.deepEqual(JSON.parse(stdout), { schema_version: 1, status: "created", run_id: RUN });
	for (const secret of [SECRET, USER_ID, "/private/base", "/private/bundles"]) assert.equal(stdout.includes(secret), false);
	assert.equal(Object.hasOwn(environment, "CLERK_SECRET_KEY"), false);
});
