import { strict as assert } from "node:assert";
import test from "node:test";
import { MODEL_PRICE_SOURCE, modelCostEur } from "../lib/scaffold.mjs";

test("modelCostEur prices the explorer's tokens at the published list price, in euros", () => {
  // One million input + one million output tokens of claude-opus-5 is USD 5 + USD 25 by the
  // published list price, so the euro figure is exactly 30 / the euro reference rate.
  const cost = modelCostEur("claude-opus-5", { input: 1_000_000, output: 1_000_000 });
  assert.ok(Math.abs(cost - 30 / MODEL_PRICE_SOURCE.usd_per_eur) < 1e-9, `got ${cost}`);
  // Output tokens are the expensive half; a run of the same size must not be priced flat.
  assert.ok(
    modelCostEur("claude-opus-5", { input: 0, output: 1000 }) >
      modelCostEur("claude-opus-5", { input: 1000, output: 0 }),
  );
  assert.equal(modelCostEur("claude-opus-5", { input: 0, output: 0 }), 0);
});

test("modelCostEur bills cached tokens at the cache rates, not as plain input", () => {
  // A million tokens served from cache costs a tenth of a million plain input tokens. Counting
  // them as input would overstate a cached run's cost roughly tenfold.
  const cached = modelCostEur("claude-opus-5", { input: 0, output: 0, cacheRead: 1_000_000 });
  const plain = modelCostEur("claude-opus-5", { input: 1_000_000, output: 0 });
  assert.ok(Math.abs(cached * 10 - plain) < 1e-9, `cache read ${cached} vs input ${plain}`);
  // A cache write costs more than plain input (1.25x), which is what makes caching a tradeoff
  // rather than free -- the figure has to show that, not hide it.
  assert.ok(modelCostEur("claude-opus-5", { cacheWrite: 1_000_000 }) > plain);
  // A run from before caching existed carries no cache counters at all and must still price.
  assert.equal(
    modelCostEur("claude-opus-5", { input: 1_000_000, output: 0 }),
    modelCostEur("claude-opus-5", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
  );
});

test("modelCostEur reports an unknown model as unpriced rather than inventing a figure", () => {
  assert.equal(modelCostEur("some-model-we-never-read-a-price-for", { input: 10, output: 10 }), null);
});
