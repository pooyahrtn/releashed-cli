import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finalizeExclusivePackOutput, validatePublicPack } from "./public-pack-runtime.ts";
import type { PublicPack } from "./public-pack-schema.ts";

export type PublicAuthorLimits = {
  maximum_input_tokens: number;
  maximum_output_tokens: number;
};

export type PublicAuthorRequest = {
  method: string;
  content_classification: string;
  maximum_input_tokens: number;
  maximum_output_tokens: number;
  content: string;
  sourceIds: Set<string>;
  sources: Array<Record<string, unknown>>;
};

export type BrokeredAuthorResponse = {
  ok?: unknown;
  actual_eur?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown } | null;
  model_identity?: { approved?: unknown } | null;
  output?: unknown;
};

function sanitizeSources(sources: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return sources.map(({ derived_path, ...source }) => source);
}

export async function publicAuthorRequest(mountDirectory: string, limits: PublicAuthorLimits): Promise<PublicAuthorRequest> {
  const manifest = JSON.parse(await readFile(join(mountDirectory, "public-input-manifest.json"), "utf8"));
  const documents = await Promise.all(manifest.sources.map(async (source: { source_id: string; derived_path: string }) => ({ source_id: source.source_id, text: await readFile(join(mountDirectory, source.derived_path), "utf8") })));
  return {
    method: "request",
    content_classification: "public-pack-text",
    maximum_input_tokens: limits.maximum_input_tokens,
    maximum_output_tokens: limits.maximum_output_tokens,
    content: `Create one compact public evidence pack using only the supplied public documents. Return JSON with exactly product_summary (string) and claims (array). Each claim must have exactly id (stable lowercase slug), kind (audience|promise|capability|entry-point|constraint), text, and source_ids (one or more supplied source IDs). Do not include paths, private data, or credentials.\n\n${documents.map((document: { source_id: string; text: string }) => `[${document.source_id}]\n${document.text}`).join("\n\n")}`,
    sourceIds: new Set(manifest.sources.map((source: { source_id: string }) => source.source_id)),
    sources: sanitizeSources(manifest.sources)
  };
}

export function validatePublicBrief(output: string, sourceIds: Set<string>, sources: unknown): PublicPack {
  let brief: { product_summary?: unknown; claims?: unknown } | undefined;
  try { brief = JSON.parse(output); } catch { throw new Error("Public pack author response is not JSON"); }
  const pack = { schema_version: 1, product_summary: brief?.product_summary, claims: brief?.claims, sources };
  validatePublicPack(pack);
  const checked = pack as PublicPack;
  if (!checked.claims.every((claim) => claim.source_ids.every((sourceId) => sourceIds.has(sourceId)))) throw new Error("Public pack claim cites an unknown source");
  return checked;
}

export async function authorPublicPack({ mountDirectory, outputDirectory, limits, requestModel }: {
  mountDirectory: string;
  outputDirectory: string;
  limits: PublicAuthorLimits;
  requestModel: (request: PublicAuthorRequest) => Promise<BrokeredAuthorResponse>;
}): Promise<{ pack: PublicPack; finalization: { manifest_path: string; manifest_sha256: string; files: Array<{ path: string; sha256: string }> } }> {
  const request = await publicAuthorRequest(mountDirectory, limits);
  const response = await requestModel(request);
  if (!response?.ok || !Number.isFinite(response.actual_eur) || !Number.isFinite(response.usage?.input_tokens) || !Number.isFinite(response.usage?.output_tokens) || response.model_identity?.approved !== true) throw new Error("Brokered public pack lacks reconciled usage or approved model identity");
  const pack = validatePublicBrief(response.output as string, request.sourceIds, request.sources);
  await writeFile(join(outputDirectory, "public-pack.json"), `${JSON.stringify(pack, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { pack, finalization: await finalizeExclusivePackOutput({ outputDirectory }) };
}
