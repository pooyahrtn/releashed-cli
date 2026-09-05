import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyAuthOutput, sessionFromAuthCmd } from "../lib/auth-cmd.mjs";
import { exploreSessionPath, mapCommand, parseArgs } from "../bin/releashed.mjs";

const temp = () => mkdtemp(join(tmpdir(), "releashed-auth-cmd-"));
const said = (fn) => assert.rejects(fn);

test("a URL on stdout is a one-shot sign-in link, JSON is a session file, anything else is an error", () => {
  assert.deepEqual(classifyAuthOutput("  https://app.example.test/sign-in?t=abc\n"), {
    kind: "url",
    url: "https://app.example.test/sign-in?t=abc",
  });
  assert.equal(classifyAuthOutput('{"schema_version":1,"cookies":[]}').kind, "session");
  assert.throws(
    () => classifyAuthOutput("bun: command not found\n"),
    /must print a sign-in URL or a schema_version-1 session file, not: "bun: command not found"/,
  );
  // The error quotes what it saw, capped, so a stray token never lands whole in a log.
  assert.throws(() => classifyAuthOutput("x".repeat(500)), (error) => {
    assert.match(error.message, /"x{80}"/);
    return true;
  });
  assert.throws(() => classifyAuthOutput('{"schema_version":2}'), /not a schema_version-1 session/);
  assert.throws(() => classifyAuthOutput("{not json"), /must print a sign-in URL/);
});

test("a printed URL is redeemed in a browser; printed JSON is written straight to the session file", async () => {
  const root = await temp();
  const redeemed = [];
  const urlPath = await sessionFromAuthCmd(
    { command: "mint", sessionDir: join(root, "sessions"), name: "app-example-test" },
    {
      shell: async () => "https://app.example.test/sign-in?__ticket=abc\n",
      redeem: async (url, options) => {
        redeemed.push({ url, ...options });
        return "/redeemed.json";
      },
    },
  );
  assert.equal(urlPath, "/redeemed.json");
  assert.deepEqual(redeemed, [
    {
      url: "https://app.example.test/sign-in?__ticket=abc",
      name: "app-example-test",
      outputDir: join(root, "sessions"),
    },
  ]);

  const session = { schema_version: 1, origin: "https://app.example.test", cookies: [] };
  const jsonPath = await sessionFromAuthCmd(
    { command: "mint", sessionDir: join(root, "sessions"), name: "app-example-test" },
    { shell: async () => `${JSON.stringify(session)}\n`, redeem: () => assert.fail("no browser for a ready-made session") },
  );
  assert.equal(jsonPath, join(root, "sessions", "app-example-test.json"));
  assert.deepEqual(JSON.parse(await readFile(jsonPath, "utf8")), session);
  // It is a credential: nobody else on the machine may read it.
  assert.equal((await stat(jsonPath)).mode & 0o777, 0o600);
  await rm(root, { recursive: true, force: true });
});

test("--auth-cmd and --login are mutually exclusive, on both commands", () => {
  const mapped = parseArgs(["map", "https://example.com", "--auth-cmd", "echo hi"]);
  assert.equal(mapped.authCmd, "echo hi");
  assert.equal(mapped.login, false);
  assert.equal(parseArgs(["map", "https://example.com"]).authCmd, null);
  assert.throws(
    () => parseArgs(["map", "https://example.com", "--login", "--auth-cmd", "echo hi"]),
    /--login and --auth-cmd are two ways to sign in; pick one/,
  );
  assert.equal(parseArgs(["explore-mcp", "https://example.com", "--auth-cmd", "echo hi"]).authCmd, "echo hi");
  assert.throws(
    () => parseArgs(["explore-mcp", "https://example.com", "--login", "--auth-cmd", "x"]),
    /pick one/,
  );
  assert.throws(() => parseArgs(["explore-mcp", "--auth-cmd", "x"]), /needs the <url> it signs in to/);
});

test("the minted session reaches the map run's target config", async () => {
  const root = await temp();
  const asked = [];
  await mapCommand(
    {
      command: "map",
      url: "https://app.example.test/today",
      model: "sonnet",
      steps: 3,
      minutes: null,
      budgetEur: null,
      login: false,
      authCmd: "bun scripts/mint.ts learner",
      mine: true,
      seedPath: null,
      uploadPath: null,
      include: [],
      exclude: [],
      allow: [],
      viewports: [{ width: 1280, height: 800 }],
    },
    {
      out: root,
      authSession: async (args) => {
        asked.push(args);
        return "/private/sessions/app-example-test.json";
      },
      login: () => assert.fail("--auth-cmd must never open a login browser"),
      authorPack: async () => ({ url: "https://app.example.test/today" }),
      sha256: async () => "sha",
      explore: async ({ configPath }) => {
        const config = JSON.parse(await readFile(configPath, "utf8"));
        assert.equal(config.authMode, "saved-session");
        assert.equal(config.savedSessionPath, "/private/sessions/app-example-test.json");
        return join(root, "runs", "run-1", "evidence");
      },
      caption: async () => ({}),
      packageRun: async () => ({ output_path: join(root, "candidate") }),
      agents: async () => null,
      log: () => {},
    },
  );
  assert.deepEqual(asked, [
    { command: "bun scripts/mint.ts learner", sessionDir: join(root, "sessions"), name: "app-example-test" },
  ]);
  await rm(root, { recursive: true, force: true });
});

test("explore-mcp resolves --auth-cmd to a session path, and --login still needs a saved one", async () => {
  const root = await temp();
  const path = await exploreSessionPath(
    { url: "https://app.example.test/today", login: false, authCmd: "mint" },
    { out: root, authSession: async ({ name, sessionDir }) => join(sessionDir, `${name}.json`) },
  );
  assert.equal(path, join(root, "sessions", "app-example-test.json"));
  assert.equal(await exploreSessionPath({ url: "https://x.test/", login: false, authCmd: null }, { out: root }), null);
  await said(() => exploreSessionPath({ url: "https://x.test/", login: true, authCmd: null }, { out: root }));
  await rm(root, { recursive: true, force: true });
});
