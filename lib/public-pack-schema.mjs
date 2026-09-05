const CLAIM_KINDS = new Set(["audience", "promise", "capability", "entry-point", "constraint"]);

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function isPublicSourceUrl(url) {
  return typeof url === "string" && (/^https:\/\//.test(url) || (process.env.SPIKE_A_TEST_ONLY_LOCAL_FIXTURE === "1" && /^http:\/\/127\.0\.0\.1(:\d+)?\//.test(url)));
}

export function validatePublicPack(pack) {
  if (!exactKeys(pack, ["schema_version", "product_summary", "claims", "sources"]) || pack.schema_version !== 1 || typeof pack.product_summary !== "string" || !pack.product_summary.trim() || !Array.isArray(pack.claims) || !Array.isArray(pack.sources) || pack.sources.length === 0) throw new Error("Public pack schema is invalid");
  const sources = new Set();
  for (const source of pack.sources) {
    if (!exactKeys(source, ["source_id", "initial_url", "final_url", "retrieved_at", "status", "content_type", "redirect_chain", "raw_sha256", "raw_bytes", "derived_text_sha256", "derived_text_bytes"]) || typeof source.source_id !== "string" || sources.has(source.source_id) || !/^source-\d{3}$/.test(source.source_id) || !isPublicSourceUrl(source.initial_url) || !isPublicSourceUrl(source.final_url) || !/^[0-9a-f]{64}$/.test(source.raw_sha256) || !/^[0-9a-f]{64}$/.test(source.derived_text_sha256)) throw new Error("Public pack sources are invalid");
    sources.add(source.source_id);
  }
  const claims = new Set();
  for (const claim of pack.claims) {
    if (!exactKeys(claim, ["id", "kind", "text", "source_ids"]) || typeof claim.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(claim.id) || claims.has(claim.id) || !CLAIM_KINDS.has(claim.kind) || typeof claim.text !== "string" || !claim.text.trim() || !Array.isArray(claim.source_ids) || claim.source_ids.length === 0 || !claim.source_ids.every((sourceId) => sources.has(sourceId))) throw new Error("Public pack claims are not citable");
    claims.add(claim.id);
  }
  const rendered = JSON.stringify(pack);
  if (/\/(Users|private|\.runtime)\/|cap[-_ ]ledger|authority-and-start\.json|origin-allowlist\.json|OPENAI_API_KEY/i.test(rendered)) throw new Error("Public pack contains a forbidden private artifact field");
  return pack;
}
