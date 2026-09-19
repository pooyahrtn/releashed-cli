import { createHash } from "node:crypto";

const ROBOTS_META = '<meta name="robots" content="noindex, nofollow, noarchive">';

// The map is a single self-contained HTML file (screenshots embedded as data: URIs), but a
// renderer could in principle emit relative asset links, so we still look for and carry those.
const ASSET_REF = /\b(?:src|href)="([^"]+)"/g;

// A real relative asset path, not a JS string built with concatenation (e.g. "' + x + '") that a
// naive src="..." scan would otherwise catch inside an inline <script>.
const RELATIVE_PATH = /^[\w./-]+\.(?:png|jpe?g|gif|webp|svg)$/i;

function isRelative(ref: string): boolean {
  return RELATIVE_PATH.test(ref);
}

/** Relative asset paths referenced by the map HTML (screenshots the renderer left external, if any). */
export function findRelativeAssets(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(ASSET_REF)) {
    if (isRelative(match[1])) found.add(match[1]);
  }
  return [...found].sort();
}

/** Ensures the page carries a noindex/nofollow meta tag. No-op if one is already present. */
export function injectNoindex(html: string): { html: string; injected: boolean } {
  if (/<meta\s+name="robots"/i.test(html)) return { html, injected: false };
  const charsetIdx = html.search(/<meta charset="[^"]*">/i);
  if (charsetIdx === -1) {
    // Fall back to right after <head>.
    return { html: html.replace(/<head>/i, `<head>${ROBOTS_META}`), injected: true };
  }
  const insertAt = html.indexOf(">", charsetIdx) + 1;
  return { html: html.slice(0, insertAt) + ROBOTS_META + html.slice(insertAt), injected: true };
}

/** Content hash for a rendered map: the page bytes plus any referenced asset bytes, in path order. */
export function hashCandidate(htmlBuffer: Uint8Array, assetEntries: Array<{ relPath: string; buffer: Uint8Array }> = []): string {
  const hash = createHash("sha256");
  hash.update(htmlBuffer);
  for (const { relPath, buffer } of [...assetEntries].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    hash.update(relPath);
    hash.update(buffer);
  }
  return hash.digest("hex");
}
