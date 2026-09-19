import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { retireDisposableClerkIdentity } from "../supervisor/clerk-bootstrap.ts";
import { validateFreshStartContract } from "./fresh-start-contract.ts";

export const OWNER_BUNDLE_RETIREMENT_RECEIPT =
	"account-retirement-receipt.json";
const STAGED_RECEIPT = `${OWNER_BUNDLE_RETIREMENT_RECEIPT}.next`;
const CONTROL_FILES = [
	"action-and-app-cost-ledger.json",
	"authority-and-start.json",
	"gate-a-evaluation.json",
	"origin-allowlist.json",
	"retention.json",
];
const CERTIFICATE_FILES = [
	"bundle-state.json",
	...CONTROL_FILES,
	"account.json",
	"fresh-start-contract.json",
	"bundle-completion.json",
];
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const USER_ID = /^[A-Za-z0-9_-]{4,256}$/;
const USERNAME = /^flowmap_[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const STATE_KIND = "spike-a-owner-bundle-build";
const COMPLETION_KIND = "spike-a-owner-bundle-completion";
const RECEIPT_KIND = "completed-owner-bundle-retirement-receipt";
const RECEIPT_STATUS = "retired";
const RECEIPT_REASON = "exact-id-absent-and-disposable-marker-empty";

type FileIdentity = { dev: number; ino: number; mode: number };
type DirectoryEntry = { path: string; identity: FileIdentity };
type FileSnapshot = {
	path: string;
	bytes: Buffer;
	sha256: string;
	identity: FileIdentity;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
};
type CertificateHashes = {
	bundle_state_sha256: string;
	account_sha256: string;
	fresh_start_contract_sha256: string;
	bundle_completion_sha256: string;
};
type RetirementReceipt = {
	schema_version: number;
	record_kind: string;
	status: string;
	reason: string;
	certificate_hashes: CertificateHashes;
};
type CertificateInspection = {
	bundleDirectory: string;
	chain: DirectoryEntry[];
	receipt: RetirementReceipt;
	receiptState: "absent" | "published" | "staged";
	assertUnchanged: () => Promise<void>;
	identity: { user_id: unknown; username: unknown; external_id: string };
	expectedFrontendOrigin: unknown;
};
type RetirementDependencies = {
	retireIdentity?: (options: {
		identity: { user_id: unknown; username: unknown; external_id: unknown };
		expectedFrontendOrigin: unknown;
		workingDayDeadline: unknown;
		environment: { CLERK_SECRET_KEY: string | null | undefined };
		fetchImpl: typeof fetch;
		beforeDelete: () => Promise<void>;
		beforeConfirmation: () => Promise<void>;
	}) => Promise<{ retirement_confirmed: boolean }>;
	afterIdentityRetired?: () => Promise<void> | void;
	afterReceiptStaged?: () => Promise<void> | void;
	afterReceiptRenamed?: () => Promise<void> | void;
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytesFor = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const exactKeys = (value: unknown, keys: string[]) =>
	Boolean(
		value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			JSON.stringify(Object.keys(value).sort()) ===
				JSON.stringify([...keys].sort()),
	);
const exactNames = (actual: string[], expected: string[]) =>
	JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const fileIdentity = (stat: Stats): FileIdentity => ({
	dev: stat.dev,
	ino: stat.ino,
	mode: stat.mode & 0o777,
});
const sameIdentity = (stat: Stats | null, expected: FileIdentity): stat is Stats =>
	Boolean(
		stat &&
			!stat.isSymbolicLink() &&
			stat.dev === expected.dev &&
			stat.ino === expected.ino &&
			(stat.mode & 0o777) === expected.mode,
	);

function refused(): never {
	throw new Error("Completed owner bundle retirement did not complete");
}

function parseJson(bytes: Buffer) {
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		refused();
	}
}

function exactHttpsOrigin(value: unknown) {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			url.pathname === "/" &&
			!url.search &&
			!url.hash
			? url.origin
			: null;
	} catch {
		return null;
	}
}

async function captureDirectoryChain(path: string) {
	if (!isAbsolute(path) || resolve(path) !== path || basename(path) === "")
		refused();
	const paths = [];
	for (let current = path; ; current = dirname(current)) {
		paths.push(current);
		if (dirname(current) === current) break;
	}
	const chain: DirectoryEntry[] = [];
	for (const current of paths) {
		const stat = await lstat(current).catch(() => null);
		if (
			!stat?.isDirectory() ||
			stat.isSymbolicLink() ||
			(await realpath(current).catch(() => null)) !== current
		)
			refused();
		chain.push({ path: current, identity: fileIdentity(stat) });
	}
	if (chain[0].identity.mode !== 0o700) refused();
	return chain;
}

async function assertDirectoryChain(chain: DirectoryEntry[]) {
	for (const directory of chain) {
		const stat = await lstat(directory.path).catch(() => null);
		if (
			!stat?.isDirectory() ||
			!sameIdentity(stat, directory.identity) ||
			(await realpath(directory.path).catch(() => null)) !== directory.path
		)
			refused();
	}
}

async function syncDirectory(directory: string, chain: DirectoryEntry[]) {
	await assertDirectoryChain(chain);
	let handle: FileHandle | undefined;
	try {
		handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
		if (!sameIdentity(await handle.stat(), chain[0].identity)) refused();
		await handle.sync();
	} finally {
		await handle?.close();
	}
	await assertDirectoryChain(chain);
}

async function privateSnapshot(path: string, chain: DirectoryEntry[]): Promise<FileSnapshot> {
	await assertDirectoryChain(chain);
	const before = await lstat(path).catch(() => null);
	if (
		!before?.isFile() ||
		before.isSymbolicLink() ||
		(before.mode & 0o777) !== 0o600 ||
		(await realpath(path).catch(() => null)) !== path
	)
		refused();
	let handle: FileHandle | undefined;
	let opened: Stats;
	let bytes: Buffer;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		opened = await handle.stat();
		if (!opened.isFile() || !sameIdentity(opened, fileIdentity(before)))
			refused();
		bytes = await handle.readFile();
		const afterRead = await handle.stat();
		if (
			!sameIdentity(afterRead, fileIdentity(opened)) ||
			afterRead.size !== opened.size ||
			afterRead.mtimeMs !== opened.mtimeMs ||
			afterRead.ctimeMs !== opened.ctimeMs
		)
			refused();
	} finally {
		await handle?.close();
	}
	const after = await lstat(path).catch(() => null);
	if (
		!sameIdentity(after, fileIdentity(opened)) ||
		after.size !== opened.size ||
		after.mtimeMs !== opened.mtimeMs ||
		after.ctimeMs !== opened.ctimeMs
	)
		refused();
	await assertDirectoryChain(chain);
	return {
		path,
		bytes,
		sha256: sha256(bytes),
		identity: fileIdentity(opened),
		size: opened.size,
		mtimeMs: opened.mtimeMs,
		ctimeMs: opened.ctimeMs,
	};
}

async function assertSnapshot(snapshot: FileSnapshot, chain: DirectoryEntry[]) {
	const current = await privateSnapshot(snapshot.path, chain);
	if (
		current.sha256 !== snapshot.sha256 ||
		current.size !== snapshot.size ||
		current.mtimeMs !== snapshot.mtimeMs ||
		current.ctimeMs !== snapshot.ctimeMs ||
		current.identity.dev !== snapshot.identity.dev ||
		current.identity.ino !== snapshot.identity.ino ||
		current.identity.mode !== snapshot.identity.mode
	)
		refused();
}

function accountRecord({ userId, username, provisionedAt }: { userId: string; username: string; provisionedAt: string }) {
	return {
		schema_version: 1,
		record_kind: "spike-a-synthetic-account",
		status: "pass",
		environment: "production",
		provisioned_at: provisionedAt,
		identity: {
			provider: "Clerk",
			provider_user_id: userId,
			username,
			classification: "fresh-disposable-synthetic-non-sensitive",
		},
		creation: {
			helper: "provisionDisposableClerkIdentity",
			completed_at: provisionedAt,
			validated_response_binding: true,
		},
		observed_starting_state: {
			clerk_identity_exists: true,
			target_browser_opened: false,
			target_app_request_made: false,
			target_app_backend_user_initialization: "not-triggered",
			sign_in_token_minted: false,
			session_created: false,
			email_or_message_sent: false,
			paid_entitlement: false,
			profile_or_progress_seeded: false,
		},
		browser_broker_handoff: {
			readiness: "ready-for-supervisor-preauthentication",
			instruction:
				"Authenticate only through the supervisor's one-use Clerk ticket boundary.",
			explorer_disclosure:
				"Identity and authentication material remain supervisor-private.",
		},
		secret_storage: {
			credentials_in_this_file: false,
			sign_in_token_in_this_file: false,
			cookies_in_this_file: false,
			provider_secret_in_this_file: false,
		},
	};
}

function expectedReceipt(hashes: CertificateHashes): RetirementReceipt {
	return {
		schema_version: 1,
		record_kind: RECEIPT_KIND,
		status: RECEIPT_STATUS,
		reason: RECEIPT_REASON,
		certificate_hashes: hashes,
	};
}

async function inspectCertificate({ bundleDirectory, runId }: { bundleDirectory: string; runId: string }): Promise<CertificateInspection> {
	if (!RUN_ID.test(runId ?? "") || basename(bundleDirectory ?? "") !== runId)
		refused();
	const chain = await captureDirectoryChain(bundleDirectory);
	const entries = await readdir(bundleDirectory);
	let receiptState: "absent" | "published" | "staged" = "absent";
	if (
		exactNames(entries, [...CERTIFICATE_FILES, OWNER_BUNDLE_RETIREMENT_RECEIPT])
	)
		receiptState = "published";
	else if (exactNames(entries, [...CERTIFICATE_FILES, STAGED_RECEIPT]))
		receiptState = "staged";
	else if (!exactNames(entries, CERTIFICATE_FILES)) refused();

	const snapshots = Object.fromEntries(
		await Promise.all(
			CERTIFICATE_FILES.map(async (name): Promise<[string, FileSnapshot]> => [
				name,
				await privateSnapshot(join(bundleDirectory, name), chain),
			]),
		),
	);
	const state = parseJson(snapshots["bundle-state.json"].bytes);
	if (
		!exactKeys(state, [
			"schema_version",
			"kind",
			"run_id",
			"clerk_frontend_api_origin",
			"base_control_hashes",
		]) ||
		state.schema_version !== 1 ||
		state.kind !== STATE_KIND ||
		state.run_id !== runId ||
		exactHttpsOrigin(state.clerk_frontend_api_origin) !==
			state.clerk_frontend_api_origin ||
		!exactKeys(state.base_control_hashes, CONTROL_FILES) ||
		!CONTROL_FILES.every(
			(name) =>
				HASH.test(state.base_control_hashes[name] ?? "") &&
				state.base_control_hashes[name] === snapshots[name].sha256,
		)
	)
		refused();

	const originPolicy = parseJson(snapshots["origin-allowlist.json"].bytes);
	const clerkRows =
		originPolicy?.browser_request_dispatch?.allow?.filter(
			(row: { purpose?: unknown }) =>
				typeof row?.purpose === "string" &&
				/Clerk frontend\/auth session transport only/i.test(row.purpose),
		) ?? [];
	if (
		originPolicy?.status !== "pass" ||
		clerkRows.length !== 1 ||
		exactHttpsOrigin(clerkRows[0].origin) !== state.clerk_frontend_api_origin
	)
		refused();

	const account = parseJson(snapshots["account.json"].bytes);
	const userId = account?.identity?.provider_user_id;
	const username = account?.identity?.username;
	const provisionedAt = account?.provisioned_at;
	if (
		!USER_ID.test(userId ?? "") ||
		!USERNAME.test(username ?? "") ||
		typeof provisionedAt !== "string" ||
		!Number.isFinite(Date.parse(provisionedAt)) ||
		new Date(provisionedAt).toISOString() !== provisionedAt ||
		JSON.stringify(account) !==
			JSON.stringify(accountRecord({ userId, username, provisionedAt }))
	)
		refused();

	const contract = parseJson(snapshots["fresh-start-contract.json"].bytes);
	try {
		validateFreshStartContract(contract, {
			runId,
			accountSha256: snapshots["account.json"].sha256,
			account,
			clerkFrontendApiOrigin: state.clerk_frontend_api_origin,
		});
	} catch {
		refused();
	}

	const completion = parseJson(snapshots["bundle-completion.json"].bytes);
	if (
		!exactKeys(completion, [
			"schema_version",
			"kind",
			"run_id",
			"bundle_state_sha256",
			"account_sha256",
			"fresh_start_contract_sha256",
		]) ||
		completion.schema_version !== 1 ||
		completion.kind !== COMPLETION_KIND ||
		completion.run_id !== runId ||
		completion.bundle_state_sha256 !== snapshots["bundle-state.json"].sha256 ||
		completion.account_sha256 !== snapshots["account.json"].sha256 ||
		completion.fresh_start_contract_sha256 !==
			snapshots["fresh-start-contract.json"].sha256
	)
		refused();

	const hashes = {
		bundle_state_sha256: snapshots["bundle-state.json"].sha256,
		account_sha256: snapshots["account.json"].sha256,
		fresh_start_contract_sha256: snapshots["fresh-start-contract.json"].sha256,
		bundle_completion_sha256: snapshots["bundle-completion.json"].sha256,
	};
	const receipt = expectedReceipt(hashes);
	let receiptSnapshot: FileSnapshot | null = null;
	if (receiptState !== "absent") {
		const receiptName =
			receiptState === "published"
				? OWNER_BUNDLE_RETIREMENT_RECEIPT
				: STAGED_RECEIPT;
		receiptSnapshot = await privateSnapshot(
			join(bundleDirectory, receiptName),
			chain,
		);
		if (!receiptSnapshot.bytes.equals(bytesFor(receipt))) refused();
	}

	const expectedEntries =
		receiptState === "published"
			? [...CERTIFICATE_FILES, OWNER_BUNDLE_RETIREMENT_RECEIPT]
			: receiptState === "staged"
				? [...CERTIFICATE_FILES, STAGED_RECEIPT]
				: CERTIFICATE_FILES;
	const assertUnchanged = async () => {
		await assertDirectoryChain(chain);
		if (!exactNames(await readdir(bundleDirectory), expectedEntries)) refused();
		await Promise.all(
			Object.values(snapshots).map((snapshot) =>
				assertSnapshot(snapshot, chain),
			),
		);
		if (receiptSnapshot) await assertSnapshot(receiptSnapshot, chain);
		await assertDirectoryChain(chain);
	};
	await assertUnchanged();
	return {
		bundleDirectory,
		chain,
		receipt,
		receiptState,
		assertUnchanged,
		identity: {
			user_id: userId,
			username,
			external_id: `flowmap_cal_${username.slice("flowmap_".length)}`,
		},
		expectedFrontendOrigin: state.clerk_frontend_api_origin,
	};
}

async function writeReceipt(certificate: CertificateInspection, dependencies: RetirementDependencies) {
	if (certificate.receiptState === "published") {
		await certificate.assertUnchanged();
		await syncDirectory(certificate.bundleDirectory, certificate.chain);
		await certificate.assertUnchanged();
		return;
	}
	const finalPath = join(
		certificate.bundleDirectory,
		OWNER_BUNDLE_RETIREMENT_RECEIPT,
	);
	const stagedPath = join(certificate.bundleDirectory, STAGED_RECEIPT);
	let stagedIdentity: FileIdentity;
	if (certificate.receiptState === "absent") {
		await certificate.assertUnchanged();
		let handle: FileHandle | undefined;
		try {
			handle = await open(
				stagedPath,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			);
			await handle.writeFile(bytesFor(certificate.receipt));
			await handle.chmod(0o600);
			await handle.sync();
			const stat = await handle.stat();
			if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) refused();
			stagedIdentity = fileIdentity(stat);
		} finally {
			await handle?.close();
		}
		await dependencies.afterReceiptStaged?.();
	} else {
		await certificate.assertUnchanged();
		stagedIdentity = fileIdentity(await lstat(stagedPath));
	}

	await assertDirectoryChain(certificate.chain);
	const staged = await privateSnapshot(stagedPath, certificate.chain);
	if (
		!sameIdentity(await lstat(stagedPath).catch(() => null), stagedIdentity) ||
		!staged.bytes.equals(bytesFor(certificate.receipt))
	)
		refused();
	if (await lstat(finalPath).catch(() => null)) refused();
	await rename(stagedPath, finalPath);
	await dependencies.afterReceiptRenamed?.();
	const published = await privateSnapshot(finalPath, certificate.chain);
	if (!published.bytes.equals(bytesFor(certificate.receipt))) refused();
	await syncDirectory(certificate.bundleDirectory, certificate.chain);
	if (
		!exactNames(await readdir(certificate.bundleDirectory), [
			...CERTIFICATE_FILES,
			OWNER_BUNDLE_RETIREMENT_RECEIPT,
		])
	)
		refused();
}

export async function retireCompletedOwnerBundle({
	bundleDirectory,
	runId,
	environment = process.env,
	fetchImpl = fetch,
	workingDayDeadline = null,
	dependencies = {},
}: {
	bundleDirectory: string;
	runId: string;
	environment?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	workingDayDeadline?: unknown;
	dependencies?: RetirementDependencies;
}) {
	let secretKey: string | null | undefined = environment.CLERK_SECRET_KEY;
	delete environment.CLERK_SECRET_KEY;
	try {
		const certificate = await inspectCertificate({ bundleDirectory, runId });
		const providerResult = await (
			dependencies.retireIdentity ?? retireDisposableClerkIdentity
		)({
			identity: certificate.identity,
			expectedFrontendOrigin: certificate.expectedFrontendOrigin,
			workingDayDeadline,
			environment: { CLERK_SECRET_KEY: secretKey },
			fetchImpl,
			beforeDelete: certificate.assertUnchanged,
			beforeConfirmation: certificate.assertUnchanged,
		});
		if (providerResult?.retirement_confirmed !== true) refused();
		secretKey = null;
		await certificate.assertUnchanged();
		await dependencies.afterIdentityRetired?.();
		await writeReceipt(certificate, dependencies);
		return certificate.receipt;
	} catch {
		throw new Error("Completed owner bundle retirement did not complete");
	} finally {
		secretKey = null;
	}
}
