#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createImmutableOwnerBundle } from "../lib/owner-bundle.mjs";

export function parseArgs(argv) {
	if (argv.length !== 6 || argv[0] !== "--run-id" || argv[2] !== "--base-owner-directory" || argv[4] !== "--bundle-parent") throw new Error("usage");
	return { runId: argv[1], baseOwnerDirectory: resolve(argv[3]), bundleParent: resolve(argv[5]) };
}
export async function main({ argv = process.argv.slice(2), environment = process.env, output = process.stdout, errorOutput = process.stderr, create = createImmutableOwnerBundle } = {}) {
	try {
		const secretKey = environment.CLERK_SECRET_KEY; delete environment.CLERK_SECRET_KEY;
		const result = await create({ ...parseArgs(argv), secretKey });
		output.write(`${JSON.stringify({ schema_version: 1, status: result.status, run_id: result.run_id })}\n`);
		return 0;
	} catch { errorOutput.write("Owner bundle creation did not complete.\n"); return 1; }
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) process.exitCode = await main();
