import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	access,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rebindPublicPack } from "../lib/public-pack-rebind.mjs";
import { parseArgs } from "../scripts/rebind-public-pack.mjs";

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function pack() {
	return {
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
				raw_sha256: "a".repeat(64),
				raw_bytes: 1,
				derived_text_sha256: "b".repeat(64),
				derived_text_bytes: 1,
			},
		],
	};
}

async function fixture() {
	const repository = await mkdtemp(join(tmpdir(), "public-pack-rebind-"));
	const packs = join(repository, "packs");
	const sourceDirectory = join(packs, "source");
	const source = join(sourceDirectory, "public-pack.json");
	const bytes = Buffer.from(`${JSON.stringify(pack(), null, 2)}\n`);
	await mkdir(sourceDirectory, { recursive: true });
	await writeFile(source, bytes);
	return { repository, packs, source, bytes, expectedSha256: sha256(bytes) };
}

async function doesNotExist(path) {
	await assert.rejects(access(path));
}

test("CLI accepts only its exact four-flag contract", () => {
	assert.throws(() => parseArgs(["--run-id", "successor-1"]), /Usage:/);
	assert.throws(
		() =>
			parseArgs([
				"--repository",
				"/repo",
				"--run-id",
				"successor-1",
				"--public-pack",
				"/repo/packs/source/public-pack.json",
				"--public-pack-sha256",
				"a".repeat(64),
				"--extra",
				"no",
			]),
		/Usage:/,
	);
});

test("rebinds only the exact immutable pack bytes with the target manifest shape", async () => {
	const value = await fixture();
	const result = await rebindPublicPack({
		repository: value.repository,
		publicPackPath: value.source,
		expectedSha256: value.expectedSha256,
		runId: "successor-1",
	});
	const output = join(value.packs, "public-pack-successor-1");
	assert.deepEqual(result, {
		run_id: "successor-1",
		output_path: "packs/public-pack-successor-1",
		public_pack_sha256: value.expectedSha256,
		public_pack_content_manifest_sha256: sha256(
			`${JSON.stringify({ schema_version: 1, files: [{ path: "public-pack.json", sha256: value.expectedSha256 }] }, null, 2)}\n`,
		),
	});
	assert.deepEqual(await readdir(output), [
		"public-pack-content-manifest.json",
		"public-pack.json",
	]);
	assert.deepEqual(
		await readFile(join(output, "public-pack.json")),
		value.bytes,
	);
	assert.deepEqual(
		JSON.parse(
			await readFile(join(output, "public-pack-content-manifest.json"), "utf8"),
		),
		{
			schema_version: 1,
			files: [{ path: "public-pack.json", sha256: value.expectedSha256 }],
		},
	);
	assert.deepEqual(await readFile(value.source), value.bytes);
});

test("refuses tampered bytes and a wrong expected hash before creating output", async () => {
	const value = await fixture();
	await writeFile(
		value.source,
		Buffer.from(
			`${JSON.stringify({ ...pack(), product_summary: "Tampered." })}\n`,
		),
	);
	await assert.rejects(
		rebindPublicPack({
			repository: value.repository,
			publicPackPath: value.source,
			expectedSha256: value.expectedSha256,
			runId: "tampered",
		}),
		/does not match/,
	);
	await doesNotExist(join(value.packs, "public-pack-tampered"));
	await assert.rejects(
		rebindPublicPack({
			repository: value.repository,
			publicPackPath: value.source,
			expectedSha256: "c".repeat(64),
			runId: "wrong-hash",
		}),
		/does not match/,
	);
	await doesNotExist(join(value.packs, "public-pack-wrong-hash"));
});

test("refuses a symbolic-link source and an occupied destination without touching either", async () => {
	const value = await fixture();
	const outside = join(value.repository, "outside-public-pack.json");
	await writeFile(outside, value.bytes);
	await assert.rejects(
		rebindPublicPack({
			repository: value.repository,
			publicPackPath: outside,
			expectedSha256: value.expectedSha256,
			runId: "outside",
		}),
		/escapes the packs directory/,
	);
	await doesNotExist(join(value.packs, "public-pack-outside"));

	const link = join(value.packs, "linked-public-pack.json");
	await symlink(value.source, link);
	await assert.rejects(
		rebindPublicPack({
			repository: value.repository,
			publicPackPath: link,
			expectedSha256: value.expectedSha256,
			runId: "linked",
		}),
		/symbolic link/,
	);
	await doesNotExist(join(value.packs, "public-pack-linked"));

	const occupied = join(value.packs, "public-pack-collision");
	await mkdir(occupied);
	await writeFile(join(occupied, "keep"), "untouched");
	await assert.rejects(
		rebindPublicPack({
			repository: value.repository,
			publicPackPath: value.source,
			expectedSha256: value.expectedSha256,
			runId: "collision",
		}),
		/EEXIST/,
	);
	assert.equal(await readFile(join(occupied, "keep"), "utf8"), "untouched");
});

test("cleans an interrupted reserved output so the same run ID can retry", async () => {
	const value = await fixture();
	await assert.rejects(
		rebindPublicPack({
			repository: value.repository,
			publicPackPath: value.source,
			expectedSha256: value.expectedSha256,
			runId: "retry",
			finalize: async () => {
				throw new Error("forced manifest failure");
			},
		}),
		/forced manifest failure/,
	);
	await doesNotExist(join(value.packs, "public-pack-retry"));
	await rebindPublicPack({
		repository: value.repository,
		publicPackPath: value.source,
		expectedSha256: value.expectedSha256,
		runId: "retry",
	});
	assert.deepEqual(
		await readFile(join(value.packs, "public-pack-retry", "public-pack.json")),
		value.bytes,
	);
});

test("a fault after the first destination link cleans only the owned partial output", async () => {
	const value = await fixture();
	const output = join(value.packs, "public-pack-destination-retry");
	await assert.rejects(
		rebindPublicPack({
			repository: value.repository,
			publicPackPath: value.source,
			expectedSha256: value.expectedSha256,
			runId: "destination-retry",
			afterPublicPackLinked: async () => {
				throw new Error("forced destination link failure");
			},
		}),
		/forced destination link failure/,
	);
	await doesNotExist(output);
	await rebindPublicPack({
		repository: value.repository,
		publicPackPath: value.source,
		expectedSha256: value.expectedSha256,
		runId: "destination-retry",
	});
	assert.deepEqual(
		await readFile(join(output, "public-pack.json")),
		value.bytes,
	);
});

test("a replacement after the first destination link remains untouched", async () => {
	const value = await fixture();
	let replacement;
	await assert.rejects(
		rebindPublicPack({
			repository: value.repository,
			publicPackPath: value.source,
			expectedSha256: value.expectedSha256,
			runId: "destination-replacement",
			afterPublicPackLinked: async ({ outputDirectory }) => {
				replacement = outputDirectory;
				await rm(outputDirectory, { recursive: true });
				await mkdir(outputDirectory);
				await writeFile(join(outputDirectory, "foreign"), "keep");
				throw new Error("forced replacement failure");
			},
		}),
		/forced replacement failure/,
	);
	assert.equal(await readFile(join(replacement, "foreign"), "utf8"), "keep");
});

test("foreign directory and symlink replacements cannot publish or be cleaned", async () => {
	const directoryCase = await fixture();
	let directoryOutput;
	await assert.rejects(
		rebindPublicPack({
			repository: directoryCase.repository,
			publicPackPath: directoryCase.source,
			expectedSha256: directoryCase.expectedSha256,
			runId: "foreign-directory",
			beforePublish: async ({ outputDirectory }) => {
				directoryOutput = outputDirectory;
				await mkdir(outputDirectory);
				await writeFile(join(outputDirectory, "foreign"), "keep");
			},
		}),
		/EEXIST/,
	);
	assert.equal(
		await readFile(join(directoryOutput, "foreign"), "utf8"),
		"keep",
	);
	assert.deepEqual(
		(await readdir(directoryCase.packs)).filter((name) =>
			name.startsWith(".public-pack-rebind-"),
		),
		[],
	);

	const symlinkCase = await fixture();
	let symlinkOutput;
	const foreignDirectory = join(symlinkCase.repository, "foreign-directory");
	await mkdir(foreignDirectory);
	await writeFile(join(foreignDirectory, "foreign"), "keep");
	await assert.rejects(
		rebindPublicPack({
			repository: symlinkCase.repository,
			publicPackPath: symlinkCase.source,
			expectedSha256: symlinkCase.expectedSha256,
			runId: "foreign-symlink",
			beforePublish: async ({ outputDirectory }) => {
				symlinkOutput = outputDirectory;
				await symlink(foreignDirectory, outputDirectory);
			},
		}),
		/EEXIST/,
	);
	assert.equal(
		await readFile(join(foreignDirectory, "foreign"), "utf8"),
		"keep",
	);
	assert.equal((await lstat(symlinkOutput)).isSymbolicLink(), true);
	assert.deepEqual(
		(await readdir(symlinkCase.packs)).filter((name) =>
			name.startsWith(".public-pack-rebind-"),
		),
		[],
	);
});

test("a displaced staging path remains untouched and cannot report success", async () => {
	const directoryCase = await fixture();
	let displacedDirectory;
	await assert.rejects(
		rebindPublicPack({
			repository: directoryCase.repository,
			publicPackPath: directoryCase.source,
			expectedSha256: directoryCase.expectedSha256,
			runId: "displaced-directory",
			beforePublish: async ({ stagingDirectory }) => {
				displacedDirectory = stagingDirectory;
				await rm(stagingDirectory, { recursive: true });
				await mkdir(stagingDirectory);
				await writeFile(join(stagingDirectory, "foreign"), "keep");
			},
		}),
		/ownership changed/,
	);
	assert.equal(
		await readFile(join(displacedDirectory, "foreign"), "utf8"),
		"keep",
	);
	await doesNotExist(
		join(directoryCase.packs, "public-pack-displaced-directory"),
	);

	const symlinkCase = await fixture();
	const foreignDirectory = join(symlinkCase.repository, "foreign-stage");
	await mkdir(foreignDirectory);
	await writeFile(join(foreignDirectory, "foreign"), "keep");
	let displacedSymlink;
	await assert.rejects(
		rebindPublicPack({
			repository: symlinkCase.repository,
			publicPackPath: symlinkCase.source,
			expectedSha256: symlinkCase.expectedSha256,
			runId: "displaced-symlink",
			beforePublish: async ({ stagingDirectory }) => {
				displacedSymlink = stagingDirectory;
				await rm(stagingDirectory, { recursive: true });
				await symlink(foreignDirectory, stagingDirectory);
			},
		}),
		/ownership changed/,
	);
	assert.equal(
		await readFile(join(foreignDirectory, "foreign"), "utf8"),
		"keep",
	);
	assert.equal((await lstat(displacedSymlink)).isSymbolicLink(), true);
	await doesNotExist(join(symlinkCase.packs, "public-pack-displaced-symlink"));
});
