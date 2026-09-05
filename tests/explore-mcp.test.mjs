import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TOOLS, createExplorer, validateAct } from "../lib/explore-mcp.mjs";

// A browser that answers every question the evidence code asks, and remembers what was done to it.
function stubBrowser({ url = "https://example.test/", offSiteAfterClick = false } = {}) {
  const log = [];
  let current = url;
  const page = {
    url: () => current,
    screenshot: async () => Buffer.from(`png-of-${current}-${log.length}`),
    async evaluate() {
      // What identifyTarget finds under the grounded point.
      return [{ role: "button", name: "Sign up" }];
    },
    mouse: {
      click: async (x, y) => {
        log.push(`click ${x},${y}`);
        if (offSiteAfterClick) current = "https://elsewhere.example/donate";
        else current = "https://example.test/signup";
      },
    },
    goto: async (to) => {
      log.push(`goto ${to}`);
      current = to;
    },
    waitForTimeout: async () => {},
  };
  const cdp = {
    send: async (method) => {
      if (method === "Accessibility.getFullAXTree")
        return { nodes: [{ role: { value: "button" }, name: { value: "Sign up" }, backendDOMNodeId: 7 }] };
      if (method === "DOM.resolveNode") return { object: { objectId: "o1" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: true } };
      return {};
    },
  };
  const agent = {
    aiLocate: async (target) => {
      log.push(`locate ${target}`);
      return { center: [40, 60] };
    },
    aiScroll: async () => log.push("scroll"),
    aiInput: async (target, { value }) => log.push(`input ${target}=${value}`),
  };
  const boundary = {
    allowed: 0,
    refused: [],
    events: [],
    total: 3,
    sameOriginMutations: 0,
    origin: "https://example.test",
    origins: new Set(["https://example.test"]),
    readOnly: true,
  };
  return { page, cdp, agent, boundary, close: async () => log.push("closed"), log };
}

async function explorerOn(browser, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "releashed-explore-"));
  const launched = [];
  const explorer = createExplorer({
    url: "https://example.test/",
    steps: 3,
    runsRoot: join(root, "runs"),
    outputRoot: root,
    launch: async (entry, options) => {
      launched.push({ entry, ...options });
      return browser;
    },
    ...extra,
  });
  return { explorer, root, launched };
}

const said = (result) => result.content.find((part) => part.type === "text").text;

test("no tool declares an output schema, or Claude Code renders the screenshot as base64 text", () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ["observe", "act", "record", "finish"]);
  for (const tool of TOOLS) assert.ok(!("outputSchema" in tool), `${tool.name} must declare no output schema`);
});

test("act only takes the vocabulary the boundary can dispatch", () => {
  assert.equal(validateAct({ action: "tap", instruction: "Tap sign up", target: "the sign up button" }), null);
  assert.match(validateAct({ action: "navigate", instruction: "go", target: "x" }), /unsupported action navigate/);
  assert.match(validateAct({ action: "tap", instruction: " ", target: "x" }), /instruction is required/);
  assert.match(validateAct({ action: "tap", instruction: "go", target: "" }), /target noun phrase/);
  assert.match(validateAct({ action: "type", instruction: "go", target: "the box" }), /needs the text/);
  assert.match(validateAct({ action: "drag", instruction: "go", target: "the word" }), /needs drop_target/);
});

test("observe returns a screenshot as an image, captured no wider than 1280", async () => {
  const browser = stubBrowser();
  const { explorer, root, launched } = await explorerOn(browser);
  const result = await explorer.handleCall("observe", {});
  assert.equal(launched[0].entry, "https://example.test/");
  assert.equal(launched[0].viewport.width, 1280);
  const image = result.content.find((part) => part.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(Buffer.from(image.data, "base64").toString(), "png-of-https://example.test/-0");
  assert.deepEqual(JSON.parse(said(result)), {
    address: "https://example.test/",
    steps_used: 0,
    steps_left: 3,
    transitions_recorded: 0,
    unrecorded_act: false,
  });
  await rm(root, { recursive: true, force: true });
});

test("act clicks through our own code and record writes the packager's event shape", async () => {
  const browser = stubBrowser();
  const { explorer, root } = await explorerOn(browser);
  await explorer.handleCall("observe", {});
  const acted = JSON.parse(
    said(await explorer.handleCall("act", { action: "tap", instruction: "Tap the sign up button", target: "the sign up button" })),
  );
  assert.deepEqual(acted.screen_changed, true);
  assert.equal(acted.address, "https://example.test/signup");
  assert.equal(acted.pointed_at, "named");
  // Midscene said WHERE; our code dispatched the input.
  assert.deepEqual(browser.log, ["locate the sign up button", "click 40,60"]);

  assert.match(said(await explorer.handleCall("record", {})), /event-0001/);
  const [event, ...rest] = (await readFile(join(explorer.runDir, "observations.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(rest.length, 0);
  assert.equal(event.run_id, explorer.runId);
  assert.equal(event.transition_kind, "solid");
  assert.equal(event.intended_action.method, "click");
  assert.equal(event.intended_action.ref, "e1");
  assert.equal(event.intended_action.target_identification, "named");
  assert.equal(event.evidence_provenance, "direct-browser-observation");
  assert.equal(event.before.screenshot_path, "screenshots/state-0001.png");
  assert.equal(event.after.screenshot_path, "screenshots/state-0002.png");
  assert.equal(event.action_matrix_class, "Reversible own-account");

  assert.match(said(await explorer.handleCall("record", {})), /nothing to record/);
  await rm(root, { recursive: true, force: true });
});

test("a door off the product's own site is a finding, not a dispatched action", async () => {
  const browser = stubBrowser({ offSiteAfterClick: true });
  const { explorer, root } = await explorerOn(browser);
  await explorer.handleCall("observe", {});
  const result = await explorer.handleCall("act", { action: "tap", instruction: "Tap donate", target: "the donate link" });
  assert.match(said(result), /led off the product's own site/);
  assert.ok(browser.log.includes("goto https://example.test/"), "the browser is put back where it was");
  assert.equal(explorer.state.blocked.length, 1);
  assert.match(said(await explorer.handleCall("record", {})), /nothing to record/);
  await rm(root, { recursive: true, force: true });
});

test("a read-only run never types a contact detail into somebody else's product", async () => {
  const browser = stubBrowser();
  const { explorer, root } = await explorerOn(browser);
  await explorer.handleCall("observe", {});
  const result = await explorer.handleCall("act", {
    action: "type",
    instruction: "Type an email address into the sign-in box",
    target: "the email box",
    text: "mapper@example.com",
  });
  assert.match(said(result), /read-only and never signs in/);
  assert.deepEqual(browser.log, [], "nothing reached the browser");
  await rm(root, { recursive: true, force: true });
});

test("the step budget is spent by refusals too, and finish needs something recorded", async () => {
  const browser = stubBrowser();
  const { explorer, root } = await explorerOn(browser);
  await explorer.handleCall("observe", {});
  assert.equal((await explorer.handleCall("finish", {})).isError, true);
  for (let step = 0; step < 3; step += 1)
    await explorer.handleCall("act", { action: "scroll", instruction: "Scroll down", target: "the page" });
  const spent = await explorer.handleCall("act", { action: "scroll", instruction: "Scroll down", target: "the page" });
  assert.match(said(spent), /step budget of 3 is spent/);
  await rm(root, { recursive: true, force: true });
});

test("finish authors the public pack from the product's own page, packages, and names the map", async () => {
  const browser = stubBrowser();
  const packaged = [];
  const { explorer, root } = await explorerOn(browser, {
    authorPack: async (url) => ({ schema_version: 1, product_summary: `read from ${url}`, claims: [] }),
    packageRun: async (args) => {
      packaged.push(args);
      return { output_path: join(root, "maps", args.runId) };
    },
  });
  await explorer.handleCall("observe", {});
  await explorer.handleCall("act", { action: "tap", instruction: "Tap sign up", target: "the sign up button" });
  await explorer.handleCall("record", {});
  const finished = JSON.parse(said(await explorer.handleCall("finish", { why: "nothing left to try" })));
  assert.equal(finished.transitions, 1);
  assert.ok(finished.map.endsWith("map.html"));
  assert.equal(packaged[0].publicPackSha256.length, 64);

  const report = JSON.parse(await readFile(join(explorer.runDir, "production-run-report.json"), "utf8"));
  assert.equal(report.public_pack_sha256, packaged[0].publicPackSha256);
  assert.equal(report.candidate_eligible, true);
  assert.equal(report.cleanup_complete, true);
  const metrics = JSON.parse(await readFile(join(explorer.runDir, "metrics.json"), "utf8"));
  // We spend nothing and cannot count what the agent's own turns cost it.
  assert.equal(metrics.model_cost_eur, null);
  const result = JSON.parse(await readFile(join(explorer.runDir, "explorer-result.json"), "utf8"));
  assert.equal(result.reason, "nothing left to try");
  assert.ok(browser.log.includes("closed"), "the browser is closed when the run is packaged");

  // Everything after finish is refused rather than half-applied.
  assert.equal((await explorer.handleCall("act", { action: "scroll", instruction: "Scroll", target: "the page" })).isError, true);
  assert.equal((await explorer.handleCall("observe", {})).isError, true);
  await rm(root, { recursive: true, force: true });
});

test("acting again before recording leaves no screenshot the finished trace does not reference", async () => {
  // record()'s own contract: "an act that is not recorded never happened". Calling act() again
  // before record() discards the prior attempt's evidence in memory -- but used to leave the
  // screenshot file it captured on disk, referenced by nothing, which the packager then refused
  // the whole candidate over (docs/DECISIONS.md, the explore-20260905T210309Z run).
  const browser = stubBrowser();
  const packaged = [];
  const { explorer, root } = await explorerOn(browser, {
    authorPack: async () => ({ schema_version: 1, product_summary: "x", claims: [] }),
    packageRun: async (args) => {
      packaged.push(args);
      return { output_path: join(root, "maps", args.runId) };
    },
  });
  await explorer.handleCall("observe", {});
  // First attempt: never recorded -- the agent tries again instead.
  await explorer.handleCall("act", { action: "tap", instruction: "Tap sign up", target: "the sign up button" });
  // Second attempt: this is the one that gets kept.
  await explorer.handleCall("act", { action: "tap", instruction: "Tap sign up again", target: "the sign up button" });
  await explorer.handleCall("record", {});
  await explorer.handleCall("finish", {});

  const events = (await readFile(join(explorer.runDir, "observations.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(events.length, 1, "the discarded first attempt never became an event");
  const referenced = new Set(
    events.flatMap((event) => [event.before.screenshot_path, event.after.screenshot_path]).map((path) => path.split("/").at(-1)),
  );
  const onDisk = (await readdir(join(explorer.runDir, "screenshots"))).sort();
  assert.deepEqual(onDisk, [...referenced].sort(), "no screenshot on disk that the recorded trace does not reference");
  await rm(root, { recursive: true, force: true });
});

test("when packaging still refuses, finish says the run's evidence is intact and not to retry blindly", async () => {
  const browser = stubBrowser();
  const { explorer, root } = await explorerOn(browser, {
    authorPack: async () => ({ schema_version: 1, product_summary: "x", claims: [] }),
    packageRun: async () => {
      throw new Error("Candidate packaging refused: unreferenced retained screenshot state-0002.png");
    },
  });
  await explorer.handleCall("observe", {});
  await explorer.handleCall("act", { action: "tap", instruction: "Tap sign up", target: "the sign up button" });
  await explorer.handleCall("record", {});
  const result = await explorer.handleCall("finish", {});
  assert.equal(result.isError, true);
  assert.match(said(result), /unreferenced retained screenshot state-0002\.png/);
  assert.match(said(result), /not.*retried/i);
  assert.match(said(result), new RegExp(explorer.runDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await rm(root, { recursive: true, force: true });
});

test("a saved session reaches the browser launch, and only when one was given", async () => {
  const plain = await explorerOn(stubBrowser());
  await plain.explorer.handleCall("observe", {});
  assert.ok(!("savedSessionPath" in plain.launched[0]));
  const signedIn = await explorerOn(stubBrowser(), { savedSessionPath: "/private/sessions/example.json" });
  await signedIn.explorer.handleCall("observe", {});
  assert.equal(signedIn.launched[0].savedSessionPath, "/private/sessions/example.json");
});
