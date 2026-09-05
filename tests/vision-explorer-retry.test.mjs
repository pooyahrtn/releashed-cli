import assert from "node:assert/strict";
import test from "node:test";
import { withRetries } from "../scripts/vision-explorer-run.mjs";

// The bug: a single transient failure (an empty model reply, a CDP timeout) used to be treated as
// fatal and end the whole run. withRetries is the fix -- it must actually retry, succeed once the
// transient condition clears, and only give up after every attempt fails.
test("withRetries recovers from a transient failure within the attempt budget", async () => {
  let calls = 0;
  const result = await withRetries(
    "test op",
    3,
    () => {
      calls += 1;
      if (calls < 3) throw new Error("transient blip");
      return "ok";
    },
    0, // no delay -- keep the test fast
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetries gives up and throws the last error once every attempt is exhausted", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetries(
        "test op",
        3,
        () => {
          calls += 1;
          throw new Error(`attempt ${calls} failed`);
        },
        0,
      ),
    /attempt 3 failed/,
  );
  assert.equal(calls, 3); // exactly the budget, not more (a real bug) and not fewer
});
