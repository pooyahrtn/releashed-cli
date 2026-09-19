import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rmdir,
	unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import {
	preflightExplorerModelConfig,
	prepareExplorerModelRuntime,
} from "./explorer-model-runtime.ts";
import { validateFreshStartContract } from "./fresh-start-contract.ts";
import type { FreshStartValidation } from "./fresh-start-contract.ts";
import { validateGateAEvaluation } from "./gate-a-evaluation.ts";
import { rebindPublicPack } from "./public-pack-rebind.ts";
import { freshCapState, sha256Text } from "./scaffold.ts";
import {
	BOUNDED_ONBOARDING_RUNTIME_MODE,
	buildTargetRuntimeConfig,
} from "./target-runtime.ts";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
const PREPARATION_KIND = "spike-a-fresh-bounded-run-preparation";
const PRIVATE_CONTROL_FILES = [
	"account.json",
	"action-and-app-cost-ledger.json",
	"authority-and-start.json",
	"fresh-start-contract.json",
	"gate-a-evaluation.json",
	"origin-allowlist.json",
	"retention.json",
];
const RETAINED_MODEL_CLASSIFICATIONS = [
	"generic-synthetic-non-target",
	"public-pack-text",
	"Synthetic visible app content from the disposable account after secret and personal-data checks.",
];
const RUN_OUTPUTS = ["input-manifest.json", "model-ledger.jsonl"];
const RUNTIME_OUTPUTS = [
	"cap-state.json",
	"explorer-model-config.json",
	"model-config.json",
	"preparation-receipt.json",
	"target-session-config.json",
];
const PACK_OUTPUTS = [
	"public-pack-content-manifest.json",
	"public-pack.json",
];

type FileIdentity = { dev: number; ino: number };
type DirectoryRef = { path: string; identity: FileIdentity; mode: number };
type FileSnapshot = {
	path: string;
	bytes: Buffer;
	sha256: string;
	identity: FileIdentity;
	mode: number;
};
// Parsed sealed JSON of owner-controlled shape; every use below is guarded by a
// requireCondition check, so the runtime validation (not the static type) stays
// the authority, exactly as in the original.
type JsonSnapshot = FileSnapshot & { value: any };
type OwnedFile = { path: string; identity: FileIdentity };
type AssertBoundary = () => Promise<void>;
// The prepared target config this file validates field by field. Fields are
// required (not optional) because the checks below reject a config that lacks
// them; a missing field fails the comparison and refuses, as before.
type PreparedTargetConfig = {
	run_id: unknown;
	mode: unknown;
	public_pack: { path: unknown; sha256: unknown };
	clerk_auth: {
		frontend_api_origin: unknown;
		approved_disposable_identity: {
			provider_user_id: unknown;
			username: unknown;
		};
	};
};
// buildTargetRuntimeConfig is still untyped JavaScript; its inferred return lacks
// the clerk_auth field this module attaches after the build, so the extension is
// stated here. No cast: the base shape stays inferred, the added field declared.
type MutableTargetConfig = Awaited<ReturnType<typeof buildTargetRuntimeConfig>> & {
	clerk_auth?: Record<string, unknown>;
};
type PreparedExplorerConfig = {
	run_id: unknown;
	run_directory: unknown;
	cap_state_path: unknown;
};
type FreshCap = {
	run_id: unknown;
	abort: unknown;
	browser: Record<string, number | null>;
	app: {
		one_way_actions: unknown;
		actual_eur: unknown;
		outstanding_reservations_eur: unknown;
		class_counts: unknown;
	};
	model: {
		calls: unknown;
		refused_before_dispatch: unknown;
		actual_eur: unknown;
		outstanding_reservations_eur: unknown;
	};
};
type OriginPolicy = {
	browser_request_dispatch?: {
		allow?: Array<{ purpose?: unknown; origin: string }>;
	};
};

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		JSON.stringify(Object.keys(value).sort()) ===
			JSON.stringify([...keys].sort())
	);
}

function requireCondition(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Bounded run preparation refused: ${message}`);
}

// Node's SystemError carries a string code (ENOENT, EEXIST, ...); anything else
// is rethrown unchanged. This reads the property without a cast: only an object
// or function with a string "code" matches, exactly what `error?.code` matched.
function errnoCode(error: unknown): string | undefined {
	if (
		(typeof error === "object" || typeof error === "function") &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
	)
		return error.code;
	return undefined;
}

function canonicalJson(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function identity(metadata: { dev: number; ino: number }): FileIdentity {
	return { dev: metadata.dev, ino: metadata.ino };
}

function matchesIdentity(
	metadata: { isSymbolicLink(): boolean; dev: number; ino: number },
	expected: FileIdentity,
): boolean {
	return (
		!metadata.isSymbolicLink() &&
		metadata.dev === expected.dev &&
		metadata.ino === expected.ino
	);
}

function matchesSnapshotMetadata(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		(left.mode & 0o777) === (right.mode & 0o777)
	);
}

async function ordinaryDirectory(path: string, label: string): Promise<DirectoryRef> {
	const requested = resolve(path);
	const metadata = await lstat(requested).catch(() => null);
	requireCondition(
		metadata !== null && metadata.isDirectory() && !metadata.isSymbolicLink(),
		`${label} must be an ordinary directory`,
	);
	const canonical = await realpath(requested);
	return {
		path: canonical,
		identity: identity(metadata),
		mode: metadata.mode & 0o777,
	};
}

async function assertDirectoryIdentity(
	directory: { path: string; identity: FileIdentity },
	label: string,
): Promise<void> {
	const metadata = await lstat(directory.path).catch(() => null);
	requireCondition(
		metadata !== null && metadata.isDirectory() && matchesIdentity(metadata, directory.identity),
		`${label} identity changed`,
	);
	requireCondition(
		(await realpath(directory.path)) === directory.path,
		`${label} ancestry changed`,
	);
}

async function ensureOrdinaryChildDirectory(
	parent: DirectoryRef,
	name: string,
	label: string,
): Promise<DirectoryRef> {
	await assertDirectoryIdentity(parent, "repository root");
	const path = join(parent.path, name);
	let metadata = await lstat(path).catch((error) => {
		if (errnoCode(error) === "ENOENT") return null;
		throw error;
	});
	if (!metadata) {
		await mkdir(path, { mode: 0o700 });
		metadata = await lstat(path);
	}
	await assertDirectoryIdentity(parent, "repository root");
	requireCondition(
		metadata.isDirectory() && !metadata.isSymbolicLink(),
		`${label} must be an ordinary directory`,
	);
	requireCondition((await realpath(path)) === path, `${label} must be canonical`);
	return {
		path,
		identity: identity(metadata),
		mode: metadata.mode & 0o777,
	};
}

async function ordinaryFile(path: string, label: string): Promise<FileSnapshot> {
	const requested = resolve(path);
	const metadata = await lstat(requested).catch(() => null);
	requireCondition(
		metadata !== null && metadata.isFile() && !metadata.isSymbolicLink(),
		`${label} must be an ordinary file`,
	);
	const canonical = await realpath(requested);
	let handle: FileHandle | undefined;
	try {
		handle = await open(canonical, "r");
		const before = await handle.stat();
		requireCondition(
			before.isFile() && matchesSnapshotMetadata(before, metadata),
			`${label} identity changed before snapshot`,
		);
		const bytes = await handle.readFile();
		const after = await handle.stat();
		requireCondition(
			matchesSnapshotMetadata(after, before),
			`${label} identity changed during snapshot`,
		);
		const pathAfter = await lstat(canonical).catch(() => null);
		requireCondition(
			pathAfter !== null && pathAfter.isFile() && matchesSnapshotMetadata(pathAfter, after),
			`${label} path changed during snapshot`,
		);
		return {
			path: canonical,
			bytes,
			sha256: digest(bytes),
			identity: identity(metadata),
			mode: metadata.mode & 0o777,
		};
	} finally {
		await handle?.close();
	}
}

async function jsonSnapshot(path: string, label: string): Promise<JsonSnapshot> {
	const snapshot = await ordinaryFile(path, label);
	try {
		return { ...snapshot, value: JSON.parse(snapshot.bytes.toString("utf8")) };
	} catch {
		throw new Error(`Bounded run preparation refused: ${label} is invalid JSON`);
	}
}

function clerkFrontendApiOrigin(originPolicy: OriginPolicy): string {
	const matches =
		originPolicy?.browser_request_dispatch?.allow?.filter(
			(entry) =>
				typeof entry?.purpose === "string" &&
				/Clerk frontend\/auth session transport only/i.test(entry.purpose),
		) ?? [];
	requireCondition(matches.length === 1, "owner policy must name one Clerk instance");
	const url = new URL(matches[0].origin);
	requireCondition(
		url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			url.pathname === "/" &&
			!url.search &&
			!url.hash,
		"owner Clerk instance must be a normalized HTTPS origin",
	);
	return url.origin;
}
async function assertSnapshotUnchanged(snapshot: FileSnapshot, label: string): Promise<void> {
	const current = await ordinaryFile(snapshot.path, label);
	requireCondition(
		current.identity.dev === snapshot.identity.dev &&
			current.identity.ino === snapshot.identity.ino &&
			current.sha256 === snapshot.sha256,
		`${label} changed after its sealed snapshot`,
	);
}

async function createExclusiveDirectory(
	path: string,
	label: string,
	assertBoundary: AssertBoundary,
	onCreated?: (createdIdentity: FileIdentity) => void,
): Promise<FileIdentity> {
	await assertBoundary();
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if (errnoCode(error) === "EEXIST")
			throw new Error(
				`Bounded run preparation refused: ${label} already exists`,
			);
		throw error;
	}
	const created = await lstat(path);
	const createdIdentity = identity(created);
	onCreated?.(createdIdentity);
	await assertBoundary();
	const beforeChmod = await lstat(path).catch(() => null);
	requireCondition(
		beforeChmod !== null && beforeChmod.isDirectory() && matchesIdentity(beforeChmod, createdIdentity),
		`${label} identity changed before mode publication`,
	);
	await chmod(path, 0o700);
	const metadata = await lstat(path);
	await assertBoundary();
	requireCondition(
		metadata.isDirectory() &&
			matchesIdentity(metadata, createdIdentity) &&
			(metadata.mode & 0o777) === 0o700,
		`${label} changed during publication`,
	);
	return identity(metadata);
}

async function writePrivate(
	path: string,
	bytes: Buffer,
	{ before, after, onCreated }: { before: AssertBoundary; after: AssertBoundary; onCreated?: (file: OwnedFile) => void },
): Promise<OwnedFile> {
	await before();
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, "wx", 0o600);
		await handle.writeFile(bytes);
		await handle.chmod(0o600);
		const metadata = await handle.stat();
		const created = { path, identity: identity(metadata) };
		onCreated?.(created);
		await after();
		const published = await lstat(path).catch(() => null);
		requireCondition(
			published !== null &&
				published.isFile() &&
				matchesIdentity(published, created.identity) &&
				(published.mode & 0o777) === 0o600,
			"private output changed during publication",
		);
		return created;
	} finally {
		await handle?.close();
	}
}

async function unlinkOwnedFile(file: OwnedFile | null | undefined, assertBoundary: AssertBoundary): Promise<void> {
	if (!file) return;
	await assertBoundary();
	const metadata = await lstat(file.path).catch(() => null);
	if (metadata?.isFile() && matchesIdentity(metadata, file.identity)) {
		await unlink(file.path);
		await assertBoundary();
	}
}

async function removeOwnedDirectory(
	path: string,
	expected: FileIdentity | null,
	files: OwnedFile[],
	assertTrustedRoots: AssertBoundary,
): Promise<void> {
	if (!expected) return;
	await assertTrustedRoots();
	const metadata = await lstat(path).catch(() => null);
	if (!metadata?.isDirectory() || !matchesIdentity(metadata, expected)) return;
	const assertRollbackBoundary = async (): Promise<void> => {
		await assertTrustedRoots();
		const current = await lstat(path).catch(() => null);
		requireCondition(
			current !== null && current.isDirectory() && matchesIdentity(current, expected),
			"rollback directory identity changed",
		);
	};
	for (const file of [...files].reverse()) {
		await unlinkOwnedFile(file, assertRollbackBoundary);
	}
	await assertRollbackBoundary();
	const after = await lstat(path).catch(() => null);
	if (after?.isDirectory() && matchesIdentity(after, expected)) {
		await rmdir(path).catch((error) => {
			if (errnoCode(error) !== "ENOTEMPTY" && errnoCode(error) !== "EEXIST") throw error;
		});
		await assertTrustedRoots();
	}
}

function strictHashSet(value: unknown, names: string[]): boolean {
	// `${...}` coerces exactly as RegExp.test's ToString did on the original
	// `value[name] ?? ""`, so non-string inputs fail the hash match as before.
	return (
		exactKeys(value, names) &&
		names.every((name) => HASH.test(`${value[name] ?? ""}`))
	);
}

async function verifiedFileHashes(
	directory: DirectoryRef,
	names: string[],
	label: string,
	assertBoundary: AssertBoundary = async () => {},
): Promise<{ hashes: Record<string, string>; snapshots: Record<string, FileSnapshot> }> {
	await assertBoundary();
	await assertDirectoryIdentity(directory, label);
	const directoryMetadata = await lstat(directory.path);
	requireCondition(
		(directoryMetadata.mode & 0o777) === 0o700,
		`${label} mode changed after publication`,
	);
	const entries = (await readdir(directory.path)).sort();
	requireCondition(
		JSON.stringify(entries) === JSON.stringify([...names].sort()),
		`${label} contains missing or additional files`,
	);
	const snapshots: Record<string, FileSnapshot> = Object.fromEntries(
		await Promise.all(
			names.map(async (name): Promise<[string, FileSnapshot]> => [
				name,
				await ordinaryFile(join(directory.path, name), `${label} ${name}`),
			]),
		),
	);
	for (const [name, snapshot] of Object.entries(snapshots)) {
		requireCondition(snapshot.mode === 0o600, `${label} ${name} is not mode 0600`);
	}
	await assertBoundary();
	await assertDirectoryIdentity(directory, label);
	requireCondition(
		JSON.stringify((await readdir(directory.path)).sort()) ===
			JSON.stringify([...names].sort()),
		`${label} changed during validation`,
	);
	return {
		hashes: Object.fromEntries(
			names.map((name): [string, string] => [name, snapshots[name].sha256]),
		),
		snapshots,
	};
}

function buildInputManifest({ runId, privateControlHashes, publicPackSha256 }: {
	runId: string;
	privateControlHashes: Record<string, string>;
	publicPackSha256: string;
}) {
	return {
		schema_version: 1,
		record_kind: "spike-a-fresh-bounded-run-input-manifest",
		run_id: runId,
		owner_input_hashes: privateControlHashes,
		owner_inputs_sealed_before_broker_start: true,
		public_pack: { sha256: publicPackSha256 },
		private_control_contents_disclosed: false,
		private_identifiers_disclosed: false,
		gate_a_evaluation_mounted_in_model_sandboxes: false,
		product_state_authority: "first-retained-browser-observation",
	};
}

function publicPackContentManifest(publicPackSha256: string) {
	return {
		schema_version: 1,
		files: [{ path: "public-pack.json", sha256: publicPackSha256 }],
	};
}

function publicResult({ runId, evaluationSha256, idempotentRetry }: {
	runId: string;
	evaluationSha256: string;
	idempotentRetry: boolean;
}) {
	return {
		run_id: runId,
		run_path: join("runs", runId),
		runtime_path: join(".runtime", runId),
		public_pack_path: join("packs", `public-pack-${runId}`),
		target_config_path: join(
			".runtime",
			runId,
			"target-session-config.json",
		),
		explorer_model_config_path: join(
			".runtime",
			runId,
			"explorer-model-config.json",
		),
		gate_a_evaluation_sha256: evaluationSha256,
		live_preflight: "required-before-target-session",
		product_state_authority: "first-retained-browser-observation",
		idempotent_retry: idempotentRetry,
	};
}

type PreparationResult = ReturnType<typeof publicResult>;

async function validateExistingPreparation({
	repo,
	owner,
	runsRoot,
	runtimeRoot,
	packsRoot,
	runId,
	inputBindingSha256,
	publicPackSha256,
	privateControlHashes,
	evaluationSha256,
	freshStart,
	clerkOrigin,
	assertTrustedRoots,
}: {
	repo: DirectoryRef;
	owner: DirectoryRef;
	runsRoot: DirectoryRef;
	runtimeRoot: DirectoryRef;
	packsRoot: DirectoryRef;
	runId: string;
	inputBindingSha256: string;
	publicPackSha256: string;
	privateControlHashes: Record<string, string>;
	evaluationSha256: string;
	freshStart: FreshStartValidation;
	clerkOrigin: string;
	assertTrustedRoots: AssertBoundary;
}): Promise<PreparationResult | null> {
	await assertTrustedRoots();
	const runDirectory = join(runsRoot.path, runId);
	const runtimeDirectory = join(runtimeRoot.path, runId);
	const packDirectory = join(packsRoot.path, `public-pack-${runId}`);
	const receiptPath = join(runtimeDirectory, "preparation-receipt.json");
	const receiptMetadata = await lstat(receiptPath).catch(() => null);
	if (!receiptMetadata) return null;
	const [run, runtime, pack, receipt] = await Promise.all([
		ordinaryDirectory(runDirectory, "existing run path"),
		ordinaryDirectory(runtimeDirectory, "existing runtime path"),
		ordinaryDirectory(packDirectory, "existing public-pack path"),
		jsonSnapshot(receiptPath, "preparation receipt"),
	]);
	await assertTrustedRoots();
	requireCondition(
		exactKeys(receipt.value, [
			"schema_version",
			"record_kind",
			"run_id",
			"input_binding_sha256",
			"output_hashes",
		]) &&
			receipt.value.schema_version === 1 &&
			receipt.value.record_kind === PREPARATION_KIND &&
			receipt.value.run_id === runId &&
			receipt.value.input_binding_sha256 === inputBindingSha256,
		"existing run is not an exact retry of this preparation",
	);
	requireCondition(
		run.mode === 0o700 && runtime.mode === 0o700 && pack.mode === 0o700,
		"existing prepared directory mode changed",
	);
	requireCondition(
		exactKeys(receipt.value.output_hashes, ["run", "runtime", "pack"]) &&
			strictHashSet(receipt.value.output_hashes.run, RUN_OUTPUTS) &&
			strictHashSet(
				receipt.value.output_hashes.runtime,
				RUNTIME_OUTPUTS.filter((name) => name !== "preparation-receipt.json"),
			) &&
			strictHashSet(receipt.value.output_hashes.pack, PACK_OUTPUTS),
		"preparation receipt output hashes are invalid",
	);
	const [runFiles, runtimeFiles, packFiles] = await Promise.all([
		verifiedFileHashes(
			run,
			RUN_OUTPUTS,
			"existing run path",
			assertTrustedRoots,
		),
		verifiedFileHashes(
			runtime,
			RUNTIME_OUTPUTS,
			"existing runtime path",
			assertTrustedRoots,
		),
		verifiedFileHashes(
			pack,
			PACK_OUTPUTS,
			"existing public-pack path",
			assertTrustedRoots,
		),
	]);
	const actualHashes = {
		run: runFiles.hashes,
		runtime: Object.fromEntries(
			Object.entries(runtimeFiles.hashes).filter(
				([name]) => name !== "preparation-receipt.json",
			),
		),
		pack: packFiles.hashes,
	};
	requireCondition(
		JSON.stringify(actualHashes) === JSON.stringify(receipt.value.output_hashes) &&
			actualHashes.run["model-ledger.jsonl"] === sha256Text(Buffer.alloc(0)) &&
			actualHashes.pack["public-pack.json"] === publicPackSha256,
		"existing prepared output changed after publication",
	);
	requireCondition(
		runtimeFiles.snapshots["preparation-receipt.json"].sha256 === receipt.sha256,
		"preparation receipt changed during retry validation",
	);
	const expectedManifest = buildInputManifest({
		runId,
		privateControlHashes,
		publicPackSha256,
	});
	requireCondition(
		runFiles.snapshots["input-manifest.json"].bytes.equals(
			canonicalJson(expectedManifest),
		),
		"existing input manifest is not the exact sealed manifest",
	);
	requireCondition(
		runFiles.snapshots["model-ledger.jsonl"].bytes.byteLength === 0,
		"existing model ledger is not empty",
	);
	requireCondition(
		packFiles.snapshots["public-pack-content-manifest.json"].bytes.equals(
			canonicalJson(publicPackContentManifest(publicPackSha256)),
		),
		"existing public-pack manifest is not the exact immutable binding",
	);
	let cap: FreshCap;
	let target: PreparedTargetConfig;
	let explorer: PreparedExplorerConfig;
	try {
		cap = JSON.parse(runtimeFiles.snapshots["cap-state.json"].bytes.toString("utf8"));
		target = JSON.parse(
			runtimeFiles.snapshots["target-session-config.json"].bytes.toString("utf8"),
		);
		explorer = JSON.parse(
			runtimeFiles.snapshots["explorer-model-config.json"].bytes.toString("utf8"),
		);
	} catch {
		throw new Error(
			"Bounded run preparation refused: existing prepared configuration is invalid JSON",
		);
	}
	validateFreshCap(cap, runId);
	await preflightExplorerModelConfig(explorer);
	const expectedTarget: MutableTargetConfig = await buildTargetRuntimeConfig({
		repository: repo.path,
		ownerDirectory: owner.path,
		runId,
		mode: BOUNDED_ONBOARDING_RUNTIME_MODE,
	});
	expectedTarget.clerk_auth = {
		...expectedTarget.clerk_auth,
		approved_disposable_identity: {
			provider_user_id: freshStart.provider_user_id,
			username: freshStart.username,
		},
	};
	requireCondition(
		runtimeFiles.snapshots["target-session-config.json"].bytes.equals(
			canonicalJson(expectedTarget),
		) &&
		target?.run_id === runId &&
			target.mode === BOUNDED_ONBOARDING_RUNTIME_MODE &&
			target.public_pack?.path === join(packDirectory, "public-pack.json") &&
			target.public_pack.sha256 === publicPackSha256 &&
			target.clerk_auth?.frontend_api_origin === clerkOrigin &&
			target.clerk_auth?.approved_disposable_identity?.provider_user_id ===
				freshStart.provider_user_id &&
			target.clerk_auth?.approved_disposable_identity?.username ===
				freshStart.username &&
			explorer?.run_id === runId &&
			explorer.run_directory === runDirectory &&
			explorer.cap_state_path === join(runtimeDirectory, "cap-state.json"),
		"existing prepared configs are not bound to the sealed run inputs",
	);
	await assertTrustedRoots();
	return publicResult({ runId, evaluationSha256, idempotentRetry: true });
}

function validateFreshCap(cap: FreshCap, runId: string): void {
	requireCondition(
		cap.run_id === runId &&
			cap.abort === null &&
			cap.browser.started_at === null &&
			Object.entries(cap.browser)
				.filter(([key]) => key !== "started_at")
				.every(([, value]) => value === 0) &&
			cap.app.one_way_actions === 0 &&
			cap.app.actual_eur === 0 &&
			cap.app.outstanding_reservations_eur === 0 &&
			exactKeys(cap.app.class_counts, []) &&
			cap.model.calls === 0 &&
			cap.model.refused_before_dispatch === 0 &&
			cap.model.actual_eur === 0 &&
			cap.model.outstanding_reservations_eur === 0,
		"fresh cap state contains a consumed counter",
	);
}

/**
 * Prepare all non-live inputs for one bounded onboarding run.
 *
 * This function deliberately performs no browser or Clerk operation. A later
 * supervisor-owned auth boundary must establish live readiness and the first
 * retained observation decides the actual product state.
 */
export async function prepareBoundedOnboardingRun({
	repository,
	ownerDirectory,
	runId,
	publicPackPath,
	publicPackSha256,
	workingDayDeadline = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
	rebind = rebindPublicPack,
	beforePublish = async () => {},
}: {
	repository: string;
	ownerDirectory: string;
	runId: string;
	publicPackPath: string;
	publicPackSha256: string;
	workingDayDeadline?: string;
	rebind?: typeof rebindPublicPack;
	beforePublish?: (args: {
		runDirectory: string;
		runtimeDirectory: string;
		packDirectory: string;
	}) => Promise<void>;
}): Promise<PreparationResult> {
	requireCondition(typeof runId === "string" && RUN_ID.test(runId), "run id is invalid");
	requireCondition(
		typeof publicPackSha256 === "string" && HASH.test(publicPackSha256),
		"public-pack SHA-256 is invalid",
	);
	requireCondition(
		Number.isFinite(Date.parse(workingDayDeadline)) &&
			Date.parse(workingDayDeadline) > Date.now(),
		"working-day deadline must be in the future",
	);

	const repo = await ordinaryDirectory(repository, "repository root");
	const owner = await ordinaryDirectory(ownerDirectory, "owner directory");
	const [runsRoot, runtimeRoot, packsRoot] = await Promise.all([
		ensureOrdinaryChildDirectory(repo, "runs", "runs root"),
		ensureOrdinaryChildDirectory(repo, ".runtime", "runtime root"),
		ensureOrdinaryChildDirectory(repo, "packs", "packs root"),
	]);
	const assertTrustedRoots = async (): Promise<void> => {
		await assertDirectoryIdentity(repo, "repository root");
		await assertDirectoryIdentity(owner, "owner directory");
		await assertDirectoryIdentity(runsRoot, "runs root");
		await assertDirectoryIdentity(runtimeRoot, "runtime root");
		await assertDirectoryIdentity(packsRoot, "packs root");
	};
	await assertTrustedRoots();
	const sourcePack = await ordinaryFile(publicPackPath, "approved public pack");
	requireCondition(
		basename(sourcePack.path) === "public-pack.json" &&
			sourcePack.sha256 === publicPackSha256,
		"approved public-pack bytes do not match the explicit SHA-256",
	);

	const controls: Record<string, JsonSnapshot> = Object.fromEntries(
		await Promise.all(
			PRIVATE_CONTROL_FILES.map(async (name): Promise<[string, JsonSnapshot]> => [
				name,
				await jsonSnapshot(join(owner.path, name), `private control ${name}`),
			]),
		),
	);
	await assertTrustedRoots();
	const assertSealedInputsUnchanged = async (): Promise<void> => {
		await assertTrustedRoots();
		await assertSnapshotUnchanged(sourcePack, "approved public pack");
		for (const name of PRIVATE_CONTROL_FILES) {
			await assertSnapshotUnchanged(
				controls[name],
				`private control ${name}`,
			);
		}
		await assertTrustedRoots();
	};
	const authority = controls["authority-and-start.json"].value;
	const originPolicy = controls["origin-allowlist.json"].value;
	const account = controls["account.json"].value;
	const clerkOrigin = clerkFrontendApiOrigin(originPolicy);
	requireCondition(
		account?.status === "pass" && account?.identity?.provider === "Clerk",
		"account.json is not an approved Clerk identity",
	);
	const freshStart = validateFreshStartContract(
		controls["fresh-start-contract.json"].value,
		{
			runId,
			accountSha256: controls["account.json"].sha256,
			account,
			clerkFrontendApiOrigin: clerkOrigin,
		},
	);
	validateGateAEvaluation(controls["gate-a-evaluation.json"].value);
	requireCondition(
		authority?.status === "pass" &&
			authority?.model_broker_approval?.status === "approved-not-called" &&
			authority.model_broker_approval.provider === "OpenAI" &&
			authority.model_broker_approval.api === "Responses API" &&
			typeof authority.model_broker_approval.model === "string" &&
			authority.model_broker_approval.model.length > 0,
		"owner model authority is not approved",
	);

	const privateControlHashes = Object.fromEntries(
		PRIVATE_CONTROL_FILES.map((name): [string, string] => [name, controls[name].sha256]),
	);
	const inputBinding = {
		run_id: runId,
		private_control_hashes: privateControlHashes,
		public_pack_sha256: publicPackSha256,
	};
	const inputBindingSha256 = digest(canonicalJson(inputBinding));
	await assertSealedInputsUnchanged();
	const existing = await validateExistingPreparation({
		repo,
		owner,
		runsRoot,
		runtimeRoot,
		packsRoot,
		runId,
		inputBindingSha256,
		publicPackSha256,
		privateControlHashes,
		evaluationSha256: controls["gate-a-evaluation.json"].sha256,
		freshStart,
		clerkOrigin,
		assertTrustedRoots,
	});
	if (existing) {
		await assertSealedInputsUnchanged();
		return existing;
	}

	const runDirectory = join(runsRoot.path, runId);
	const runtimeDirectory = join(runtimeRoot.path, runId);
	const packDirectory = join(packsRoot.path, `public-pack-${runId}`);
	for (const [path, label] of [
		[runDirectory, "run path"],
		[runtimeDirectory, "runtime path"],
		[packDirectory, "public-pack destination"],
	]) {
		await assertTrustedRoots();
		requireCondition(!(await lstat(path).catch(() => null)), `${label} already exists`);
	}

	let runIdentity: FileIdentity | null = null;
	let runtimeIdentity: FileIdentity | null = null;
	let packIdentity: FileIdentity | null = null;
	const runFiles: OwnedFile[] = [];
	const runtimeFiles: OwnedFile[] = [];
	const packFiles: OwnedFile[] = [];
	const assertRunBoundary = async (): Promise<void> => {
		await assertTrustedRoots();
		if (runIdentity) {
			await assertDirectoryIdentity(
				{ path: runDirectory, identity: runIdentity },
				"run path",
			);
		}
	};
	const assertRuntimeBoundary = async (): Promise<void> => {
		await assertTrustedRoots();
		if (runtimeIdentity) {
			await assertDirectoryIdentity(
				{ path: runtimeDirectory, identity: runtimeIdentity },
				"runtime path",
			);
		}
	};
	const writeRun = async (name: string, bytes: Buffer): Promise<void> => {
		await writePrivate(join(runDirectory, name), bytes, {
			before: assertRunBoundary,
			after: assertRunBoundary,
			onCreated: (file) => runFiles.push(file),
		});
	};
	const writeRuntime = async (
		name: string,
		bytes: Buffer,
		before: AssertBoundary = assertRuntimeBoundary,
	): Promise<void> => {
		await writePrivate(join(runtimeDirectory, name), bytes, {
			before,
			after: assertRuntimeBoundary,
			onCreated: (file) => runtimeFiles.push(file),
		});
	};
	try {
		await assertSealedInputsUnchanged();
		await rebind({
			repository: repo.path,
			publicPackPath: sourcePack.path,
			expectedSha256: publicPackSha256,
			runId,
		});
		await assertTrustedRoots();
		const reboundPack = await ordinaryDirectory(
			packDirectory,
			"rebound public-pack path",
		);
		requireCondition(
			reboundPack.mode === 0o700,
			"rebound public-pack path is not mode 0700",
		);
		packIdentity = reboundPack.identity;
		const reboundFiles = await verifiedFileHashes(
			reboundPack,
			PACK_OUTPUTS,
			"rebound public-pack path",
			assertTrustedRoots,
		);
		requireCondition(
			reboundFiles.hashes["public-pack.json"] === publicPackSha256,
			"rebound public pack does not match the explicit SHA-256",
		);
		requireCondition(
			reboundFiles.snapshots["public-pack-content-manifest.json"].bytes.equals(
				canonicalJson(publicPackContentManifest(publicPackSha256)),
			),
			"rebound public-pack manifest is not the exact immutable binding",
		);
		for (const name of PACK_OUTPUTS) {
			packFiles.push({
				path: reboundFiles.snapshots[name].path,
				identity: reboundFiles.snapshots[name].identity,
			});
		}
		await assertSealedInputsUnchanged();
		runIdentity = await createExclusiveDirectory(
			runDirectory,
			"run path",
			assertTrustedRoots,
			(createdIdentity) => {
				runIdentity = createdIdentity;
			},
		);
		runtimeIdentity = await createExclusiveDirectory(
			runtimeDirectory,
			"runtime path",
			assertTrustedRoots,
			(createdIdentity) => {
				runtimeIdentity = createdIdentity;
			},
		);

		const cap = freshCapState(authority.limits, workingDayDeadline, runId);
		validateFreshCap(cap, runId);
		const capStatePath = join(runtimeDirectory, "cap-state.json");
		await writeRuntime("cap-state.json", canonicalJson(cap));
		await writeRun("model-ledger.jsonl", Buffer.alloc(0));

		const inputManifest = buildInputManifest({
			runId,
			privateControlHashes,
			publicPackSha256,
		});
		await writeRun("input-manifest.json", canonicalJson(inputManifest));

		const approval = authority.model_broker_approval;
		const retainedModelConfig = {
			run_id: runId,
			run_directory: runDirectory,
			cap_state_path: capStatePath,
			model: approval.model,
			minimum_output_tokens: 16,
			approved_model_identity_policy: {
				approved_alias: approval.model,
				approved_snapshots: [],
			},
			pricing: approval.pricing,
			allowed_content_classifications: RETAINED_MODEL_CLASSIFICATIONS,
		};
		await writeRuntime("model-config.json", canonicalJson(retainedModelConfig));
		await assertRunBoundary();
		await assertRuntimeBoundary();
		await assertSealedInputsUnchanged();
		await prepareExplorerModelRuntime({
			repository: repo.path,
			ownerDirectory: owner.path,
			runId,
		});
		await assertRunBoundary();
		await assertRuntimeBoundary();
		await assertSealedInputsUnchanged();
		const explorerPath = join(runtimeDirectory, "explorer-model-config.json");
		const explorerSnapshot = await ordinaryFile(
			explorerPath,
			"explorer model config",
		);
		requireCondition(
			explorerSnapshot.mode === 0o600,
			"explorer model config is not mode 0600",
		);
		runtimeFiles.push({ path: explorerPath, identity: explorerSnapshot.identity });

		await assertRunBoundary();
		await assertRuntimeBoundary();
		await assertSealedInputsUnchanged();
		const targetConfig: MutableTargetConfig = await buildTargetRuntimeConfig({
			repository: repo.path,
			ownerDirectory: owner.path,
			runId,
			mode: BOUNDED_ONBOARDING_RUNTIME_MODE,
		});
		targetConfig.clerk_auth = {
			...targetConfig.clerk_auth,
			approved_disposable_identity: {
				provider_user_id: freshStart.provider_user_id,
				username: freshStart.username,
			},
		};
		await writeRuntime(
			"target-session-config.json",
			canonicalJson(targetConfig),
		);

		await beforePublish({ runDirectory, runtimeDirectory, packDirectory });
		await assertRunBoundary();
		await assertRuntimeBoundary();
		await assertSealedInputsUnchanged();
		const [verifiedRun, verifiedRuntime, verifiedPack] = await Promise.all([
			verifiedFileHashes(
				{ path: runDirectory, identity: runIdentity, mode: 0o700 },
				RUN_OUTPUTS,
				"prepared run path",
				assertTrustedRoots,
			),
			verifiedFileHashes(
				{ path: runtimeDirectory, identity: runtimeIdentity, mode: 0o700 },
				RUNTIME_OUTPUTS.filter(
					(name) => name !== "preparation-receipt.json",
				),
				"prepared runtime path",
				assertTrustedRoots,
			),
			verifiedFileHashes(
				{ path: packDirectory, identity: packIdentity, mode: 0o700 },
				PACK_OUTPUTS,
				"prepared public-pack path",
				assertTrustedRoots,
			),
		]);
		const outputHashes = {
			run: verifiedRun.hashes,
			runtime: verifiedRuntime.hashes,
			pack: verifiedPack.hashes,
		};
		requireCondition(
			verifiedRun.snapshots["input-manifest.json"].bytes.equals(
				canonicalJson(inputManifest),
			) &&
				verifiedRun.snapshots["model-ledger.jsonl"].bytes.byteLength === 0 &&
				verifiedRuntime.snapshots["target-session-config.json"].bytes.equals(
					canonicalJson(targetConfig),
				) &&
				verifiedPack.snapshots[
					"public-pack-content-manifest.json"
				].bytes.equals(
					canonicalJson(publicPackContentManifest(publicPackSha256)),
				),
			"prepared artifacts changed before publication",
		);
		let verifiedCap: FreshCap;
		let verifiedExplorer: unknown;
		try {
			verifiedCap = JSON.parse(
				verifiedRuntime.snapshots["cap-state.json"].bytes.toString("utf8"),
			);
			verifiedExplorer = JSON.parse(
				verifiedRuntime.snapshots["explorer-model-config.json"].bytes.toString("utf8"),
			);
		} catch {
			throw new Error(
				"Bounded run preparation refused: prepared config changed before publication",
			);
		}
		validateFreshCap(verifiedCap, runId);
		await preflightExplorerModelConfig(verifiedExplorer);
		requireCondition(
			outputHashes.run["model-ledger.jsonl"] === sha256Text(Buffer.alloc(0)),
			"fresh model ledger is not zero bytes",
		);
		const receipt = {
			schema_version: 1,
			record_kind: PREPARATION_KIND,
			run_id: runId,
			input_binding_sha256: inputBindingSha256,
			output_hashes: outputHashes,
		};
		await writeRuntime(
			"preparation-receipt.json",
			canonicalJson(receipt),
			async () => {
				await assertRuntimeBoundary();
				await assertRunBoundary();
				await assertSealedInputsUnchanged();
			},
		);
		await assertSealedInputsUnchanged();
		return publicResult({
			runId,
			evaluationSha256: controls["gate-a-evaluation.json"].sha256,
			idempotentRetry: false,
		});
	} catch (error) {
		await removeOwnedDirectory(
			runtimeDirectory,
			runtimeIdentity,
			runtimeFiles,
			assertTrustedRoots,
		).catch(() => {});
		await removeOwnedDirectory(
			runDirectory,
			runIdentity,
			runFiles,
			assertTrustedRoots,
		).catch(() => {});
		await removeOwnedDirectory(
			packDirectory,
			packIdentity,
			packFiles,
			assertTrustedRoots,
		).catch(() => {});
		throw error;
	}
}

export const boundedRunPreparationContract = {
	private_control_files: [...PRIVATE_CONTROL_FILES],
	run_outputs: [...RUN_OUTPUTS],
	runtime_outputs: [...RUNTIME_OUTPUTS],
	pack_outputs: [...PACK_OUTPUTS],
};
