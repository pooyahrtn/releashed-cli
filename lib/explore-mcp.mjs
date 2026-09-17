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
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { authorTargetPack } from "../scripts/author-target-pack.mjs";
import { packageCandidate } from "./candidate-packager.mjs";
import { ACTION_TYPES } from "./explorer-protocol.mjs";
import {
  checkActionAuthorized,
  detectWall,
  noEffectNote,
  onBoundOrigin,
  waitAllowance,
  FORBIDDEN_VERBS,
  OWNER_FORBIDDEN_VERBS,
  RUN_WAIT_BUDGET_MS,
} from "./run-limits.mjs";
import {
  buildTransitionEvent,
  identifyTarget,
  observeScreen,
} from "./explorer-evidence.mjs";
import { sha256Text } from "./scaffold.mjs";
import {
  resolveLocatorConfig,
  locateOnShot,
  pngDimensions,
  defaultLocatorFactories,
  DEFAULT_LOCATOR_TIMEOUT_MS,
} from "./caller-locator.mjs";
import { digest, recordedSelection } from "./capture-selection.mjs";
import { validateCaptureMetadata } from "./capture-metadata.mjs";
import { createLocalTiming } from "./local-timing.mjs";

// The four reversible input kinds the CLI's own pre-dispatch gate authorizes, and the protocol
// method each is recorded as. A drag and a tap are both a click as far as the evidence goes.
// "wait" is the fifth and is not an input at all: nothing is dispatched, so it is recorded under
// its own label -- a change that happened because time passed was not caused by a click.
const RECORDED_METHOD = {
  tap: "click",
  drag: "click",
  type: "type",
  scroll: "scroll",
  wait: "wait",
};
// A screenshot wider than this costs the agent tokens for pixels it does not need, and the browser
// is ours, so the cheapest downscale is never to capture wider in the first place.
export const MAX_VIEWPORT_WIDTH = 1280;

export const TOOLS = [
  {
    name: "observe",
    description:
      "Look at the product: returns a screenshot of the current screen, its address, and how many steps and recorded transitions the run has left. Call it first, and again whenever you are unsure what is on screen. Pass record_previous: true to keep the pending transition from the last act first and then look at the already-cached screen in one call (an explicit save plus the cached view, not a fresh capture); without it, an unrecorded act still needs a separate record call.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "only on the first call, and only if the server was started without a URL",
        },
        record_previous: {
          type: "boolean",
          description:
            "when true, record the pending transition before observing; refuses without starting a browser when nothing is pending",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "act",
    description:
      'Do one thing on the screen: give an instruction and a short noun phrase naming the target ("the blue Sign up button top right"), never a CSS selector. The installed server uses Midscene to locate tap, type and drag targets on the last observed screenshot: omit coordinate and drop_coordinate for those actions. For scroll only, an optional coordinate selects the content pane. Explicit programmatic legacy mode requires coordinates for tap, type and drag. For screens that move on by themselves, wait lets a few seconds pass and needs no target; immediately after a stale-screen refusal only, wait with refresh true takes one immediate fresh look instead of waiting. Returns what the screen did.',
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["tap", "type", "scroll", "drag", "wait"],
        },
        instruction: {
          type: "string",
          description: "one action, plain English",
        },
        target: {
          type: "string",
          description:
            "noun phrase for the thing to point at; not needed for wait",
        },
        direction: {
          type: "string",
          enum: ["up", "down"],
          description:
            "required for scroll; sends a 600-pixel wheel input over coordinate when supplied, otherwise at the current pointer",
        },
        coordinate: {
          type: "object",
          description:
            "For scroll, an optional point inside the visible content pane. Omit for tap, type and drag: the installed server locates those targets and refuses caller coordinates. Required for those actions only in explicit programmatic legacy mode.",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x", "y"],
          additionalProperties: false,
        },
        text: { type: "string", description: "for type only: what to type" },
        drop_target: {
          type: "string",
          description: "for drag only: where it lands",
        },
        drop_coordinate: {
          type: "object",
          description:
            "Omit on the installed server, which locates drop_target itself. Required for drag only in explicit programmatic legacy mode.",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x", "y"],
          additionalProperties: false,
        },
        refresh: {
          type: "boolean",
          description:
            "For wait only, immediately after a stale-screen refusal: true takes one fresh look through the ordinary wait path with no requested sleep instead of waiting. Refused on any other action, without a stale refusal behind it, or twice in a row without a successful input between.",
        },
      },
      required: ["action", "instruction"],
      additionalProperties: false,
    },
  },
  {
    name: "record",
    description:
      "Keep the transition the last act produced as evidence in the map. Call it after every act whose result you believe -- an act that is not recorded never happened as far as the map is concerned.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description:
      "Stop exploring, package the evidence and render the map. Returns the candidate directory and the path of map.html.",
    inputSchema: {
      type: "object",
      properties: {
        why: { type: "string", description: "one sentence: why you stopped" },
        goal_screenshots: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description:
            "Ordered screenshot paths from recorded observations showing the requested goal; may precede the final screen. Requires goal_reached: true.",
        },
        goal_reached: {
          type: "boolean",
          description:
            "compatibility claim only when the run was given a goal: true claims recorded evidence shows it; false says it was not reached",
        },
      },
      additionalProperties: false,
    },
  },
];

const text = (value) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});
const toolError = (message) => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

// Everything about WHAT may be dispatched. The action vocabulary is the protocol's own
// (lib/explorer-protocol.mjs ACTION_TYPES, after tap/drag fold into "click"); whether the dispatch
// is allowed right now is checkActionAuthorized's call, imported from the CLI loop unchanged.
export function validateAct(args, { locatorEnabled = false } = {}) {
  const method = RECORDED_METHOD[args?.action];
  // A wait points at nothing and dispatches nothing, so it is not in the protocol's input
  // vocabulary and needs no target -- everything else still is, and still does.
  if (!method || (method !== "wait" && !ACTION_TYPES.has(method)))
    return `unsupported action ${args?.action}`;
  if (typeof args.instruction !== "string" || !args.instruction.trim())
    return "instruction is required";
  if (
    method !== "wait" &&
    (typeof args.target !== "string" || !args.target.trim())
  )
    return "target noun phrase is required";
  if (args.action === "type" && (typeof args.text !== "string" || !args.text))
    return "a type action needs the text to type";
  if (
    args.action === "drag" &&
    (typeof args.drop_target !== "string" || !args.drop_target)
  )
    return "a drag action needs drop_target, the noun phrase for where it lands";
  // One immediate refresh after a stale-screen refusal, wait only: a non-boolean flag or
  // any non-wait action refuses here, before a step is spent. Whether a stale refusal is
  // actually behind the request (and the one refresh not already spent) is runtime state,
  // so act() refuses that below -- never by silently running an ordinary wait instead.
  if (args.refresh !== undefined) {
    if (typeof args.refresh !== "boolean")
      return 'refresh must be a boolean: true requests one immediate fresh look, and only with action "wait" immediately after a stale-screen refusal';
    if (args.action !== "wait")
      return 'refresh is only valid with action "wait" immediately after a stale-screen refusal';
  }
  if (args.action === "scroll" && !["up", "down"].includes(args.direction))
    return 'a scroll action needs direction "up" or "down"';
  // Locator mode owns pointing for tap, type and drag: a caller coordinate there is
  // refused loudly, never silently used nor silently used as a fallback. Scroll keeps
  // its optional caller pane point in either mode.
  if (
    locatorEnabled &&
    ["tap", "type", "drag"].includes(args.action) &&
    (args.coordinate != null || args.drop_coordinate != null)
  )
    return "this server locates targets itself (RELEASHED_LOCATOR=midscene): omit coordinate and drop_coordinate and name the target noun phrase only";
  const callerPointed = !locatorEnabled || args.action === "scroll";
  if (
    callerPointed &&
    (["tap", "type", "drag"].includes(args.action) ||
      (args.action === "scroll" && args.coordinate != null)) &&
    (!args.coordinate ||
      !Number.isFinite(args.coordinate.x) ||
      !Number.isFinite(args.coordinate.y))
  )
    return `${args.action} needs coordinate { x, y } from the last observe screenshot`;
  if (
    callerPointed &&
    args.action === "drag" &&
    (!args.drop_coordinate ||
      !Number.isFinite(args.drop_coordinate.x) ||
      !Number.isFinite(args.drop_coordinate.y))
  )
    return "a drag action needs drop_coordinate { x, y } from the last observe screenshot";
  return null;
}

function coordinateError(coordinate, name) {
  if (!coordinate) return null;
  if (
    coordinate.x < 0 ||
    coordinate.x >= MAX_VIEWPORT_WIDTH ||
    coordinate.y < 0 ||
    coordinate.y >= 800
  )
    return `${name} must be inside the last observe screenshot (0 ≤ x < ${MAX_VIEWPORT_WIDTH}, 0 ≤ y < 800)`;
  return null;
}

// Real Chromium, the same boundary the CLI installs. Replaced by a stub in tests.
export async function launchBoundBrowser(
  entryUrl,
  {
    viewport,
    savedSessionPath = null,
    mine = false,
    measure = (_name, work) => work(),
  } = {},
) {
  const { chromium } = await import("playwright");
  const { installActionBoundary } = await import(
    "../scripts/vision-explorer-spike.mjs"
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
  const browser = await measure("browser.launch", () =>
    chromium.launch({ headless: true }),
  );
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const cdp = await installActionBoundary(context, page, boundary);
    await cdp.send("Accessibility.enable").catch(() => {});
    if (savedSessionPath) {
      // The session the user saved with `releashed login`, applied by the same code `map --login`
      // uses; it also refuses to continue when the landing page still looks like a sign-in wall.
      const { loadSavedSession } = await import(
        "../scripts/vision-explorer-run.mjs"
      );
      await measure("browser.session_load", () =>
        loadSavedSession(page, cdp, entryUrl, savedSessionPath),
      );
    } else {
      await measure("navigation.entry", () =>
        page.goto(entryUrl, { waitUntil: "networkidle" }),
      );
      await measure("wait.entry", () => page.waitForTimeout(3_000));
    }
    return { page, cdp, boundary, close: () => browser.close() };
  } catch (error) {
    await measure("browser.cleanup", () => browser.close()).catch(() => {});
    throw error;
  }
}

export function createExplorer({
  url = null,
  steps = 40,
  imageOutput = "inline",
  runsRoot,
  outputRoot,
  savedSessionPath = null,
  // Owner mode: the run may use the product like a user (send, post, submit, reply); pay, delete
  // and money-shaped paths (billing, checkout, subscribe, ...) still refuse either way.
  mine = false,
  // Capture mode (S-5), owner-only and never in discovery: `goal` is the one standing objective in
  // the caller's own words, handed back on every observe so it is in front of the agent each turn;
  // `policy` is how to behave on the way, conduct only. Both null is the source-blind run this
  // server has always served, and nothing below is reachable without a goal.
  goal = null,
  policy = null,
  continues = null,
  precondition = null,
  identityLabel = null,
  // Optional absolute acquisition cutoff as ms since epoch (CLI --acquire-until ISO).
  // Preparation and authentication count against it; it is never reset by browser startup.
  // After it passes, new act (including wait) refuses before dispatch, while pending record,
  // necessary current evidence and finish/seal/cleanup stay available.
  acquireUntil = null,
  // Server-side target locator (see lib/caller-locator.ts). `locator` is a resolved
  // resolveLocatorConfig value; null resolves from the process environment, so
  // RELEASHED_LOCATOR=midscene plus MIDSCENE_MODEL_* opts the server in with no
  // code change. `createLocatorAgent` and `createScreenshotItem` inject the Midscene
  // agent and screenshot factories (tests); `locatorTimeoutMs` caps one locate call
  // before the acquisition budget does.
  locator = undefined,
  createLocatorAgent = null,
  createScreenshotItem = null,
  locatorTimeoutMs = DEFAULT_LOCATOR_TIMEOUT_MS,
  launch = launchBoundBrowser,
  resolveSession = null,
  cleanupSession = async () => {},
  timing = createLocalTiming({ outputRoot }),
  now = () => Date.now(),
  // Only injected by the tests; the real one reads the target's own landing page.
  authorPack = authorTargetPack,
  packageRun = packageCandidate,
}) {
  if (!["inline", "paths"].includes(imageOutput))
    throw new Error("imageOutput must be inline or paths");
  if (
    acquireUntil !== null &&
    acquireUntil !== undefined &&
    !Number.isFinite(acquireUntil)
  )
    throw new Error("acquireUntil must be a finite ms timestamp or null");
  const acquireUntilMs = acquireUntil ?? null;
  const acquireUntilIso =
    acquireUntilMs === null ? null : new Date(acquireUntilMs).toISOString();
  const acquireExpired = () =>
    acquireUntilMs !== null && now() >= acquireUntilMs;
  const acquireMsLeft = () =>
    acquireUntilMs === null ? null : Math.max(0, acquireUntilMs - now());
  const acquireSteer = () =>
    acquireUntilMs === null
      ? {}
      : { acquire_until: acquireUntilIso, acquire_ms_left: acquireMsLeft() };
  // Sentinel for the last pre-dispatch recheck: thrown after async target resolution (and the
  // drag-motion import) when the absolute window lapses mid-resolution, before the FIRST browser
  // input. It is distinct from the executor's no-match path so a lapsed window never reads as a
  // grounding miss. Once the first input of an in-flight action has started (click begun, wheel
  // sent, drag motion started, wait commenced, text insertion begun) that action runs to
  // completion and stays recordable, so a started gesture is never stranded half-done.
  class CutoffExpiredError extends Error {}
  // Locator-mode sentinels. A stale screen or an unlocatable target dispatches nothing;
  // both are honest caller-visible messages, never a coordinate fallback.
  class StaleObservationError extends Error {}
  class LocateMissError extends Error {
    constructor(kind, target, detail) {
      super(`${kind}: ${target}: ${detail}`);
      this.kind = kind;
      this.target = target;
    }
  }
  // Explicit locator configuration: an operator who opts in but misconfigures gets a
  // loud construction failure naming the missing piece, never a silent return to
  // caller coordinates.
  const locatorFromEnv = locator === undefined;
  const locatorResolution = locatorFromEnv
    ? resolveLocatorConfig(process.env)
    : locator;
  if (
    locatorFromEnv &&
    (process.env.RELEASHED_LOCATOR ?? "").trim() &&
    !locatorResolution.enabled
  )
    throw new Error(
      `target locator misconfigured: ${locatorResolution.reason}`,
    );
  const locatorEnabled = locatorResolution?.enabled === true;
  const locatorConfig = locatorEnabled ? locatorResolution.config : null;
  // Midscene agent factories load lazily on the first locator act, so the default
  // caller-coordinate server never imports the grounding packages at all. Injected
  // test factories thread through untouched, keeping locate hermetic.
  let locatorFactoriesPromise = null;
  async function locatorFactories() {
    if (createLocatorAgent && createScreenshotItem)
      return { createAgent: createLocatorAgent, createScreenshotItem };
    const defaults = await (locatorFactoriesPromise ??=
      defaultLocatorFactories());
    return {
      createAgent: createLocatorAgent ?? defaults.createAgent,
      createScreenshotItem:
        createScreenshotItem ?? defaults.createScreenshotItem,
    };
  }
  // The observation the next dispatch must still match: exact observed bytes, their
  // pixel dimensions, the CSS viewport inputs dispatch in, and the sealed hash.
  // An unusable observation is stale, never a reason to point blindly.
  function observedShot() {
    const viewport =
      typeof state.session?.page.viewportSize === "function"
        ? state.session.page.viewportSize()
        : null;
    const dims = pngDimensions(state.current.png);
    if (!viewport || !dims)
      throw new StaleObservationError(
        "the last observation has no usable screenshot dimensions; call observe again before acting.",
      );
    return {
      png: state.current.png,
      width: dims.width,
      height: dims.height,
      cssWidth: viewport.width,
      cssHeight: viewport.height,
      sha256: state.current.evidence.screenshot_sha256,
    };
  }
  // Locate one noun phrase on the observed bytes for dispatch. Any failure throws
  // before the first browser input: a located point past the cutoff is discarded,
  // never dispatched ("no orphan locator actions after deadline").
  async function locateForDispatch(shot, target) {
    const msLeft = acquireMsLeft();
    const budget =
      msLeft === null ? locatorTimeoutMs : Math.min(locatorTimeoutMs, msLeft);
    if (budget <= 0) throw new CutoffExpiredError();
    const outcome = await timing.span("grounding.locate", async () =>
      locateOnShot(await locatorFactories(), state.session.page, shot, target, {
        timeoutMs: budget,
      }),
    );
    if (!outcome.ok) {
      if (outcome.kind === "stale-shot")
        throw new StaleObservationError(
          `the observed screen no longer matches what was located: ${outcome.detail} Call observe again before acting.`,
        );
      if (acquireExpired()) throw new CutoffExpiredError();
      throw new LocateMissError(outcome.kind, target, outcome.detail);
    }
    return outcome;
  }
  // Same-URL staleness: the address can stay while the pixels move (a countdown, a
  // carousel, a re-render), which the URL check cannot see. Re-capture immediately
  // before the first input and require the exact observed bytes; anything else --
  // including an unreadable re-capture -- refuses as stale with the step refunded.
  async function reverifyObservation(beforeUrl, beforeHash) {
    if (state.session.page.url() !== beforeUrl)
      throw new StaleObservationError(
        "the screen changed while the target was being located; call observe again before acting.",
      );
    const reverified = await timing.span("grounding.reverify", () =>
      state.session.page.screenshot().catch(() => null),
    );
    if (!reverified || digest(reverified) !== beforeHash)
      throw new StaleObservationError(
        "the screen changed since it was observed; call observe again before acting.",
      );
  }
  const cutoffRefusal = () =>
    toolError(
      `acquisition window expired at ${acquireUntilIso}; no new act was dispatched, including wait. ` +
        (state.pending
          ? "A pending act is still recordable: call record to keep it, then finish to package. "
          : "Call finish to package what was recorded. ") +
        "The run is retained; record, observe for necessary current evidence, finish, seal and cleanup remain available. " +
        "Actions already in flight when the cutoff passes may finish so a started gesture is not stranded; only new dispatches refuse.",
    );
  const runId = `explore-${new Date(now())
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}`;
  const runDir = join(resolve(runsRoot), runId, "target-session-1");
  const declarationPath = join(
    resolve(outputRoot),
    "preparations",
    `${timing.attemptId}.json`,
  );
  timing.bindRun(runId);
  let metadataValidated = false;
  let sessionResolved = false;
  let authenticationFailure = null;
  let browserStartupFailure = null;
  let callQueue = Promise.resolve();
  let closing = null;
  let declarationWritten = false;
  const state = {
    entryUrl: url,
    session: null,
    current: null,
    pending: null,
    events: [],
    blocked: [],
    stateIndex: 0,
    stepsUsed: 0,
    // The breaker's streak, and how much of the run's total waiting time is already spent.
    noEffectStreak: 0,
    waitedMs: 0,
    // Stale-screen recovery episode: a refused input arms it, one immediate wait refresh
    // spends it, and only a successful non-wait input (tap/type/drag/scroll) closes it.
    // Ordinary waits never close it: a repeated refusal while it is spent routes to an
    // ordinary wait instead of a free refresh loop.
    staleArmed: false,
    staleRefreshSpent: false,
    startedAt: now(),
    finished: null,
    walled: null,
  };

  async function open(firstUrl) {
    // Do this before a browser (and therefore before a saved session) is opened.
    if (!metadataValidated) {
      await validateCaptureMetadata({
        goal,
        policy,
        continues,
        precondition,
        identityLabel,
        runsRoot,
        mapsRoot: join(resolve(outputRoot), "maps"),
      });
      metadataValidated = true;
    }
    const entry = firstUrl ?? state.entryUrl;
    if (!entry)
      throw new Error(
        "no URL yet: pass one to observe, or start the server with a URL",
      );
    new URL(entry); // a malformed URL is a caller error, thrown before a browser is launched
    state.entryUrl = entry;
    await mkdir(join(runDir, "screenshots"), { recursive: true });
    if (goal && !declarationWritten) {
      // This is caller-authored provenance, not telemetry or proof of external account readiness.
      // Persist it before auth even when the caller forgot to create a separate request record.
      await timing.span("preparation.declaration", async () => {
        await mkdir(join(resolve(outputRoot), "preparations"), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(
          declarationPath,
          JSON.stringify(
            {
              schema_version: 1,
              run_id: runId,
              attempt_id: timing.attemptId,
              recorded_at: new Date().toISOString(),
              identity_label: identityLabel,
              precondition,
              basis:
                "Caller declaration recorded before authentication; external readiness is not verified by this file.",
              external_preparation_timing: null,
            },
            null,
            2,
          ) + "\n",
          { flag: "wx", mode: 0o600 },
        );
      });
      declarationWritten = true;
    }
    if (authenticationFailure) throw authenticationFailure;
    if (!sessionResolved && resolveSession) {
      try {
        savedSessionPath = await timing.span("authentication", resolveSession);
        sessionResolved = true;
      } catch (error) {
        authenticationFailure = error;
        throw error;
      }
    }
    // The authentication span above is async: recheck the absolute window before launching a
    // browser. An expiry here starts no browser; task-owned session cleanup still runs via
    // close(), so a freshly minted session is never leaked. This is not a browser-startup
    // failure and sets no such marker.
    if (acquireExpired() && !state.session)
      throw new Error(
        `acquisition window expired at ${acquireUntilIso} after authentication and before browser launch; no browser was launched. ` +
          `End this server, complete task-owned session cleanup via close, and stop honestly within the original outer deadline. ` +
          `Do not reset the cutoff or reserve. No new evidence was captured.`,
      );
    try {
      state.session = await timing.span("browser.startup", () =>
        launch(entry, {
          viewport: { width: MAX_VIEWPORT_WIDTH, height: 800 },
          ...(savedSessionPath ? { savedSessionPath } : {}),
          mine,
          measure: timing.span,
        }),
      );
    } catch (error) {
      browserStartupFailure = new Error(
        `${error?.message ?? String(error)}\nBrowser startup failed; no new evidence was captured. ` +
          "Retain these diagnostics, end this server, complete task-owned session cleanup, and repair the startup failure before a new prepared attempt. This attempt will not launch again.",
      );
      throw browserStartupFailure;
    }
  }

  async function snapshot() {
    state.stateIndex += 1;
    const { page, cdp } = state.session;
    state.current = await timing.span("observation", () =>
      observeScreen(page, cdp, runDir, state.stateIndex, true, timing.span),
    );
    // Immutable acquisition timestamp from the injected clock: the sealed date of this
    // observation. File mtimes and the finish clock can never move it afterwards.
    state.current.evidence.observed_at = new Date(now()).toISOString();
    return state.current;
  }

  async function observe(args = {}) {
    if (state.finished)
      return toolError("this run is finished; its map is already packaged");
    if (browserStartupFailure) throw browserStartupFailure;
    // Combined keep-and-look: an explicit save of the pending transition, then the ordinary
    // cached view below -- the screenshot act already took, not a fresh capture. Only a boolean
    // true records; false or omitted keeps the old look-only behavior, and any other value
    // refuses before any write or browser start. A record error (notably nothing pending)
    // propagates unchanged, so a refused keep never starts a browser.
    let recorded = null;
    if (args.record_previous !== undefined && args.record_previous !== false) {
      if (args.record_previous !== true)
        return toolError(
          "record_previous must be a boolean: true keeps the pending transition before looking; false or omitted just looks",
        );
      const kept = await record();
      if (kept.isError) return kept;
      recorded = JSON.parse(kept.content[0].text).recorded;
    }
    if (!state.session) {
      // An expired absolute window before first observation starts no login: honest failure.
      if (acquireExpired())
        return toolError(
          `acquisition window expired at ${acquireUntilIso}; no authentication or browser was started. ` +
            `End this server, complete task-owned session cleanup, and stop honestly within the original outer deadline. ` +
            `Do not reset the cutoff or reserve. No new evidence was captured.`,
        );
      await open(args.url);
      await snapshot();
      const entryWall = detectWall(
        state.current.evidence.url,
        state.current.evidence.visible_state_summary,
        { entry: true },
      );
      if (entryWall) {
        state.walled = entryWall.reason;
        state.blocked.push({
          instruction: "open the product",
          target: null,
          transition_kind: "unknown-terminal",
          reason: entryWall.reason,
        });
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
              // The standing objective, repeated every turn rather than only at the start -- this
              // is the whole of "the goal is in the brief" when the brief is the agent's own head.
              ...(goal ? { goal, ...(policy ? { policy } : {}) } : {}),
              address: state.current.evidence.url,
              ...(goal || imageOutput === "paths"
                ? { screenshot_path: state.current.evidence.screenshot_path }
                : {}),
              ...(imageOutput === "paths"
                ? {
                    image_path: join(
                      runDir,
                      state.current.evidence.screenshot_path,
                    ),
                  }
                : {}),
              steps_used: state.stepsUsed,
              steps_left: Math.max(0, steps - state.stepsUsed),
              transitions_recorded: state.events.length,
              unrecorded_act: Boolean(state.pending),
              ...(recorded ? { recorded } : {}),
              ...(state.walled ? { wall: state.walled } : {}),
              ...acquireSteer(),
            },
            null,
            2,
          ),
        },
        // NO output schema on this tool, so the client renders this as an image.
        ...(imageOutput === "inline"
          ? [
              {
                type: "image",
                data: state.current.png.toString("base64"),
                mimeType: "image/png",
              },
            ]
          : []),
      ],
    };
  }

  async function act(args = {}) {
    if (state.finished)
      return toolError("this run is finished; its map is already packaged");
    if (!state.session || !state.current)
      return toolError("call observe first: nothing has been looked at yet");
    if (state.stepsUsed >= steps)
      return toolError(
        `the step budget of ${steps} is spent -- call finish to package what was seen`,
      );
    // A wall is a finding, and it is terminal: nothing honest is left to try on this product.
    if (state.walled)
      return toolError(`${state.walled} Call finish to package what was seen.`);
    const invalid = validateAct(args, { locatorEnabled });
    if (invalid) return toolError(invalid);
    const coordinateProblem =
      coordinateError(args.coordinate, "coordinate") ??
      coordinateError(args.drop_coordinate, "drop_coordinate");
    if (coordinateProblem) return toolError(coordinateProblem);
    // Absolute acquisition cutoff: refuse NEW dispatch (including wait) before anything
    // is sent, but never block a pending record, necessary current evidence or finish.
    // Preparation cannot reset this budget: it is compared against the injected wall clock.
    if (acquireExpired()) return cutoffRefusal();

    const { page, boundary } = state.session;
    // A wait is not an input: nothing is dispatched, no request crosses the action boundary, and
    // the pre-dispatch gate has nothing to authorize -- so it skips the gate rather than being
    // refused by it. It still costs a step and still runs the wall check below, so waiting can
    // never be a way to sit out a bot check or a rate limit.
    const waiting = args.action === "wait";
    // An immediate passive refresh: the same wait path below with no requested sleep, valid
    // only once per stale-screen episode. It bypasses the wait-budget gate (it sleeps nothing
    // and charges nothing) but never the acquisition cutoff, the wall, or the pending record.
    const refreshing = waiting && args.refresh === true;
    const waitMs = waiting && !refreshing ? waitAllowance(state.waitedMs) : 0;
    if (refreshing) {
      // Invalid refresh requests dispatch nothing and spend no step -- and never fall back
      // to an ordinary wait silently, which would charge sleep the caller did not ask for.
      if (state.pending)
        return toolError(
          "a transition is already pending: call record (or observe with record_previous: true) to keep it before requesting a refresh, so the refresh never overwrites evidence",
        );
      if (!state.staleArmed)
        return toolError(
          'refresh is only valid immediately after a stale-screen refusal: call act with action "wait" without refresh for an ordinary wait',
        );
      if (state.staleRefreshSpent)
        return toolError(
          'the one immediate refresh for this stale screen is spent: call act with action "wait" without refresh to let the screen settle',
        );
      if (acquireExpired()) return cutoffRefusal();
    }
    if (waiting && !refreshing && waitMs === 0) {
      state.stepsUsed += 1;
      return text(
        `A run may wait ${RUN_WAIT_BUDGET_MS / 1000} seconds in total and this one has used all of it. Waiting again will not work -- do something else on the screen, or call finish.`,
      );
    }
    const decision = {
      action: args.action,
      instruction: args.instruction,
      target: args.target ?? null,
      coordinate: args.coordinate ?? null,
      direction: args.direction ?? null,
      text: args.text ?? null,
      drop_target: args.drop_target ?? null,
      drop_coordinate: args.drop_coordinate ?? null,
    };
    // The same pre-dispatch gate the CLI runs, read-only forced on: four reversible input kinds,
    // on the product's own origin, and never a contact detail or a password typed into it. Owner
    // mode shrinks the forbidden-verb list and adds the money/destruction-destination check.
    const authorized = waiting
      ? { authorized: true, reason: null }
      : checkActionAuthorized(decision, boundary.origins, page.url(), true, {
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
      return text(
        `${authorized.reason} Nothing was dispatched. Find something else on screen.`,
      );
    }

    const before = state.current.evidence;
    const mutationsBefore = boundary.sameOriginMutations;
    let identified = { tier: "positional", ref: null };
    state.stepsUsed += 1;
    if (waiting) {
      // No async target resolution precedes a wait, but recheck at this last boundary anyway
      // so a window that lapsed since the entry check dispatches nothing. Cutoff refusals
      // consume no step, matching the entry check.
      if (acquireExpired()) {
        state.stepsUsed -= 1;
        return cutoffRefusal();
      }
      if (refreshing) {
        // Immediate means immediate: the shared snapshot below takes the fresh look, no
        // requested sleep is slept, and no waited time is charged. The episode stays open
        // (spent, not closed) until a real successful input (tap/type/drag/scroll) lands,
        // never another wait.
        state.staleRefreshSpent = true;
      } else {
        state.waitedMs += waitMs;
        await timing.span("wait.requested", () => page.waitForTimeout(waitMs));
      }
    } else {
      try {
        await timing.span("action.dispatch", async () => {
          // Last pre-dispatch recheck per action, after every async resolution (target
          // lookup, drag-motion import) and before the FIRST browser input. Once that input
          // starts the in-flight action runs to completion and stays recordable.
          // Locator mode resolves the dispatch point here, on the exact bytes the last
          // observe returned: the caller named the target, the runtime points at it, and
          // any locate failure below dispatches nothing and is never a coordinate fallback.
          let point = decision.coordinate;
          let dropPoint = decision.drop_coordinate;
          if (locatorEnabled && ["tap", "type", "drag"].includes(args.action)) {
            const shot = observedShot();
            const located = await locateForDispatch(shot, decision.target);
            point = { x: located.x, y: located.y };
            if (args.action === "drag") {
              const dropLocated = await locateForDispatch(
                shot,
                decision.drop_target ?? "",
              );
              dropPoint = { x: dropLocated.x, y: dropLocated.y };
            }
            // Bind the located points to the observation they were found on: the
            // page must still show those exact bytes before the first input.
            await reverifyObservation(before.url, before.screenshot_sha256);
          }
          if (args.action === "tap") {
            const { x, y } = point;
            identified = await identifyTarget(page, state.current.refs, x, y);
            if (acquireExpired()) throw new CutoffExpiredError();
            await page.mouse.click(x, y);
          } else if (args.action === "type") {
            const { x, y } = point;
            identified = await identifyTarget(page, state.current.refs, x, y);
            if (acquireExpired()) throw new CutoffExpiredError();
            await page.mouse.click(x, y);
            await page.keyboard.insertText(decision.text);
          } else if (args.action === "scroll") {
            if (acquireExpired()) throw new CutoffExpiredError();
            if (point) await page.mouse.move(point.x, point.y);
            await page.mouse.wheel(0, args.direction === "down" ? 600 : -600);
          } else if (args.action === "drag") {
            const { x, y } = point;
            identified = await identifyTarget(page, state.current.refs, x, y);
            const { ourDragMotion } = await import(
              "../scripts/vision-explorer-spike.mjs"
            );
            if (acquireExpired()) throw new CutoffExpiredError();
            await ourDragMotion(page, { x, y }, dropPoint);
          } else {
            throw new Error(`unsupported action ${args.action}`);
          }
        });
      } catch (error) {
        if (error instanceof CutoffExpiredError) {
          state.stepsUsed -= 1;
          return cutoffRefusal();
        }
        if (locatorEnabled) {
          // A stale screen spent no input: the step is refunded so the caller can
          // refresh (or wait) and retry on fresh bytes. Misses stay spent -- an
          // attempted instruction on a fresh screen is a real attempt.
          if (error instanceof StaleObservationError) {
            state.stepsUsed -= 1;
            // Arm (never disarm) the recovery episode: a repeat refusal while the one
            // refresh is spent keeps it spent, so staleness cannot mint free refreshes.
            // Only a successful non-wait input below closes the episode. The cause keeps
            // its wording minus the bare "observe again" instruction: observe alone would
            // return the same cached bytes, so the refresh (or the ordinary wait) is the
            // route to fresh ones.
            state.staleArmed = true;
            const cause = error.message.replace(
              /;?\s*call observe again before acting\.?/i,
              "",
            );
            if (!state.staleRefreshSpent)
              return text(
                `${cause} Nothing was dispatched. Call act with action "wait" and refresh true for one immediate fresh look, then observe with record_previous true to keep it and see the new screen.`,
              );
            return text(
              `${cause} Nothing was dispatched. The immediate refresh for this screen is spent: call act with action "wait" without refresh to let the screen settle, then observe with record_previous true to keep it and see the new screen.`,
            );
          }
          if (error instanceof LocateMissError) {
            const why =
              error.kind === "timeout"
                ? `locating "${error.target}" timed out`
                : error.kind === "out-of-bounds"
                  ? `the locator placed "${error.target}" outside the observed screen`
                  : `Nothing on screen matched "${error.target}"`;
            return text(
              `${why}, so nothing was done. Try a different phrase, or a different control.`,
            );
          }
          throw error;
        }
        // The executor refused to guess a coordinate, so no input was dispatched. An attempted
        // instruction is not evidence.
        return text(
          `Nothing on screen matched "${decision.target}", so nothing was done. Try a different phrase, or a different control.`,
        );
      }
      await timing.span("wait.settle", () => page.waitForTimeout(1_500));
    }

    if (!onBoundOrigin(page.url(), boundary.origins)) {
      const reason = `"${decision.instruction}" led off the product's own site; the run did not follow it.`;
      state.blocked.push({
        instruction: decision.instruction,
        target: decision.target,
        transition_kind: "unknown-terminal",
        reason,
      });
      await timing.span("navigation.restore", () =>
        page.goto(before.url, { waitUntil: "domcontentloaded" }),
      );
      await timing.span("wait.restore", () => page.waitForTimeout(1_000));
      await snapshot();
      return text(
        `${reason} You are back where you were. Do not try it again.`,
      );
    }

    const after = (await snapshot()).evidence;
    // A bot check ends the run exactly as it does in the CLI loop -- recorded as a finding, never
    // worked around. The transition that reached it is still recordable, so the wall is in the map.
    const wall = detectWall(after.url, after.visible_state_summary);
    if (wall) {
      state.walled = wall.reason;
      state.blocked.push({
        instruction: decision.instruction,
        target: decision.target,
        transition_kind: "unknown-terminal",
        reason: wall.reason,
      });
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
    // The breaker: a step that changed nothing -- a wait included, since waiting forever is the
    // same failure as clicking forever -- adds to the streak; any step that did something clears
    // it. From three in a row this says so plainly rather than letting the same idea be rephrased.
    state.noEffectStreak =
      state.pending.transition_kind === "solid" ? 0 : state.noEffectStreak + 1;
    // A successful non-wait input (tap/type/drag/scroll) closes any stale-recovery
    // episode: the next stale refusal arms a fresh one with its own single refresh. An
    // ordinary wait only spends time -- it never re-arms a free refresh.
    if (!waiting) {
      state.staleArmed = false;
      state.staleRefreshSpent = false;
    }
    const stuck = noEffectNote(state.noEffectStreak);
    return text({
      screen_changed: state.pending.transition_kind === "solid",
      address: after.url,
      pointed_at: identified.tier,
      ...(stuck ? { stuck } : {}),
      ...(wall ? { wall: wall.reason } : {}),
      ...acquireSteer(),
      next: wall
        ? "call record to keep this transition, then finish: a wall is a finding, not something to get around"
        : "call observe with record_previous: true to keep this transition and see the new screen in one step (or call record to keep it, then observe separately)",
    });
  }

  async function record() {
    if (state.finished)
      return toolError("this run is finished; its map is already packaged");
    if (!state.pending) return toolError("nothing to record: call act first");
    const event = state.pending;
    state.pending = null;
    state.events.push(event);
    await timing.span("evidence.write", () =>
      writeFile(
        join(runDir, "observations.jsonl"),
        `${JSON.stringify(event)}\n`,
        { flag: "a", mode: 0o600 },
      ),
    );
    return text({
      recorded: event.event_id,
      ...(goal
        ? {
            before_screenshot: event.before.screenshot_path,
            after_screenshot: event.after.screenshot_path,
          }
        : {}),
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
  async function sweepUnreferencedScreenshots(keepExtra = []) {
    const keep = new Set(keepExtra);
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

  // The one blocked-screen selection for a nonzero-action blocked finish, shared by the
  // pre-finish refusal, the sealed sidecar marker and the finish response, so the three can
  // never disagree. A blocked finish must bind the ACTUAL observed wall: the current screen
  // when the trace retains it, or an equivalent unrecorded repeat of the last recorded
  // screen (same image bytes AND same address -- a wait that changed nothing). A current
  // screen that differs is not evidence yet: the caller must record it first, so this
  // returns an actionable error instead of blessing a stale screen as the blocked wall.
  // Returns null when this is not a nonzero-action blocked finish at all.
  function selectNonzeroBlockedShot({
    why: wallReason,
    unreached: wallUnreached,
    selected: wallSelected,
  }) {
    if (!goal || !wallUnreached || wallSelected || state.events.length === 0)
      return null;
    if (typeof wallReason !== "string" || !wallReason.trim()) return null;
    const retained = new Set();
    for (const event of state.events) {
      if (event.before?.screenshot_path)
        retained.add(event.before.screenshot_path);
      if (event.after?.screenshot_path)
        retained.add(event.after.screenshot_path);
    }
    const current = state.current?.evidence;
    if (current?.screenshot_path && retained.has(current.screenshot_path))
      return { shot: current };
    const last = state.events[state.events.length - 1]?.after;
    if (
      current?.screenshot_sha256 &&
      last?.screenshot_path &&
      retained.has(last.screenshot_path) &&
      current.screenshot_sha256 === last.screenshot_sha256 &&
      current.url === last.url
    )
      return { shot: last };
    return {
      error:
        "the current screen is not recorded, so it cannot back a blocked finish: call record to keep what this screen shows, then call finish again with goal_reached: false",
    };
  }

  // The sidecars the packager and the renderer read beside the trace. There is no cost line: option
  // D spends none of our tokens and cannot count the agent's.
  async function writeSidecars(
    why,
    publicPackSha256,
    claimed = null,
    selected = null,
    unreached = false,
  ) {
    // The sealed wall image for a blocked finish, so the packager, renderer stop annotation and
    // report can verify it against the manifest. Zero-action runs name the single observed wall
    // screenshot; nonzero blocked runs name the actual observed wall bound to the trace by
    // selectNonzeroBlockedShot. Never a transition, never a success claim.
    // observed_at is the immutable acquisition stamp from snapshot(), never file mtime.
    const nonzeroBlockedShot =
      selectNonzeroBlockedShot({ why, unreached, selected })?.shot ?? null;
    let blockedMarker = null;
    const blockedShot =
      state.events.length === 0 ? state.current?.evidence : nonzeroBlockedShot;
    if (blockedShot?.screenshot_path) {
      try {
        const bytes = await readFile(join(runDir, blockedShot.screenshot_path));
        if (bytes.length && digest(bytes) === blockedShot.screenshot_sha256) {
          blockedMarker = {
            reason:
              state.events.length === 0
                ? typeof why === "string" && why.trim()
                  ? why.trim()
                  : null
                : typeof why === "string"
                  ? why.trim()
                  : "",
            screenshot_path: blockedShot.screenshot_path,
            screenshot_sha256: blockedShot.screenshot_sha256 ?? null,
            observed_at: blockedShot.observed_at ?? null,
            url: blockedShot.url ?? null,
          };
          if (
            !blockedMarker.reason ||
            !blockedMarker.screenshot_sha256 ||
            !blockedMarker.observed_at
          )
            blockedMarker = null;
        }
      } catch {
        blockedMarker = null;
      }
    }
    // With no goal this is exactly what it always was: finished, or walled. With one, the run has
    // to answer the question it was asked -- reached at this step, or not reached and here is
    // where it got to instead. A wall stays a wall either way; it just also says it fell short.
    const free = state.walled
      ? { stop_reason: "wall", reason: state.walled }
      : {
          stop_reason: "explorer_finished",
          reason: why ?? "The agent driving this run said it was finished.",
        };
    const stop = goal
      ? claimed && !state.walled
        ? {
            stop_reason: "goal_claimed",
            reason: `Claimed at step ${state.stepsUsed}. ${why ?? "The agent said it was looking at the goal."}`,
          }
        : {
            stop_reason: state.walled ? "wall" : "goal_not_reached",
            reason: `${selected ? "Goal evidence was selected earlier." : "The goal was not reached."} ${free.reason} The last screen it stood on was ${state.current?.evidence.url ?? state.entryUrl}.`,
          }
      : free;
    await writeFile(
      join(runDir, "explorer-result.json"),
      `${JSON.stringify(
        {
          status: "done",
          stop_reason: stop.stop_reason,
          reason: stop.reason,
          auth_mode: savedSessionPath ? "saved-session" : "public",
          identity_label: identityLabel ?? null,
          ...(goal
            ? {
                directed_by: goal,
                ...(selected
                  ? {
                      goal_screenshots: selected.map(
                        (item) => item.screenshot_path,
                      ),
                    }
                  : {}),
                ...(policy ? { policy } : {}),
                ...(continues ? { continues } : {}),
                ...(precondition ? { precondition } : {}),
                ...(stop.stop_reason === "goal_claimed"
                  ? {
                      goal_claimed_at_step: state.stepsUsed,
                      goal_screenshot_path:
                        selected?.[0]?.screenshot_path ??
                        state.current?.evidence.screenshot_path ??
                        null,
                    }
                  : {}),
              }
            : {}),
          decisions: state.events.length,
          unexecutable_instructions: [],
          blocked_actions: state.blocked,
          finished_at: new Date().toISOString(),
          // Blocked evidence: the sealed wall screenshot, so the packager, renderer stop
          // annotation and report can verify it against the manifest. Zero-action runs name
          // the single observed wall screenshot; nonzero blocked runs name the actual
          // observed wall bound to the trace (see selectNonzeroBlockedShot). Never a
          // transition, never a success claim.
          // observed_at is the immutable acquisition stamp from snapshot(), never file mtime.
          ...(blockedMarker ? { blocked: blockedMarker } : {}),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(runDir, "request-events.jsonl"),
      (state.session?.boundary.events ?? [])
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(""),
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
          // Locator mode grounds the caller's noun phrase on the observed bytes
          // through the operator's own configured model; coordinate mode keeps the
          // historical null (the coding agent supplies visible coordinates).
          grounding_model: locatorEnabled
            ? `midscene aiLocate on the observed screenshot bytes (${locatorConfig.modelName}); the caller names the target`
            : null,
          browser: {
            active_seconds: Number(
              ((now() - state.startedAt) / 1000).toFixed(3),
            ),
            actions: state.events.length,
            requests_seen_by_action_boundary: boundary?.total ?? 0,
            mutating_requests_allowed: boundary?.allowed ?? 0,
            same_origin_mutating_requests: boundary?.sameOriginMutations ?? 0,
            requests_refused_by_action_boundary: boundary?.refused.length ?? 0,
          },
          action_boundary: {
            installed:
              "raw CDP Fetch.requestPaused, attached before the executor",
            // "owner" when the run was started with --mine, "stranger" otherwise -- see
            // docs/CONTROL-SURFACE.md.
            mode: mine ? "owner" : "stranger",
            refused: (boundary?.refused ?? []).map((item) => ({
              method: item.method,
              reason: item.reason,
            })),
          },
          // The coding agent supplies visible coordinates. We make no model call and cannot see
          // what its own turns cost its user. In locator mode the server additionally
          // grounds each target through the operator's configured model at unknown cost.
          model_cost_eur: null,
          model_cost_basis: locatorEnabled
            ? {
                covers:
                  "server-side target grounding per act; the coding agent drives",
              }
            : {
                covers: "nothing: the coding agent drives and grounds this run",
              },
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
          observed_transitions: state.events.filter(
            (event) => event.transition_kind === "solid",
          ).length,
          no_effect_actions: state.events.filter(
            (event) => event.transition_kind === "none",
          ).length,
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
          non_publishable_reasons:
            state.events.length > 0 ? [] : ["no transition was recorded"],
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
    if (browserStartupFailure) throw browserStartupFailure;
    if (state.events.length === 0) {
      // Observation-only blocked finish. A wall on the first screen leaves no dispatched
      // action and no transition -- but the observed wall screenshot is real evidence, so an
      // explicit unreached-wall claim flows through the normal sealed path below instead of
      // forcing a fake wait/record round-trip. The gate is exact: zero recorded events, zero
      // spent steps, and no unrecorded act pending. A dispatched-but-unrecorded act, or any
      // spent step, can never slip through as a zero-action finish. Anything else (no
      // observation yet, or any claim but an explicit unreached wall) keeps the refusal.
      const observed = state.current?.evidence;
      const wallWhy = typeof args.why === "string" ? args.why.trim() : "";
      if (
        args.goal_reached !== false ||
        !wallWhy ||
        !observed?.screenshot_path ||
        state.stepsUsed !== 0 ||
        state.pending
      ) {
        return toolError(
          "nothing was recorded, so there is no map to package: act and record first",
        );
      }
      try {
        const bytes = await readFile(join(runDir, observed.screenshot_path));
        if (!bytes.length || digest(bytes) !== observed.screenshot_sha256)
          throw new Error("unreadable");
      } catch {
        return toolError(
          "the observed wall screenshot is not readable; re-observe before finishing",
        );
      }
      // An empty trace file keeps the packager's required run files uniform; it carries no events.
      await writeFile(join(runDir, "observations.jsonl"), "", {
        flag: "a",
        mode: 0o600,
      });
    }
    let selected = null;
    if (args.goal_screenshots !== undefined) {
      if (!goal || args.goal_reached !== true)
        return toolError(
          "goal_screenshots requires a directed goal and goal_reached: true",
        );
      try {
        selected = recordedSelection(state.events, args.goal_screenshots);
        for (const item of selected) {
          const bytes = await readFile(join(runDir, item.screenshot_path));
          if (!bytes.length || digest(bytes) !== item.screenshot_sha256)
            throw new Error(
              `selected screenshot ${item.screenshot_path} is empty or differs from its recorded hash`,
            );
        }
      } catch (error) {
        // Strict selection stays strict: no silent dedupe, no reordering, no unknown
        // substitution. The run is retained with its recorded trace intact, so retry finish
        // on this same instance with corrected recorded ordered unique refs.
        return toolError(
          `${error?.message ?? String(error)} The run is retained with its recorded trace intact: ` +
            `retry finish with corrected goal_screenshots that are recorded, ordered and unique, without abandoning the originals.`,
        );
      }
    }
    if (goal && args.goal_reached === true && !selected) {
      const claimPath = state.current?.evidence.screenshot_path;
      const claimIsRecorded = state.events.some(
        (event) =>
          event.before.screenshot_path === claimPath ||
          event.after.screenshot_path === claimPath,
      );
      // A claim may name only the image that the sealed trace retains. In the normal case an act
      // is pending, so the agent can simply record it; an off-site/unrecordable attempt must not
      // be papered over by silently claiming against an older image.
      if (!claimIsRecorded)
        return toolError(
          state.pending
            ? "record the current act first: a goal claim must use a screenshot retained by the trace"
            : "the current goal screenshot is not retained by the trace, so this run cannot claim the goal",
        );
    }
    // A blocked finish must bind the actual observed wall to the trace. When the current
    // screen differs from every retained screenshot this refuses BEFORE sealing, cleanup or
    // packaging, so the caller can record it and finish again correctly.
    const blockedSelection = selectNonzeroBlockedShot({
      why: args.why,
      unreached: goal ? args.goal_reached === false : false,
      selected,
    });
    if (blockedSelection?.error) return toolError(blockedSelection.error);
    // The public pack is read from the product's own landing page by plain code -- no model call,
    // no journeys, just what that page says about itself. The packager binds the map to it.
    const pack = await timing.span("pack.author", () =>
      authorPack(state.entryUrl),
    );
    const packBytes = `${JSON.stringify(pack, null, 2)}\n`;
    const packDir = join(resolve(outputRoot), "packs", runId);
    await mkdir(packDir, { recursive: true });
    const packPath = join(packDir, "public-pack.json");
    await writeFile(packPath, packBytes, { mode: 0o600 });
    const publicPackSha256 = sha256Text(Buffer.from(packBytes));
    await timing.span("evidence.sidecars", () =>
      writeSidecars(
        args.why,
        publicPackSha256,
        goal ? args.goal_reached === true : null,
        selected,
        goal ? args.goal_reached === false : false,
      ),
    );
    // An attempt that never became a recorded event never happened -- so any screenshot it left
    // behind must not either, or the packager (correctly) refuses the whole candidate over it.
    // The one exception is an observation-only blocked finish, whose single observed wall
    // screenshot is explicit sealed evidence (see the blocked marker in explorer-result.json).
    await timing.span("evidence.sweep", () =>
      sweepUnreferencedScreenshots(
        state.events.length === 0 && state.current?.evidence?.screenshot_path
          ? [state.current.evidence.screenshot_path]
          : [],
      ),
    );
    await timing.span("browser.cleanup", async () => {
      await state.session?.close();
    });
    state.session = null;
    await timing.span("session.cleanup", cleanupSession);
    let result;
    try {
      result = await timing.span("packaging", () =>
        packageRun({
          runId,
          runPath: runDir,
          outputPath: join(resolve(outputRoot), "maps", runId),
          publicPackPath: packPath,
          publicPackSha256,
        }),
      );
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
    // Directed runs only: the same screens as one picture, in order. The candidate is sealed and
    // read-only once packaged, so it is written beside it. A failure here is cosmetic.
    let stripPath = null;
    if (goal) {
      stripPath = `${result.output_path}-strip.png`;
      const { renderStrip } = await import("./flow-strip.mjs");
      await timing
        .span("render.strip", () =>
          renderStrip({
            candidateDir: result.output_path,
            outputPath: stripPath,
            heading: goal,
            subheading: new URL(state.entryUrl).host,
          }),
        )
        .catch(() => {
          stripPath = null;
        });
    }
    state.finished = {
      candidate_dir: result.output_path,
      diagnostics_dir: timing.directory,
      ...(declarationWritten ? { preparation_record: declarationPath } : {}),
      map: join(result.output_path, "map.html"),
      ...(stripPath ? { strip: stripPath } : {}),
      ...(selected
        ? {
            goal_screenshots: selected.map((item) => ({
              ...item,
              screenshot_path: join(result.output_path, item.screenshot_path),
            })),
          }
        : {}),
      transitions: state.events.length,
      doors_not_followed: state.blocked.length,
    };
    const markdownLink = (label, path) =>
      `[${label}](<${path.replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll("\n", "%0A")}>)`;
    if (selected) {
      state.finished.evidence_markdown = selected
        .map((item, index) =>
          markdownLink(
            `Captured screen ${index + 1} — ${item.captured_at ?? "date unavailable"}`,
            join(result.output_path, item.screenshot_path),
          ),
        )
        .join("\n\n");
      if (declarationWritten)
        state.finished.evidence_markdown += `\n\n${markdownLink("Preparation declaration (not independent verification)", declarationPath)}`;
      state.finished.evidence_markdown += `\n\n${markdownLink("Local timing", join(timing.directory, "summary.md"))}`;
    } else if (
      state.events.length === 0 &&
      state.current?.evidence?.screenshot_path
    ) {
      // Observation-only blocked evidence through the standard markdown contract: the sealed
      // wall image with NOT-reached and its original timestamp, never a success claim.
      const observed = state.current.evidence;
      state.finished.evidence_markdown =
        `${markdownLink(`Blocked wall — ${observed.observed_at ?? "date unavailable"}`, join(result.output_path, observed.screenshot_path))}\n\n` +
        `Goal NOT reached: ${typeof args.why === "string" ? args.why.trim() : "unstated"}\n\n` +
        markdownLink("Local timing", join(timing.directory, "summary.md"));
    } else if (goal && args.goal_reached === false && state.events.length > 0) {
      // Nonzero-action blocked evidence through the same standard markdown contract: the
      // actual observed wall bound by selectNonzeroBlockedShot (already refused above when
      // the current screen differs from the trace) with NOT-reached and its original
      // timestamp. The image is already sealed in the candidate via the trace; this names
      // it without claiming success.
      const shot = selectNonzeroBlockedShot({
        why: args.why,
        unreached: true,
        selected,
      })?.shot;
      if (shot?.screenshot_path) {
        state.finished.evidence_markdown =
          `${markdownLink(`Blocked wall — ${shot.observed_at ?? "date unavailable"}`, join(result.output_path, shot.screenshot_path))}\n\n` +
          `Goal NOT reached: ${typeof args.why === "string" && args.why.trim() ? args.why.trim() : "unstated"}\n\n` +
          markdownLink("Local timing", join(timing.directory, "summary.md"));
      }
    }
    return text(state.finished);
  }

  async function cleanup() {
    try {
      await timing.span("browser.cleanup", async () => {
        await state.session?.close();
      });
    } finally {
      state.session = null;
      try {
        await timing.span("session.cleanup", cleanupSession);
      } finally {
        await timing.flush();
      }
    }
  }

  function close() {
    closing ??= callQueue.then(cleanup);
    return closing;
  }

  async function dispatchCall(name, args = {}) {
    try {
      if (closing)
        return toolError(
          "this capture is closed; start a new prepared attempt",
        );
      if (name === "observe") return await observe(args);
      if (name === "act") return await act(args);
      if (name === "record") return await record();
      if (name === "finish") return await finish(args);
      return toolError(`unknown tool ${name}`);
    } catch (error) {
      return toolError(
        `${error?.message ?? String(error)}\nLocal timing: ${timing.directory}` +
          (declarationWritten
            ? `\nPreparation declaration: ${declarationPath}`
            : ""),
      );
    }
  }

  function handleCall(name, args = {}) {
    // This browser has one current observation. Concurrent callers must not authenticate or act twice.
    const result = callQueue.then(async () => {
      let response, timingReceipt;
      try {
        const label = TOOLS.some((tool) => tool.name === name)
          ? name
          : "unknown";
        response = await timing.span(`tool.${label}`, () =>
          dispatchCall(name, args),
        );
      } finally {
        timingReceipt = await timing.flush();
      }
      if (name === "finish" && state.finished && !response.isError) {
        // Return server-owned timing after tool.finish has closed. The caller can retain
        // this new receipt with its own attempt without reading the diagnostics directory.
        state.finished.timing_receipt ??= timingReceipt;
        return text(state.finished);
      }
      return response;
    });
    callQueue = result.catch(() => {});
    return result;
  }

  return { handleCall, close, runId, runDir, state, timing };
}

export async function serveExplorer(options) {
  // The installed server locates the caller's noun phrase itself; starting it
  // without a configured locator is a setup failure, not a silent return to
  // caller coordinates. An explicitly passed locator (tests, compatible
  // programmatic callers) is respected as-is.
  if (options.locator === undefined) {
    const resolution = resolveLocatorConfig(process.env);
    if (!resolution.enabled)
      throw new Error(
        `caller target locator is not configured: ${resolution.reason}. ` +
          `Set RELEASHED_LOCATOR=midscene with MIDSCENE_MODEL_BASE_URL, MIDSCENE_MODEL_NAME and ` +
          `MIDSCENE_MODEL_FAMILY (verified: codex://app-server with gpt-5.6-sol and gpt-5, plus ` +
          `MIDSCENE_MODEL_REASONING_ENABLED=true and MIDSCENE_MODEL_REASONING_EFFORT=low; confirm access ` +
          `with \`codex login status\`). Caller-supplied coordinates remain available only as an ` +
          `explicit legacy mode for tests and compatible callers.`,
      );
    options = { ...options, locator: resolution };
  }
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );
  const explorer = createExplorer(options);
  const server = new Server(
    { name: "releashed-explore", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
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
  server.onclose = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    void explorer
      .close()
      .catch(() =>
        process.stderr.write(
          "Capture cleanup failed; inspect the local timing report.\n",
        ),
      );
  };
  if (!options.timing)
    process.stderr.write(
      `Local capture timing: ${explorer.timing.directory}\n`,
    );
  await explorer.timing.flush();
  await server.connect(new StdioServerTransport());
  return explorer;
}
