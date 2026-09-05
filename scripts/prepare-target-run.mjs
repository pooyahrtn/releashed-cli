import { chmod, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTargetRuntimeConfig } from "../lib/target-runtime.mjs";

export async function prepareTargetRun({ repository, ownerDirectory, runId, registryPath = null, mode = "source-blind-target-isolation", targetOriginOverride = null, testOnlyLocalFixture = false, anonymous = false, savedSessionPath = null }) {
  const repo = resolve(repository);
  const config = await buildTargetRuntimeConfig({ repository: repo, ownerDirectory, runId, registryPath, mode, targetOriginOverride, testOnlyLocalFixture, anonymous, savedSessionPath });
  const configPath = join(repo, ".runtime", runId, "target-session-config.json");
  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(configPath, 0o600);
  } catch {
    throw new Error("Target-session configuration could not be created exclusively");
  }
  return { run_id: runId, config_path: relative(repo, configPath) };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const anonymous = rawArgs.includes("--anonymous");
  const savedSessionIndex = rawArgs.indexOf("--saved-session");
  const savedSessionPath = savedSessionIndex === -1 ? null : rawArgs[savedSessionIndex + 1];
  const positional = rawArgs.filter((arg, index) => arg !== "--anonymous" && index !== savedSessionIndex && index !== savedSessionIndex + 1);
  const args = Object.fromEntries(Array.from({ length: positional.length / 2 }, (_, index) => positional.slice(index * 2, index * 2 + 2)));
  if (!args["--run-id"] || (!args["--registry"] && args["--mode"] !== "source-blind-bounded-onboarding-v1") || (anonymous && savedSessionPath)) throw new Error("Usage: node scripts/prepare-target-run.mjs --run-id <run-id> [--mode source-blind-bounded-onboarding-v1 | --registry <private-registry-path>] [--target-origin <origin>] [--owner-directory <path>] [--anonymous | --saved-session <captured-session.json>]");
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await prepareTargetRun({ repository, ownerDirectory: resolve(repository, args["--owner-directory"] ?? "../flow-map-lab-private/spike-a"), runId: args["--run-id"], registryPath: args["--registry"] ? resolve(args["--registry"]) : null, mode: args["--mode"] ?? "source-blind-target-isolation", targetOriginOverride: args["--target-origin"] ?? null, anonymous, savedSessionPath: savedSessionPath ? resolve(savedSessionPath) : null });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Target preparation failed"}\n`);
    process.exitCode = 1;
  });
}
