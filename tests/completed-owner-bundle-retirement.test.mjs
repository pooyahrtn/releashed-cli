import assert from "node:assert/strict";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	OWNER_BUNDLE_RETIREMENT_RECEIPT,
	retireCompletedOwnerBundle,
} from "../lib/completed-owner-bundle-retirement.mjs";
import {
	BUNDLE_CONTROL_FILES,
	createImmutableOwnerBundle,
} from "../lib/owner-bundle.mjs";
import { main, parseArgs } from "../scripts/retire-completed-owner-bundle.mjs";
import { CLERK_DOMAINS_ENDPOINT } from "../supervisor/clerk-bootstrap.mjs";

const RUN_ID = "spike-a-bounded-20260904T060350Z";
const ORIGIN = "https://clerk.example.test";
const SECRET = "sk_live_retirement_fixture_never_output";
const MARKER = `flowmap_cal_${"1".repeat(32)}`;
const USERNAME = `flowmap_${"1".repeat(32)}`;
const USER_ID = "user_retirement_fixture";
const FINAL_FILES = [
	"bundle-state.json",
	...BUNDLE_CONTROL_FILES,
	"account.json",
	"fresh-start-contract.json",
	"bundle-completion.json",
];

async function fixture() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "owner-retirement-test-")),
	);
	const base = join(root, "base");
	const parent = join(root, "owner-bundles");
	await mkdir(base, { mode: 0o700 });
	await mkdir(parent, { mode: 0o700 });
	for (const name of BUNDLE_CONTROL_FILES) {
		const value =
			name === "origin-allowlist.json"
				? {
						status: "pass",
						browser_request_dispatch: {
							allow: [
								{
									origin: ORIGIN,
									purpose: "Clerk frontend/auth session transport only",
								},
							],
						},
					}
				: { status: "pass", fixture: name };
		await writeFile(join(base, name), `${JSON.stringify(value)}\n`, {
			mode: 0o600,
		});
		await chmod(join(base, name), 0o600);
	}
	await createImmutableOwnerBundle({
		baseOwnerDirectory: base,
		bundleParent: parent,
		runId: RUN_ID,
		secretKey: SECRET,
		dependencies: {
			now: () => new Date("2026-09-04T06:04:07.061Z"),
			provisionIdentity: async ({ onRecoveryMaterial }) => {
				await onRecoveryMaterial({
					state: "creation-pending",
					external_id: MARKER,
					user_id: null,
				});
				await onRecoveryMaterial({
					state: "identity-bound",
					external_id: MARKER,
					user_id: USER_ID,
				});
				return {
					userId: USER_ID,
					cleanup: async () => ({ cleanup_complete: true }),
				};
			},
		},
	});
	return { root, base, parent, bundle: join(parent, RUN_ID) };
}

function jsonResponse(status, value) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function provider({
	present = true,
	frontendOrigin = ORIGIN,
	exact = null,
	markerRows = null,
	onExactLookup = null,
	onMarkerLookup = null,
} = {}) {
	let identityPresent = present;
	let deletes = 0;
	const calls = [];
	const fetchImpl = async (raw, init = {}) => {
		const url = new URL(raw);
		const method = init.method ?? "GET";
		calls.push(`${method} ${url.pathname}${url.search}`);
		if (raw === CLERK_DOMAINS_ENDPOINT) {
			return jsonResponse(200, {
				data: [{ frontend_api_url: frontendOrigin }],
				total_count: 1,
			});
		}
		if (url.pathname === `/v1/users/${USER_ID}` && method === "GET") {
			await onExactLookup?.();
			if (!identityPresent) return jsonResponse(404, {});
			return jsonResponse(
				200,
				exact ?? { id: USER_ID, username: USERNAME, external_id: MARKER },
			);
		}
		if (url.pathname === "/v1/users" && method === "GET") {
			await onMarkerLookup?.();
			const rows =
				markerRows ??
				(identityPresent ? [{ id: USER_ID, external_id: MARKER }] : []);
			return jsonResponse(200, { data: rows, total_count: rows.length });
		}
		if (url.pathname === `/v1/users/${USER_ID}` && method === "DELETE") {
			deletes += 1;
			identityPresent = false;
			return jsonResponse(200, { deleted: true });
		}
		throw new Error("unexpected provider request");
	};
	return {
		fetchImpl,
		calls,
		deletes: () => deletes,
		present: () => identityPresent,
	};
}

async function retire(value, harness, dependencies = {}) {
	const environment = { CLERK_SECRET_KEY: SECRET };
	const result = await retireCompletedOwnerBundle({
		bundleDirectory: value.bundle,
		runId: RUN_ID,
		environment,
		fetchImpl: harness.fetchImpl,
		dependencies,
	});
	assert.equal(Object.hasOwn(environment, "CLERK_SECRET_KEY"), false);
	return result;
}

test("retires the exact identity from the current legacy-complete bundle and publishes only a sanitized private receipt", async (t) => {
	const value = await fixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	assert.deepEqual(
		(await readdir(value.bundle)).sort(),
		[...FINAL_FILES].sort(),
	);
	assert.equal((await readdir(value.bundle)).includes("recovery.json"), false);

	const harness = provider();
	const result = await retire(value, harness);
	assert.equal(harness.deletes(), 1);
	assert.equal(harness.present(), false);
	assert.deepEqual(harness.calls, [
		"GET /v1/domains",
		`GET /v1/users/${USER_ID}`,
		`GET /v1/users?external_id=${MARKER}&limit=2&offset=0`,
		`DELETE /v1/users/${USER_ID}`,
		`GET /v1/users/${USER_ID}`,
		`GET /v1/users?external_id=${MARKER}&limit=2&offset=0`,
	]);
	const receiptPath = join(value.bundle, OWNER_BUNDLE_RETIREMENT_RECEIPT);
	assert.equal((await lstat(receiptPath)).mode & 0o777, 0o600);
	const receiptBytes = await readFile(receiptPath);
	assert.deepEqual(JSON.parse(receiptBytes), result);
	assert.deepEqual(Object.keys(result), [
		"schema_version",
		"record_kind",
		"status",
		"reason",
		"certificate_hashes",
	]);
	assert.equal(result.status, "retired");
	assert.equal(Object.keys(result.certificate_hashes).length, 4);
	assert.doesNotMatch(
		receiptBytes.toString(),
		/user_retirement|flowmap_|clerk\.example|owner-retirement|spike-a-bounded|sk_live/,
	);
});

test("an already absent exact id succeeds only with an empty marker search and remains idempotent", async (t) => {
	const value = await fixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	const absent = provider({ present: false });
	const first = await retire(value, absent);
	assert.equal(absent.deletes(), 0);

	const retry = provider({ present: false });
	assert.deepEqual(await retire(value, retry), first);
	assert.equal(retry.deletes(), 0);

	const ambiguous = provider({
		present: false,
		markerRows: [{ id: "user_other_fixture", external_id: MARKER }],
	});
	await assert.rejects(retire(value, ambiguous), /did not complete/);
	assert.equal(ambiguous.deletes(), 0);
});

test("an injected provider result cannot publish a receipt without an explicit confirmation proof", async (t) => {
	const value = await fixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	await assert.rejects(
		retireCompletedOwnerBundle({
			bundleDirectory: value.bundle,
			runId: RUN_ID,
			environment: { CLERK_SECRET_KEY: SECRET },
			dependencies: { retireIdentity: async () => ({}) },
		}),
		/did not complete/,
	);
	assert.deepEqual(
		(await readdir(value.bundle)).sort(),
		[...FINAL_FILES].sort(),
	);
});

test("wrong instance, exact identity mismatch, and duplicate marker all fail before DELETE", async () => {
	for (const [label, options] of [
		["wrong instance", { frontendOrigin: "https://other.example.test" }],
		[
			"wrong id",
			{
				exact: {
					id: "user_other_fixture",
					username: USERNAME,
					external_id: MARKER,
				},
			},
		],
		[
			"wrong username",
			{
				exact: {
					id: USER_ID,
					username: `flowmap_${"2".repeat(32)}`,
					external_id: MARKER,
				},
			},
		],
		[
			"wrong marker",
			{
				exact: {
					id: USER_ID,
					username: USERNAME,
					external_id: `flowmap_cal_${"2".repeat(32)}`,
				},
			},
		],
		[
			"duplicate marker",
			{
				markerRows: [
					{ id: USER_ID, external_id: MARKER },
					{ id: "user_other_fixture", external_id: MARKER },
				],
			},
		],
	]) {
		await test(label, async () => {
			const value = await fixture();
			try {
				const harness = provider(options);
				await assert.rejects(retire(value, harness), /did not complete/);
				assert.equal(harness.deletes(), 0);
				assert.equal(
					(await readdir(value.bundle)).includes(
						OWNER_BUNDLE_RETIREMENT_RECEIPT,
					),
					false,
				);
			} finally {
				await rm(value.root, { recursive: true, force: true });
			}
		});
	}
});

test("schema, hash, mode, extra-entry, and symlink drift fail locally without provider work", async () => {
	const mutations = [
		[
			"schema",
			async ({ bundle }) => {
				const path = join(bundle, "bundle-completion.json");
				const completion = JSON.parse(await readFile(path));
				completion.unapproved = true;
				await writeFile(path, `${JSON.stringify(completion)}\n`, {
					mode: 0o600,
				});
				await chmod(path, 0o600);
			},
		],
		[
			"hash",
			async ({ bundle }) => {
				const path = join(bundle, "retention.json");
				await writeFile(
					path,
					`${JSON.stringify({ status: "pass", fixture: "changed" })}\n`,
					{ mode: 0o600 },
				);
				await chmod(path, 0o600);
			},
		],
		[
			"file mode",
			async ({ bundle }) => chmod(join(bundle, "account.json"), 0o644),
		],
		["directory mode", async ({ bundle }) => chmod(bundle, 0o755)],
		[
			"extra recovery",
			async ({ bundle }) =>
				writeFile(join(bundle, "recovery.json"), "{}\n", { mode: 0o600 }),
		],
		[
			"file symlink",
			async ({ bundle }) => {
				const path = join(bundle, "account.json");
				const original = `${path}.original`;
				await writeFile(original, await readFile(path), { mode: 0o600 });
				await rm(path);
				await symlink(original, path);
			},
		],
	];
	for (const [label, mutate] of mutations) {
		await test(label, async () => {
			const value = await fixture();
			try {
				await mutate(value);
				let providerCalls = 0;
				await assert.rejects(
					retireCompletedOwnerBundle({
						bundleDirectory: value.bundle,
						runId: RUN_ID,
						environment: { CLERK_SECRET_KEY: SECRET },
						dependencies: {
							retireIdentity: async () => {
								providerCalls += 1;
							},
						},
					}),
					/did not complete/,
				);
				assert.equal(providerCalls, 0);
			} finally {
				await rm(value.root, { recursive: true, force: true });
			}
		});
	}
});

test("a symlinked ancestor and ancestor drift before deletion both refuse with zero DELETE", async (t) => {
	const value = await fixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	const linkedParent = join(value.root, "linked-owner-bundles");
	await symlink(value.parent, linkedParent);
	let providerCalls = 0;
	await assert.rejects(
		retireCompletedOwnerBundle({
			bundleDirectory: join(linkedParent, RUN_ID),
			runId: RUN_ID,
			environment: { CLERK_SECRET_KEY: SECRET },
			dependencies: {
				retireIdentity: async () => {
					providerCalls += 1;
				},
			},
		}),
		/did not complete/,
	);
	assert.equal(providerCalls, 0);

	let changed = false;
	const harness = provider({
		onMarkerLookup: async () => {
			if (!changed) {
				changed = true;
				await chmod(value.parent, 0o755);
			}
		},
	});
	await assert.rejects(retire(value, harness), /did not complete/);
	assert.equal(harness.deletes(), 0);
});

test("confirmed deletion retries safely across each receipt crash boundary", async () => {
	for (const crashPoint of [
		"afterIdentityRetired",
		"afterReceiptStaged",
		"afterReceiptRenamed",
	]) {
		await test(crashPoint, async () => {
			const value = await fixture();
			try {
				const firstProvider = provider();
				await assert.rejects(
					retire(value, firstProvider, {
						[crashPoint]: async () => {
							throw new Error("simulated crash");
						},
					}),
					/did not complete/,
				);
				assert.equal(firstProvider.deletes(), 1);
				const retryProvider = provider({ present: false });
				const result = await retire(value, retryProvider);
				assert.equal(retryProvider.deletes(), 0);
				assert.equal(result.status, "retired");
				assert.deepEqual(
					(await readdir(value.bundle)).sort(),
					[...FINAL_FILES, OWNER_BUNDLE_RETIREMENT_RECEIPT].sort(),
				);
			} finally {
				await rm(value.root, { recursive: true, force: true });
			}
		});
	}
});

test("CLI requires one absolute bundle/run binding, consumes the environment secret, and emits only the sanitized result", async () => {
	assert.throws(
		() =>
			parseArgs(["--owner-bundle-directory", "relative", "--run-id", RUN_ID]),
		/Usage:/,
	);
	assert.throws(
		() =>
			parseArgs([
				"--run-id",
				RUN_ID,
				"--owner-bundle-directory",
				"/private/bundle",
			]),
		/Usage:/,
	);
	assert.deepEqual(
		parseArgs([
			"--owner-bundle-directory",
			"/private/bundle",
			"--run-id",
			RUN_ID,
		]),
		{
			bundleDirectory: "/private/bundle",
			runId: RUN_ID,
		},
	);
	const environment = { CLERK_SECRET_KEY: SECRET };
	const output = [];
	const errors = [];
	const safeResult = {
		schema_version: 1,
		record_kind: "completed-owner-bundle-retirement-receipt",
		status: "retired",
		reason: "fixed",
		certificate_hashes: { bundle_state_sha256: "a".repeat(64) },
	};
	assert.equal(
		await main({
			argv: ["--owner-bundle-directory", "/private/bundle", "--run-id", RUN_ID],
			environment,
			output: { write: (chunk) => output.push(String(chunk)) },
			errorOutput: { write: (chunk) => errors.push(String(chunk)) },
			retire: async ({ environment: passed }) => {
				delete passed.CLERK_SECRET_KEY;
				return safeResult;
			},
		}),
		0,
	);
	assert.equal(Object.hasOwn(environment, "CLERK_SECRET_KEY"), false);
	assert.deepEqual(JSON.parse(output.join("")), safeResult);
	assert.deepEqual(errors, []);
	assert.doesNotMatch(
		output.join(""),
		/sk_live|user_|flowmap_|private\/bundle/,
	);
});
