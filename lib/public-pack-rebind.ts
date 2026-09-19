import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
	finalizeExclusivePackOutput,
	validatePublicPack,
} from "./public-pack-runtime.ts";
import { sha256Text } from "./scaffold.ts";
import type { Stats } from "node:fs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type DirIdentity = { dev: number; ino: number };
type OwnedFile = { path: string; identity: DirIdentity };

function isInside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path !== "" && !path.startsWith(`..${sep}`) && path !== "..";
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		Object.keys(value).sort().join("\n") === [...keys].sort().join("\n")
	);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value)
		throw new Error(`${label} is required`);
	return value;
}

function identity(metadata: Stats): DirIdentity {
	return { dev: metadata.dev, ino: metadata.ino };
}

function matchesIdentity(metadata: Stats, expected: DirIdentity): boolean {
	return (
		!metadata.isSymbolicLink() &&
		metadata.dev === expected.dev &&
		metadata.ino === expected.ino
	);
}

async function ordinaryDirectory(path: string, label: string): Promise<{ requested: string; canonical: string; identity: DirIdentity }> {
	const requested = resolve(path);
	const metadata = await lstat(requested);
	if (metadata.isSymbolicLink() || !metadata.isDirectory())
		throw new Error(`${label} must be an ordinary directory`);
	return {
		requested,
		canonical: await realpath(requested),
		identity: identity(metadata),
	};
}

async function directoryIdentity(path: string, label: string): Promise<DirIdentity> {
	const metadata = await lstat(path);
	if (metadata.isSymbolicLink() || !metadata.isDirectory())
		throw new Error(`${label} must be an ordinary directory`);
	return identity(metadata);
}

async function assertOwnedDirectory(path: string, expected: DirIdentity, label: string): Promise<void> {
	const metadata = await lstat(path);
	if (!metadata.isDirectory() || !matchesIdentity(metadata, expected))
		throw new Error(`${label} ownership changed`);
}

async function ordinaryPathWithin({ parent, requestedParent, path, label }: {
	parent: string;
	requestedParent: string;
	path: string;
	label: string;
}): Promise<string> {
	const resolved = resolve(path);
	if (!isInside(requestedParent, resolved))
		throw new Error(`${label} escapes the packs directory`);
	const requestedParts = relative(requestedParent, resolved).split(sep);
	let requested = requestedParent;
	for (const part of requestedParts) {
		requested = join(requested, part);
		if ((await lstat(requested)).isSymbolicLink())
			throw new Error(`${label} may not traverse a symbolic link`);
	}
	const canonical = await realpath(resolved);
	if (!isInside(parent, canonical))
		throw new Error(`${label} escapes the packs directory`);
	const parts = relative(parent, canonical).split(sep);
	let current = parent;
	for (const part of parts) {
		current = join(current, part);
		if ((await lstat(current)).isSymbolicLink())
			throw new Error(`${label} may not traverse a symbolic link`);
	}
	return canonical;
}

function outputDirectory({ packsDirectory, runId }: { packsDirectory: string; runId: string }): string {
	if (typeof runId !== "string" || !RUN_ID.test(runId))
		throw new Error("Run ID is invalid");
	const output = join(packsDirectory, `public-pack-${runId}`);
	if (!isInside(packsDirectory, output))
		throw new Error("Public-pack output escapes the packs directory");
	return output;
}

async function ordinaryFile(path: string, label: string): Promise<DirIdentity> {
	const metadata = await lstat(path);
	if (metadata.isSymbolicLink() || !metadata.isFile())
		throw new Error(`${label} must be an ordinary file`);
	return identity(metadata);
}

async function validateStagedOutput({
	directory,
	directoryIdentity,
	expectedSha256,
}: {
	directory: string;
	directoryIdentity: DirIdentity;
	expectedSha256: string;
}): Promise<{ publicPack: OwnedFile; manifest: OwnedFile; manifestSha256: string }> {
	await assertOwnedDirectory(
		directory,
		directoryIdentity,
		"Staged public-pack output",
	);
	const entries = (await readdir(directory)).sort();
	if (
		entries.length !== 2 ||
		entries[0] !== "public-pack-content-manifest.json" ||
		entries[1] !== "public-pack.json"
	) {
		throw new Error("Staged public-pack output contains unexpected files");
	}
	const publicPackPath = join(directory, "public-pack.json");
	const manifestPath = join(directory, "public-pack-content-manifest.json");
	const [publicPackIdentity, manifestIdentity, bytes, manifestBytes] =
		await Promise.all([
			ordinaryFile(publicPackPath, "Staged public-pack"),
			ordinaryFile(manifestPath, "Staged public-pack manifest"),
			readFile(publicPackPath),
			readFile(manifestPath),
		]);
	if (sha256Text(bytes) !== expectedSha256)
		throw new Error("Staged public-pack bytes changed");
	validatePublicPack(JSON.parse(bytes.toString("utf8")));
	const manifest = JSON.parse(manifestBytes.toString("utf8"));
	if (
		!exactKeys(manifest, ["schema_version", "files"]) ||
		manifest.schema_version !== 1 ||
		!Array.isArray(manifest.files) ||
		manifest.files.length !== 1 ||
		!exactKeys(manifest.files[0], ["path", "sha256"]) ||
		manifest.files[0].path !== "public-pack.json" ||
		manifest.files[0].sha256 !== expectedSha256
	) {
		throw new Error(
			"Staged public-pack manifest is not the required minimal shape",
		);
	}
	return {
		publicPack: { path: publicPackPath, identity: publicPackIdentity },
		manifest: { path: manifestPath, identity: manifestIdentity },
		manifestSha256: sha256Text(manifestBytes),
	};
}

async function unlinkOwnedFile(file: OwnedFile | undefined): Promise<void> {
	if (!file) return;
	try {
		const metadata = await lstat(file.path);
		if (metadata.isFile() && matchesIdentity(metadata, file.identity))
			await unlink(file.path);
	} catch {
		// A missing or replaced file belongs to neither this cleanup nor this run.
	}
}

async function discardOwnedDirectory({ directory, directoryIdentity, files }: {
	directory: string | undefined;
	directoryIdentity: DirIdentity | undefined;
	files: OwnedFile[];
}): Promise<boolean> {
	if (!directory || !directoryIdentity) return false;
	try {
		await assertOwnedDirectory(
			directory,
			directoryIdentity,
			"Rebind temporary output",
		);
	} catch {
		return false;
	}
	for (const file of files) await unlinkOwnedFile(file);
	try {
		await assertOwnedDirectory(
			directory,
			directoryIdentity,
			"Rebind temporary output",
		);
		await rmdir(directory);
		return true;
	} catch {
		return false;
	}
}

/**
 * Rebind immutable public-pack bytes. Content is finalized in an owned staging
 * directory; the required manifest is linked into the exclusive destination
 * last, so a partial output cannot satisfy the target runtime.
 */
export async function rebindPublicPack({
	repository,
	publicPackPath,
	expectedSha256,
	runId,
	finalize = finalizeExclusivePackOutput,
	beforePublish = async () => {},
	afterPublicPackLinked = async () => {},
}: {
	repository: string;
	publicPackPath: string;
	expectedSha256: string;
	runId: string;
	finalize?: (args: { outputDirectory: string }) => Promise<unknown>;
	beforePublish?: (args: { outputDirectory: string; stagingDirectory: string }) => Promise<void>;
	afterPublicPackLinked?: (args: { outputDirectory: string }) => Promise<void>;
}): Promise<{
	run_id: string;
	output_path: string;
	public_pack_sha256: string;
	public_pack_content_manifest_sha256: string;
}> {
	const repositoryRoot = resolve(requireString(repository, "Repository root"));
	const repositoryDirectory = await ordinaryDirectory(
		repositoryRoot,
		"Repository root",
	);
	const packs = await ordinaryDirectory(
		join(repositoryDirectory.requested, "packs"),
		"Packs directory",
	);
	const packsDirectory = packs.canonical;
	const source = await ordinaryPathWithin({
		parent: packsDirectory,
		requestedParent: packs.requested,
		path: requireString(publicPackPath, "Public-pack path"),
		label: "Public-pack source",
	});
	if (basename(source) !== "public-pack.json")
		throw new Error("Public-pack source must be named public-pack.json");
	if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256))
		throw new Error("Expected public-pack SHA-256 is invalid");

	const bytes = await readFile(source);
	if (sha256Text(bytes) !== expectedSha256)
		throw new Error(
			"Public-pack SHA-256 does not match the expected immutable bytes",
		);
	validatePublicPack(JSON.parse(bytes.toString("utf8")));

	const output = outputDirectory({ packsDirectory, runId });
	let staging;
	let stagingIdentity;
	let stagedFiles: OwnedFile[] = [];
	let destinationIdentity;
	let destinationFiles: OwnedFile[] = [];
	try {
		await assertOwnedDirectory(
			packsDirectory,
			packs.identity,
			"Packs directory",
		);
		staging = await mkdtemp(join(packsDirectory, ".public-pack-rebind-"));
		await chmod(staging, 0o700);
		stagingIdentity = await directoryIdentity(staging, "Staging output");
		const stagedPublicPack = join(staging, "public-pack.json");
		await assertOwnedDirectory(staging, stagingIdentity, "Staging output");
		await writeFile(stagedPublicPack, bytes, { flag: "wx", mode: 0o600 });
		stagedFiles = [
			{
				path: stagedPublicPack,
				identity: await ordinaryFile(stagedPublicPack, "Staged public-pack"),
			},
		];
		await assertOwnedDirectory(staging, stagingIdentity, "Staging output");
		await finalize({ outputDirectory: staging });
		let staged = await validateStagedOutput({
			directory: staging,
			directoryIdentity: stagingIdentity,
			expectedSha256,
		});
		stagedFiles = [staged.publicPack, staged.manifest];
		await beforePublish({ outputDirectory: output, stagingDirectory: staging });
		staged = await validateStagedOutput({
			directory: staging,
			directoryIdentity: stagingIdentity,
			expectedSha256,
		});
		stagedFiles = [staged.publicPack, staged.manifest];

		await assertOwnedDirectory(
			packsDirectory,
			packs.identity,
			"Packs directory",
		);
		await mkdir(output, { mode: 0o700 });
		destinationIdentity = await directoryIdentity(
			output,
			"Public-pack destination",
		);
		await assertOwnedDirectory(staging, stagingIdentity, "Staging output");
		await assertOwnedDirectory(
			output,
			destinationIdentity,
			"Public-pack destination",
		);
		const outputPublicPack = join(output, "public-pack.json");
		await link(staged.publicPack.path, outputPublicPack);
		destinationFiles = [
			{ path: outputPublicPack, identity: staged.publicPack.identity },
		];
		await afterPublicPackLinked({ outputDirectory: output });
		await assertOwnedDirectory(staging, stagingIdentity, "Staging output");
		await assertOwnedDirectory(
			output,
			destinationIdentity,
			"Public-pack destination",
		);
		const outputManifest = join(output, "public-pack-content-manifest.json");
		await link(staged.manifest.path, outputManifest);
		destinationFiles = [
			...destinationFiles,
			{ path: outputManifest, identity: staged.manifest.identity },
		];
		await validateStagedOutput({
			directory: output,
			directoryIdentity: destinationIdentity,
			expectedSha256,
		});
		await discardOwnedDirectory({
			directory: staging,
			directoryIdentity: stagingIdentity,
			files: stagedFiles,
		});
		return {
			run_id: runId,
			output_path: relative(repositoryDirectory.canonical, output),
			public_pack_sha256: expectedSha256,
			public_pack_content_manifest_sha256: staged.manifestSha256,
		};
	} catch (error) {
		await discardOwnedDirectory({
			directory: output,
			directoryIdentity: destinationIdentity,
			files: destinationFiles,
		});
		await discardOwnedDirectory({
			directory: staging,
			directoryIdentity: stagingIdentity,
			files: stagedFiles,
		});
		throw error;
	}
}
