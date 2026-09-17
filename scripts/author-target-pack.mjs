// Authors the public pack a --target-config must bind to, for ANY public target, from the target's
// own landing page and nothing else.
//
// scripts/author-public-pack.mjs is the owner-authority path: a sandboxed child, a frozen fetch
// policy, a cap ledger, and a model call -- and lib/public-pack-fetch.mjs hardcodes one single
// approved source, so it cannot fetch anybody else. That whole ceremony exists to
// let a MODEL write claims about a product we own. For a third-party public target none of it
// applies: the claims here are quoted verbatim out of the page's own markup by plain code, so there
// is no model call to bound, no cap to spend, and nothing to sandbox. Deterministic code over a
// model call, per AGENTS.md.
//
// What it does NOT do, deliberately: it reads only the landing page, so the pack describes the
// product's front door and never its journeys. The explorer stays source-blind either way -- the
// pack is renderer/packager metadata, never explorer input.
//
// Usage:
//   node scripts/author-target-pack.mjs https://example.com [--out packs/<name>]
// It prints the pack path and its sha256, which go straight into targets/<x>.json.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deriveVisiblePublicText } from "../lib/public-pack-fetch.mjs";
import { sha256Text } from "../lib/scaffold.mjs";
import { validatePublicPack } from "../lib/public-pack-schema.mjs";

const MAX_RAW_BYTES = 4_000_000;

const decode = (value) =>
  String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

const attr = (tag, name) =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1] ??
  tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"))?.[1] ??
  null;

function meta(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (attr(tag, "name") ?? attr(tag, "property") ?? "").toLowerCase();
    if (name === key) {
      const content = attr(tag, "content");
      if (content?.trim()) return decode(content);
    }
  }
  return null;
}

// Visible label text of every element of `tag`, in document order, de-duplicated. This is what a
// person reads off the page's controls -- quoted, never paraphrased.
function labels(html, tag, limit) {
  const found = new Set();
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "gi");
  for (const match of html.matchAll(pattern)) {
    const text = decode(match[1].replace(/<[^>]+>/g, " "));
    if (text && text.length <= 60 && !/^[\s\W]*$/.test(text)) found.add(text);
    if (found.size >= limit) break;
  }
  return [...found];
}

function claimsFrom(html, sourceId) {
  const claims = [];
  const add = (id, kind, text) => {
    if (text) claims.push({ id, kind, text, source_ids: [sourceId] });
  };
  const title = decode(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "");
  const description = meta(html, "description") ?? meta(html, "og:description");
  const headings = labels(html, "h1", 3);
  const linkLabels = labels(html, "a", 24).filter((text) => text.length > 1);
  const buttonLabels = labels(html, "button", 12).filter((text) => text.length > 1);

  add("page-title", "promise", title && `The landing page's own title is "${title}".`);
  add(
    "page-description",
    "promise",
    description && `The page's own meta description reads: "${description}".`,
  );
  add(
    "headline",
    "audience",
    headings.length && `The page's top heading${headings.length > 1 ? "s read" : " reads"}: ${headings.map((h) => `"${h}"`).join(", ")}.`,
  );
  add(
    "link-entry-points",
    "entry-point",
    linkLabels.length &&
      `The landing page's own links are labelled: ${linkLabels.map((l) => `"${l}"`).join(", ")}.`,
  );
  add(
    "button-controls",
    "capability",
    buttonLabels.length &&
      `The landing page's own buttons are labelled: ${buttonLabels.map((l) => `"${l}"`).join(", ")}.`,
  );
  return claims;
}

export async function authorTargetPack(url, fetchImpl = fetch) {
  const initialUrl = new URL(url).href;
  // Identify honestly. Node's default `User-Agent: node` gets rate-limited or refused by ordinary
  // public sites (OpenStreetMap answers it with a 429), so the fetch says what it is and who to
  // contact -- the good-citizen convention, not a disguise. If a target refuses THIS, that is a
  // finding about the target and the run stops; nothing here pretends to be a browser.
  const response = await fetchImpl(initialUrl, {
    redirect: "follow",
    headers: {
      "user-agent": "releashed-public-pack-author/1.0 (+https://releashed.io; reads one public page)",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${initialUrl} answered HTTP ${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.byteLength > MAX_RAW_BYTES) throw new Error("Landing page is implausibly large for a public pack");
  const contentType = (response.headers.get("content-type") ?? "text/html").split(";", 1)[0].toLowerCase();
  const html = raw.toString("utf8");
  const derived = deriveVisiblePublicText(raw, contentType);
  const finalUrl = new URL(response.url || initialUrl).href;
  const claims = claimsFrom(html, "source-001");
  // A pack with no citable claim is a finding about the target (a blank shell, a bot wall, a
  // client-rendered app that ships no markup), not something to paper over with a generic sentence.
  if (claims.length < 2)
    throw new Error(
      `${finalUrl} served no readable title, description, headings, links or buttons -- nothing citable to build a public pack from`,
    );
  return validatePublicPack({
    schema_version: 1,
    product_summary: `Public facts read from ${finalUrl} on ${new Date().toISOString().slice(0, 10)}. Every claim below is quoted verbatim from that page's own markup; no journey, route or capability is inferred.`,
    claims,
    sources: [
      {
        source_id: "source-001",
        initial_url: initialUrl,
        final_url: finalUrl,
        retrieved_at: new Date().toISOString(),
        status: response.status,
        content_type: contentType,
        redirect_chain: initialUrl === finalUrl ? [initialUrl] : [initialUrl, finalUrl],
        raw_sha256: sha256Text(raw),
        raw_bytes: raw.byteLength,
        derived_text_sha256: sha256Text(derived),
        derived_text_bytes: Buffer.byteLength(derived),
      },
    ],
  });
}

if (process.argv[1]?.endsWith("author-target-pack.mjs")) {
  const [url, ...rest] = process.argv.slice(2);
  if (!url) throw new Error("Usage: node scripts/author-target-pack.mjs <https url> [--out packs/<dir>]");
  const outIndex = rest.indexOf("--out");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const directory =
    outIndex >= 0 && rest[outIndex + 1]
      ? resolve(rest[outIndex + 1])
      : resolve(
          import.meta.dirname,
          "..",
          "packs",
          `public-pack-${new URL(url).hostname.replace(/[^a-z0-9]+/gi, "-")}-${stamp}`,
        );
  const pack = await authorTargetPack(url);
  const bytes = `${JSON.stringify(pack, null, 2)}\n`;
  await mkdir(directory, { recursive: true });
  const path = join(directory, "public-pack.json");
  await writeFile(path, bytes, { mode: 0o600 });
  console.log(path);
  console.log(sha256Text(Buffer.from(bytes)));
}
