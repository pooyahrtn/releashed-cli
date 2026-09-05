import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finalizeExclusivePackOutput, validatePublicPack } from "./public-pack-runtime.mjs";

function sanitizeSources(sources) {
  return sources.map(({ derived_path, ...source }) => source);
}

export async function publicAuthorRequest(mountDirectory, limits) {
  const manifest = JSON.parse(await readFile(join(mountDirectory, "public-input-manifest.json"), "utf8"));
  const documents = await Promise.all(manifest.sources.map(async (source) => ({ source_id: source.source_id, text: await readFile(join(mountDirectory, source.derived_path), "utf8") })));
  return {
    method: "request",
    content_classification: "public-pack-text",
    maximum_input_tokens: limits.maximum_input_tokens,
    maximum_output_tokens: limits.maximum_output_tokens,
    content: `Create one compact public evidence pack using only the supplied public documents. Return JSON with exactly product_summary (string) and claims (array). Each claim must have exactly id (stable lowercase slug), kind (audience|promise|capability|entry-point|constraint), text, and source_ids (one or more supplied source IDs). Do not include paths, private data, or credentials.\n\n${documents.map((document) => `[${document.source_id}]\n${document.text}`).join("\n\n")}`,
    sourceIds: new Set(manifest.sources.map((source) => source.source_id)),
    sources: sanitizeSources(manifest.sources)
  };
}

export function validatePublicBrief(output, sourceIds, sources) {
  let brief;
  try { brief = JSON.parse(output); } catch { throw new Error("Public pack author response is not JSON"); }
  const pack = { schema_version: 1, product_summary: brief?.product_summary, claims: brief?.claims, sources };
  validatePublicPack(pack);
  if (!pack.claims.every((claim) => claim.source_ids.every((sourceId) => sourceIds.has(sourceId)))) throw new Error("Public pack claim cites an unknown source");
  return pack;
}

export async function authorPublicPack({ mountDirectory, outputDirectory, limits, requestModel }) {
  const request = await publicAuthorRequest(mountDirectory, limits);
  const response = await requestModel(request);
  if (!response?.ok || !Number.isFinite(response.actual_eur) || !Number.isFinite(response.usage?.input_tokens) || !Number.isFinite(response.usage?.output_tokens) || response.model_identity?.approved !== true) throw new Error("Brokered public pack lacks reconciled usage or approved model identity");
  const pack = validatePublicBrief(response.output, request.sourceIds, request.sources);
  await writeFile(join(outputDirectory, "public-pack.json"), `${JSON.stringify(pack, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { pack, finalization: await finalizeExclusivePackOutput({ outputDirectory }) };
}
