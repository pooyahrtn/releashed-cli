import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	provisionDisposableClerkIdentity,
	reconcileDisposableClerkRecovery,
	verifyDisposableClerkIdentity,
} from "../supervisor/clerk-bootstrap.mjs";
import { FIRST_OBSERVATION_AUTHORITY, FRESH_START_RECORD_KIND, validateFreshStartContract } from "./fresh-start-contract.mjs";

export const BUNDLE_CONTROL_FILES = [
	"action-and-app-cost-ledger.json",
	"authority-and-start.json",
	"gate-a-evaluation.json",
	"origin-allowlist.json",
	"retention.json",
];
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const USER_ID = /^[A-Za-z0-9_-]{4,256}$/;
const HASH = /^[0-9a-f]{64}$/;
const STATE_KIND = "spike-a-owner-bundle-build";
const RECOVERY_KIND = "spike-a-owner-bundle-recovery";
const COMPLETION_KIND = "spike-a-owner-bundle-completion";
const FINAL_NAMES = ["bundle-state.json", ...BUNDLE_CONTROL_FILES, "account.json", "fresh-start-contract.json", "bundle-completion.json"];
const OWNED_NAMES = [...FINAL_NAMES, "recovery.json", "recovery.json.next"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const body = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777 });
const sameIdentity = (stat, expected) => Boolean(
	stat && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino && (stat.mode & 0o777) === expected.mode
);
const exactKeys = (value, keys) => Boolean(
	value && typeof value === "object" && !Array.isArray(value) &&
	JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
);
const exactNames = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());

function refused() { throw new Error("Owner bundle creation did not complete"); }

/*
 * This boundary defends against accidental replacement, symlinks, and ancestor
 * changes observed between operations. A malicious process running as this same
 * OS user is out of scope: it can already inspect this process and its provider
 * secret, and closing its syscall-level races would require a native openat layer.
 */

function exactHttpsOrigin(value) {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
			? url.origin
			: null;
	} catch { return null; }
}

async function directory(path, { privateMode = false } = {}) {
	if (!isAbsolute(path) || resolve(path) !== path) refused();
	const stat = await lstat(path).catch(() => null);
	if (!stat?.isDirectory() || stat.isSymbolicLink() || (privateMode && (stat.mode & 0o077) !== 0) || await realpath(path).catch(() => null) !== path) refused();
	return { path, identity: identity(stat) };
}

async function assertDirectory(directory) {
	const stat = await lstat(directory.path).catch(() => null);
	if (!stat?.isDirectory() || !sameIdentity(stat, directory.identity) || await realpath(directory.path).catch(() => null) !== directory.path) refused();
}

async function syncDirectory(directory) {
	await assertDirectory(directory);
	let handle;
	try {
		handle = await open(directory.path, constants.O_RDONLY | constants.O_NOFOLLOW);
		if (!sameIdentity(await handle.stat(), directory.identity)) refused();
		await handle.sync();
	} finally { await handle?.close(); }
	await assertDirectory(directory);
}

async function privateSnapshot(path, boundary = async () => {}) {
	await boundary();
	const pathBefore = await lstat(path).catch(() => null);
	if (!pathBefore?.isFile() || pathBefore.isSymbolicLink() || (pathBefore.mode & 0o777) !== 0o600 || await realpath(path).catch(() => null) !== path) refused();
	let handle;
	let bytes;
	let opened;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		opened = await handle.stat();
		if (!opened.isFile() || !sameIdentity(opened, identity(pathBefore))) refused();
		bytes = await handle.readFile();
		const afterRead = await handle.stat();
		if (!sameIdentity(afterRead, identity(opened)) || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs) refused();
	} finally { await handle?.close(); }
	const pathAfter = await lstat(path).catch(() => null);
	if (!pathAfter?.isFile() || !sameIdentity(pathAfter, identity(opened)) || pathAfter.size !== opened.size || pathAfter.mtimeMs !== opened.mtimeMs || pathAfter.ctimeMs !== opened.ctimeMs) refused();
	await boundary();
	return { path, bytes, sha256: sha256(bytes), identity: identity(opened), size: opened.size, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs };
}

async function assertSnapshot(snapshot, boundary) {
	const current = await privateSnapshot(snapshot.path, boundary);
	if (
		current.identity.dev !== snapshot.identity.dev || current.identity.ino !== snapshot.identity.ino || current.identity.mode !== snapshot.identity.mode ||
		current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs || current.ctimeMs !== snapshot.ctimeMs || current.sha256 !== snapshot.sha256
	) refused();
}

async function writeOwned(path, bytes, owned, { boundary, parent, replace = false }) {
	await boundary();
	if (replace) {
		const next = `${path}.next`;
		await writeOwned(next, bytes, owned, { boundary, parent });
		await boundary();
		await rename(next, path);
		owned.delete(next);
		const stat = await lstat(path).catch(() => null);
		if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) refused();
		owned.set(path, identity(stat));
	} else {
		let handle;
		try {
			handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			await handle.writeFile(bytes);
			await handle.chmod(0o600);
			await handle.sync();
			const stat = await handle.stat();
			if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) refused();
			owned.set(path, identity(stat));
		} finally { await handle?.close(); }
	}
	await boundary();
	if (!sameIdentity(await lstat(path).catch(() => null), owned.get(path))) refused();
	await syncDirectory(parent);
	await boundary();
}

async function unlinkOwned(path, expected, { boundary, parent }) {
	await boundary();
	if (!sameIdentity(await lstat(path).catch(() => null), expected)) refused();
	await unlink(path);
	await boundary();
	await syncDirectory(parent);
	if (await lstat(path).catch(() => null)) refused();
}

async function removeOwned(bundle, bundleRoot, parent, owned) {
	const boundary = async () => { await assertDirectory(parent); await assertDirectory(bundleRoot); };
	await boundary();
	for (const [path, expected] of [...owned].reverse()) {
		const stat = await lstat(path).catch(() => null);
		if (sameIdentity(stat, expected)) {
			await unlink(path);
			await boundary();
			await syncDirectory(bundleRoot);
		}
	}
	if ((await readdir(bundle)).length !== 0) return false;
	await rmdir(bundle);
	await syncDirectory(parent);
	if (await lstat(bundle).catch(() => null)) refused();
	return true;
}

function clerkOrigin(policy) {
	const rows = policy?.browser_request_dispatch?.allow?.filter((row) =>
		typeof row?.purpose === "string" && /Clerk frontend\/auth session transport only/i.test(row.purpose)) ?? [];
	if (policy?.status !== "pass" || rows.length !== 1) refused();
	const origin = exactHttpsOrigin(rows[0].origin);
	if (!origin) refused();
	return origin;
}

function stateValue(bytes, runId) {
	let value;
	try { value = JSON.parse(bytes); } catch { refused(); }
	if (
		!exactKeys(value, ["schema_version", "kind", "run_id", "clerk_frontend_api_origin", "base_control_hashes"]) ||
		value.schema_version !== 1 || value.kind !== STATE_KIND || value.run_id !== runId ||
		exactHttpsOrigin(value.clerk_frontend_api_origin) !== value.clerk_frontend_api_origin || !exactKeys(value.base_control_hashes, BUNDLE_CONTROL_FILES) ||
		!BUNDLE_CONTROL_FILES.every((name) => HASH.test(value.base_control_hashes[name] ?? ""))
	) refused();
	return value;
}

function recoveryValue(bytes, { runId, stateSha256 }) {
	let value;
	try { value = JSON.parse(bytes); } catch { refused(); }
	if (
		!exactKeys(value, ["schema_version", "kind", "run_id", "bundle_state_sha256", "state", "external_id", "user_id"]) ||
		value.schema_version !== 1 || value.kind !== RECOVERY_KIND || value.run_id !== runId || value.bundle_state_sha256 !== stateSha256 ||
		!["creation-pending", "identity-bound"].includes(value.state) || !/^flowmap_cal_[0-9a-f]{32}$/.test(value.external_id ?? "") ||
		(value.state === "creation-pending" ? value.user_id !== null : !USER_ID.test(value.user_id ?? ""))
	) refused();
	return value;
}

function accountRecord({ userId, username, provisionedAt }) {
	return {
		schema_version: 1, record_kind: "spike-a-synthetic-account", status: "pass", environment: "production", provisioned_at: provisionedAt,
		identity: { provider: "Clerk", provider_user_id: userId, username, classification: "fresh-disposable-synthetic-non-sensitive" },
		creation: { helper: "provisionDisposableClerkIdentity", completed_at: provisionedAt, validated_response_binding: true },
		observed_starting_state: { clerk_identity_exists: true, target_browser_opened: false, target_app_request_made: false, target_app_backend_user_initialization: "not-triggered", sign_in_token_minted: false, session_created: false, email_or_message_sent: false, paid_entitlement: false, profile_or_progress_seeded: false },
		browser_broker_handoff: { readiness: "ready-for-supervisor-preauthentication", instruction: "Authenticate only through the supervisor's one-use Clerk ticket boundary.", explorer_disclosure: "Identity and authentication material remain supervisor-private." },
		secret_storage: { credentials_in_this_file: false, sign_in_token_in_this_file: false, cookies_in_this_file: false, provider_secret_in_this_file: false },
	};
}

function accountValue(value, { userId, username }) {
	const provisionedAt = value?.provisioned_at;
	if (
		!USER_ID.test(userId ?? "") || !/^flowmap_[0-9a-f]{32}$/.test(username ?? "") ||
		typeof provisionedAt !== "string" || !Number.isFinite(Date.parse(provisionedAt)) || new Date(provisionedAt).toISOString() !== provisionedAt ||
		JSON.stringify(value) !== JSON.stringify(accountRecord({ userId, username, provisionedAt }))
	) refused();
	return value;
}

function completionValue(bytes, { runId, stateSha256 }) {
	let value;
	try { value = JSON.parse(bytes); } catch { refused(); }
	if (
		!exactKeys(value, ["schema_version", "kind", "run_id", "bundle_state_sha256", "account_sha256", "fresh_start_contract_sha256"]) ||
		value.schema_version !== 1 || value.kind !== COMPLETION_KIND || value.run_id !== runId || value.bundle_state_sha256 !== stateSha256 ||
		!HASH.test(value.account_sha256 ?? "") || !HASH.test(value.fresh_start_contract_sha256 ?? "")
	) refused();
	return value;
}

const providerRecovery = (value) => ({ state: value.state, external_id: value.external_id, user_id: value.user_id });

async function inspectExisting(bundle, runId, parent) {
	const root = await directory(bundle, { privateMode: true });
	const boundary = async () => { await assertDirectory(parent); await assertDirectory(root); };
	const entries = await readdir(bundle);
	const snapshots = new Map();
	for (const name of OWNED_NAMES) {
		if (entries.includes(name)) snapshots.set(name, await privateSnapshot(join(bundle, name), boundary));
	}
	const stateFile = snapshots.get("bundle-state.json");
	if (!stateFile) refused();
	const state = stateValue(stateFile.bytes, runId);
	if (exactNames(entries, ["bundle-state.json"])) {
		return {
			complete: false,
			preProvision: true,
			root,
			owned: new Map([[stateFile.path, stateFile.identity]]),
		};
	}
	const final = exactNames(entries, FINAL_NAMES);
	const finalWithRecovery = exactNames(entries, [...FINAL_NAMES, "recovery.json"]);
	if (final || finalWithRecovery) {
		for (const name of BUNDLE_CONTROL_FILES) if (snapshots.get(name)?.sha256 !== state.base_control_hashes[name]) refused();
		let originPolicy;
		let account;
		let contract;
		try {
			originPolicy = JSON.parse(snapshots.get("origin-allowlist.json").bytes);
			account = JSON.parse(snapshots.get("account.json").bytes);
			contract = JSON.parse(snapshots.get("fresh-start-contract.json").bytes);
		} catch { refused(); }
		if (clerkOrigin(originPolicy) !== state.clerk_frontend_api_origin) refused();
		const userId = account?.identity?.provider_user_id;
		const username = account?.identity?.username;
		if (!USER_ID.test(userId ?? "") || !/^flowmap_[0-9a-f]{32}$/.test(username ?? "")) refused();
		accountValue(account, { userId, username });
		try {
			validateFreshStartContract(contract, { runId, accountSha256: snapshots.get("account.json").sha256, account, clerkFrontendApiOrigin: state.clerk_frontend_api_origin });
		} catch { refused(); }
		const completion = completionValue(snapshots.get("bundle-completion.json").bytes, { runId, stateSha256: stateFile.sha256 });
		if (completion.account_sha256 !== snapshots.get("account.json").sha256 || completion.fresh_start_contract_sha256 !== snapshots.get("fresh-start-contract.json").sha256) refused();
		if (finalWithRecovery) {
			const recovery = recoveryValue(snapshots.get("recovery.json").bytes, { runId, stateSha256: stateFile.sha256 });
			const username = `flowmap_${recovery.external_id.slice("flowmap_cal_".length)}`;
			if (recovery.state !== "identity-bound" || recovery.user_id !== account?.identity?.provider_user_id || username !== account?.identity?.username) refused();
			return {
				complete: false,
				pendingCompletion: true,
				root,
				state,
				recovery: providerRecovery(recovery),
				account: { user_id: recovery.user_id, username, external_id: recovery.external_id },
				recoveryIdentity: snapshots.get("recovery.json").identity,
			};
		}
		await boundary();
		if (!exactNames(await readdir(bundle), FINAL_NAMES)) refused();
		return { complete: true };
	}
	// A full bundle plus any other entry is ambiguous custody, never a partial build to delete.
	if (FINAL_NAMES.every((name) => entries.includes(name))) refused();
	if (!snapshots.has("recovery.json")) refused();
	const recovery = recoveryValue(snapshots.get("recovery.json").bytes, { runId, stateSha256: stateFile.sha256 });
	let effectiveRecovery = recovery;
	if (snapshots.has("recovery.json.next")) {
		const next = recoveryValue(snapshots.get("recovery.json.next").bytes, { runId, stateSha256: stateFile.sha256 });
		if (recovery.state !== "creation-pending" || next.state !== "identity-bound" || next.external_id !== recovery.external_id) refused();
		effectiveRecovery = next;
	}
	return {
		complete: false,
		root,
		state,
		recovery: providerRecovery(effectiveRecovery),
		owned: new Map([...snapshots.values()].map((snapshot) => [snapshot.path, snapshot.identity])),
	};
}

async function snapshotBase(base) {
	const boundary = () => assertDirectory(base);
	const snapshots = Object.fromEntries(await Promise.all(BUNDLE_CONTROL_FILES.map(async (name) => [name, await privateSnapshot(join(base.path, name), boundary)])));
	const hashes = Object.fromEntries(BUNDLE_CONTROL_FILES.map((name) => [name, snapshots[name].sha256]));
	let policy;
	try { policy = JSON.parse(snapshots["origin-allowlist.json"].bytes); } catch { refused(); }
	return { snapshots, hashes, origin: clerkOrigin(policy) };
}

export async function createImmutableOwnerBundle({ baseOwnerDirectory, bundleParent, runId, secretKey, fetchImpl = fetch, dependencies = {} }) {
	if (!RUN_ID.test(runId ?? "") || typeof secretKey !== "string" || !(secretKey.startsWith("sk_live_") || secretKey.startsWith("sk_test_")) || /[\r\n]/.test(secretKey)) refused();
	const base = await directory(resolve(baseOwnerDirectory ?? ""));
	const parent = await directory(resolve(bundleParent ?? ""));
	const bundle = join(parent.path, runId);

	if (await lstat(bundle).catch(() => null)) {
		const existing = await inspectExisting(bundle, runId, parent);
		if (existing.complete) return { schema_version: 1, status: "already-created", run_id: runId };
		if (existing.pendingCompletion) {
			let proof;
			try {
				proof = await (dependencies.verifyIdentity ?? verifyDisposableClerkIdentity)({
					identity: existing.account,
					expectedFrontendOrigin: existing.state.clerk_frontend_api_origin,
					environment: { CLERK_SECRET_KEY: secretKey },
					fetchImpl,
				});
			} catch { refused(); }
			if (proof?.identity_exact !== true) refused();
			const boundary = async () => { await assertDirectory(parent); await assertDirectory(existing.root); };
			await unlinkOwned(join(bundle, "recovery.json"), existing.recoveryIdentity, { boundary, parent: existing.root });
			if (!exactNames(await readdir(bundle), FINAL_NAMES)) refused();
			return { schema_version: 1, status: "already-created", run_id: runId };
		}
		if (!existing.preProvision) {
			const result = await (dependencies.reconcileRecovery ?? reconcileDisposableClerkRecovery)({
				recovery: existing.recovery,
				expectedFrontendOrigin: existing.state.clerk_frontend_api_origin,
				environment: { CLERK_SECRET_KEY: secretKey },
				fetchImpl,
			});
			if (result?.cleanup_complete !== true) refused();
		}
		if (!await removeOwned(bundle, existing.root, parent, existing.owned)) refused();
	}

	const { snapshots, hashes, origin } = await snapshotBase(base);
	await assertDirectory(base);
	await assertDirectory(parent);
	await mkdir(bundle, { mode: 0o700 });
	const bundleRoot = await directory(bundle, { privateMode: true });
	if (bundleRoot.identity.mode !== 0o700) refused();
	await syncDirectory(parent);
	const boundary = async () => { await assertDirectory(parent); await assertDirectory(bundleRoot); };
	const owned = new Map();
	const stateBytes = body({ schema_version: 1, kind: STATE_KIND, run_id: runId, clerk_frontend_api_origin: origin, base_control_hashes: hashes });
	const stateSha256 = sha256(stateBytes);
	await writeOwned(join(bundle, "bundle-state.json"), stateBytes, owned, { boundary, parent: bundleRoot });
	let lifecycle = null;
	try {
		for (const name of BUNDLE_CONTROL_FILES) await assertSnapshot(snapshots[name], () => assertDirectory(base));
		lifecycle = await (dependencies.provisionIdentity ?? provisionDisposableClerkIdentity)({
			environment: { CLERK_SECRET_KEY: secretKey }, expectedFrontendOrigin: origin, fetchImpl,
			onRecoveryMaterial: async (material) => writeOwned(
				join(bundle, "recovery.json"),
				body({ schema_version: 1, kind: RECOVERY_KIND, run_id: runId, bundle_state_sha256: stateSha256, ...material }),
				owned,
				{ boundary, parent: bundleRoot, replace: material.state === "identity-bound" },
			),
		});
		const recovery = recoveryValue((await privateSnapshot(join(bundle, "recovery.json"), boundary)).bytes, { runId, stateSha256 });
		if (recovery.state !== "identity-bound" || recovery.user_id !== lifecycle.userId) refused();
		const username = `flowmap_${recovery.external_id.slice("flowmap_cal_".length)}`;
		const provisionedAt = (dependencies.now ?? (() => new Date()))().toISOString();
		const account = accountRecord({ userId: lifecycle.userId, username, provisionedAt });
		accountValue(account, { userId: lifecycle.userId, username });
		const accountBytes = body(account);
		const contract = {
			schema_version: 1, record_kind: FRESH_START_RECORD_KIND, status: "pass", run_id: runId,
			approved_account_binding: { file_name: "account.json", sha256: sha256(accountBytes), clerk_frontend_api_origin: origin, provider_user_id: lifecycle.userId, username },
			product_state_rule: { authority: FIRST_OBSERVATION_AUTHORITY, pre_observation_claims: [] },
		};
		try {
			validateFreshStartContract(contract, { runId, accountSha256: sha256(accountBytes), account, clerkFrontendApiOrigin: origin });
		} catch { refused(); }
		const contractBytes = body(contract);
		const completionBytes = body({
			schema_version: 1,
			kind: COMPLETION_KIND,
			run_id: runId,
			bundle_state_sha256: stateSha256,
			account_sha256: sha256(accountBytes),
			fresh_start_contract_sha256: sha256(contractBytes),
		});
		for (const name of BUNDLE_CONTROL_FILES) await writeOwned(join(bundle, name), snapshots[name].bytes, owned, { boundary, parent: bundleRoot });
		await writeOwned(join(bundle, "account.json"), accountBytes, owned, { boundary, parent: bundleRoot });
		await writeOwned(join(bundle, "fresh-start-contract.json"), contractBytes, owned, { boundary, parent: bundleRoot });
		await writeOwned(join(bundle, "bundle-completion.json"), completionBytes, owned, { boundary, parent: bundleRoot });
		for (const name of BUNDLE_CONTROL_FILES) await assertSnapshot(snapshots[name], () => assertDirectory(base));
		await boundary();
		if (!exactNames(await readdir(bundle), [...FINAL_NAMES, "recovery.json"])) refused();
		await dependencies.beforeComplete?.({ bundle });
		await boundary();
		if (!exactNames(await readdir(bundle), [...FINAL_NAMES, "recovery.json"])) refused();
		await unlinkOwned(join(bundle, "recovery.json"), owned.get(join(bundle, "recovery.json")), { boundary, parent: bundleRoot });
		owned.delete(join(bundle, "recovery.json"));
		await boundary();
		if (!exactNames(await readdir(bundle), FINAL_NAMES)) refused();
		return { schema_version: 1, status: "created", run_id: runId };
	} catch (error) {
		if (lifecycle) {
			const cleanup = await lifecycle.cleanup({ browserStopped: true }).catch(() => null);
			if (cleanup?.cleanup_complete === true) await removeOwned(bundle, bundleRoot, parent, owned).catch(() => {});
		} else {
			let cleanup = error?.cleanup ?? null;
			if (typeof error?.cleanup_handle === "function") cleanup = await error.cleanup_handle().catch(() => cleanup);
			if (cleanup?.cleanup_complete === true) await removeOwned(bundle, bundleRoot, parent, owned).catch(() => {});
		}
		refused();
	}
}
