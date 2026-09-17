const CLAIM_KINDS = new Set(["audience", "promise", "capability", "entry-point", "constraint"]);

const TOP_KEYS = ["schema_version", "product_summary", "claims", "sources"];
const SOURCE_KEYS = ["source_id", "initial_url", "final_url", "retrieved_at", "status", "content_type", "redirect_chain", "raw_sha256", "raw_bytes", "derived_text_sha256", "derived_text_bytes"];
const CLAIM_KEYS = ["id", "kind", "text", "source_ids"];

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

// Bounded, quoted rendering of an offending value for an error message -- never the whole pack,
// just enough to recognise which value failed.
function show(value) {
  if (typeof value === "string") return value.length > 120 ? `${JSON.stringify(value.slice(0, 120))}…` : JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}

function shapeMismatch(value, keys) {
  const actual = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : null;
  return `expected exactly the fields [${[...keys].sort().join(", ")}]; got ${actual ? `[${actual.join(", ") || "none"}]` : Array.isArray(value) ? "an array" : `a ${typeof value}`}`;
}

function isPublicSourceUrl(url) {
  return typeof url === "string" && (/^https:\/\//.test(url) || (process.env.SPIKE_A_TEST_ONLY_LOCAL_FIXTURE === "1" && /^http:\/\/127\.0\.0\.1(:\d+)?\//.test(url)));
}

// Explains why a given source URL failed isPublicSourceUrl, so the fix is obvious rather than a
// guess. `Public pack sources are invalid` was filed three times by real dogfood sessions
// ("Should name which source failed and why") because the real cause -- a local fixture URL, with
// SPIKE_A_TEST_ONLY_LOCAL_FIXTURE unset -- named nothing.
function localSourceUrlHint(url) {
  if (typeof url !== "string") return "";
  const flagSet = process.env.SPIKE_A_TEST_ONLY_LOCAL_FIXTURE === "1";
  if (/^http:\/\/127\.0\.0\.1(:\d+)?\//.test(url) && !flagSet)
    return " -- a local target needs SPIKE_A_TEST_ONLY_LOCAL_FIXTURE=1 set in the environment that builds this pack; without it only https:// sources are accepted";
  if (/^https?:\/\/localhost(:\d+)?\//.test(url))
    return url.startsWith("https://")
      ? ""
      : " -- a local target needs SPIKE_A_TEST_ONLY_LOCAL_FIXTURE=1 set in the environment that builds this pack, and even then only the literal http://127.0.0.1 form is accepted; \"localhost\" itself is never a valid source host, use http://127.0.0.1 instead";
  return "";
}

function topLevelIssue(pack) {
  if (!exactKeys(pack, TOP_KEYS)) return `top level ${shapeMismatch(pack, TOP_KEYS)}`;
  if (pack.schema_version !== 1) return `schema_version must be 1, got ${show(pack.schema_version)}`;
  if (typeof pack.product_summary !== "string" || !pack.product_summary.trim())
    return `product_summary must be a nonempty string, got ${show(pack.product_summary)}`;
  if (!Array.isArray(pack.claims)) return `claims must be an array, got ${show(pack.claims)}`;
  if (!Array.isArray(pack.sources)) return `sources must be an array, got ${show(pack.sources)}`;
  if (pack.sources.length === 0) return "sources must not be empty";
  return null;
}

function sourceIssue(source, index, seenIds) {
  const label = typeof source?.source_id === "string" && source.source_id ? `"${source.source_id}"` : `at index ${index}`;
  if (!exactKeys(source, SOURCE_KEYS)) return `source ${label} ${shapeMismatch(source, SOURCE_KEYS)}`;
  if (typeof source.source_id !== "string") return `source ${label}'s source_id must be a string, got ${show(source.source_id)}`;
  if (seenIds.has(source.source_id)) return `source_id ${show(source.source_id)} is used by more than one source`;
  if (!/^source-\d{3}$/.test(source.source_id)) return `source ${label}'s source_id must match "source-NNN", got ${show(source.source_id)}`;
  if (!isPublicSourceUrl(source.initial_url))
    return `source ${label}'s initial_url is not an accepted public URL: ${show(source.initial_url)}${localSourceUrlHint(source.initial_url)}`;
  if (!isPublicSourceUrl(source.final_url))
    return `source ${label}'s final_url is not an accepted public URL: ${show(source.final_url)}${localSourceUrlHint(source.final_url)}`;
  if (!/^[0-9a-f]{64}$/.test(source.raw_sha256))
    return `source ${label}'s raw_sha256 must be a 64-character lowercase hex sha256, got ${show(source.raw_sha256)}`;
  if (!/^[0-9a-f]{64}$/.test(source.derived_text_sha256))
    return `source ${label}'s derived_text_sha256 must be a 64-character lowercase hex sha256, got ${show(source.derived_text_sha256)}`;
  return null;
}

function claimIssue(claim, index, knownSourceIds) {
  const label = typeof claim?.id === "string" && claim.id ? `"${claim.id}"` : `at index ${index}`;
  if (!exactKeys(claim, CLAIM_KEYS)) return `claim ${label} ${shapeMismatch(claim, CLAIM_KEYS)}`;
  if (typeof claim.id !== "string") return `claim ${label}'s id must be a string, got ${show(claim.id)}`;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(claim.id)) return `claim ${label}'s id must match "[a-z][a-z0-9-]{0,63}", got ${show(claim.id)}`;
  if (!CLAIM_KINDS.has(claim.kind))
    return `claim ${label}'s kind must be one of [${[...CLAIM_KINDS].join(", ")}], got ${show(claim.kind)}`;
  if (typeof claim.text !== "string" || !claim.text.trim()) return `claim ${label}'s text must be a nonempty string, got ${show(claim.text)}`;
  if (!Array.isArray(claim.source_ids) || claim.source_ids.length === 0)
    return `claim ${label}'s source_ids must be a nonempty array, got ${show(claim.source_ids)}`;
  const unknown = claim.source_ids.find((sourceId) => !knownSourceIds.has(sourceId));
  if (unknown !== undefined) return `claim ${label} cites source_id ${show(unknown)}, which is not one of this pack's sources`;
  return null;
}

// Every failure kind above and below throws its own message naming the field and value at fault,
// and for a source, its source_id -- a single "invalid" string for all of them named none of that.
export function validatePublicPack(pack) {
  const topIssue = topLevelIssue(pack);
  if (topIssue) throw new Error(`Public pack schema is invalid: ${topIssue}`);
  const seenIds = new Set();
  pack.sources.forEach((source, index) => {
    const issue = sourceIssue(source, index, seenIds);
    if (issue) throw new Error(`Public pack sources are invalid: ${issue}`);
    seenIds.add(source.source_id);
  });
  const claimIds = new Set();
  pack.claims.forEach((claim, index) => {
    const issue = claimIssue(claim, index, seenIds);
    if (issue) throw new Error(`Public pack claims are not citable: ${issue}`);
    if (claimIds.has(claim.id)) throw new Error(`Public pack claims are not citable: claim id ${show(claim.id)} is used by more than one claim`);
    claimIds.add(claim.id);
  });
  const rendered = JSON.stringify(pack);
  const forbidden = [
    [/\/(Users|private|\.runtime)\//i, "a private filesystem path (/Users/, /private/ or /.runtime/)"],
    [/cap[-_ ]ledger/i, "a cap-ledger reference"],
    [/authority-and-start\.json/i, "authority-and-start.json"],
    [/origin-allowlist\.json/i, "origin-allowlist.json"],
    [/OPENAI_API_KEY/i, "an OPENAI_API_KEY reference"],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(rendered)) throw new Error(`Public pack contains a forbidden private artifact field: it matches ${label}`);
  }
  return pack;
}
