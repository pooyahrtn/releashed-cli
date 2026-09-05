import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedJsonlChild } from "../lib/bounded-child.mjs";

test("bounded JSONL child rejects protocol messages after completion", async () => {
  await assert.rejects(
    () => runBoundedJsonlChild({
      command: process.execPath,
      args: ["--input-type=module", "--eval", "process.stdout.write('{\"kind\":\"done\"}\\n{\"kind\":\"late\"}\\n')"],
      options: { cwd: "/", env: { PATH: "/usr/bin:/bin" } },
      timeoutMs: 1_000,
      label: "Protocol fixture",
      onMessage(message) {
        if (message.kind !== "done") throw new Error("unexpected message");
        return { complete: true };
      }
    }),
    /message after completion/
  );
});

test("bounded JSONL child rejects malformed and oversized messages", async (t) => {
  for (const [name, expression, pattern] of [
    ["malformed", "process.stdout.write('nope\\n')", /malformed JSONL/],
    ["oversized", "process.stdout.write(JSON.stringify({value:'x'.repeat(1000001)})+'\\n')", /exceeded its bound/],
    ["whitespace-padded", "process.stdout.write(' '.repeat(1000001)+'{}\\n')", /exceeded its bound/]
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        () => runBoundedJsonlChild({
          command: process.execPath,
          args: ["--input-type=module", "--eval", expression],
          options: { cwd: "/", env: { PATH: "/usr/bin:/bin" } },
          timeoutMs: 1_000,
          label: "Protocol fixture",
          onMessage() {}
        }),
        pattern
      );
    });
  }
});

test("deadline still wins when an output handler never settles after child exit", async () => {
  const started = Date.now();
  await assert.rejects(
    () => runBoundedJsonlChild({
      command: process.execPath,
      args: ["--input-type=module", "--eval", "process.stdout.write('{\"kind\":\"stall\"}\\n')"],
      options: { cwd: "/", env: { PATH: "/usr/bin:/bin" } },
      timeoutMs: 50,
      label: "Nonsettling handler fixture",
      onMessage: () => new Promise(() => {})
    }),
    /deadline reached/
  );
  assert.ok(Date.now() - started < 1_000);
});
