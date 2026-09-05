import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBoundedOnboardingRun } from "../lib/bounded-run-prep.mjs";

const USAGE =
	"Usage: node scripts/prepare-bounded-onboarding-run.mjs --run-id <run-id> --public-pack <exact-public-pack.json> --public-pack-sha256 <sha256> [--owner-directory <private-owner-bundle>]";

export function parseArgs(argv) {
	if (
		![6, 8].includes(argv.length) ||
		argv[0] !== "--run-id" ||
		argv[2] !== "--public-pack" ||
		argv[4] !== "--public-pack-sha256" ||
		!argv[1] ||
		!argv[3] ||
		!argv[5] ||
		(argv.length === 8 && (argv[6] !== "--owner-directory" || !argv[7]))
	) {
		throw new Error(USAGE);
	}
	return {
		runId: argv[1],
		publicPackPath: resolve(argv[3]),
		publicPackSha256: argv[5],
		...(argv.length === 8 ? { ownerDirectory: resolve(argv[7]) } : {}),
	};
}

export async function main(argv = process.argv.slice(2)) {
	const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const parsed = parseArgs(argv);
	const result = await prepareBoundedOnboardingRun({
		repository,
		ownerDirectory: parsed.ownerDirectory ?? resolve(repository, "../flow-map-lab-private/spike-a"),
		...parsed,
	});
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return result;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Bounded run preparation failed"}\n`,
		);
		process.exitCode = 1;
	});
}
