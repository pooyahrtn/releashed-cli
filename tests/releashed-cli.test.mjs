import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { agentsBlock, doctor, mapCommand, parseArgs, writeAgentsBlock } from "../bin/releashed.mjs";
import { options as explorerOptions, resolveTarget } from "../scripts/vision-explorer-run.mjs";

test("map takes one url and the controls the run is bound by", () => {
  const plain = parseArgs(["map", "https://example.com"]);
  assert.equal(plain.url, "https://example.com/");
  assert.equal(plain.model, "sonnet");
  assert.equal(plain.steps, 40);
  assert.equal(plain.minutes, null);
  assert.equal(plain.budgetEur, null);
  assert.equal(plain.login, false);
  assert.equal(plain.mine, false);
  assert.deepEqual(plain.viewports, [{ width: 1280, height: 800 }]);
  assert.deepEqual(plain.include, []);

  const full = parseArgs([
    "map", "https://example.com/app",
    "--model", "opus", "--steps", "12", "--minutes", "30", "--budget", "2.5",
    "--include", "/tools/**,/app/**", "--exclude", "/blog/**",
    "--allow", "https://app.example.com", "--viewports", "desktop,phone",
    "--seed", "seeds.json", "--upload", "a.png", "--login", "--mine",
  ]);
  assert.equal(full.model, "opus");
  assert.equal(full.steps, 12);
  assert.equal(full.minutes, 30);
  assert.equal(full.budgetEur, 2.5);
  assert.deepEqual(full.include, ["/tools/**", "/app/**"]);
  assert.deepEqual(full.exclude, ["/blog/**"]);
  assert.deepEqual(full.allow, ["https://app.example.com"]);
  assert.deepEqual(full.viewports, [{ width: 1280, height: 800 }, { width: 390, height: 844 }]);
  assert.equal(full.login, true);
  assert.equal(full.mine, true);
  assert.ok(full.seedPath.endsWith("/seeds.json"));
  assert.ok(full.uploadPath.endsWith("/a.png"));
});

test("map refuses what the explorer could not run", () => {
  assert.throws(() => parseArgs(["map"]), /usage: releashed map/);
  assert.throws(() => parseArgs(["map", "https://a.com", "https://b.com"]), /usage: releashed map/);
  assert.throws(() => parseArgs(["map", "ftp://example.com"]), /http or https/);
  assert.throws(() => parseArgs(["map", "https://a.com", "--model", "haiku"]), /sonnet.*opus/);
  assert.throws(() => parseArgs(["map", "https://a.com", "--steps", "0"]), /--steps must be/);
  assert.throws(() => parseArgs(["map", "https://a.com", "--steps", "61"]), /--steps must be/);
  assert.throws(() => parseArgs(["map", "https://a.com", "--steps"]), /--steps needs a value/);
  assert.throws(() => parseArgs(["map", "https://a.com", "--minutes", "0"]), /--minutes must be/);
  assert.throws(() => parseArgs(["map", "https://a.com", "--budget", "-1"]), /--budget must be/);
  assert.throws(() => parseArgs(["map", "https://a.com", "--viewports", "tablet"]), /--viewports takes/);
  assert.throws(() => parseArgs(["map", "https://a.com", "--allow", "https://a.com/path"]), /--allow takes origins/);
  assert.throws(() => parseArgs(["map", "https://a.com", "--headless", "yes"]), /unknown option --headless/);
});

test("the other four commands take what they need and nothing else", () => {
  assert.equal(parseArgs(["mcp", "some/candidate"]).command, "mcp");
  assert.ok(parseArgs(["mcp", "some/candidate"]).candidateDir.endsWith("/some/candidate"));
  assert.throws(() => parseArgs(["mcp"]), /usage: releashed mcp/);
  assert.deepEqual(parseArgs(["login", "https://example.com"]), { command: "login", url: "https://example.com/" });
  assert.throws(() => parseArgs(["login"]), /usage: releashed login/);
  assert.deepEqual(parseArgs(["doctor"]), { command: "doctor" });
  assert.deepEqual(parseArgs(["explore-mcp"]), { command: "explore-mcp", url: null, steps: 40, login: false, authCmd: null, mine: false });
  assert.equal(parseArgs(["explore-mcp", "https://example.com", "--login"]).login, true);
  assert.throws(() => parseArgs(["explore-mcp", "--login"]), /needs the <url>/);
  assert.equal(parseArgs(["explore-mcp", "https://example.com", "--steps", "8"]).steps, 8);
  assert.equal(parseArgs(["explore-mcp", "https://example.com", "--mine"]).mine, true);
  assert.throws(() => parseArgs(["explore-mcp", "not a url"]), /Invalid URL/);
  assert.equal(parseArgs([]).command, "help");
  assert.throws(() => parseArgs(["maps", "https://a.com"]), /unknown command "maps"/);
});

test("the run directory defaults to the installation's own runs/, and --run-dir moves it", () => {
  const repoRuns = resolve(new URL("../runs", import.meta.url).pathname);
  // Six pending W1-6 reruns depend on this default being byte-for-byte what it always was.
  assert.equal(explorerOptions(["--steps", "12"]).runDirRoot, repoRuns);
  assert.equal(explorerOptions(["--run-dir", "/tmp/elsewhere"]).runDirRoot, "/tmp/elsewhere");
  assert.equal(explorerOptions(["--minutes", "20"]).minutes, 20);
  assert.equal(explorerOptions(["--budget-eur", "1.5"]).maxEur, 1.5);
  assert.throws(() => explorerOptions(["--minutes", "0"]), /--minutes must be/);
});

test("map runs the stages in order, bound by every control it was given", async () => {
  const out = await mkdtemp(join(tmpdir(), "releashed-cli-"));
  const runPath = join(out, "runs", "vision-prod-20260906T000000Z", "target-session-1");
  await mkdir(runPath, { recursive: true });
  await writeFile(join(runPath, "observations.jsonl"), "");
  const seedPath = join(out, "seeds.json");
  await writeFile(seedPath, JSON.stringify({ email: "person@example.com" }));
  const calls = [];
  const result = await mapCommand(
    {
      command: "map",
      url: "https://example.com/",
      model: "opus",
      steps: 7,
      minutes: 30,
      budgetEur: 2,
      login: false,
      mine: false,
      seedPath,
      uploadPath: null,
      include: ["/tools/**"],
      exclude: ["/blog/**"],
      allow: ["https://app.example.com"],
      viewports: [{ width: 1280, height: 800 }, { width: 390, height: 844 }],
    },
    {
      out,
      log: (line) => calls.push(String(line).startsWith("https://example.com is not marked") ? "warned" : `log`),
      agents: () => calls.push("agents"),
      authorPack: (url) => {
        calls.push(`pack ${url}`);
        return { schema_version: 1, claims: [] };
      },
      login: () => assert.fail("a public run must never open a login browser"),
      explore: async (args) => {
        calls.push(`explore ${args.steps} ${args.model} ${args.minutes} ${args.budgetEur}`);
        assert.equal(args.runDir, join(out, "runs"), "the run is written in the user's project, not ours");
        // The config the explorer is handed is the one thing that says what this run may do -- and
        // the explorer's own loader is what decides whether it is a config at all.
        const target = await resolveTarget(args.url, args.configPath);
        assert.equal(target.authMode, "public");
        assert.equal(target.readOnly, true, "somebody else's product is never written to");
        assert.deepEqual(target.forbidden, ["send", "post", "pay", "delete"]);
        assert.deepEqual(target.pathScope, { include: ["/tools/**"], exclude: ["/blog/**"] });
        assert.deepEqual(target.seedValues, ["person@example.com"]);
        assert.deepEqual(target.viewports, [{ width: 1280, height: 800 }, { width: 390, height: 844 }]);
        assert.deepEqual(target.allowedOrigins, ["https://example.com", "https://app.example.com"]);
        return runPath;
      },
      caption: async ({ tracePath, outputPath }) => {
        calls.push("caption");
        assert.equal(tracePath, join(runPath, "observations.jsonl"));
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, JSON.stringify({ captions: { abc: "A screen" } }));
      },
      packageRun: (args) => {
        calls.push("package");
        assert.equal(args.runId, "vision-prod-20260906T000000Z");
        assert.deepEqual(args.captions, { abc: "A screen" });
        return { output_path: join(out, "maps", args.runId) };
      },
    },
  );
  assert.deepEqual(
    calls.filter((entry) => entry !== "log"),
    ["warned", "pack https://example.com/", "explore 7 opus 30 2", "caption", "package", "agents"],
  );
  assert.equal(result.mapPath, join(out, "maps", "vision-prod-20260906T000000Z", "map.html"));
  await rm(out, { recursive: true, force: true });
});

test("--login captures a session before exploring, and the run says so", async () => {
  const out = await mkdtemp(join(tmpdir(), "releashed-cli-"));
  const runPath = join(out, "runs", "run-1", "target-session-1");
  await mkdir(runPath, { recursive: true });
  const calls = [];
  await mapCommand(
    {
      command: "map", url: "https://example.com/", model: "sonnet", steps: 3, minutes: null, budgetEur: null,
      login: true, mine: true, seedPath: null, uploadPath: null, include: [], exclude: [], allow: [],
      viewports: [{ width: 1280, height: 800 }],
    },
    {
      out,
      log: () => {},
      agents: () => {},
      authorPack: () => ({ schema_version: 1 }),
      login: (url, dir) => {
        calls.push("login");
        return join(dir, "example-com.json");
      },
      explore: (args) => {
        calls.push("explore");
        const config = JSON.parse(readFileSync(args.configPath, "utf8"));
        assert.equal(config.authMode, "saved-session");
        assert.ok(config.savedSessionPath.endsWith("example-com.json"));
        return runPath;
      },
      caption: () => {
        throw new Error("no GEMINI_API_KEY");
      },
      packageRun: (args) => {
        calls.push("package");
        // A failed captioning is not a failed run: the cards keep the titles read off the screens.
        assert.deepEqual(args.captions, {});
        return { output_path: join(out, "maps", "run-1") };
      },
    },
  );
  assert.deepEqual(calls, ["login", "explore", "package"]);
  await rm(out, { recursive: true, force: true });
});

test("the agent instruction block is written once and updated in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "releashed-agents-"));
  const one = join(dir, "releashed", "maps", "one");
  const two = join(dir, "releashed", "maps", "two");
  const printed = [];
  // Nothing to append to: print the block rather than creating a file nobody asked for.
  assert.equal(await writeAgentsBlock(one, dir, (line) => printed.push(line)), null);
  assert.match(printed.join("\n"), /releashed mcp .*maps\/one/);

  await writeFile(join(dir, "AGENTS.md"), "# My project\n\nRules here.\n");
  await writeAgentsBlock(one, dir, () => {});
  let text = await readFile(join(dir, "AGENTS.md"), "utf8");
  assert.match(text, /# My project/);
  assert.match(text, /releashed mcp .*maps\/one/);

  await writeAgentsBlock(two, dir, () => {});
  text = await readFile(join(dir, "AGENTS.md"), "utf8");
  assert.equal(text.split("## The product's flow map").length - 1, 1, "the block is replaced, never stacked");
  assert.match(text, /releashed mcp .*maps\/two/);
  assert.match(text, /# My project/);
  assert.ok(agentsBlock("/maps/two").includes("find_screen"));
  await rm(dir, { recursive: true, force: true });
});

test("doctor names the one thing that is broken instead of failing the whole run", async () => {
  const lines = [];
  const ok = { ask: async () => {}, ground: async () => {}, browser: async () => {}, log: (line) => lines.push(line) };
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.GEMINI_API_KEY = "gem-test";
  assert.ok((await doctor(ok)).every((check) => check.ok));
  assert.match(lines.join("\n"), /all good/);

  const broke = await doctor({
    ...ok,
    ask: async () => {
      throw new Error("400 credit balance is too low");
    },
    log: () => {},
  });
  const credit = broke.find((check) => check.name.startsWith("ANTHROPIC"));
  assert.equal(credit.ok, false);
  assert.match(credit.message, /credit balance/);
  assert.ok(broke.filter((check) => !check.ok).length === 1, "one failure does not fail the others");

  delete process.env.ANTHROPIC_API_KEY;
  const missing = await doctor({ ...ok, log: () => {} });
  assert.equal(missing.find((check) => check.name.startsWith("ANTHROPIC")).message, "not set");
});

// Dogfood night, 2026-09-06: a run launched from somebody else's checkout appended a pointer to a
// scratch folder to THEIR instructions file. A project only gets edited when it holds the map.
test("a map that lands outside this project leaves its instructions alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "releashed-agents-elsewhere-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "releashed-maps-"));
  await writeFile(join(dir, "AGENTS.md"), "# Somebody else's project\n");
  const printed = [];
  assert.equal(await writeAgentsBlock(join(elsewhere, "maps", "one"), dir, (line) => printed.push(line)), null);
  assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), "# Somebody else's project\n");
  assert.match(printed.join("\n"), /add this to your AGENTS.md/);
});
