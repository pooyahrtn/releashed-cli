// The explorer's model call, on the Vercel AI SDK. One code path for every provider: Anthropic by
// default, any OpenAI-compatible host (Together, OpenRouter, DashScope) when SPIKE_EXPLORER_BASE_URL
// is set. The decision contract is identical on both -- one cached system prompt, a cached
// append-only instruction history, one fresh screenshot, one JSON reply -- so only the transport and
// the price record differ.
//
//   SPIKE_EXPLORER_MODEL=zai-org/GLM-5.3-Flash \
//   SPIKE_EXPLORER_BASE_URL=https://api.together.xyz/v1 \
//   SPIKE_EXPLORER_API_KEY=$TOGETHER_API_KEY node scripts/vision-explorer-run.mjs ...
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

// Prompt caching. Only Anthropic bills a cache write, and only Anthropic reads these markers; on
// every other provider they are inert, which is why they can sit in the shared message shape
// instead of behind a branch. The breakpoints are the stable bytes -- system prompt, then the
// instruction history -- and the screenshot, the only part that changes every turn, comes after
// both. See the note on `decide` in scripts/vision-explorer-spike.mjs.
const CACHE_HERE = { anthropic: { cacheControl: { type: "ephemeral" } } };

export function explorerModel(modelId, env = process.env) {
  const baseURL = env.SPIKE_EXPLORER_BASE_URL;
  if (!baseURL) return anthropic(modelId);
  const apiKey = env.SPIKE_EXPLORER_API_KEY;
  if (!apiKey) throw new Error("SPIKE_EXPLORER_API_KEY is required when SPIKE_EXPLORER_BASE_URL is set");
  return createOpenAICompatible({ name: "explorer", baseURL, apiKey }).chatModel(modelId);
}

// A reasoning model bills its thinking against the SAME output budget as its answer, and GLM
// ignores enable_thinking:false, so the Anthropic path's 1500 is not enough there: the model spends
// it all thinking and answers with nothing. SPIKE_EXPLORER_MAX_TOKENS raises the ceiling for such a
// host without touching what the Anthropic path sends.
export const explorerMaxOutputTokens = (fallback, env = process.env) =>
  Number(env.SPIKE_EXPLORER_MAX_TOKENS) || fallback;

export async function callExplorer({ model, system, history, screenshot, question, maxOutputTokens }) {
  const result = await generateText({
    model,
    maxOutputTokens,
    // Anthropic's own low-effort output config, unchanged from the hand-rolled SDK call. Inert on
    // every other provider.
    providerOptions: { anthropic: { effort: "low" } },
    // A SystemModelMessage rather than a bare string, because that is the only shape the SDK lets
    // provider options -- here, the first cache breakpoint -- ride on.
    instructions: { role: "system", content: system, providerOptions: CACHE_HERE },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: history, providerOptions: CACHE_HERE },
          { type: "file", mediaType: "image/png", data: screenshot },
          { type: "text", text: question },
        ],
      },
    ],
  });
  // A reasoning model splits its reply in two, and when it runs the answer close to the budget it
  // puts the decision in its thinking and leaves the answer empty. Reading only the answer there
  // throws away a reply the model actually made. Prefer the answer; fall back to the thinking.
  const text = result.text || result.reasoningText;
  if (typeof text !== "string" || text.length === 0)
    throw new Error(`Explorer model returned no text (finish reason ${JSON.stringify(result.finishReason)})`);
  const usage = result.usage ?? {};
  return {
    text,
    usage: {
      // `inputTokens` is the TOTAL, cached share included; the three rates are priced apart in
      // lib/scaffold.mjs, so the uncached count is the one that must be billed as plain input.
      input: usage.inputTokenDetails?.noCacheTokens ?? usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cacheRead: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    },
  };
}
