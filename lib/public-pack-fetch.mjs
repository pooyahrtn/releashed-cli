import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sha256Text } from "./scaffold.mjs";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PRODUCTION_INITIAL = "https://inburgering.coach/";
const PRODUCTION_FINALS = ["https://inburgering.coach/", "https://www.inburgering.coach/"];
const CONTENT_TYPES = ["text/html", "text/plain"];
function exactKeys(value, keys) {
    return !!value && typeof value === "object" && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}
function normalizedExactUrl(value, allowInsecureFixture) {
    const url = new URL(value);
    if ((url.protocol !== "https:" && !(allowInsecureFixture && url.protocol === "http:")) || url.username || url.password || url.hash || url.search || !url.pathname)
        throw new Error("Public-source URL is not an exact permitted HTTP(S) URL");
    return url.href;
}
export function validateFrozenPublicFetchPolicy(policy, { allowInsecureFixture = false } = {}) {
    const expected = ["schema_version", "record_kind", "policy_id", "initial_urls", "permitted_final_urls", "maximum_redirects", "timeout_ms", "maximum_raw_bytes_per_source", "allowed_content_types", "maximum_derived_text_bytes_total", "content_classification", "note"];
    const p = policy;
    if (!exactKeys(policy, expected) || p.schema_version !== 1 || p.record_kind !== "spike-a-frozen-public-pack-fetch-policy" || typeof p.policy_id !== "string" || !p.policy_id || p.content_classification !== "public-only" || typeof p.note !== "string")
        throw new Error("Frozen public-source policy schema is invalid");
    if (!Array.isArray(p.initial_urls) || !Array.isArray(p.permitted_final_urls) || p.initial_urls.length !== 1 || p.permitted_final_urls.length !== 2 || !Number.isSafeInteger(p.maximum_redirects) || !Number.isSafeInteger(p.timeout_ms) || !Number.isSafeInteger(p.maximum_raw_bytes_per_source) || !Number.isSafeInteger(p.maximum_derived_text_bytes_total) || !Array.isArray(p.allowed_content_types))
        throw new Error("Frozen public-source policy values are invalid");
    const initialUrls = p.initial_urls.map((url) => normalizedExactUrl(url, allowInsecureFixture));
    const finalUrls = p.permitted_final_urls.map((url) => normalizedExactUrl(url, allowInsecureFixture));
    if (new Set(finalUrls).size !== 2 || new Set(p.allowed_content_types).size !== CONTENT_TYPES.length || !CONTENT_TYPES.every((type) => p.allowed_content_types.includes(type)))
        throw new Error("Frozen public-source policy list values are invalid");
    if (p.maximum_redirects !== 3 || p.timeout_ms !== 20_000 || p.maximum_raw_bytes_per_source !== 524_288 || p.maximum_derived_text_bytes_total !== 28_672)
        throw new Error("Frozen public-source policy limits are not exact");
    if (!allowInsecureFixture && (initialUrls[0] !== PRODUCTION_INITIAL || finalUrls.join("\n") !== PRODUCTION_FINALS.join("\n")))
        throw new Error("Frozen public-source policy does not name the sole approved public source");
    if (allowInsecureFixture && ![...initialUrls, ...finalUrls].every((url) => new URL(url).hostname === "127.0.0.1"))
        throw new Error("Test fixture policy must be localhost-only");
    return { policy_id: p.policy_id, initial_urls: initialUrls, permitted_final_urls: finalUrls, permitted_origins: [...new Set(finalUrls.map((url) => new URL(url).origin))], maximum_redirects: p.maximum_redirects, timeout_ms: p.timeout_ms, maximum_raw_bytes_per_source: p.maximum_raw_bytes_per_source, allowed_content_types: [...CONTENT_TYPES], maximum_derived_text_bytes_total: p.maximum_derived_text_bytes_total, policy_sha256: sha256Text(JSON.stringify(policy)) };
}
async function boundedBytes(response, maximumBytes) {
    const reader = response.body?.getReader();
    if (!reader)
        throw new Error("Public source response body is unavailable");
    const chunks = [];
    let bytes = 0;
    for (;;) {
        const next = await reader.read();
        if (next.done)
            break;
        bytes += next.value.byteLength;
        if (bytes > maximumBytes)
            throw new Error("Public source exceeded its frozen raw-byte limit");
        chunks.push(next.value);
    }
    return Buffer.concat(chunks);
}
export function deriveVisiblePublicText(raw, contentType) {
    let text = new TextDecoder("utf-8", { fatal: false }).decode(raw).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (contentType === "text/html")
        text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ").replace(/<[^>]+>/g, " ");
    return text.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim() + "\n";
}
export async function fetchFrozenPublicSources({ policy, outputDirectory, fetchImpl = fetch, allowInsecureFixture = false }) {
    const frozen = validateFrozenPublicFetchPolicy(policy, { allowInsecureFixture });
    const staging = join(dirname(outputDirectory), `.${basename(outputDirectory)}.staging-${process.pid}-${Date.now()}`);
    await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 });
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
        await Promise.all([mkdir(join(staging, "raw"), { mode: 0o700 }), mkdir(join(staging, "author-input"), { mode: 0o700 })]);
        const sources = [];
        let derivedTotal = 0;
        for (let index = 0; index < frozen.initial_urls.length; index += 1) {
            const initialUrl = frozen.initial_urls[index];
            let url = initialUrl;
            const redirectChain = [initialUrl];
            let response;
            while (true) {
                response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(frozen.timeout_ms) });
                if (!REDIRECTS.has(response.status))
                    break;
                if (redirectChain.length - 1 >= frozen.maximum_redirects)
                    throw new Error("Public source exceeded the frozen redirect limit");
                const location = response.headers.get("location");
                if (!location)
                    throw new Error("Public source redirect lacked a location");
                url = new URL(location, url).href;
                if (!frozen.permitted_final_urls.includes(url))
                    throw new Error("Public source redirect did not land on a frozen permitted final URL");
                redirectChain.push(url);
            }
            if (!frozen.permitted_final_urls.includes(url) || !response.ok)
                throw new Error("Public source final URL or status is not frozen-approved");
            const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
            if (!frozen.allowed_content_types.includes(contentType))
                throw new Error("Public source content type is not frozen-approved");
            const raw = await boundedBytes(response, frozen.maximum_raw_bytes_per_source);
            const derived = deriveVisiblePublicText(raw, contentType);
            const derivedBytes = Buffer.byteLength(derived);
            derivedTotal += derivedBytes;
            if (derivedTotal > frozen.maximum_derived_text_bytes_total)
                throw new Error("Public sources exceeded the frozen derived-text cap");
            const sourceId = `source-${String(index + 1).padStart(3, "0")}`;
            await Promise.all([writeFile(join(staging, "raw", `${sourceId}.bin`), raw, { flag: "wx", mode: 0o600 }), writeFile(join(staging, "author-input", `${sourceId}.txt`), derived, { flag: "wx", mode: 0o600 })]);
            sources.push({ source_id: sourceId, initial_url: initialUrl, final_url: url, retrieved_at: new Date().toISOString(), status: response.status, content_type: contentType, redirect_chain: redirectChain, raw_sha256: sha256Text(raw), raw_bytes: raw.byteLength, derived_text_sha256: sha256Text(derived), derived_text_bytes: derivedBytes, derived_path: `${sourceId}.txt` });
        }
        const authorManifest = { schema_version: 1, content_classification: "public-only", policy_id: frozen.policy_id, policy_sha256: frozen.policy_sha256, sources };
        const receipt = { schema_version: 1, content_classification: "public-only", policy_id: frozen.policy_id, policy_sha256: frozen.policy_sha256, sources: sources.map(({ derived_path, ...source }) => ({ ...source, raw_path: `raw/${source.source_id}.bin` })) };
        await Promise.all([writeFile(join(staging, "author-input", "public-input-manifest.json"), `${JSON.stringify(authorManifest, null, 2)}\n`, { flag: "wx", mode: 0o600 }), writeFile(join(staging, "fetch-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 })]);
        await rename(staging, outputDirectory);
        return { policy_sha256: frozen.policy_sha256, sources: receipt.sources, author_input_directory: join(outputDirectory, "author-input") };
    }
    catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
    }
}
