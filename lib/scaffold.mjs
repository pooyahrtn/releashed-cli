import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, readdir, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function isoNow() {
  return new Date().toISOString();
}

export function monotonicSeconds() {
  return Number(process.hrtime.bigint()) / 1e9;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function sha256File(path) {
  const body = await readFile(path);
  return createHash("sha256").update(body).digest("hex");
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
}

export async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function writeExclusiveJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function filesBelow(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await filesBelow(path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

export async function withFileLock(path, work, timeoutMs = 5000) {
  const lockPath = `${path}.lock`;
  const started = monotonicSeconds();
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if ((monotonicSeconds() - started) * 1000 >= timeoutMs) throw new Error("cap-state lock unavailable; fail closed");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  try {
    return await work();
  } finally {
    await rmdir(lockPath);
  }
}

export async function mutateCapState(path, mutation) {
  return withFileLock(path, async () => {
    const state = await readJson(path);
    const result = await mutation(state);
    await writePrivateJson(path, state);
    return result;
  });
}

// The one place that answers "is the pointing key set" -- `doctor` and `explore-mcp`'s startup
// refusal both call this rather than each re-testing process.env.GEMINI_API_KEY their own way.
export function hasGeminiKey(env = process.env) {
  return Boolean(env.GEMINI_API_KEY);
}

export function refusal(code, message) {
  return { ok: false, refusal: { code, message } };
}

export function normalizeOrigin(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs are accepted");
  }
  if (url.username || url.password) throw new Error("URL userinfo is forbidden");
  return url.origin;
}

export function sanitizeUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.search = "";
  url.hash = "";
  if (isAuthFlowUrl(url.href)) {
    url.pathname = "/:auth-flow-redacted";
    return url.href;
  }
  const suspicious = /(^[A-Za-z0-9_-]{24,}$)|(@)|(^[0-9a-f]{8}-[0-9a-f-]{27,}$)|(^eyJ)/i;
  url.pathname = url.pathname
    .split("/")
    .map((segment) => {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return ":redacted";
      }
      return suspicious.test(decoded) ? ":redacted" : segment;
    })
    .join("/");
  return url.href;
}

export function isAuthFlowUrl(rawUrl) {
  const url = new URL(rawUrl);
  return /\/(auth|oauth|sso|sign-?in|sign-?up|callback|verify|tokens?)(\/|$)/i.test(url.pathname);
}

export function rollingCount(timestamps, now, seconds = 60) {
  const floor = now - seconds;
  while (timestamps.length > 0 && timestamps[0] <= floor) timestamps.shift();
  return timestamps.length;
}

export function freshCapState(limits, workingDayDeadline, runId = null) {
  return {
    schema_version: 1,
    run_id: runId,
    working_day_deadline: workingDayDeadline,
    abort: null,
    browser: {
      started_at: null,
      active_seconds: 0,
      operations: 0,
      peak_operations_per_minute: 0,
      requests: 0,
      peak_requests_per_minute: 0,
      blocked_origin_attempts: 0,
      redirects: 0
    },
    app: {
      one_way_actions: 0,
      actual_eur: 0,
      outstanding_reservations_eur: 0,
      class_counts: {}
    },
    model: {
      calls: 0,
      refused_before_dispatch: 0,
      actual_eur: 0,
      outstanding_reservations_eur: 0
    },
    caps: {
      browser_active_seconds: limits.browser_active_seconds,
      browser_operations_total: limits.browser_operations_total,
      browser_operations_per_rolling_minute: limits.browser_operations_per_rolling_minute,
      browser_requests_total: limits.browser_requests_total,
      browser_requests_per_rolling_minute: limits.browser_requests_per_rolling_minute,
      listed_one_way_actions_total: limits.listed_one_way_actions_total,
      app_side_cost_cap_eur: limits.app_side_cost_cap_eur,
      model_cost_cap_eur: limits.model_cost_cap_eur,
      combined_actual_plus_reserved_cap_eur: limits.combined_actual_plus_reserved_cap_eur
    }
  };
}

export function combinedReservedAndActual(state) {
  return (
    state.app.actual_eur +
    state.app.outstanding_reservations_eur +
    state.model.actual_eur +
    state.model.outstanding_reservations_eur
  );
}

export function roundEur(value) {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

// What a run costs in model spend. Published Anthropic list prices, USD per million tokens, read
// 2026-09-05 from https://platform.claude.com/docs/en/about-claude/models/overview -- not from
// memory. EUR conversion uses the ECB euro reference rate published 2026-09-04 (1 EUR = 1.1622
// USD, https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/).
// Both are dated snapshots: re-read them when they age, do not guess.
export const MODEL_PRICE_SOURCE = {
  prices_url: "https://platform.claude.com/docs/en/about-claude/models/overview",
  prices_retrieved: "2026-09-05",
  eur_rate_source: "ECB euro reference rate",
  eur_rate_date: "2026-09-04",
  usd_per_eur: 1.1622,
};
// Four rates per model, because the explorer caches its prompt: a cached token is not an input
// token and must not be billed as one. cacheWrite is the 5-minute write rate (1.25x base input),
// cacheRead the hit rate (0.1x base input) -- both read from the pricing page above, not derived.
const USD_PER_MTOK = {
  "claude-opus-5": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-fable-5-1": { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 },
  "claude-sonnet-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  // Together.ai serverless list prices, read 2026-09-06 from the account's own /v1/models
  // response (the authoritative per-model `pricing` block, not a marketing page). No cacheWrite
  // rate exists on these -- Together bills a cache hit at `cached_input` and never charges to
  // write one -- so cacheWrite is left at the plain input rate and cacheRead at the published
  // cached_input rate. A model with no published cached_input caches nothing and reports nothing.
  "zai-org/GLM-5.3-Flash": { input: 0.15, cacheWrite: 0.15, cacheRead: 0.03, output: 0.5 },
  "zai-org/GLM-5.3": { input: 1.4, cacheWrite: 1.4, cacheRead: 0.26, output: 4.4 },
  "Qwen/Qwen3-VL-32B-Instruct": { input: 0.5, cacheWrite: 0.5, cacheRead: 0.5, output: 1.5 },
  "Qwen/Qwen3-VL-8B-Instruct": { input: 0.18, cacheWrite: 0.18, cacheRead: 0.18, output: 0.68 },
};

// Where each model's prices were read, and when. The euro rate is shared: it is the ECB reference
// rate above, not a per-host figure.
export const TOGETHER_PRICE_SOURCE = {
  ...MODEL_PRICE_SOURCE,
  prices_url: "https://api.together.xyz/v1/models",
  prices_retrieved: "2026-09-06",
};

export function priceSourceFor(model) {
  return model?.startsWith("claude-") ? MODEL_PRICE_SOURCE : TOGETHER_PRICE_SOURCE;
}

// null, never a number, for a model whose price we have not read: an invented figure in a run
// report is worse than an honest gap. ponytail: the grounding model's spend is not counted here
// (Midscene owns those calls and returns no usage); add it if grounding stops being the cheap half.
export function modelCostEur(model, usage) {
  const price = USD_PER_MTOK[model];
  if (!price) return null;
  const usd =
    Object.entries(price).reduce((sum, [kind, rate]) => sum + (usage?.[kind] ?? 0) * rate, 0) / 1e6;
  return roundEur(usd / MODEL_PRICE_SOURCE.usd_per_eur);
}

export function attachJsonLineReader(stream, onMessage) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      onMessage(JSON.parse(line));
    }
  });
}

export function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}
