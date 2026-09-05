import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { packageCandidate } from "../lib/candidate-packager.mjs";

const USAGE =
  "Usage: node scripts/package-candidate.mjs --run-id <run-id> --run-path <exact-run-directory> --output <new-artifact-directory> --public-pack <path> --public-pack-sha256 <sha256> [--title-overrides <path-to-json>] [--captions <path-to-json>] [--allow-strings <path-to-json>]";

const REQUIRED = ["--run-id", "--run-path", "--output", "--public-pack", "--public-pack-sha256"];
const OPTIONAL = ["--title-overrides", "--captions", "--allow-strings"];

function parseArgs(argv) {
  const values = {};
  if (argv.length % 2 !== 0) throw new Error(USAGE);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (![...REQUIRED, ...OPTIONAL].includes(flag) || values[flag] || !argv[index + 1])
      throw new Error(USAGE);
    values[flag] = argv[index + 1];
  }
  if (REQUIRED.some((flag) => !values[flag])) throw new Error(USAGE);
  const result = {
    runId: values["--run-id"],
    runPath: resolve(values["--run-path"]),
    outputPath: resolve(values["--output"]),
    publicPackPath: resolve(values["--public-pack"]),
    publicPackSha256: values["--public-pack-sha256"],
  };
  // Verified-on-screen title fixes for a specific run (see renderer/render-map.mjs
  // deriveNodeTitle) -- a JSON object of { [observation_hash]: string[] }.
  if (values["--title-overrides"])
    result.titleOverrides = JSON.parse(readFileSync(resolve(values["--title-overrides"]), "utf8"));
  // Screen descriptions written from the screenshots (see scripts/caption-screens.mjs). Optional:
  // without it every card keeps the title read off its own screen, exactly as before.
  if (values["--captions"])
    result.captions = JSON.parse(readFileSync(resolve(values["--captions"]), "utf8")).captions ?? {};
  // Exact benign strings to exempt from the PII/secret scan for THIS run only (see
  // lib/candidate-packager.mjs scanText) -- a flat JSON array of strings, e.g. a target's own
  // public support address or a literal docs placeholder. Optional: without it, behavior is
  // unchanged from before this flag existed.
  if (values["--allow-strings"])
    result.allowExactStrings = JSON.parse(readFileSync(resolve(values["--allow-strings"]), "utf8"));
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const result = await packageCandidate(parseArgs(argv));
  process.stdout.write(
    `${JSON.stringify({ run_id: result.run_id, output_path: result.output_path, candidate_sha256: result.candidate_sha256 })}\n`,
  );
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Candidate packaging failed"}\n`,
    );
    process.exitCode = 1;
  });
}
