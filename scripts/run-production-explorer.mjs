import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProductionExplorerSession } from "../supervisor/explorer-session.mjs";

export async function runProductionExplorerCli(args, repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  if (args.length !== 2 || args[0] !== "--run-id" || !args[1]) throw new Error("Usage: node scripts/run-production-explorer.mjs --run-id <run-id>");
  const report = await runProductionExplorerSession({ runId: args[1], repositoryRoot: repository });
  process.stdout.write(`${JSON.stringify({ run_id: report.run_id, status: report.status, candidate_eligible: report.candidate_eligible })}\n`);
  if (!report.candidate_eligible) process.exitCode = 1;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProductionExplorerCli(process.argv.slice(2)).catch(() => {
    process.stderr.write("Production explorer failed before a safe report\n");
    process.exitCode = 1;
  });
}
