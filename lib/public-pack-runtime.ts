import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { sha256File, sha256Text } from "./scaffold.ts";
import { validateFrozenPublicFetchPolicy } from "./public-pack-fetch.ts";
import type { FrozenPublicFetchPolicy } from "./public-pack-fetch.ts";
import { validatePublicPack } from "./public-pack-schema.ts";

const RUNTIME_SCHEMA = "spike-a-public-pack-author-runtime-v2";
const FROZEN_AUTHOR_RPC_ID = "public-pack-author-1";
const CLEAN_ENVIRONMENT_KEYS = ["LANG", "SPIKE_A_AUTHOR_CONFIG", "SPIKE_A_AUTHOR_INPUT", "SPIKE_A_AUTHOR_OUTPUT", "SPIKE_A_AUTHOR_VERIFY_ONLY"];

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !path.includes("/../");
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return !!value && typeof value === "object" && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

export type PublicPackAuthorAllocation = {
  content_classification: string;
  broker: string;
  provider: string;
  api: string;
  model: string;
  maximum_calls: number;
  maximum_input_tokens: number;
  maximum_output_tokens: number;
  worst_case_reserved_eur: number;
  reservation_breakdown_eur: { input: number; output: number };
  status: string;
};

export type OwnerPublicPackPolicy = {
  allocation: PublicPackAuthorAllocation;
  fetch_policy: FrozenPublicFetchPolicy;
  fetch_policy_raw: unknown;
  authority_sha256: string;
  origin_policy_sha256: string;
};

export function authorSandboxEnvironment({ configPath, inputPath, outputDirectory, verifyOnly = false }: {
  configPath: string;
  inputPath: string;
  outputDirectory: string;
  verifyOnly?: boolean;
}): Record<string, string> {
  return { LANG: "C.UTF-8", SPIKE_A_AUTHOR_CONFIG: configPath, SPIKE_A_AUTHOR_INPUT: inputPath, SPIKE_A_AUTHOR_OUTPUT: outputDirectory, ...(verifyOnly ? { SPIKE_A_AUTHOR_VERIFY_ONLY: "1" } : {}) };
}

export function authorSandboxProfile({ nodePath, scriptPath, configPath, inputPath, outputDirectory }: {
  nodePath: string;
  scriptPath: string;
  configPath: string;
  inputPath: string;
  outputDirectory: string;
}): string {
  const literal = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const inputIntegrityPath = resolve(dirname(scriptPath), "public-input-integrity.mjs");
  return `(version 1)
(deny default)
(import "system.sb")
(allow process-exec (literal "${literal(nodePath)}"))
(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/private/var/db/timezone") (literal "/dev/null") (literal "/dev/urandom") (literal "${literal(nodePath)}") (literal "${literal(scriptPath)}") (literal "${literal(inputIntegrityPath)}") (literal "${literal(configPath)}") (subpath "${literal(inputPath)}"))
(allow file-read-metadata file-test-existence (path-ancestors "${literal(nodePath)}") (path-ancestors "${literal(scriptPath)}") (path-ancestors "${literal(inputIntegrityPath)}") (path-ancestors "${literal(configPath)}") (path-ancestors "${literal(inputPath)}"))
(allow file-write* (subpath "${literal(outputDirectory)}"))
(allow sysctl-read) (allow mach-lookup) (allow signal (target self))
`;
}

export function validatePublicPackAuthorAllocation(authority: unknown): PublicPackAuthorAllocation {
  const root = authority as { model_broker_approval?: { public_pack_author?: unknown }; limits?: { model_cost_cap_eur?: unknown; combined_actual_plus_reserved_cap_eur?: unknown } } | null | undefined;
  const allocation = root?.model_broker_approval?.public_pack_author as Record<string, unknown>;
  const expected = ["content_classification", "broker", "provider", "api", "model", "maximum_calls", "maximum_input_tokens", "maximum_output_tokens", "worst_case_reserved_eur", "reservation_breakdown_eur", "status"];
  const breakdown = allocation.reservation_breakdown_eur as Record<string, unknown>;
  if (!exactKeys(allocation, expected) || allocation.content_classification !== "public-only" || allocation.broker !== "spike-a-openai-model-broker-v1" || allocation.provider !== "OpenAI" || allocation.api !== "Responses API" || allocation.model !== "gpt-5.6-terra" || allocation.maximum_calls !== 1 || allocation.maximum_input_tokens !== 32_000 || allocation.maximum_output_tokens !== 2_000 || allocation.worst_case_reserved_eur !== 0.104 || allocation.status !== "approved-not-called" || !exactKeys(allocation.reservation_breakdown_eur, ["input", "output"]) || breakdown.input !== 0.08 || breakdown.output !== 0.024) throw new Error("Frozen public-author allocation is invalid");
  if (root?.limits?.model_cost_cap_eur !== 18 || root?.limits?.combined_actual_plus_reserved_cap_eur !== 20 || (allocation.worst_case_reserved_eur as number) > (root?.limits?.model_cost_cap_eur as number) || (allocation.worst_case_reserved_eur as number) > (root?.limits?.combined_actual_plus_reserved_cap_eur as number)) throw new Error("Public-author allocation does not fit the frozen caps");
  return allocation as unknown as PublicPackAuthorAllocation;
}

export function validateOwnerPublicPackPolicies({ authority, originAllowlist, allowInsecureFixture = false }: {
  authority: unknown;
  originAllowlist: unknown;
  allowInsecureFixture?: boolean;
}): OwnerPublicPackPolicy {
  const auth = authority as { status?: unknown } | null | undefined;
  const allow = originAllowlist as { status?: unknown; public_pack_fetch_policy?: unknown } | null | undefined;
  if (auth?.status !== "pass" || allow?.status !== "pass") throw new Error("Owner policy status is not pass");
  const allocation = validatePublicPackAuthorAllocation(authority);
  const fetchPolicy = validateFrozenPublicFetchPolicy(allow?.public_pack_fetch_policy, { allowInsecureFixture });
  return { allocation, fetch_policy: fetchPolicy, fetch_policy_raw: allow?.public_pack_fetch_policy, authority_sha256: sha256Text(JSON.stringify(authority)), origin_policy_sha256: sha256Text(JSON.stringify(allow?.public_pack_fetch_policy)) };
}

export async function validatePublicInputMount({ inputDirectory, ownerPolicy }: {
  inputDirectory: string;
  ownerPolicy: OwnerPublicPackPolicy;
}): Promise<{ manifest: Record<string, unknown>; manifestHash: string }> {
  const manifestPath = resolve(inputDirectory, "public-input-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schema_version !== 1 || manifest.content_classification !== "public-only" || manifest.policy_id !== ownerPolicy.fetch_policy.policy_id || manifest.policy_sha256 !== ownerPolicy.fetch_policy.policy_sha256 || !Array.isArray(manifest.sources) || manifest.sources.length !== 1) throw new Error("Public input mount manifest is not bound to the frozen policy");
  const expectedPaths = new Set(["public-input-manifest.json", ...manifest.sources.map((source: { derived_path: string }) => source.derived_path)]);
  const actualPaths = await packFiles(inputDirectory);
  if (actualPaths.length !== expectedPaths.size || actualPaths.some((file) => !expectedPaths.has(file.path))) throw new Error("Public input mount contains an unmanifested file");
  const source = manifest.sources[0];
  const sourceKeys = ["source_id", "initial_url", "final_url", "retrieved_at", "status", "content_type", "redirect_chain", "raw_sha256", "raw_bytes", "derived_text_sha256", "derived_text_bytes", "derived_path"];
  if (!exactKeys(source, sourceKeys) || source.source_id !== "source-001" || source.initial_url !== ownerPolicy.fetch_policy.initial_urls[0] || !ownerPolicy.fetch_policy.permitted_final_urls.includes(source.final_url) || !Array.isArray(source.redirect_chain) || source.redirect_chain[0] !== source.initial_url || source.redirect_chain.at(-1) !== source.final_url || source.redirect_chain.length - 1 > ownerPolicy.fetch_policy.maximum_redirects || source.status < 200 || source.status > 299 || !ownerPolicy.fetch_policy.allowed_content_types.includes(source.content_type) || !/^[0-9a-f]{64}$/.test(source.raw_sha256) || !/^[0-9a-f]{64}$/.test(source.derived_text_sha256) || !Number.isSafeInteger(source.raw_bytes) || source.raw_bytes < 0 || source.raw_bytes > ownerPolicy.fetch_policy.maximum_raw_bytes_per_source || !Number.isSafeInteger(source.derived_text_bytes) || source.derived_text_bytes < 0 || source.derived_text_bytes > ownerPolicy.fetch_policy.maximum_derived_text_bytes_total || source.derived_path !== "source-001.txt" || Number.isNaN(Date.parse(source.retrieved_at))) throw new Error("Public input mount source provenance is invalid");
  if (await sha256File(resolve(inputDirectory, source.derived_path)) !== source.derived_text_sha256) throw new Error("Public input mount derived-text hash does not match");
  return { manifest, manifestHash: await sha256File(manifestPath) };
}

export async function preflightPublicPackAuthorRuntime({ repository, configPath }: {
  repository: string;
  configPath: string;
}): Promise<{
  runtime_identity: string;
  run_id: string;
  public_input_mount: string;
  public_input_manifest_sha256: string;
  public_source_policy: { policy_id: string; policy_sha256: string; initial_urls: string[]; permitted_final_urls: string[]; permitted_origins: string[] };
  public_author_allocation: PublicPackAuthorAllocation;
  owner_authority_sha256: string;
  output_directory: string;
  output_exclusive_create_required: boolean;
  output_hash_algorithm: string;
  clean_environment_keys: string[];
  direct_network: string;
  model_broker_identity: string;
}> {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.schema_version !== 1 || config.runtime_identity !== RUNTIME_SCHEMA || config.mode !== "one-shot-public-pack-author" || typeof config.run_id !== "string" || !config.run_id || typeof config.owner_authority_path !== "string" || typeof config.owner_origin_allowlist_path !== "string") throw new Error("Public-pack author runtime configuration is not recognized");
  const [authority, originAllowlist] = await Promise.all([readFile(config.owner_authority_path, "utf8").then(JSON.parse), readFile(config.owner_origin_allowlist_path, "utf8").then(JSON.parse)]);
  const allowInsecureFixture = config.test_only_local_fixture === true && process.env.SPIKE_A_TEST_ONLY_LOCAL_FIXTURE === "1";
  if (config.test_only_local_fixture === true && !allowInsecureFixture) throw new Error("Local public-pack fixture mode is test-only");
  const ownerPolicy = validateOwnerPublicPackPolicies({ authority, originAllowlist, allowInsecureFixture });
  const resolvedRepository = await realpath(repository);
  const inputDirectory = await realpath(config.public_input_mount);
  const outputDirectory = resolve(await realpath(dirname(config.output_directory)), basename(config.output_directory));
  if (!isInside(resolvedRepository, inputDirectory) || !isInside(resolve(resolvedRepository, "packs"), outputDirectory) || basename(outputDirectory) !== config.pack_id) throw new Error("Public-pack input or output is outside its dedicated public boundary");
  const capState = JSON.parse(await readFile(config.cap_state_path, "utf8"));
  if (capState.run_id !== config.run_id || capState.abort || capState.caps?.model_cost_cap_eur !== 18 || capState.caps?.combined_actual_plus_reserved_cap_eur !== 20 || capState.model?.actual_eur + capState.model?.outstanding_reservations_eur + ownerPolicy.allocation.worst_case_reserved_eur > 18 || (capState.app?.actual_eur ?? 0) + (capState.app?.outstanding_reservations_eur ?? 0) + capState.model.actual_eur + capState.model.outstanding_reservations_eur + ownerPolicy.allocation.worst_case_reserved_eur > 20) throw new Error("Public-pack author cap ledger is not safe for the frozen reservation");
  const input = await validatePublicInputMount({ inputDirectory, ownerPolicy });
  return { runtime_identity: RUNTIME_SCHEMA, run_id: config.run_id, public_input_mount: inputDirectory, public_input_manifest_sha256: input.manifestHash, public_source_policy: { policy_id: ownerPolicy.fetch_policy.policy_id, policy_sha256: ownerPolicy.fetch_policy.policy_sha256, initial_urls: ownerPolicy.fetch_policy.initial_urls, permitted_final_urls: ownerPolicy.fetch_policy.permitted_final_urls, permitted_origins: ownerPolicy.fetch_policy.permitted_origins }, public_author_allocation: ownerPolicy.allocation, owner_authority_sha256: ownerPolicy.authority_sha256, output_directory: outputDirectory, output_exclusive_create_required: true, output_hash_algorithm: "sha256", clean_environment_keys: CLEAN_ENVIRONMENT_KEYS, direct_network: "denied", model_broker_identity: ownerPolicy.allocation.broker };
}

export async function createExclusivePackOutput({ outputDirectory, runtimeManifest }: {
  outputDirectory: string;
  runtimeManifest: Record<string, unknown>;
}): Promise<{ manifest_path: string; manifest_sha256: string }> {
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  await mkdir(outputDirectory, { mode: 0o700 });
  const manifestPath = resolve(outputDirectory, "author-runtime-manifest.json");
  const { output_directory, public_input_mount, ...sanitizedRuntimeManifest } = runtimeManifest;
  const body = `${JSON.stringify(sanitizedRuntimeManifest, null, 2)}\n`;
  await writeFile(manifestPath, body, { flag: "wx", mode: 0o600 });
  return { manifest_path: manifestPath, manifest_sha256: sha256Text(body) };
}

async function packFiles(directory: string, root: string = directory): Promise<Array<{ path: string; sha256: string }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ path: string; sha256: string }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await packFiles(path, root)));
    else if (entry.isFile() && entry.name !== "public-pack-content-manifest.json") files.push({ path: relative(root, path), sha256: await sha256File(path) });
    else if (!entry.isFile()) throw new Error("Public-pack output may contain only ordinary files and directories");
  }
  return files;
}

export async function finalizeExclusivePackOutput({ outputDirectory }: {
  outputDirectory: string;
}): Promise<{ manifest_path: string; manifest_sha256: string; files: Array<{ path: string; sha256: string }> }> {
  const output = await stat(outputDirectory);
  if (!output.isDirectory()) throw new Error("Public-pack output directory is missing");
  const pack = validatePublicPack(JSON.parse(await readFile(resolve(outputDirectory, "public-pack.json"), "utf8")));
  void pack;
  const files = await packFiles(outputDirectory);
  const body = `${JSON.stringify({ schema_version: 1, files }, null, 2)}\n`;
  const manifestPath = resolve(outputDirectory, "public-pack-content-manifest.json");
  await writeFile(manifestPath, body, { flag: "wx", mode: 0o600 });
  return { manifest_path: manifestPath, manifest_sha256: sha256Text(body), files };
}

export function validateForwardedAuthorRpc({ message, allocation, alreadyForwarded, expectedPublicInputManifestSha256 }: {
  message: unknown;
  allocation: { maximum_input_tokens: number; maximum_output_tokens: number };
  alreadyForwarded: boolean;
  expectedPublicInputManifestSha256: string;
}): { ok: boolean; reason?: string } {
  const m = message as Record<string, unknown> | null | undefined;
  if (alreadyForwarded) return { ok: false, reason: "Author sandbox attempted a repeated RPC forward" };
  if (m?.kind !== "rpc" || m?.broker !== "model" || m?.rpc_id !== FROZEN_AUTHOR_RPC_ID) return { ok: false, reason: "Author sandbox RPC is malformed" };
  if (m.public_input_manifest_sha256 !== expectedPublicInputManifestSha256) return { ok: false, reason: "Author sandbox RPC is not bound to the frozen public input" };
  const payload = m.payload as Record<string, unknown> | null | undefined;
  if (payload?.method !== "request" || payload?.content_classification !== "public-pack-text" || payload?.maximum_input_tokens !== allocation.maximum_input_tokens || payload?.maximum_output_tokens !== allocation.maximum_output_tokens) {
    return { ok: false, reason: "Author sandbox RPC does not match the frozen allocation" };
  }
  return { ok: true };
}

export function validatePublicPackAuthorCompletion({ message, expectedPublicInputManifestSha256 }: {
  message: unknown;
  expectedPublicInputManifestSha256: string;
}): { ok: boolean; reason?: string } {
  const m = message as Record<string, unknown> | null | undefined;
  if (m?.kind !== "public_pack_author_complete" || m.clean_environment !== true || m.canary_blocked !== true || m.public_input_manifest_sha256 !== expectedPublicInputManifestSha256) return { ok: false, reason: "Public-pack author completion is not bound to the frozen public input" };
  return { ok: true };
}

export { CLEAN_ENVIRONMENT_KEYS, RUNTIME_SCHEMA, validatePublicPack };
