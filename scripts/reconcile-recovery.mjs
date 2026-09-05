#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileDisposableClerkRecovery } from "../supervisor/clerk-bootstrap.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOwnerDirectory = resolve(repository, "../flow-map-lab-private/spike-a");
const allowedCustodyFiles = new Set([
  "browser-config.json",
  "browser-startup.jsonl",
  "cap-state.json",
  "reconciliation-anchor.json",
  "recovery-fallback.json",
  "recovery.json"
]);
const reconciliationAnchorName = "reconciliation-anchor.json";
const receiptName = "cleanup-reconciliation.json";
const receiptStagingName = `${receiptName}.pending`;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const exactKeys = (value, keys) =>
  value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

function exactHttpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function expectedFrontendOrigin(ownerDirectory = defaultOwnerDirectory) {
  const path = join(resolve(ownerDirectory), "origin-allowlist.json");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("policy unavailable");
  const policy = JSON.parse(await readFile(path, "utf8"));
  if (policy?.status !== "pass" || !Array.isArray(policy?.browser_request_dispatch?.allow)) throw new Error("policy invalid");
  const matches = policy.browser_request_dispatch.allow.filter((row) =>
    typeof row?.purpose === "string" && /Clerk frontend\/auth session transport only/i.test(row.purpose)
  );
  const origin = matches.length === 1 ? exactHttpsOrigin(matches[0].origin) : null;
  if (origin === null) throw new Error("policy invalid");
  return origin;
}

async function ordinaryPrivateFile(path) {
  const metadata = await lstat(path);
  return metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o600
    ? metadata
    : null;
}

async function ensureAbsent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function validateReceipt(path, recoverySha256) {
  try {
    const metadata = await ordinaryPrivateFile(path);
    if (!metadata) return false;
    const value = JSON.parse(await readFile(path, "utf8"));
    return exactKeys(value, ["schema_version", "kind", "status", "reason", "recovery_sha256", "reconciled_at"]) &&
      value.schema_version === 1 &&
      value.kind === "disposable-recovery-reconciliation" &&
      value.status === "cleanup-complete" &&
      value.reason === "synthetic-identity-confirmed-absent" &&
      value.recovery_sha256 === recoverySha256 &&
      typeof value.reconciled_at === "string" &&
      Number.isFinite(Date.parse(value.reconciled_at));
  } catch {
    return false;
  }
}

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function removeOrdinaryPrivateFile(path) {
  if (!await ordinaryPrivateFile(path)) throw new Error("private staging file is invalid");
  await unlink(path);
  await syncDirectory(dirname(path));
}

async function publishReceipt({ path, value, recoverySha256, dependencies }) {
  const directoryPath = dirname(path);
  const stagingPath = join(directoryPath, receiptStagingName);
  if (!await ensureAbsent(path)) {
    if (!await validateReceipt(path, recoverySha256) || !await ensureAbsent(stagingPath)) {
      throw new Error("existing receipt is invalid");
    }
    await syncDirectory(directoryPath);
    return;
  }

  if (!await ensureAbsent(stagingPath)) {
    if (!(await ordinaryPrivateFile(stagingPath) && await validateReceipt(stagingPath, recoverySha256))) {
      await removeOrdinaryPrivateFile(stagingPath);
    }
  }

  if (await ensureAbsent(stagingPath)) {
    let handle;
    try {
      handle = await open(stagingPath, "wx", 0o600);
      await dependencies.afterReceiptTempOpen?.();
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle?.close().catch(() => {});
    }
    await dependencies.afterReceiptTempSync?.();
  }

  if (!await validateReceipt(stagingPath, recoverySha256) || !await ensureAbsent(path)) {
    throw new Error("staged receipt is invalid");
  }
  await rename(stagingPath, path);
  await dependencies.afterReceiptRename?.();
  await syncDirectory(directoryPath);
}

async function validateCustodyDirectory(runtimeDirectory, recoveryPath) {
  const entries = await readdir(runtimeDirectory, { withFileTypes: true });
  const recoveryFiles = entries.filter((entry) =>
    /^recovery(?:-fallback)?\.json$/.test(entry.name) || entry.name === reconciliationAnchorName
  );
  if (
    recoveryFiles.length !== 1 ||
    ![basename(recoveryPath), reconciliationAnchorName].includes(recoveryFiles[0].name) ||
    entries.some((entry) => !allowedCustodyFiles.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())
  ) throw new Error("custody directory is not exact");
  return entries;
}

async function validateRecoveryFile({ recoveryPath, repositoryRoot }) {
  if (
    !isAbsolute(recoveryPath) ||
    resolve(recoveryPath) !== recoveryPath ||
    !["recovery.json", "recovery-fallback.json"].includes(basename(recoveryPath))
  ) throw new Error("recovery path must be exact");
  const root = await realpath(repositoryRoot);
  const runtimeRoot = await realpath(join(root, ".runtime"));
  const runsRoot = await realpath(join(root, "runs"));
  const runtimeDirectory = dirname(recoveryPath);
  const canonicalRuntime = await realpath(runtimeDirectory);
  if (
    canonicalRuntime !== runtimeDirectory ||
    dirname(runtimeDirectory) !== runtimeRoot ||
    !/^safe-control-probe-[A-Za-z0-9_-]+$/.test(basename(runtimeDirectory))
  ) throw new Error("runtime custody path is invalid");
  const runtimeMetadata = await lstat(runtimeDirectory);
  if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) throw new Error("runtime custody path is invalid");
  await validateCustodyDirectory(runtimeDirectory, recoveryPath);

  const anchorPath = join(runtimeDirectory, reconciliationAnchorName);
  const materialPath = await ensureAbsent(recoveryPath) ? anchorPath : recoveryPath;
  const materialMetadata = await ordinaryPrivateFile(materialPath);
  if (!materialMetadata || await realpath(materialPath) !== materialPath) throw new Error("recovery file is not private");
  const raw = await readFile(materialPath);
  const recovery = JSON.parse(raw.toString("utf8"));
  const baseKeys = ["schema_version", "state", "external_id", "user_id", "profile_directory", "browser_config_path", "run_directory"];
  const sourceName = Object.hasOwn(recovery ?? {}, "recovery_reason") ? "recovery-fallback.json" : "recovery.json";
  const keys = sourceName === "recovery-fallback.json" ? [...baseKeys, "recovery_reason"] : baseKeys;
  if (
    sourceName !== basename(recoveryPath) ||
    !exactKeys(recovery, keys) ||
    recovery.schema_version !== 1 ||
    !["creation-pending", "identity-bound"].includes(recovery.state) ||
    typeof recovery.external_id !== "string" ||
    !/^flowmap_cal_[0-9a-f]{32}$/.test(recovery.external_id) ||
    (recovery.state === "creation-pending" && recovery.user_id !== null) ||
    (recovery.state === "identity-bound" && (typeof recovery.user_id !== "string" || !/^[A-Za-z0-9_-]{4,256}$/.test(recovery.user_id))) ||
    (sourceName === "recovery-fallback.json" && recovery.recovery_reason !== "primary-recovery-write-failed") ||
    recovery.profile_directory !== join(runtimeDirectory, "profile") ||
    recovery.browser_config_path !== join(runtimeDirectory, "browser-config.json")
  ) throw new Error("recovery schema is invalid");

  const runDirectory = recovery.run_directory;
  if (
    !isAbsolute(runDirectory) ||
    resolve(runDirectory) !== runDirectory ||
    dirname(runDirectory) !== runsRoot ||
    !/^safe-control-probe-[0-9]{14}-[0-9a-f]{8}$/.test(basename(runDirectory)) ||
    await realpath(runDirectory) !== runDirectory
  ) throw new Error("public run path is invalid");
  const runMetadata = await lstat(runDirectory);
  if (!runMetadata.isDirectory() || runMetadata.isSymbolicLink()) throw new Error("public run path is invalid");
  if (!await ensureAbsent(recovery.profile_directory)) throw new Error("browser profile still exists");
  return {
    recovery,
    recoverySha256: sha256(raw),
    requestedRecoveryPath: recoveryPath,
    materialPath,
    materialMetadata,
    runtimeDirectory,
    runtimeMetadata,
    runDirectory
  };
}

async function removeCustodyDirectory({ validated, dependencies }) {
  const anchorPath = join(validated.runtimeDirectory, reconciliationAnchorName);
  const [currentRuntime, currentMaterial] = await Promise.all([
    lstat(validated.runtimeDirectory),
    lstat(validated.materialPath)
  ]);
  if (
    currentRuntime.dev !== validated.runtimeMetadata.dev ||
    currentRuntime.ino !== validated.runtimeMetadata.ino ||
    currentMaterial.dev !== validated.materialMetadata.dev ||
    currentMaterial.ino !== validated.materialMetadata.ino
  ) throw new Error("custody changed during reconciliation");
  await validateCustodyDirectory(validated.runtimeDirectory, validated.requestedRecoveryPath);

  let anchorMetadata;
  if (validated.materialPath !== anchorPath) {
    if (!await ensureAbsent(anchorPath)) throw new Error("custody anchor already exists");
    await rename(validated.materialPath, anchorPath);
    await syncDirectory(validated.runtimeDirectory);
    anchorMetadata = await ordinaryPrivateFile(anchorPath);
    if (!anchorMetadata) throw new Error("custody anchor is invalid");
    await dependencies.afterRecoveryAnchored?.();
  } else {
    anchorMetadata = validated.materialMetadata;
  }

  const entries = await validateCustodyDirectory(validated.runtimeDirectory, validated.requestedRecoveryPath);
  for (const entry of entries.map((entry) => entry.name).sort()) {
    if (entry === reconciliationAnchorName) continue;
    const path = join(validated.runtimeDirectory, entry);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !allowedCustodyFiles.has(entry)) {
      throw new Error("custody changed during reconciliation");
    }
    await unlink(path);
    await syncDirectory(validated.runtimeDirectory);
    await dependencies.afterCustodyFileRemoval?.(entry);
  }

  const remaining = await readdir(validated.runtimeDirectory);
  const currentAnchor = await ordinaryPrivateFile(anchorPath);
  if (
    remaining.length !== 1 ||
    remaining[0] !== reconciliationAnchorName ||
    !currentAnchor ||
    currentAnchor.dev !== anchorMetadata.dev ||
    currentAnchor.ino !== anchorMetadata.ino
  ) throw new Error("custody changed during reconciliation");
  await unlink(anchorPath);
  await syncDirectory(validated.runtimeDirectory);
  await rmdir(validated.runtimeDirectory);
  await syncDirectory(dirname(validated.runtimeDirectory));
}

export async function runRecoveryReconciliation({
  recoveryPath,
  repositoryRoot = repository,
  ownerDirectory = defaultOwnerDirectory,
  environment = process.env,
  output = process.stdout,
  now = () => Date.now(),
  dependencies = {}
}) {
  let secretKey = environment.CLERK_SECRET_KEY;
  delete environment.CLERK_SECRET_KEY;
  try {
    if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
      throw new Error("secret unavailable");
    }
    const validated = await validateRecoveryFile({ recoveryPath, repositoryRoot });
    const receiptPath = join(validated.runDirectory, receiptName);
    if (!await ensureAbsent(receiptPath) && !await validateReceipt(receiptPath, validated.recoverySha256)) {
      throw new Error("existing receipt is invalid");
    }
    const loadOrigin = dependencies.expectedFrontendOrigin ?? (() => expectedFrontendOrigin(ownerDirectory));
    const providerReconcile = dependencies.providerReconcile ?? reconcileDisposableClerkRecovery;
    const provider = await providerReconcile({
      recovery: validated.recovery,
      expectedFrontendOrigin: await loadOrigin(),
      workingDayDeadline: new Date(now() + 30_000).toISOString(),
      environment: { CLERK_SECRET_KEY: secretKey },
      fetchImpl: dependencies.fetchImpl
    });
    if (provider?.cleanup_complete !== true) throw new Error("provider cleanup incomplete");

    const receipt = {
      schema_version: 1,
      kind: "disposable-recovery-reconciliation",
      status: "cleanup-complete",
      reason: "synthetic-identity-confirmed-absent",
      recovery_sha256: validated.recoverySha256,
      reconciled_at: new Date(now()).toISOString()
    };
    await publishReceipt({
      path: receiptPath,
      value: receipt,
      recoverySha256: validated.recoverySha256,
      dependencies
    });

    await dependencies.afterReceipt?.();
    await removeCustodyDirectory({ validated, dependencies });
    output.write(`${JSON.stringify({ schema_version: 1, kind: "disposable-recovery-reconciled", status: "cleanup-complete" })}\n`);
    return { cleanup_complete: true };
  } catch {
    throw new Error("Disposable recovery reconciliation did not complete");
  } finally {
    secretKey = null;
  }
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--recovery" || !isAbsolute(argv[1])) throw new Error("usage");
  return { recoveryPath: resolve(argv[1]) };
}

async function main() {
  try {
    await runRecoveryReconciliation(parseArgs(process.argv.slice(2)));
  } catch {
    process.stderr.write("Disposable recovery reconciliation did not complete.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
