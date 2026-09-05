// Option D: the explorer runs inside the coding agent.
//
// We ship no model call. This MCP server exposes four tools -- observe (a screenshot), act (one
// plain-English instruction plus the noun phrase to point at), record (append the observed
// transition to the evidence), finish (package and render the map) -- and skills/releashed-explore
// tells the agent how to run the loop. The agent in front of the user IS the vision model; the
// boundary, the evidence contract, the packager and the renderer are ours, and are the SAME ones
// `releashed map` uses: nothing here re-implements the loop, it just lets someone else drive it.
//
// observe declares NO output schema on purpose: Claude Code renders an MCP image as base64 text
// when a tool declares one (anthropics/claude-code#31208). Nothing in TOOLS may grow one.
//
// Read-only by default: unless the caller says --mine (see the "mine" option on createExplorer /
// serveExplorer), the boundary refuses every mutating request to the product's own origins, and
// act refuses to type contact details or passwords. --mine widens that to ordinary product use
// (send, post, submit, reply) while still refusing pay, delete, and anything money-shaped
// (billing, checkout, subscribe, ...) -- see lib/run-limits.mjs and the "mine" branch of
// classifyRequest in scripts/vision-explorer-spike.mjs. A login wall is a finding, not an obstacle,
// in either mode.
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { authorTargetPack } from "../scripts/author-target-pack.mjs";
import { packageCandidate } from "./candidate-packager.mjs";
import { ACTION_TYPES } from "./explorer-protocol.mjs";
import { checkActionAuthorized, detectWall, onBoundOrigin, FORBIDDEN_VERBS, OWNER_FORBIDDEN_VERBS } from "./run-limits.mjs";
import { buildTransitionEvent, identifyTarget, observeScreen } from "./explorer-evidence.mjs";
import { sha256Text } from "./scaffold.mjs";

// The four reversible input kinds the CLI's own pre-dispatch gate authorizes, and the protocol
// method each is recorded as. A drag and a tap are both a click as far as the evidence goes.
const RECORDED_METHOD = { tap: "click", drag: "click", type: "type", scroll: "scroll" };
// A screenshot wider than this costs the agent tokens for pixels it does not need, and the browser
// is ours, so the cheapest downscale is never to capture wider in the first place.
export const MAX_VIEWPORT_WIDTH = 1280;

export const TOOLS = [
  {
    name: "observe",
    description:
      "Look at the product: returns a screenshot of the current screen, its address, and how many steps and recorded transitions the run has left. Call it first, and again whenever you are unsure what is on screen.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "only on the first call, and only if the server was started without a URL",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "act",
    description:
      "Do one thing on the screen, described the way you would tell a person: an instruction, and a short noun phrase naming what to point at (\"the blue Sign up button top right\"). Never a CSS selector. Returns what the screen did.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["tap", "type", "scroll", "drag"] },
        instruction: { type: "string", description: "one action, plain English" },
        target: { type: "string", description: "noun phrase for the thing to point at" },
        text: { type: "string", description: "for type only: what to type" },
        drop_target: { type: "string", description: "for drag only: where it lands" },
      },
      required: ["action", "instruction", "target"],
      additionalProperties: false,
    },
  },
  {
    name: "record",
    description:
      "Keep the transition the last act produced as evidence in the map. Call it after every act whose result you believe -- an act that is not recorded never happened as far as the map is concerned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "finish",
    description:
      "Stop exploring, package the evidence and render the map. Returns the candidate directory and the path of map.html.",
    inputSchema: {
      type: "object",
      properties: { why: { type: "string", description: "one sentence: why you stopped" } },
      additionalProperties: false,
    },
  },
];

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const toolError = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

// Everything about WHAT may be dispatched. The action vocabulary is the protocol's own
// (lib/explorer-protocol.mjs ACTION_TYPES, after tap/drag fold into "click"); whether the dispatch
// is allowed right now is checkActionAuthorized's call, imported from the CLI loop unchanged.
export function validateAct(args) {
  const method = RECORDED_METHOD[args?.action];
  if (!method || !ACTION_TYPES.has(method)) return `unsupported action ${args?.action}`;
  if (typeof args.instruction !== "string" || !args.instruction.trim()) return "instruction is required";
  if (typeof args.target !== "string" || !args.target.trim()) return "target noun phrase is required";
  if (args.action === "type" && (typeof args.text !== "string" || !args.text))
    return "a type action needs the text to type";
  if (args.action === "drag" && (typeof args.drop_target !== "string" || !args.drop_target))
    return "a drag action needs drop_target, the noun phrase for where it lands";
  return null;
}

// Real Chromium, the same boundary the CLI installs. Replaced by a stub in tests.
export async function launchBoundBrowser(entryUrl, { viewport, savedSessionPath = null, mine = false } = {}) {
  const { chromium } = await import("playwright");
  const { PlaywrightAgent } = await import("@midscene/web/playwright");
  const { defineActionDragAndDrop } = await import("@midscene/core/device");
  const { installActionBoundary, ourDragMotion } = await import("../scripts/vision-explorer-spike.mjs");
  // Midscene resolves its grounding model entirely from the environment. Until the Claude grounder
  // swap lands (docs/ARCHITECTURE-OPTIONS.md), this is the one key option D still needs.
  process.env.MIDSCENE_MODEL_NAME ??= "gemini-3.6-flash";
  process.env.MIDSCENE_MODEL_FAMILY ??= "gemini";
  process.env.MIDSCENE_MODEL_BASE_URL ??= "https://generativelanguage.googleapis.com/v1beta/openai/";
  process.env.MIDSCENE_MODEL_API_KEY ??= process.env.GEMINI_API_KEY;
  // Midscene writes its own report folder to the CURRENT directory unless told otherwise, which
  // litters whatever repo the run was launched from. Keep it beside the run's own output.
  process.env.MIDSCENE_RUN_DIR ??= join(process.env.RELEASHED_OUT ?? join(process.cwd(), "releashed"), "midscene");
  if (!process.env.MIDSCENE_MODEL_API_KEY)
    throw new Error(
      "GEMINI_API_KEY is required: pointing at a control on the screenshot is still a second model. See the README.",
    );
  const origin = new URL(entryUrl).origin;
  const boundary = {
    allowed: 0,
    refused: [],
    events: [],
    total: 0,
    sameOriginMutations: 0,
    origin,
    origins: new Set([origin]),
    readOnly: true,
    mine,
  };
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const cdp = await installActionBoundary(context, page, boundary);
  await cdp.send("Accessibility.enable").catch(() => {});
  if (savedSessionPath) {
    // The session the user saved with `releashed login`, applied by the same code `map --login`
    // uses; it also refuses to continue when the landing page still looks like a sign-in wall.
    const { loadSavedSession } = await import("../scripts/vision-explorer-run.mjs");
    await loadSavedSession(page, cdp, entryUrl, savedSessionPath);
  } else {
    await page.goto(entryUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(3_000);
  }
  const agent = new PlaywrightAgent(page, {
    cache: { id: `releashed-explore-${new URL(entryUrl).host.replace(/[^a-z0-9]+/gi, "-")}`, strategy: "read-write" },
    customActions: [defineActionDragAndDrop((from, to) => ourDragMotion(page, from, to))],
  });
  return { page, cdp, agent, boundary, close: () => browser.close().catch(() => {}) };
}

export function createExplorer({
  url = null,
  steps = 40,
  runsRoot,
  outputRoot,
  savedSessionPath = null,
  // Owner mode: the run may use the product like a user (send, post, submit, reply); pay, delete
  // and money-shaped paths (billing, checkout, subscribe, ...) still refuse either way.
  mine = false,
  launch = launchBoundBrowser,
  now = () => Date.now(),
  // Only injected by the tests; the real one reads the target's own landing page.
  authorPack = authorTargetPack,
  packageRun = packageCandidate,
}) {
  const runId = `explore-${new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const runDir = join(resolve(runsRoot), runId, "target-session-1");
  const state = {
    entryUrl: url,
    session: null,
    current: null,
    pending: null,
    events: [],
    blocked: [],
    stateIndex: 0,
    stepsUsed: 0,
    startedAt: now(),
    finished: null,
    walled: null,
  };

  async function open(firstUrl) {
    const entry = firstUrl ?? state.entryUrl;
    if (!entry) throw new Error("no URL yet: pass one to observe, or start the server with a URL");
    new URL(entry); // a malformed URL is a caller error, thrown before a browser is launched
    state.entryUrl = entry;
    await mkdir(join(runDir, "screenshots"), { recursive: true });
    state.session = await launch(entry, {
      viewport: { width: MAX_VIEWPORT_WIDTH, height: 800 },
      ...(savedSessionPath ? { savedSessionPath } : {}),
      mine,
    });
  }

  async function snapshot() {
    state.stateIndex += 1;
    const { page, cdp } = state.session;
    state.current = await observeScreen(page, cdp, runDir, state.stateIndex, true);
    return state.current;
  }

  async function observe(args = {}) {
    if (state.finished) return toolError("this run is finished; its map is already packaged");
    if (!state.session) {
      await open(args.url);
      await snapshot();
      const entryWall = detectWall(state.current.evidence.url, state.current.evidence.visible_state_summary, { entry: true });
      if (entryWall) {
        state.walled = entryWall.reason;
        state.blocked.push({ instruction: "open the product", target: null, transition_kind: "unknown-terminal", reason: entryWall.reason });
      }
    } else if (!state.current) {
      await snapshot();
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              address: state.current.evidence.url,
              steps_used: state.stepsUsed,
              steps_left: Math.max(0, steps - state.stepsUsed),
              transitions_recorded: state.events.length,
              unrecorded_act: Boolean(state.pending),
              ...(state.walled ? { wall: state.walled } : {}),
            },
            null,
            2,
          ),
        },
        // NO output schema on this tool, so the client renders this as an image.
        { type: "image", data: state.current.png.toString("base64"), mimeType: "image/png" },
      ],
    };
  }

  async function act(args = {}) {
    if (state.finished) return toolError("this run is finished; its map is already packaged");
    if (!state.session || !state.current) return toolError("call observe first: nothing has been looked at yet");
    if (state.stepsUsed >= steps)
      return toolError(`the step budget of ${steps} is spent -- call finish to package what was seen`);
    // A wall is a finding, and it is terminal: nothing honest is left to try on this product.
    if (state.walled) return toolError(`${state.walled} Call finish to package what was seen.`);
    const invalid = validateAct(args);
    if (invalid) return toolError(invalid);

    const { page, agent, boundary } = state.session;
    const decision = {
      action: args.action,
      instruction: args.instruction,
      target: args.target,
      text: args.text ?? null,
      drop_target: args.drop_target ?? null,
    };
    // The same pre-dispatch gate the CLI runs, read-only forced on: four reversible input kinds,
    // on the product's own origin, and never a contact detail or a password typed into it. Owner
    // mode shrinks the forbidden-verb list and adds the money/destruction-destination check.
    const authorized = checkActionAuthorized(decision, boundary.origins, page.url(), true, {
      forbidden: mine ? OWNER_FORBIDDEN_VERBS : FORBIDDEN_VERBS,
      mine,
    });
    if (!authorized.authorized) {
      state.stepsUsed += 1;
      state.blocked.push({
        instruction: decision.instruction,
        target: decision.target,
        transition_kind: "unknown-terminal",
        reason: authorized.reason,
      });
      return text(`${authorized.reason} Nothing was dispatched. Find something else on screen.`);
    }

    const before = state.current.evidence;
    const mutationsBefore = boundary.sameOriginMutations;
    let identified = { tier: "positional", ref: null };
    state.stepsUsed += 1;
    try {
      if (args.action === "tap") {
        // One grounding call, then identify what sits under that point while the page is still in
        // its BEFORE state, then dispatch. Our code is the only place input is dispatched.
        const located = await agent.aiLocate(decision.target);
        const [x, y] = Array.isArray(located.center) ? located.center : [located.center.x, located.center.y];
        identified = await identifyTarget(page, state.current.refs, x, y);
        await page.mouse.click(x, y);
      } else {
        const { execute } = await import("../scripts/vision-explorer-spike.mjs");
        await execute(agent, page, decision);
      }
    } catch (error) {
      // The executor refused to guess a coordinate, so no input was dispatched. An attempted
      // instruction is not evidence.
      return text(`Nothing on screen matched "${decision.target}", so nothing was done. Try a different phrase, or a different control.`);
    }
    await page.waitForTimeout(1_500);

    if (!onBoundOrigin(page.url(), boundary.origins)) {
      const reason = `"${decision.instruction}" led off the product's own site; the run did not follow it.`;
      state.blocked.push({ instruction: decision.instruction, target: decision.target, transition_kind: "unknown-terminal", reason });
      await page.goto(before.url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1_000);
      await snapshot();
      return text(`${reason} You are back where you were. Do not try it again.`);
    }

    const after = (await snapshot()).evidence;
    // A bot check ends the run exactly as it does in the CLI loop -- recorded as a finding, never
    // worked around. The transition that reached it is still recordable, so the wall is in the map.
    const wall = detectWall(after.url, after.visible_state_summary);
    if (wall) {
      state.walled = wall.reason;
      state.blocked.push({ instruction: decision.instruction, target: decision.target, transition_kind: "unknown-terminal", reason: wall.reason });
    }
    const method = RECORDED_METHOD[args.action];
    state.pending = buildTransitionEvent({
      runId,
      index: state.events.length + 1,
      before,
      after,
      method,
      identified,
      mutated: boundary.sameOriginMutations > mutationsBefore,
      elapsedSeconds: (now() - state.startedAt) / 1000,
      requests: boundary.total,
    });
    return text({
      screen_changed: state.pending.transition_kind === "solid",
      address: after.url,
      pointed_at: identified.tier,
      ...(wall ? { wall: wall.reason } : {}),
      next: wall
        ? "call record to keep this transition, then finish: a wall is a finding, not something to get around"
        : "call record to keep this transition, then observe the new screen",
    });
  }

  async function record() {
    if (state.finished) return toolError("this run is finished; its map is already packaged");
    if (!state.pending) return toolError("nothing to record: call act first");
    const event = state.pending;
    state.pending = null;
    state.events.push(event);
    await writeFile(join(runDir, "observations.jsonl"), `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o600 });
    return text({
      recorded: event.event_id,
      transition_kind: event.transition_kind,
      transitions_recorded: state.events.length,
    });
  }

  // act() takes a screenshot on every attempt, but a step only becomes evidence when record() is
  // called on it -- an unrecorded attempt (act() called again before record, a door that led off
  // the product and was put back, ...) "never happened", exactly as record's own description says.
  // Nothing upstream of here ever deletes the file that "never happened" attempt left behind, so it
  // piles up on disk referenced by nothing -- which is what the packager's own safety check (never
  // ship evidence the trace does not account for) then correctly refuses at finish() time, with the
  // whole run's map lost. Delete it here instead, at the one place we know for certain what the
  // FINAL trace will reference: right before packaging. See docs/DECISIONS.md.
  async function sweepUnreferencedScreenshots() {
    const keep = new Set();
    for (const event of state.events) {
      keep.add(event.before.screenshot_path);
      keep.add(event.after.screenshot_path);
    }
    const dir = join(runDir, "screenshots");
    const files = await readdir(dir).catch(() => []);
    await Promise.all(
      files
        .filter((name) => !keep.has(`screenshots/${name}`))
        .map((name) => unlink(join(dir, name)).catch(() => {})),
    );
  }

  // The sidecars the packager and the renderer read beside the trace. There is no cost line: option
  // D spends none of our tokens and cannot count the agent's.
  async function writeSidecars(why, publicPackSha256) {
    await writeFile(
      join(runDir, "explorer-result.json"),
      `${JSON.stringify(
        {
          status: "done",
          stop_reason: state.walled ? "wall" : "explorer_finished",
          reason: state.walled ?? why ?? "The agent driving this run said it was finished.",
          decisions: state.events.length,
          unexecutable_instructions: [],
          blocked_actions: state.blocked,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(runDir, "request-events.jsonl"),
      (state.session?.boundary.events ?? []).map((event) => `${JSON.stringify(event)}\n`).join(""),
      { mode: 0o600 },
    );
    const boundary = state.session?.boundary;
    await writeFile(
      join(runDir, "metrics.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          run_id: runId,
          explorer_model: "the coding agent driving this MCP server",
          grounding_model: process.env.MIDSCENE_MODEL_NAME ?? null,
          browser: {
            active_seconds: Number(((now() - state.startedAt) / 1000).toFixed(3)),
            actions: state.events.length,
            requests_seen_by_action_boundary: boundary?.total ?? 0,
            mutating_requests_allowed: boundary?.allowed ?? 0,
            same_origin_mutating_requests: boundary?.sameOriginMutations ?? 0,
            requests_refused_by_action_boundary: boundary?.refused.length ?? 0,
          },
          action_boundary: {
            installed: "raw CDP Fetch.requestPaused, attached before the executor",
            // "owner" when the run was started with --mine, "stranger" otherwise -- see
            // docs/CONTROL-SURFACE.md.
            mode: mine ? "owner" : "stranger",
            refused: (boundary?.refused ?? []).map((item) => ({ method: item.method, reason: item.reason })),
          },
          // We do not pay for this run and cannot see what the agent's own turns cost it.
          model_cost_eur: null,
          model_cost_basis: { covers: "nothing: the agent driving this server pays its own tokens" },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(runDir, "production-run-report.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          run_id: runId,
          public_pack_sha256: publicPackSha256,
          status: "completed",
          explorer_status: "done",
          explorer_stop_reason: "explorer_finished",
          observed_transitions: state.events.filter((event) => event.transition_kind === "solid").length,
          no_effect_actions: state.events.filter((event) => event.transition_kind === "none").length,
          app_one_way_actions: 0,
          app_actual_eur: 0,
          model_actual_eur: 0,
          outstanding_reservations_eur: 0,
          model_stopped: true,
          browser_stopped: true,
          profile_deleted: true,
          // No identity was ever created: option D never signs in.
          auth_cleanup_complete: true,
          identity_retirement_confirmed: true,
          cleanup_complete: true,
          candidate_eligible: state.events.length > 0,
          non_publishable_reasons: state.events.length > 0 ? [] : ["no transition was recorded"],
          failure_stage: null,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  async function finish(args = {}) {
    if (state.finished) return text(state.finished);
    if (state.events.length === 0)
      return toolError("nothing was recorded, so there is no map to package: act and record first");
    // The public pack is read from the product's own landing page by plain code -- no model call,
    // no journeys, just what that page says about itself. The packager binds the map to it.
    const pack = await authorPack(state.entryUrl);
    const packBytes = `${JSON.stringify(pack, null, 2)}\n`;
    const packDir = join(resolve(outputRoot), "packs", runId);
    await mkdir(packDir, { recursive: true });
    const packPath = join(packDir, "public-pack.json");
    await writeFile(packPath, packBytes, { mode: 0o600 });
    const publicPackSha256 = sha256Text(Buffer.from(packBytes));
    await writeSidecars(args.why, publicPackSha256);
    // An attempt that never became a recorded event never happened -- so any screenshot it left
    // behind must not either, or the packager (correctly) refuses the whole candidate over it.
    await sweepUnreferencedScreenshots();
    await state.session?.close();
    state.session = null;
    let result;
    try {
      result = await packageRun({
        runId,
        runPath: runDir,
        outputPath: join(resolve(outputRoot), "maps", runId),
        publicPackPath: packPath,
        publicPackSha256,
      });
    } catch (error) {
      // The run's screenshots, trace and sidecars are all still on disk at runDir -- nothing here
      // was deleted or half-applied. This is not a transient error: retrying finish() unchanged
      // will fail the same way every time. Say so plainly instead of looking like something worth
      // five retries.
      throw new Error(
        `packaging failed and was not retried: ${error?.message ?? error}. ` +
          `The run's evidence is intact at ${runDir} -- fix what the message names there, or hand ` +
          `that directory to someone who can, rather than calling finish again unchanged.`,
      );
    }
    state.finished = {
      candidate_dir: result.output_path,
      map: join(result.output_path, "map.html"),
      transitions: state.events.length,
      doors_not_followed: state.blocked.length,
    };
    return text(state.finished);
  }

  async function close() {
    await state.session?.close();
    state.session = null;
  }

  async function handleCall(name, args = {}) {
    try {
      if (name === "observe") return await observe(args);
      if (name === "act") return await act(args);
      if (name === "record") return await record();
      if (name === "finish") return await finish(args);
      return toolError(`unknown tool ${name}`);
    } catch (error) {
      return toolError(error?.message ?? String(error));
    }
  }

  return { handleCall, close, runId, runDir, state };
}

export async function serveExplorer(options) {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const explorer = createExplorer(options);
  const server = new Server({ name: "releashed-explore", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    explorer.handleCall(request.params.name, request.params.arguments ?? {}),
  );
  const shutdown = async () => {
    await explorer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
  return explorer;
}
