const CLAIM_KINDS = new Set(["audience", "promise", "capability", "entry-point", "constraint"]);

const TOP_KEYS = ["schema_version", "product_summary", "claims", "sources"];
const SOURCE_KEYS = ["source_id", "initial_url", "final_url", "retrieved_at", "status", "content_type", "redirect_chain", "raw_sha256", "raw_bytes", "derived_text_sha256", "derived_text_bytes"];
const CLAIM_KEYS = ["id", "kind", "text", "source_ids"];

export type PublicPackSource = {
  source_id: string;
  initial_url: string;
  final_url: string;
  retrieved_at: string;
  status: number;
  content_type: string;
  redirect_chain: string[];
  raw_sha256: string;
  raw_bytes: number;
  derived_text_sha256: string;
  derived_text_bytes: number;
};

export type PublicPackClaim = {
  id: string;
  kind: string;
  text: string;
  source_ids: string[];
};

export type PublicPack = {
  schema_version: number;
  product_summary: string;
  claims: PublicPackClaim[];
  sources: PublicPackSource[];
};

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return !!value && typeof value === "object" && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

// Bounded, quoted rendering of an offending value for an error message -- never the whole pack,
// just enough to recognise which value failed.
function show(value: unknown): string {
  if (typeof value === "string") return value.length > 120 ? `${JSON.stringify(value.slice(0, 120))}…` : JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}

function shapeMismatch(value: unknown, keys: readonly string[]): string {
  const actual = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : null;
  return `expected exactly the fields [${[...keys].sort().join(", ")}]; got ${actual ? `[${actual.join(", ") || "none"}]` : Array.isArray(value) ? "an array" : `a ${typeof value}`}`;
}

function isPublicSourceUrl(url: unknown): boolean {
  return typeof url === "string" && (/^https:\/\//.test(url) || (process.env.SPIKE_A_TEST_ONLY_LOCAL_FIXTURE === "1" && /^http:\/\/127\.0\.0\.1(:\d+)?\//.test(url)));
}

// Explains why a given source URL failed isPublicSourceUrl, so the fix is obvious rather than a
// guess. `Public pack sources are invalid` was filed three times by real dogfood sessions
// ("Should name which source failed and why") because the real cause -- a local fixture URL, with
// SPIKE_A_TEST_ONLY_LOCAL_FIXTURE unset -- named nothing.
function localSourceUrlHint(url: unknown): string {
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

function topLevelIssue(pack: unknown): string | null {
  if (!exactKeys(pack, TOP_KEYS)) return `top level ${shapeMismatch(pack, TOP_KEYS)}`;
  const p = pack as Record<string, unknown>;
  if (p.schema_version !== 1) return `schema_version must be 1, got ${show(p.schema_version)}`;
  if (typeof p.product_summary !== "string" || !p.product_summary.trim())
    return `product_summary must be a nonempty string, got ${show(p.product_summary)}`;
  if (!Array.isArray(p.claims)) return `claims must be an array, got ${show(p.claims)}`;
  if (!Array.isArray(p.sources)) return `sources must be an array, got ${show(p.sources)}`;
  if (p.sources.length === 0) return "sources must not be empty";
  return null;
}

function sourceIssue(source: unknown, index: number, seenIds: Set<string>): string | null {
  const s = source as Record<string, unknown>;
  const label = typeof s?.source_id === "string" && s.source_id ? `"${s.source_id}"` : `at index ${index}`;
  if (!exactKeys(source, SOURCE_KEYS)) return `source ${label} ${shapeMismatch(source, SOURCE_KEYS)}`;
  if (typeof s.source_id !== "string") return `source ${label}'s source_id must be a string, got ${show(s.source_id)}`;
  if (seenIds.has(s.source_id)) return `source_id ${show(s.source_id)} is used by more than one source`;
  if (!/^source-\d{3}$/.test(s.source_id)) return `source ${label}'s source_id must match "source-NNN", got ${show(s.source_id)}`;
  if (!isPublicSourceUrl(s.initial_url))
    return `source ${label}'s initial_url is not an accepted public URL: ${show(s.initial_url)}${localSourceUrlHint(s.initial_url)}`;
  if (!isPublicSourceUrl(s.final_url))
    return `source ${label}'s final_url is not an accepted public URL: ${show(s.final_url)}${localSourceUrlHint(s.final_url)}`;
  if (!/^[0-9a-f]{64}$/.test(s.raw_sha256 as string))
    return `source ${label}'s raw_sha256 must be a 64-character lowercase hex sha256, got ${show(s.raw_sha256)}`;
  if (!/^[0-9a-f]{64}$/.test(s.derived_text_sha256 as string))
    return `source ${label}'s derived_text_sha256 must be a 64-character lowercase hex sha256, got ${show(s.derived_text_sha256)}`;
  return null;
}

function claimIssue(claim: unknown, index: number, knownSourceIds: Set<string>): string | null {
  const c = claim as Record<string, unknown>;
  const label = typeof c?.id === "string" && c.id ? `"${c.id}"` : `at index ${index}`;
  if (!exactKeys(claim, CLAIM_KEYS)) return `claim ${label} ${shapeMismatch(claim, CLAIM_KEYS)}`;
  if (typeof c.id !== "string") return `claim ${label}'s id must be a string, got ${show(c.id)}`;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(c.id)) return `claim ${label}'s id must match "[a-z][a-z0-9-]{0,63}", got ${show(c.id)}`;
  if (!CLAIM_KINDS.has(c.kind as string))
    return `claim ${label}'s kind must be one of [${[...CLAIM_KINDS].join(", ")}], got ${show(c.kind)}`;
  if (typeof c.text !== "string" || !c.text.trim()) return `claim ${label}'s text must be a nonempty string, got ${show(c.text)}`;
  if (!Array.isArray(c.source_ids) || c.source_ids.length === 0)
    return `claim ${label}'s source_ids must be a nonempty array, got ${show(c.source_ids)}`;
  const unknown = (c.source_ids as unknown[]).find((sourceId) => !knownSourceIds.has(sourceId as string));
  if (unknown !== undefined) return `claim ${label} cites source_id ${show(unknown)}, which is not one of this pack's sources`;
  return null;
}

// Every failure kind above and below throws its own message naming the field and value at fault,
// and for a source, its source_id -- a single "invalid" string for all of them named none of that.
export function validatePublicPack(pack: unknown): PublicPack {
  const topIssue = topLevelIssue(pack);
  if (topIssue) throw new Error(`Public pack schema is invalid: ${topIssue}`);
  const checked = pack as PublicPack;
  const seenIds = new Set<string>();
  checked.sources.forEach((source, index) => {
    const issue = sourceIssue(source, index, seenIds);
    if (issue) throw new Error(`Public pack sources are invalid: ${issue}`);
    seenIds.add(source.source_id);
  });
  const claimIds = new Set<string>();
  checked.claims.forEach((claim, index) => {
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
  for (const [pattern, label] of forbidden as Array<[RegExp, string]>) {
    if (pattern.test(rendered)) throw new Error(`Public pack contains a forbidden private artifact field: it matches ${label}`);
  }
  return checked;
}
