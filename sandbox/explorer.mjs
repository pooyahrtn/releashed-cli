import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { runExplorerLoop, SequentialRpcTransport, validateBoundPublicPack } from "../lib/explorer-protocol.mjs";

const ALLOWED_ENVIRONMENT_KEYS = new Set(["FLOW_MAP_EXPLORER_PUBLIC_PACK", "FLOW_MAP_EXPLORER_PUBLIC_PACK_SHA256", "FLOW_MAP_EXPLORER_ALLOWED_HTTP_ORIGIN", "LANG", "SPIKE_A_TEST_ONLY_TARGET_FIXTURE", "__CF_USER_TEXT_ENCODING"]);

async function proveTestIsolation() {
  const raw = process.env.FLOW_MAP_EXPLORER_TEST_ISOLATION;
  delete process.env.FLOW_MAP_EXPLORER_TEST_ISOLATION;
  if (!raw) return;
  if (process.env.SPIKE_A_TEST_ONLY_TARGET_FIXTURE !== "1") throw new Error("explorer_test_isolation_forbidden");
  const probe = JSON.parse(raw);
  if (!Array.isArray(probe.forbidden_paths) || probe.forbidden_paths.length !== 2 || typeof probe.network_url !== "string") {
    throw new Error("explorer_test_isolation_invalid");
  }
  const deniedRead = async (path) => {
    try {
      await readFile(path);
      return false;
    } catch {
      return true;
    }
  };
  const fileReadDenied = (await Promise.all(probe.forbidden_paths.map(deniedRead))).every(Boolean);
  let directNetworkDenied = false;
  try {
    await fetch(probe.network_url, { signal: AbortSignal.timeout(500) });
  } catch {
    directNetworkDenied = true;
  }
  process.stdout.write(`${JSON.stringify({ kind: "explorer_isolation_check", source_and_private_file_read_denied: fileReadDenied, direct_network_denied: directNetworkDenied })}\n`);
}

async function main() {
  await proveTestIsolation();
  if (!Object.keys(process.env).every((key) => ALLOWED_ENVIRONMENT_KEYS.has(key))) throw new Error("explorer_environment_not_clean");
  const publicPackPath = process.env.FLOW_MAP_EXPLORER_PUBLIC_PACK;
  const expectedPublicPackSha256 = process.env.FLOW_MAP_EXPLORER_PUBLIC_PACK_SHA256;
  if (!publicPackPath || !expectedPublicPackSha256) throw new Error("explorer_public_pack_missing");
  const publicPackBytes = await readFile(publicPackPath);
  const binding = validateBoundPublicPack(publicPackBytes, expectedPublicPackSha256);
  let terminal = false;
  const transport = new SequentialRpcTransport({ write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`) });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (terminal) return;
    transport.receiveLine(line);
  });
  lines.on("close", () => transport.close());

  try {
    const result = await runExplorerLoop({ publicPack: binding.pack, rpc: (broker, payload) => transport.request(broker, payload) });
    terminal = true;
    process.stdout.write(`${JSON.stringify({ kind: "explorer_complete", public_pack_sha256: binding.sha256, result })}\n`);
  } finally {
    transport.close("explorer_complete");
    lines.close();
  }
}

try {
  await main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ kind: "explorer_failed_closed", reason: error?.code ?? error?.message ?? "explorer_failure" })}\n`);
  process.exitCode = 1;
}
