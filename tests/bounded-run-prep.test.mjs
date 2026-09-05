import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	boundedRunPreparationContract,
	prepareBoundedOnboardingRun,
} from "../lib/bounded-run-prep.mjs";
import {
	FIRST_OBSERVATION_AUTHORITY,
	validateFreshStartContract,
} from "../lib/fresh-start-contract.mjs";
import { validateGateAEvaluation } from "../lib/gate-a-evaluation.mjs";
import { rebindPublicPack } from "../lib/public-pack-rebind.mjs";
import { createImmutableOwnerBundle } from "../lib/owner-bundle.mjs";
import { parseArgs } from "../scripts/prepare-bounded-onboarding-run.mjs";

const RUN_ID = "fresh-bounded-1";
const CLERK_ORIGIN = "https://clerk.example.test";
const PRICING = {
	currency: "USD",
	input_per_million_tokens: 2,
	cached_input_per_million_tokens: 0.2,
	output_per_million_tokens: 12,
	cache_write_reservation_multiplier_on_uncached_input: 1.25,
	accounting_rate: { usd: 1, eur: 1, reason: "Conservative test rate." },
	source_url: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
	retrieved_date: "2026-09-03",
	price_version: "retrieved-2026-09-03",
};
const LIMITS = {
	working_day_count: 1,
	focused_scaffold_seconds: 7200,
	browser_active_seconds: 7200,
	browser_operations_total: 150,
	browser_operations_per_rolling_minute: 30,
	browser_requests_total: 3000,
	browser_requests_per_rolling_minute: 300,
	listed_one_way_actions_total: 20,
	app_side_cost_cap_eur: 2,
	model_cost_cap_eur: 18,
	combined_actual_plus_reserved_cap_eur: 20,
};

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function writeJson(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
	await writeFile(path, body, { mode: 0o600 });
	return { body, sha256: hash(body) };
}

function gateEvaluation() {
	const questions = Array.from({ length: 3 }, (_, index) => ({
		id: `Q${index + 1}`,
		kind: "direct-observation-multi-step-journey",
		distinctLearnerGoal: `Goal ${index + 1}`,
		prompt: `Question ${index + 1}`,
		expectedAnswerElements: [
			{
				id: `Q${index + 1}-E1`,
				required: true,
				answer: "One expected answer.",
				sourceRefs: ["S-ONE"],
			},
		],
		evidenceRequirements: {
			minimumDirectObservedTransitions: 2,
			requiredSequence: ["before to after"],
			requiredArtifacts: ["event and screenshot"],
			notAccepted: ["unsupported answer"],
		},
		scoring: { 0: "Wrong", 1: "Partial", 2: "Complete" },
	}));
	return {
		schema: "external-flow-map.hidden-artifact-evaluation",
		schemaVersion: 1,
		evaluationVersion: "fresh.1",
		sealed: true,
		author: { role: "gate owner" },
		sealingContract: {
			visibility: "private",
			mustNotBeShownTo: ["public-pack author", "explorer", "map builder"],
			candidateHashBeforeUnseal: true,
			candidateMutationAfterUnsealInvalidatesReview: true,
			reviewMode: "artifact-only; no live product and no explorer conversation",
			reviewTimeLimitMinutes: 10,
		},
		target: { private: true },
		reachabilityAndBudget: { private: true },
		questions,
		globalScoringRubric: {
			questionScale: { 0: "Wrong", 1: "Partial", 2: "Complete" },
			maximumScore: 6,
			passingScore: 6,
			perQuestionFloor: 2,
			necessaryPassConditions: ["All questions pass."],
			automaticFailure: ["A solid edge is unsupported."],
			qualitativeReview: ["Is it useful?"],
		},
		sourceSnapshot: [
			{ id: "S-ONE", path: "/private/source", sha256: "a".repeat(64) },
		],
	};
}

function legacyMatureAccountEvaluation() {
	return {
		schema: "legacy-mature-account-rubric",
		note: "Legacy mature-account rubric; must remain untouched by fresh-run prep.",
	};
}

async function fixture({ badPricing = false, includeGateAEvaluation = true } = {}) {
	const root = await mkdtemp(join(tmpdir(), "bounded-run-prep-"));
	const repository = join(root, "flow-map-lab");
	const ownerDirectory = join(root, "owner");
	await Promise.all([
		mkdir(join(repository, "packs", "approved"), { recursive: true }),
		mkdir(ownerDirectory, { recursive: true }),
	]);
	const publicPack = {
		schema_version: 1,
		product_summary: "A public product summary.",
		claims: [
			{
				id: "claim-one",
				kind: "promise",
				text: "A public promise.",
				source_ids: ["source-001"],
			},
		],
		sources: [
			{
				source_id: "source-001",
				initial_url: "https://example.test/",
				final_url: "https://example.test/",
				retrieved_at: "2026-09-04T00:00:00.000Z",
				status: 200,
				content_type: "text/html",
				redirect_chain: ["https://example.test/"],
				raw_sha256: "b".repeat(64),
				raw_bytes: 1,
				derived_text_sha256: "c".repeat(64),
				derived_text_bytes: 1,
			},
		],
	};
	const publicPackPath = join(repository, "packs", "approved", "public-pack.json");
	const pack = await writeJson(publicPackPath, publicPack);
	const authority = {
		status: "pass",
		limits: LIMITS,
		model_broker_approval: {
			status: "approved-not-called",
			provider: "OpenAI",
			api: "Responses API",
			model: "gpt-5.6-terra",
			pricing: badPricing ? { ...PRICING, source_url: "http://invalid.test" } : PRICING,
		},
	};
	const origins = {
		status: "pass",
		deployed_origins: { learner_app: "https://app.example.test" },
		browser_request_dispatch: {
			allow: [
				{ origin: "https://app.example.test", purpose: "Learner app" },
				{
					origin: CLERK_ORIGIN,
					purpose: "Clerk frontend/auth session transport only",
				},
			],
			recognized_but_suppress_before_dispatch: [],
		},
	};
	const account = {
		status: "pass",
		identity: {
			provider: "Clerk",
			provider_user_id: "user_private_fixture",
			username: "fresh-private-marker",
		},
	};
	const accountSnapshot = await writeJson(join(ownerDirectory, "account.json"), account);
	await Promise.all([
		writeJson(join(ownerDirectory, "authority-and-start.json"), authority),
		writeJson(join(ownerDirectory, "origin-allowlist.json"), origins),
		writeJson(join(ownerDirectory, "action-and-app-cost-ledger.json"), {
			schema_version: 1,
			record_kind: "spike-a-action-and-app-cost-ledger",
			status: "pass",
			caps: {
				listed_one_way_actions_total: LIMITS.listed_one_way_actions_total,
				app_side_actual_plus_outstanding_reservations_eur: LIMITS.app_side_cost_cap_eur,
				combined_model_and_app_actual_plus_outstanding_reservations_eur: LIMITS.combined_actual_plus_reserved_cap_eur,
			},
			allowed_one_way_classes: [
				{
					id: "bounded-onboarding",
					action_matrix_row: "Bounded own-account onboarding progress",
					maximum_count: 20,
					worst_case_eur_per_action: 0,
					maximum_reserved_eur: 0,
					allowed_effects: "bound-route onboarding progress only",
					reservation_rule: "reserve zero and settle zero per bound-route action",
				},
			],
		}),
		writeJson(join(ownerDirectory, "retention.json"), { status: "pass" }),
		writeJson(join(ownerDirectory, "evaluation.json"), legacyMatureAccountEvaluation()),
		...(includeGateAEvaluation
			? [writeJson(join(ownerDirectory, "gate-a-evaluation.json"), gateEvaluation())]
			: []),
	]);
	const contract = {
		schema_version: 1,
		record_kind: "spike-a-fresh-start-contract",
		status: "pass",
		run_id: RUN_ID,
		approved_account_binding: {
			file_name: "account.json",
			sha256: accountSnapshot.sha256,
			clerk_frontend_api_origin: CLERK_ORIGIN,
			provider_user_id: account.identity.provider_user_id,
			username: account.identity.username,
		},
		product_state_rule: {
			authority: FIRST_OBSERVATION_AUTHORITY,
			pre_observation_claims: [],
		},
	};
	await writeJson(join(ownerDirectory, "fresh-start-contract.json"), contract);
	return {
		root,
		repository,
		ownerDirectory,
		publicPackPath,
		publicPackSha256: pack.sha256,
		account,
		accountSha256: accountSnapshot.sha256,
		contract,
	};
}

async function prepare(value) {
	return prepareBoundedOnboardingRun({
		repository: value.repository,
		ownerDirectory: value.ownerDirectory,
		runId: RUN_ID,
		publicPackPath: value.publicPackPath,
		publicPackSha256: value.publicPackSha256,
		workingDayDeadline: new Date(Date.now() + 60_000).toISOString(),
	});
}

test("fresh-start contract admits only durable account and first-observation premises", async () => {
	const value = await fixture();
	try {
		assert.equal(
			validateFreshStartContract(value.contract, {
				runId: RUN_ID,
				accountSha256: value.accountSha256,
				account: value.account,
				clerkFrontendApiOrigin: CLERK_ORIGIN,
			}).product_state_authority,
			FIRST_OBSERVATION_AUTHORITY,
		);
		assert.throws(
			() =>
				validateFreshStartContract(
					{ ...value.contract, browser_profile_empty: true },
					{
						runId: RUN_ID,
						accountSha256: value.accountSha256,
						account: value.account,
						clerkFrontendApiOrigin: CLERK_ORIGIN,
					},
				),
			/unknown or missing/,
		);
		assert.throws(
			() =>
				validateFreshStartContract(
					{
						...value.contract,
						product_state_rule: {
							...value.contract.product_state_rule,
							pre_observation_claims: ["session is empty"],
						},
					},
					{
						runId: RUN_ID,
						accountSha256: value.accountSha256,
						account: value.account,
						clerkFrontendApiOrigin: CLERK_ORIGIN,
					},
				),
			/first retained observation/,
		);
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("Gate A validator accepts only a sealed precommitted artifact-only rubric", () => {
	const evaluation = gateEvaluation();
	assert.deepEqual(validateGateAEvaluation(evaluation), {
		evaluation_version: "fresh.1",
		question_count: 3,
		maximum_score: 6,
		review_time_limit_minutes: 10,
	});
	assert.throws(
		() =>
			validateGateAEvaluation({
				...evaluation,
				sealingContract: {
					...evaluation.sealingContract,
					candidateHashBeforeUnseal: false,
				},
			}),
		/precommitted/,
	);
});

test("prepares a zero-count bounded run and retries only the exact immutable result", async () => {
	const value = await fixture();
	try {
		const first = await prepare(value);
		assert.equal(first.idempotent_retry, false);
		assert.equal(first.live_preflight, "required-before-target-session");
		assert.equal("gate_a_question_count" in first, false);
		const runDirectory = join(value.repository, first.run_path);
		const runtimeDirectory = join(value.repository, first.runtime_path);
		assert.equal((await stat(runDirectory)).mode & 0o777, 0o700);
		assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
		assert.equal((await readFile(join(runDirectory, "model-ledger.jsonl"))).length, 0);
		const cap = JSON.parse(await readFile(join(runtimeDirectory, "cap-state.json"), "utf8"));
		assert.equal(cap.model.calls, 0);
		assert.equal(cap.model.actual_eur, 0);
		assert.equal(cap.app.one_way_actions, 0);
		assert.equal(cap.browser.operations, 0);

		const manifestText = await readFile(join(runDirectory, "input-manifest.json"), "utf8");
		const manifest = JSON.parse(manifestText);
		assert.deepEqual(
			Object.keys(manifest.owner_input_hashes).sort(),
			boundedRunPreparationContract.private_control_files,
		);
		assert.equal(manifest.private_control_contents_disclosed, false);
		assert.equal(manifest.private_identifiers_disclosed, false);
		assert.equal(manifest.gate_a_evaluation_mounted_in_model_sandboxes, false);
		assert.doesNotMatch(manifestText, /user_private_fixture|fresh-private-marker/);

		const targetText = await readFile(
			join(runtimeDirectory, "target-session-config.json"),
			"utf8",
		);
		assert.equal(
			(await stat(join(runtimeDirectory, "target-session-config.json"))).mode &
				0o777,
			0o600,
		);
		const target = JSON.parse(targetText);
		assert.equal(target.mode, "source-blind-bounded-onboarding-v1");
		assert.deepEqual(target.clerk_auth.approved_disposable_identity, {
			provider_user_id: "user_private_fixture",
			username: "fresh-private-marker",
		});
		const model = JSON.parse(
			await readFile(join(runtimeDirectory, "explorer-model-config.json"), "utf8"),
		);
		const retainedModelText = await readFile(
			join(runtimeDirectory, "model-config.json"),
			"utf8",
		);
		assert.equal(model.run_id, RUN_ID);
		assert.equal(model.run_directory, await realpath(runDirectory));
		for (const modelBoundary of [JSON.stringify(model), retainedModelText]) {
			assert.doesNotMatch(
				modelBoundary,
				/user_private_fixture|fresh-private-marker|clerk\.example\.test/,
			);
			assert.doesNotMatch(
				modelBoundary,
				/evaluation\.json|Question 1|expected answer/,
			);
		}
		const receiptText = await readFile(
			join(runtimeDirectory, "preparation-receipt.json"),
			"utf8",
		);
		assert.equal("result" in JSON.parse(receiptText), false);
		for (const publicSurface of [manifestText, receiptText, JSON.stringify(first)]) {
			assert.doesNotMatch(
				publicSurface,
				/user_private_fixture|fresh-private-marker|clerk\.example\.test|\/private\/|bounded-run-prep-/,
			);
		}
		assert.deepEqual(await readFile(join(value.repository, first.public_pack_path, "public-pack.json")), await readFile(value.publicPackPath));

		const retry = await prepare(value);
		assert.deepEqual(retry, { ...first, idempotent_retry: true });
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("rolls back every run-owned output when later config validation fails", async () => {
	const value = await fixture({ badPricing: true });
	try {
		await assert.rejects(() => prepare(value), /pricing/);
		for (const path of [
			join(value.repository, "runs", RUN_ID),
			join(value.repository, ".runtime", RUN_ID),
			join(value.repository, "packs", `public-pack-${RUN_ID}`),
		]) {
			await assert.rejects(access(path));
		}
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("rejects run-path symlinks and collisions without touching them", async () => {
	const value = await fixture();
	try {
		const outside = join(value.root, "outside");
		await mkdir(outside);
		await mkdir(join(value.repository, "runs"), { recursive: true });
		const collision = join(value.repository, "runs", RUN_ID);
		await symlink(outside, collision);
		await assert.rejects(() => prepare(value), /run path already exists/);
		assert.equal((await lstat(collision)).isSymbolicLink(), true);
		assert.deepEqual(await readdir(outside), []);
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("detects a trusted packs-root swap after rebind and never removes a foreign marker", async () => {
	const value = await fixture();
	const packs = join(await realpath(value.repository), "packs");
	const movedPacks = join(await realpath(value.repository), "packs-before-swap");
	const foreignMarker = join(packs, "foreign-marker");
	try {
		await assert.rejects(
			() =>
				prepareBoundedOnboardingRun({
					repository: value.repository,
					ownerDirectory: value.ownerDirectory,
					runId: RUN_ID,
					publicPackPath: value.publicPackPath,
					publicPackSha256: value.publicPackSha256,
					workingDayDeadline: new Date(Date.now() + 60_000).toISOString(),
					rebind: async (options) => {
						const result = await rebindPublicPack(options);
						await rename(packs, movedPacks);
						await mkdir(packs, { mode: 0o700 });
						await writeFile(foreignMarker, "foreign\n", { mode: 0o600 });
						return result;
					},
				}),
			/packs root identity changed/,
		);
		assert.equal(await readFile(foreignMarker, "utf8"), "foreign\n");
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("rollback removes only tracked files and leaves an injected foreign child intact", async () => {
	const value = await fixture();
	let foreignMarker;
	try {
		await assert.rejects(
			() =>
				prepareBoundedOnboardingRun({
					repository: value.repository,
					ownerDirectory: value.ownerDirectory,
					runId: RUN_ID,
					publicPackPath: value.publicPackPath,
					publicPackSha256: value.publicPackSha256,
					workingDayDeadline: new Date(Date.now() + 60_000).toISOString(),
					beforePublish: async ({ runtimeDirectory }) => {
						foreignMarker = join(runtimeDirectory, "foreign-marker");
						await writeFile(foreignMarker, "foreign\n", { mode: 0o600 });
					},
				}),
			/contains missing or additional files/,
		);
		assert.equal(await readFile(foreignMarker, "utf8"), "foreign\n");
		assert.deepEqual(await readdir(dirname(foreignMarker)), ["foreign-marker"]);
		await assert.rejects(access(join(value.repository, "runs", RUN_ID)));
		await assert.rejects(
			access(join(value.repository, "packs", `public-pack-${RUN_ID}`)),
		);
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("owner-input mutation during public-pack rebind fails and rolls back owned outputs", async () => {
	const value = await fixture();
	const gateAEvaluationPath = join(value.ownerDirectory, "gate-a-evaluation.json");
	try {
		await assert.rejects(
			() =>
				prepareBoundedOnboardingRun({
					repository: value.repository,
					ownerDirectory: value.ownerDirectory,
					runId: RUN_ID,
					publicPackPath: value.publicPackPath,
					publicPackSha256: value.publicPackSha256,
					workingDayDeadline: new Date(Date.now() + 60_000).toISOString(),
					rebind: async (options) => {
						const result = await rebindPublicPack(options);
						await writeFile(gateAEvaluationPath, "{}\n");
						return result;
					},
				}),
			/gate-a-evaluation\.json changed after its sealed snapshot/,
		);
		for (const path of [
			join(value.repository, "runs", RUN_ID),
			join(value.repository, ".runtime", RUN_ID),
			join(value.repository, "packs", `public-pack-${RUN_ID}`),
		]) {
			await assert.rejects(access(path));
		}
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("refuses a directory that only has the legacy evaluation.json and no gate-a-evaluation.json", async () => {
	const value = await fixture({ includeGateAEvaluation: false });
	try {
		await assert.rejects(
			() => prepare(value),
			/private control gate-a-evaluation\.json must be an ordinary file/,
		);
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("changes to the legacy evaluation.json never affect a valid fresh preparation", async () => {
	const value = await fixture();
	const legacyEvaluationPath = join(value.ownerDirectory, "evaluation.json");
	try {
		const first = await prepare(value);
		assert.equal(first.idempotent_retry, false);

		await writeFile(
			legacyEvaluationPath,
			`${JSON.stringify({ schema: "legacy-mature-account-rubric", mutated: true }, null, 2)}\n`,
		);

		const retry = await prepare(value);
		assert.deepEqual(retry, { ...first, idempotent_retry: true });
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("exact retry rejects receipt result injection and private-value fields", async (t) => {
	for (const [name, injected] of [
		["result", { result: { run_id: "attacker-run" } }],
		["provider id", { provider_user_id: "user_private_fixture" }],
		["username", { username: "fresh-private-marker" }],
		["private path", { private_path: "/private/owner/account.json" }],
		["rubric", { rubric: "Question 1 expected answer" }],
	]) {
		await t.test(name, async () => {
			const value = await fixture();
			try {
				const first = await prepare(value);
				const receiptPath = join(
					value.repository,
					first.runtime_path,
					"preparation-receipt.json",
				);
				const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
				await writeFile(
					receiptPath,
					`${JSON.stringify({ ...receipt, ...injected }, null, 2)}\n`,
				);
				await assert.rejects(() => prepare(value), /exact retry/);
			} finally {
				await rm(value.root, { recursive: true, force: true });
			}
		});
	}
});

test("exact retry rejects relaxed file and directory modes", async (t) => {
	for (const [name, target] of [
		["file", (value) => join(value.repository, ".runtime", RUN_ID, "target-session-config.json")],
		["directory", (value) => join(value.repository, "runs", RUN_ID)],
	]) {
		await t.test(name, async () => {
			const value = await fixture();
			try {
				await prepare(value);
				await chmod(target(value), 0o755);
				await assert.rejects(() => prepare(value), /mode/);
			} finally {
				await rm(value.root, { recursive: true, force: true });
			}
		});
	}
});

test("exact retry revalidates sealed artifacts even when receipt hashes are forged", async () => {
	const value = await fixture();
	try {
		await prepare(value);
		const runtimeDirectory = join(value.repository, ".runtime", RUN_ID);
		const targetPath = join(runtimeDirectory, "target-session-config.json");
		const receiptPath = join(runtimeDirectory, "preparation-receipt.json");
		const target = JSON.parse(await readFile(targetPath, "utf8"));
		const tamperedBody = Buffer.from(
			`${JSON.stringify({ ...target, leaked_private_path: "/private/owner", rubric: "Question 1 expected answer" }, null, 2)}\n`,
		);
		await writeFile(targetPath, tamperedBody);
		const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
		receipt.output_hashes.runtime["target-session-config.json"] = hash(tamperedBody);
		await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
		await assert.rejects(() => prepare(value), /configs are not bound/);
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("bounded preparation consumes an immutable per-run owner bundle", async () => {
	const value = await fixture();
	try {
		const bundleParent = join(value.root, "owner-bundles");
		await mkdir(bundleParent, { mode: 0o700 });
		await createImmutableOwnerBundle({
			baseOwnerDirectory: await realpath(value.ownerDirectory),
			bundleParent: await realpath(bundleParent),
			runId: RUN_ID,
			secretKey: "sk_live_bundle_fixture",
			dependencies: {
				now: () => new Date("2026-09-04T12:00:00.000Z"),
				provisionIdentity: async ({ onRecoveryMaterial }) => {
					const externalId = "flowmap_cal_11111111111111111111111111111111";
					await onRecoveryMaterial({ state: "creation-pending", external_id: externalId, user_id: null });
					await onRecoveryMaterial({ state: "identity-bound", external_id: externalId, user_id: "user_bundle_fixture" });
					return { userId: "user_bundle_fixture", cleanup: async () => ({ cleanup_complete: true }) };
				},
			},
		});
		const prepared = await prepare({ ...value, ownerDirectory: join(bundleParent, RUN_ID) });
		assert.equal(prepared.idempotent_retry, false);
		assert.equal(prepared.live_preflight, "required-before-target-session");
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("CLI accepts only the exact run and public-pack binding", () => {
	assert.throws(() => parseArgs(["--run-id", RUN_ID]), /Usage:/);
	assert.deepEqual(
		parseArgs([
			"--run-id",
			RUN_ID,
			"--public-pack",
			"/tmp/public-pack.json",
			"--public-pack-sha256",
			"a".repeat(64),
		]),
		{
			runId: RUN_ID,
			publicPackPath: "/tmp/public-pack.json",
			publicPackSha256: "a".repeat(64),
		},
	);
	assert.equal(
		parseArgs([
			"--run-id", RUN_ID,
			"--public-pack", "/tmp/public-pack.json",
			"--public-pack-sha256", "a".repeat(64),
			"--owner-directory", "/tmp/private-owner-bundle",
		]).ownerDirectory,
		"/tmp/private-owner-bundle",
	);
});
