#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { retireCompletedOwnerBundle } from "../lib/completed-owner-bundle-retirement.mjs";

const USAGE =
	"Usage: node scripts/retire-completed-owner-bundle.mjs --owner-bundle-directory <absolute-path> --run-id <run-id>";

export function parseArgs(argv) {
	if (
		argv.length !== 4 ||
		argv[0] !== "--owner-bundle-directory" ||
		argv[2] !== "--run-id"
	)
		throw new Error(USAGE);
	if (!isAbsolute(argv[1]) || resolve(argv[1]) !== argv[1])
		throw new Error(USAGE);
	return { bundleDirectory: argv[1], runId: argv[3] };
}

export async function main({
	argv = process.argv.slice(2),
	environment = process.env,
	output = process.stdout,
	errorOutput = process.stderr,
	retire = retireCompletedOwnerBundle,
} = {}) {
	try {
		const result = await retire({ ...parseArgs(argv), environment });
		output.write(`${JSON.stringify(result)}\n`);
		return 0;
	} catch {
		delete environment.CLERK_SECRET_KEY;
		errorOutput.write("Completed owner bundle retirement did not complete.\n");
		return 1;
	}
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
	process.exitCode = await main();
