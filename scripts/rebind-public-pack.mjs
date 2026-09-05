import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rebindPublicPack } from "../lib/public-pack-rebind.mjs";

export function parseArgs(argv) {
	if (
		argv.length !== 8 ||
		argv[0] !== "--repository" ||
		argv[2] !== "--run-id" ||
		argv[4] !== "--public-pack" ||
		argv[6] !== "--public-pack-sha256" ||
		!argv[1] ||
		!argv[3] ||
		!argv[5] ||
		!argv[7]
	) {
		throw new Error(
			"Usage: node scripts/rebind-public-pack.mjs --repository <repo-root> --run-id <new-run-id> --public-pack <exact-public-pack.json> --public-pack-sha256 <sha256>",
		);
	}
	return {
		repository: resolve(argv[1]),
		runId: argv[3],
		publicPackPath: resolve(argv[5]),
		expectedSha256: argv[7],
	};
}

export async function main(argv = process.argv.slice(2)) {
	const result = await rebindPublicPack(parseArgs(argv));
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return result;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Public-pack rebinding failed"}\n`,
		);
		process.exitCode = 1;
	});
}
