import { strict as assert } from "node:assert";
import test from "node:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { MockLanguageModelV4 } from "ai/test";
import { callExplorer, explorerMaxOutputTokens, explorerModel } from "../lib/explorer-client.mjs";

const usage = (over = {}) => ({
  inputTokens: { total: 1000, noCache: 700, cacheRead: 300, cacheWrite: 0, ...over.inputTokens },
  outputTokens: { total: 40, text: 40, reasoning: undefined, ...over.outputTokens },
});

// Captures the prompt the SDK actually hands the provider, which is what the decision contract is:
// a cached system prompt, a cached history, one PNG, then the question.
function mockModel(content, over = {}) {
  const seen = {};
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      Object.assign(seen, options);
      return { content, finishReason: { unified: "stop", raw: undefined }, usage: usage(over), warnings: [] };
    },
  });
  return { model, seen };
}

const REQUEST = (model) => ({
  model,
  maxOutputTokens: 1500,
  system: "You are the explorer.",
  history: "Instructions you already gave, oldest first:\n1. Click Search",
  screenshot: Buffer.from("fake-png-bytes"),
  question: "What would you try next, and why?",
});

test("the screenshot and both cache breakpoints reach the provider in the contract's order", async () => {
  const { model, seen } = mockModel([{ type: "text", text: '{"action":"click"}' }]);
  await callExplorer(REQUEST(model));
  assert.equal(seen.maxOutputTokens, 1500);
  const [system, user] = seen.prompt;
  assert.equal(system.role, "system");
  assert.equal(system.content, "You are the explorer.");
  assert.deepEqual(system.providerOptions, { anthropic: { cacheControl: { type: "ephemeral" } } });
  // History (cached), then the screenshot, then the question -- the image before the question is
  // the documented order for vision quality, and only stable bytes may sit ahead of it.
  assert.deepEqual(
    user.content.map((p) => p.type),
    ["text", "file", "text"],
  );
  assert.deepEqual(user.content[0].providerOptions, { anthropic: { cacheControl: { type: "ephemeral" } } });
  assert.equal(user.content[1].mediaType, "image/png");
  // The SDK normalizes binary data into a { type: "data", data } envelope; the bytes must survive.
  assert.equal(Buffer.from(user.content[1].data.data).toString(), "fake-png-bytes");
  assert.equal(user.content[2].providerOptions, undefined);
  // Anthropic's low-effort output config still rides along, inert elsewhere.
  assert.deepEqual(seen.providerOptions, { anthropic: { effort: "low" } });
});

test("usage comes back split by rate, with the cached share out of plain input", async () => {
  const { model } = mockModel([{ type: "text", text: '{"action":"click"}' }]);
  const result = await callExplorer(REQUEST(model));
  assert.equal(result.text, '{"action":"click"}');
  // Billing the 1000 total as plain input would double-charge the 300 served from cache.
  assert.deepEqual(result.usage, { input: 700, output: 40, cacheRead: 300, cacheWrite: 0 });
});

test("a reasoning model that answers inside its thinking is read, not thrown away", async () => {
  // GLM ignores enable_thinking:false and bills thinking against the same output budget, so it
  // sometimes returns the decision as reasoning with the answer empty. Failing there costs a whole
  // step -- three in a row end the run -- for a reply the model did make.
  const { model } = mockModel([{ type: "reasoning", text: '{"action":"scroll"}' }]);
  assert.equal((await callExplorer(REQUEST(model))).text, '{"action":"scroll"}');
  // The real answer still wins when both are present.
  const both = mockModel([
    { type: "reasoning", text: "thinking out loud" },
    { type: "text", text: "answer" },
  ]);
  assert.equal((await callExplorer(REQUEST(both.model))).text, "answer");
});

test("a reply with no text at all is raised at the call, not left as unparseable JSON", async () => {
  const { model } = mockModel([]);
  await assert.rejects(() => callExplorer(REQUEST(model)), /returned no text/);
});

test("SPIKE_EXPLORER_BASE_URL picks the OpenAI-compatible provider, and demands its key", () => {
  const together = {
    SPIKE_EXPLORER_BASE_URL: "https://api.together.xyz/v1",
    SPIKE_EXPLORER_API_KEY: "k",
  };
  assert.equal(explorerModel("zai-org/GLM-5.3-Flash", together).provider, "explorer.chat");
  // No base URL at all is the untouched Anthropic path.
  assert.equal(explorerModel("claude-opus-5", {}).provider, "anthropic.messages");
  assert.throws(
    () => explorerModel("zai-org/GLM-5.3-Flash", { SPIKE_EXPLORER_BASE_URL: together.SPIKE_EXPLORER_BASE_URL }),
    /SPIKE_EXPLORER_API_KEY is required/,
  );
});

test("SPIKE_EXPLORER_MAX_TOKENS raises the reasoning budget, and only when set", () => {
  assert.equal(explorerMaxOutputTokens(1500, { SPIKE_EXPLORER_MAX_TOKENS: "4000" }), 4000);
  assert.equal(explorerMaxOutputTokens(1500, {}), 1500);
  assert.equal(explorerMaxOutputTokens(1500, { SPIKE_EXPLORER_MAX_TOKENS: "not-a-number" }), 1500);
});

test("on the real Anthropic provider the caching markers and cache counters survive the wire", async () => {
  // The Anthropic path is the one already in production, and prompt caching is what makes it
  // affordable, so this checks the actual request body @ai-sdk/anthropic builds -- not a mock's
  // idea of it. A live call would need a key; the wire format is what the migration could break.
  let sent;
  const provider = createAnthropic({
    apiKey: "test-key",
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: '{"action":"click"}' }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 700,
            output_tokens: 40,
            cache_creation_input_tokens: 120,
            cache_read_input_tokens: 300,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await callExplorer(REQUEST(provider("claude-sonnet-5")));
  // Two ephemeral breakpoints: the system prompt, and the instruction history ahead of the image.
  assert.deepEqual(sent.system[0].cache_control, { type: "ephemeral" });
  const [history, image, question] = sent.messages[0].content;
  assert.deepEqual(history.cache_control, { type: "ephemeral" });
  assert.equal(image.type, "image");
  assert.equal(image.source.media_type, "image/png");
  assert.equal(question.cache_control, undefined);
  assert.equal(sent.max_tokens, 1500);
  assert.deepEqual(sent.output_config, { effort: "low" });
  // The three rates the cost line needs, each read from its own counter.
  assert.deepEqual(result.usage, { input: 700, output: 40, cacheRead: 300, cacheWrite: 120 });
});
