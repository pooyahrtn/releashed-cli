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
import { checkActionAuthorized, detectWall, noEffectNote, onBoundOrigin, waitAllowance, FORBIDDEN_VERBS, OWNER_FORBIDDEN_VERBS, RUN_WAIT_BUDGET_MS, } from "./run-limits.mjs";
import { buildTransitionEvent, identifyTarget, observeScreen, } from "./explorer-evidence.mjs";
import { sha256Text } from "./scaffold.mjs";
import { resolveLocatorConfig, locateOnShot, pngDimensions, defaultLocatorFactories, DEFAULT_LOCATOR_TIMEOUT_MS, } from "./caller-locator.mjs";
import { digest, recordedSelection } from "./capture-selection.mjs";
import { validateCaptureMetadata } from "./capture-metadata.mjs";
import { createLocalTiming } from "./local-timing.mjs";
import { alternativesFromStore, formatAlternatives, } from "./goal-alternatives.mjs";
function toPoint(value) {
    if (!value)
        return null;
    const { x, y } = value;
    return typeof x === "number" &&
        Number.isFinite(x) &&
        typeof y === "number" &&
        Number.isFinite(y)
        ? { x, y }
        : null;
}
function requirePoint(value, action) {
    // Unreachable when validateAct passed: tap/type/drag always carry finite points by then.
    if (!value)
        throw new Error(`unsupported action ${action}`);
    return value;
}
// `${error?.message ?? String(error)}` without a cast: identical coercion for Error
// instances, exotic throws with a message field, and everything else.
function thrownMessage(error) {
    if (typeof error === "object" && error !== null && "message" in error) {
        const message = error.message;
        if (message !== null && message !== undefined)
            return String(message);
    }
    return String(error);
}
class ScreenshotCaptureError extends Error {
    cause;
    constructor(cause) {
        super("screenshot capture failed");
        this.cause = cause;
    }
}
function captureFailureCategory(error) {
    let text = "";
    try {
        const source = error instanceof ScreenshotCaptureError ? error.cause : error;
        const fields = [thrownMessage(source)];
        if (source && typeof source === "object") {
            const value = source;
            if (typeof value.name === "string")
                fields.push(value.name);
            if (typeof value.code === "string")
                fields.push(value.code);
        }
        text = fields.join(" ").toLowerCase();
    }
    catch {
        return "unknown";
    }
    if (/(target|page|browser|context).*(closed|crashed)|targetclosed|err_target_closed/.test(text))
        return "target_closed";
    if (/timeout|timed out|deadline exceeded|err_timed_out/.test(text))
        return "timeout";
    if (/protocol error|protocolerror|cdp|session.*closed/.test(text))
        return "protocol_error";
    if (/navigation.*(interrupted|aborted)|err_aborted|frame.*detached|execution context was destroyed/.test(text))
        return "navigation_interrupted";
    return "unknown";
}
const defaultLaunchMeasure = (_name, work) => work();
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
        description: "Look at the product: returns a screenshot of the current screen, its address, and how many steps and recorded transitions the run has left. Call it first, and again whenever you are unsure what is on screen. Pass record_previous: true to keep the pending transition from the last act first and then look at the already-cached screen in one call (an explicit save plus the cached view, not a fresh capture); without it, an unrecorded act still needs a separate record call.",
        inputSchema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "only on the first call, and only if the server was started without a URL",
                },
                record_previous: {
                    type: "boolean",
                    description: "when true, record the pending transition before observing; refuses without starting a browser when nothing is pending",
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: "act",
        description: 'Do one thing on the screen: give an instruction and a short noun phrase naming the target ("the blue Sign up button top right"), never a CSS selector. The installed server uses Midscene to locate tap, type and drag targets on the last observed screenshot: omit coordinate and drop_coordinate for those actions. For scroll only, an optional coordinate selects the content pane. Explicit programmatic legacy mode requires coordinates for tap, type and drag. For screens that move on by themselves, wait lets a few seconds pass and needs no target; immediately after a stale-screen refusal only, wait with refresh true takes one immediate fresh look instead of waiting. Returns what the screen did.',
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
                    description: "noun phrase for the thing to point at; not needed for wait",
                },
                direction: {
                    type: "string",
                    enum: ["up", "down"],
                    description: "required for scroll; sends a 600-pixel wheel input over coordinate when supplied, otherwise at the current pointer",
                },
                coordinate: {
                    type: "object",
                    description: "For scroll, an optional point inside the visible content pane. Omit for tap, type and drag: the installed server locates those targets and refuses caller coordinates. Required for those actions only in explicit programmatic legacy mode.",
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
                    description: "Omit on the installed server, which locates drop_target itself. Required for drag only in explicit programmatic legacy mode.",
                    properties: { x: { type: "number" }, y: { type: "number" } },
                    required: ["x", "y"],
                    additionalProperties: false,
                },
                refresh: {
                    type: "boolean",
                    description: "For wait only, immediately after a stale-screen refusal: true takes one fresh look through the ordinary wait path with no requested sleep instead of waiting. Refused on any other action, without a stale refusal behind it, or twice in a row without a successful input between.",
                },
            },
            required: ["action", "instruction"],
            additionalProperties: false,
        },
    },
    {
        name: "record",
        description: "Keep the transition the last act produced as evidence in the map. Call it after every act whose result you believe -- an act that is not recorded never happened as far as the map is concerned.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: "finish",
        description: "Stop exploring, package the evidence and render the map. Returns the candidate directory and the path of map.html.",
        inputSchema: {
            type: "object",
            properties: {
                why: { type: "string", description: "one sentence: why you stopped" },
                goal_screenshots: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string" },
                    description: "Ordered screenshot paths from recorded observations showing the requested goal; may precede the final screen. Requires goal_reached: true.",
                },
                goal_reached: {
                    type: "boolean",
                    description: "compatibility claim only when the run was given a goal: true claims recorded evidence shows it; false says it was not reached",
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
    const method = typeof args?.action === "string" ? RECORDED_METHOD[args.action] : undefined;
    // A wait points at nothing and dispatches nothing, so it is not in the protocol's input
    // vocabulary and needs no target -- everything else still is, and still does.
    if (!method || (method !== "wait" && !ACTION_TYPES.has(method)))
        return `unsupported action ${args?.action}`;
    if (typeof args.instruction !== "string" || !args.instruction.trim())
        return "instruction is required";
    if (method !== "wait" &&
        (typeof args.target !== "string" || !args.target.trim()))
        return "target noun phrase is required";
    if (args.action === "type" && (typeof args.text !== "string" || !args.text))
        return "a type action needs the text to type";
    if (args.action === "drag" &&
        (typeof args.drop_target !== "string" || !args.drop_target))
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
    if (args.action === "scroll" &&
        !["up", "down"].includes(args.direction ?? ""))
        return 'a scroll action needs direction "up" or "down"';
    // Locator mode owns pointing for tap, type and drag: a caller coordinate there is
    // refused loudly, never silently used nor silently used as a fallback. Scroll keeps
    // its optional caller pane point in either mode.
    if (locatorEnabled &&
        ["tap", "type", "drag"].includes(args.action ?? "") &&
        (args.coordinate != null || args.drop_coordinate != null))
        return "this server locates targets itself: omit coordinate and drop_coordinate and name the target noun phrase only";
    const callerPointed = !locatorEnabled || args.action === "scroll";
    if (callerPointed &&
        (["tap", "type", "drag"].includes(args.action ?? "") ||
            (args.action === "scroll" && args.coordinate != null)) &&
        (!args.coordinate ||
            !Number.isFinite(args.coordinate.x) ||
            !Number.isFinite(args.coordinate.y)))
        return `${args.action} needs coordinate { x, y } from the last observe screenshot`;
    if (callerPointed &&
        args.action === "drag" &&
        (!args.drop_coordinate ||
            !Number.isFinite(args.drop_coordinate.x) ||
            !Number.isFinite(args.drop_coordinate.y)))
        return "a drag action needs drop_coordinate { x, y } from the last observe screenshot";
    return null;
}
function coordinateError(coordinate, name) {
    if (!coordinate)
        return null;
    // validateAct already refused non-finite points; a non-number here behaves exactly as the
    // old comparisons did (no comparison is true), so this stays a bounds check only.
    const { x, y } = coordinate;
    if ((typeof x === "number" && (x < 0 || x >= MAX_VIEWPORT_WIDTH)) ||
        (typeof y === "number" && (y < 0 || y >= 800)))
        return `${name} must be inside the last observe screenshot (0 ≤ x < ${MAX_VIEWPORT_WIDTH}, 0 ≤ y < 800)`;
    return null;
}
// Real Chromium, the same boundary the CLI installs. Replaced by a stub in tests.
export async function launchBoundBrowser(entryUrl, { viewport, savedSessionPath = null, mine = false, measure = defaultLaunchMeasure, } = {}) {
    const { chromium } = await import("playwright");
    const { installActionBoundary } = await import("../scripts/vision-explorer-spike.mjs");
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
    const browser = await measure("browser.launch", () => chromium.launch({ headless: true }));
    try {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        const cdp = await installActionBoundary(context, page, boundary);
        await cdp.send("Accessibility.enable").catch(() => { });
        if (savedSessionPath) {
            // The session the user saved with `releashed login`, applied by the same code `map --login`
            // uses; it also refuses to continue when the landing page still looks like a sign-in wall.
            // vision-explorer-run.mjs has no .ts source yet, so the specifier stays .mjs.
            const { loadSavedSession } = await import("../scripts/vision-explorer-run.mjs");
            await measure("browser.session_load", () => loadSavedSession(page, cdp, entryUrl, savedSessionPath));
        }
        else {
            await measure("navigation.entry", () => page.goto(entryUrl, { waitUntil: "networkidle" }));
            await measure("wait.entry", () => page.waitForTimeout(3_000));
        }
        return { page, cdp, boundary, close: () => browser.close() };
    }
    catch (error) {
        await measure("browser.cleanup", () => browser.close()).catch(() => { });
        throw error;
    }
}
/**
 * Owner-directed capture hooks (not tool payloads): locateTarget({ page, target, screenshot })
 * receives a detached observed { png, sha256, width, height, cssWidth, cssHeight } and returns
 * { center: [x, y], rect?: { left, top, width, height } } in CSS pixels, or null. Trusted
 * code may inspect the page but must never dispatch input. Late results are discarded.
 * captureTransitions retains immediate and settled frames for each dispatched input.
 */
export function createExplorer({ url = null, steps = 40, imageOutput = "inline", runsRoot, outputRoot, savedSessionPath = null, 
// Owner mode: the run may use the product like a user (send, post, submit, reply); pay, delete
// and money-shaped paths (billing, checkout, subscribe, ...) still refuse either way.
mine = false, 
// Capture mode (S-5), owner-only and never in discovery: `goal` is the one standing objective in
// the caller's own words, handed back on every observe so it is in front of the agent each turn;
// `policy` is how to behave on the way, conduct only. Both null is the source-blind run this
// server has always served, and nothing below is reachable without a goal.
goal = null, policy = null, continues = null, precondition = null, 
// What the owner expects to see when the goal is reached, verbatim. Sealed with the run as
// `expected`, so a report always shows the expectation this run was judged against, however the
// journey file is reworded later.
expect = null, identityLabel = null, 
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
locator = undefined, locateTarget = undefined, captureTransitions = false, createLocatorAgent = null, createScreenshotItem = null, locatorTimeoutMs = DEFAULT_LOCATOR_TIMEOUT_MS, launch = launchBoundBrowser, resolveSession = null, cleanupSession = async () => { }, timing = createLocalTiming({ outputRoot }), now = () => Date.now(), 
// Only injected by the tests; the real one reads the target's own landing page.
authorPack = authorTargetPack, packageRun = packageCandidate, }) {
    if (!["inline", "paths"].includes(imageOutput))
        throw new Error("imageOutput must be inline or paths");
    if (acquireUntil !== null &&
        acquireUntil !== undefined &&
        !Number.isFinite(acquireUntil))
        throw new Error("acquireUntil must be a finite ms timestamp or null");
    const acquireUntilMs = acquireUntil ?? null;
    const acquireUntilIso = acquireUntilMs === null ? null : new Date(acquireUntilMs).toISOString();
    const acquireExpired = () => acquireUntilMs !== null && now() >= acquireUntilMs;
    const acquireMsLeft = () => acquireUntilMs === null ? null : Math.max(0, acquireUntilMs - now());
    const acquireSteer = () => acquireUntilMs === null
        ? {}
        : { acquire_until: acquireUntilIso, acquire_ms_left: acquireMsLeft() };
    // Sentinel for the last pre-dispatch recheck: thrown after async target resolution (and the
    // drag-motion import) when the absolute window lapses mid-resolution, before the FIRST browser
    // input. It is distinct from the executor's no-match path so a lapsed window never reads as a
    // grounding miss. Once the first input of an in-flight action has started (click begun, wheel
    // sent, drag motion started, wait commenced, text insertion begun) that action runs to
    // completion and stays recordable, so a started gesture is never stranded half-done.
    class CutoffExpiredError extends Error {
    }
    // Locator-mode sentinels. A stale screen or an unlocatable target dispatches nothing;
    // both are honest caller-visible messages, never a coordinate fallback.
    class StaleObservationError extends Error {
    }
    class LocateMissError extends Error {
        kind;
        target;
        constructor(kind, target, detail) {
            super(`${kind}: ${target}: ${detail}`);
            this.kind = kind;
            this.target = target;
        }
    }
    // Explicit locator configuration: an operator who opts in but misconfigures gets a
    // loud construction failure naming the missing piece, never a silent return to
    // caller coordinates.
    if (locateTarget !== undefined && typeof locateTarget !== "function")
        throw new Error("locateTarget must be a function");
    if (typeof captureTransitions !== "boolean")
        throw new Error("captureTransitions must be a boolean");
    if ((locateTarget !== undefined || captureTransitions) &&
        (mine !== true || typeof goal !== "string" || !goal.trim()))
        throw new Error("capture hooks require mine: true and a nonempty goal");
    if (locateTarget && (!Number.isFinite(locatorTimeoutMs) || locatorTimeoutMs <= 0))
        throw new Error("locatorTimeoutMs must be a positive finite number");
    const locatorFromEnv = locator === undefined && !locateTarget;
    // With a programmatic hook and no locator value there is nothing to resolve: the
    // resolution stays undefined and the hook below carries locating on its own.
    const locatorResolution = locatorFromEnv
        ? resolveLocatorConfig(process.env)
        : locator;
    if (locatorFromEnv && (process.env.RELEASHED_LOCATOR ?? "").trim()) {
        const resolution = locatorResolution;
        if (resolution && !resolution.enabled)
            throw new Error(`target locator misconfigured: ${resolution.reason}`);
    }
    // A programmatic hook locates even with no model configured; the env/model path below
    // is unchanged. locatorModelName stays beside the flag so later template uses never
    // touch a nullable.
    const locatorEnabled = Boolean(locateTarget) || locatorResolution?.enabled === true;
    const locatorConfig = locatorResolution?.enabled === true ? locatorResolution.config : null;
    const locatorModelName = locatorConfig ? locatorConfig.modelName : null;
    // Midscene agent factories load lazily on the first locator act, so the default
    // caller-coordinate server never imports the grounding packages at all. Injected
    // test factories thread through untouched, keeping locate hermetic.
    let locatorFactoriesPromise = null;
    async function locatorFactories(shot) {
        // A programmatic hook grounds the noun phrase without any model package: the shot
        // handed over is detached (copied bytes), so late caller mutation cannot move the
        // sealed observation. The Promise wrapper only satisfies the agent contract;
        // locateOnShot awaits it either way.
        if (locateTarget)
            return {
                createScreenshotItem: (base64) => ({ base64 }),
                createAgent: (_page) => ({
                    aiLocate: (target) => Promise.resolve(locateTarget({
                        page: _page,
                        target,
                        screenshot: { ...shot, png: Buffer.from(shot.png) },
                    })),
                }),
            };
        if (createLocatorAgent && createScreenshotItem)
            return { createAgent: createLocatorAgent, createScreenshotItem };
        const defaults = await (locatorFactoriesPromise ??=
            defaultLocatorFactories());
        return {
            createAgent: createLocatorAgent ?? defaults.createAgent,
            createScreenshotItem: createScreenshotItem ?? defaults.createScreenshotItem,
        };
    }
    // The observation the next dispatch must still match: exact observed bytes, their
    // pixel dimensions, the CSS viewport inputs dispatch in, and the sealed hash.
    // An unusable observation is stale, never a reason to point blindly.
    function observedShot() {
        // Unreachable in dispatch (act only dispatches with a session and an observation), so
        // these read as stale rather than throwing a TypeError off a null.
        const session = state.session;
        const current = state.current;
        if (!session || !current)
            throw new StaleObservationError("the last observation has no usable screenshot dimensions; call observe again before acting.");
        const viewport = typeof session.page.viewportSize === "function"
            ? session.page.viewportSize()
            : null;
        const dims = pngDimensions(current.png);
        if (!viewport || !dims)
            throw new StaleObservationError("the last observation has no usable screenshot dimensions; call observe again before acting.");
        return {
            png: current.png,
            width: dims.width,
            height: dims.height,
            cssWidth: viewport.width,
            cssHeight: viewport.height,
            sha256: current.evidence.screenshot_sha256,
        };
    }
    // Locate one noun phrase on the observed bytes for dispatch. Any failure throws
    // before the first browser input: a located point past the cutoff is discarded,
    // never dispatched ("no orphan locator actions after deadline").
    async function locateForDispatch(shot, target) {
        const msLeft = acquireMsLeft();
        const budget = msLeft === null ? locatorTimeoutMs : Math.min(locatorTimeoutMs, msLeft);
        if (budget <= 0)
            throw new CutoffExpiredError();
        const session = state.session;
        if (!session)
            throw new StaleObservationError("the last observation has no usable screenshot dimensions; call observe again before acting.");
        const outcome = await timing.span("grounding.locate", async () => locateOnShot(await locatorFactories(shot), session.page, shot, target, {
            timeoutMs: budget,
        }));
        if (!outcome.ok) {
            if (outcome.kind === "stale-shot")
                throw new StaleObservationError(`the observed screen no longer matches what was located: ${outcome.detail} Call observe again before acting.`);
            if (acquireExpired())
                throw new CutoffExpiredError();
            throw new LocateMissError(outcome.kind, target, outcome.detail);
        }
        return outcome;
    }
    // Same-URL staleness: the address can stay while the pixels move (a countdown, a
    // carousel, a re-render), which the URL check cannot see. Re-capture immediately
    // before the first input and require the exact observed bytes; anything else --
    // including an unreadable re-capture -- refuses as stale with the step refunded.
    async function reverifyObservation(beforeUrl, beforeHash) {
        const session = state.session;
        if (!session || session.page.url() !== beforeUrl)
            throw new StaleObservationError("the screen changed while the target was being located; call observe again before acting.");
        const reverified = await timing.span("grounding.reverify", () => session.page.screenshot().catch(() => null));
        if (!reverified || digest(reverified) !== beforeHash)
            throw new StaleObservationError("the screen changed since it was observed; call observe again before acting.");
    }
    const cutoffRefusal = () => toolError(`acquisition window expired at ${acquireUntilIso}; no new act was dispatched, including wait. ` +
        (state.pending
            ? "A pending act is still recordable: call record to keep it, then finish to package. "
            : "Call finish to package what was recorded. ") +
        "The run is retained; record, observe for necessary current evidence, finish, seal and cleanup remain available. " +
        "Actions already in flight when the cutoff passes may finish so a started gesture is not stranded; only new dispatches refuse.");
    const runId = `explore-${new Date(now())
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z")}`;
    const runDir = join(resolve(runsRoot), runId, "target-session-1");
    const declarationPath = join(resolve(outputRoot), "preparations", `${timing.attemptId}.json`);
    timing.bindRun(runId);
    let metadataValidated = false;
    let sessionResolved = false;
    let authenticationFailure = null;
    let browserStartupFailure = null;
    let callQueue = Promise.resolve();
    let closing = null;
    let declarationWritten = false;
    let browserClosed = false;
    let browserCloseFailure = null;
    let removeScopeListener = null;
    const state = {
        entryUrl: url,
        session: null,
        current: null,
        pending: null,
        pendingTail: [],
        captureFailure: null,
        scopeExit: null,
        wallObservation: null,
        events: [],
        blocked: [],
        stateIndex: 0,
        stepsUsed: 0,
        inputsDispatched: 0,
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
            throw new Error("no URL yet: pass one to observe, or start the server with a URL");
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
                await writeFile(declarationPath, JSON.stringify({
                    schema_version: 1,
                    run_id: runId,
                    attempt_id: timing.attemptId,
                    recorded_at: new Date().toISOString(),
                    identity_label: identityLabel,
                    precondition,
                    basis: "Caller declaration recorded before authentication; external readiness is not verified by this file.",
                    external_preparation_timing: null,
                }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
            });
            declarationWritten = true;
        }
        if (authenticationFailure)
            throw authenticationFailure;
        if (!sessionResolved && resolveSession) {
            try {
                savedSessionPath = await timing.span("authentication", resolveSession);
                sessionResolved = true;
            }
            catch (error) {
                authenticationFailure = error;
                throw error;
            }
        }
        // The authentication span above is async: recheck the absolute window before launching a
        // browser. An expiry here starts no browser; task-owned session cleanup still runs via
        // close(), so a freshly minted session is never leaked. This is not a browser-startup
        // failure and sets no such marker.
        if (acquireExpired() && !state.session)
            throw new Error(`acquisition window expired at ${acquireUntilIso} after authentication and before browser launch; no browser was launched. ` +
                `End this server, complete task-owned session cleanup via close, and stop honestly within the original outer deadline. ` +
                `Do not reset the cutoff or reserve. No new evidence was captured.`);
        try {
            await timing.span("browser.startup", async () => {
                state.session = await launch(entry, {
                    viewport: { width: MAX_VIEWPORT_WIDTH, height: 800 },
                    ...(savedSessionPath ? { savedSessionPath } : {}),
                    mine,
                    measure: timing.span,
                });
                // The launch contract exposes the page only at this handoff, not during
                // launcher's own initialization. Guard it before the startup span completes.
                if (captureTransitions) {
                    const { page } = state.session;
                    if (typeof page.on === "function" && typeof page.off === "function" &&
                        typeof page.mainFrame === "function") {
                        const navigation = (frame) => {
                            try {
                                if (frame === page.mainFrame())
                                    sampleCaptureScope(frame.url());
                            }
                            catch {
                                stopAtScopeExit(null);
                            }
                        };
                        removeScopeListener = () => page.off("framenavigated", navigation);
                        page.on("framenavigated", navigation);
                    }
                    sampleCaptureScope();
                }
            });
        }
        catch (error) {
            if (state.session)
                await closeCaptureBrowser().catch(() => { });
            removeScopeListener?.();
            removeScopeListener = null;
            browserStartupFailure = new Error(`${thrownMessage(error)}\nBrowser startup failed; no new evidence was captured. ` +
                "Retain these diagnostics, end this server, complete task-owned session cleanup, and repair the startup failure before a new prepared attempt. This attempt will not launch again.");
            throw browserStartupFailure;
        }
    }
    function stopAtScopeExit(decision) {
        if (!state.scopeExit) {
            state.scopeExit =
                "Observation went off the product's own site or its origin became uncertain. No out-of-scope screenshot retained; the final effect is unknown. No more input will be dispatched. Record any pending in-scope frames, then finish with goal_reached: false or close; never repeat this input.";
            state.blocked.push({
                instruction: decision?.instruction ?? "observe the product",
                target: decision?.target ?? null,
                transition_kind: "unknown-terminal",
                reason: state.scopeExit,
            });
        }
        return new Error(state.scopeExit);
    }
    // The owned session stays guarded between tools and through native close. Eventless
    // injected pages have URL sampling only; they cannot prove a crossing-and-return absent.
    function sampleCaptureScope(url) {
        if (!captureTransitions || !state.session || browserClosed)
            return;
        try {
            if (!onBoundOrigin(url ?? state.session.page.url(), state.session.boundary.origins))
                stopAtScopeExit(null);
        }
        catch {
            stopAtScopeExit(null);
        }
    }
    function requireCaptureScope(decision = null) {
        sampleCaptureScope();
        if (captureTransitions && state.scopeExit)
            throw stopAtScopeExit(decision);
    }
    async function closeCaptureBrowser() {
        const session = state.session;
        if (!session || browserClosed)
            return;
        sampleCaptureScope();
        try {
            await timing.span("browser.cleanup", async () => {
                await session.close();
                // Keep the listener and last live URL available until native close resolves.
                sampleCaptureScope();
                browserClosed = true;
                browserCloseFailure = null;
                removeScopeListener?.();
                removeScopeListener = null;
            });
        }
        catch (error) {
            // A timing failure after native close must not cause a second native close.
            if (browserClosed)
                throw error;
            sampleCaptureScope();
            browserCloseFailure = `Browser cleanup failed; closure is not confirmed. No goal can be sealed. Call close to retry cleanup: ${thrownMessage(error)}`;
            throw new Error(browserCloseFailure);
        }
    }
    async function snapshot(decision = null) {
        state.stateIndex += 1;
        const session = state.session;
        if (!session)
            throw new Error("call observe first: nothing has been looked at yet");
        const { page, cdp, boundary } = session;
        const path = join(runDir, "screenshots", `state-${String(state.stateIndex).padStart(4, "0")}.png`);
        let acquiredPng = null;
        let invalidScope = false;
        // Latch a main-frame crossing, even if it returns before an await resolves. The URL
        // sampled by observeScreen is not sufficient: its PNG and AX arrive asynchronously.
        const sampleScope = (url) => {
            try {
                if (!onBoundOrigin(url, boundary.origins))
                    invalidScope = true;
            }
            catch {
                invalidScope = true;
            }
        };
        const navigation = (frame) => {
            try {
                if (frame === page.mainFrame())
                    sampleScope(frame.url());
            }
            catch {
                invalidScope = true;
            }
        };
        const checkScope = () => {
            if (!captureTransitions)
                return;
            try {
                sampleScope(page.url());
            }
            catch {
                invalidScope = true;
            }
            sampleCaptureScope();
            if (state.scopeExit)
                invalidScope = true;
            if (invalidScope)
                throw stopAtScopeExit(decision);
        };
        // Guard each acquisition/write await, plus the whole transaction before committing
        // current. Same-origin route changes remain allowed; this is not a URL-stability gate.
        const measure = captureTransitions
            ? (name, work) => timing.span(name, async () => {
                checkScope();
                try {
                    return await work();
                }
                finally {
                    checkScope();
                }
            })
            : timing.span;
        // observeScreen only reads url() and screenshot(); it never touches evaluate, so the
        // capture stub refuses DOM access loudly instead of inheriting it.
        const capturePage = captureTransitions
            ? {
                url: () => page.url(),
                screenshot: async () => {
                    try {
                        return (acquiredPng = await page.screenshot());
                    }
                    catch (error) {
                        throw new ScreenshotCaptureError(error);
                    }
                },
                evaluate: () => {
                    throw new Error("capture stub has no DOM access");
                },
            }
            : page;
        const listen = captureTransitions &&
            typeof page.on === "function" &&
            typeof page.off === "function" &&
            typeof page.mainFrame === "function";
        try {
            if (listen)
                page.on("framenavigated", navigation);
            let observed;
            try {
                observed = await measure("observation", () => observeScreen(capturePage, cdp, runDir, state.stateIndex, true, measure));
                checkScope();
            }
            catch (error) {
                checkScope();
                // A metadata failure may retain valid acquired pixels, but never origin-uncertain
                // bytes. A crossing during this fallback write is also rolled back below. The
                // const copy keeps the null check the checker can see: the field is reassigned
                // on the scope-exit path below.
                const preserved = acquiredPng;
                if (preserved)
                    await measure("screenshot.preserve", () => writeFile(path, preserved, { mode: 0o600 }));
                throw error;
            }
            // Immutable acquisition timestamp from the injected clock: the sealed date of this
            // observation. File mtimes and the finish clock can never move it afterwards.
            // Runtime state commits only after guarded completion.
            observed.evidence.observed_at = new Date(now()).toISOString();
            checkScope();
            state.current = observed;
            return observed;
        }
        catch (error) {
            try {
                checkScope();
            }
            catch {
                /* scope exit takes precedence over acquisition failure */
            }
            if (invalidScope) {
                acquiredPng = null;
                // observeScreen may already have written this attempt. Remove only its file,
                // never earlier valid observations or the pending immediate transition.
                await unlink(path).catch((failure) => {
                    if (failure.code !== "ENOENT")
                        throw failure;
                });
                throw stopAtScopeExit(decision);
            }
            throw error;
        }
        finally {
            if (listen)
                page.off("framenavigated", navigation);
        }
    }
    async function observe(args = {}) {
        if (state.finished)
            return toolError("this run is finished; its map is already packaged");
        if (browserStartupFailure)
            throw browserStartupFailure;
        sampleCaptureScope();
        if (browserClosed || browserCloseFailure)
            return toolError(browserCloseFailure ?? "the browser is closed; finish packaging or close this capture");
        if (state.scopeExit && !state.current)
            return toolError(state.scopeExit);
        // Combined keep-and-look: an explicit save of the pending transition, then the ordinary
        // cached view below -- the screenshot act already took, not a fresh capture. Only a boolean
        // true records; false or omitted keeps the old look-only behavior, and any other value
        // refuses before any write or browser start. A record error (notably nothing pending)
        // propagates unchanged, so a refused keep never starts a browser.
        let recorded = null;
        let recordedEvents = null;
        if (args.record_previous !== undefined && args.record_previous !== false) {
            if (args.record_previous !== true)
                return toolError("record_previous must be a boolean: true keeps the pending transition before looking; false or omitted just looks");
            const kept = await record();
            if (kept.isError)
                return kept;
            const keptFirst = kept.content[0];
            const receipt = keptFirst && keptFirst.type === "text"
                ? JSON.parse(keptFirst.text)
                : {};
            recorded = receipt.recorded;
            recordedEvents = receipt.recorded_events;
        }
        if (!state.session) {
            // An expired absolute window before first observation starts no login: honest failure.
            if (acquireExpired())
                return toolError(`acquisition window expired at ${acquireUntilIso}; no authentication or browser was started. ` +
                    `End this server, complete task-owned session cleanup, and stop honestly within the original outer deadline. ` +
                    `Do not reset the cutoff or reserve. No new evidence was captured.`);
            await open(args.url);
            await snapshot();
            const opened = state.current;
            // snapshot() always sets the observation, so this throw is unreachable; it only
            // tells the type checker what the open-then-snapshot sequence guarantees.
            if (!opened)
                throw new Error("call observe first: nothing has been looked at yet");
            const entryWall = detectWall(opened.evidence.url, opened.evidence.visible_state_summary, { entry: true });
            if (entryWall) {
                state.walled = entryWall.reason;
                state.blocked.push({
                    instruction: "open the product",
                    target: null,
                    transition_kind: "unknown-terminal",
                    reason: entryWall.reason,
                });
            }
        }
        else if (!state.current) {
            await snapshot();
        }
        const current = state.current;
        if (!current)
            throw new Error("call observe first: nothing has been looked at yet");
        // NO output schema on this tool, so the client renders the image part as an image.
        const currentImage = imageOutput === "inline"
            ? [
                {
                    type: "image",
                    data: current.png.toString("base64"),
                    mimeType: "image/png",
                },
            ]
            : [];
        const content = [
            {
                type: "text",
                text: JSON.stringify({
                    // The standing objective, repeated every turn rather than only at the start -- this
                    // is the whole of "the goal is in the brief" when the brief is the agent's own head.
                    ...(goal ? { goal, ...(policy ? { policy } : {}) } : {}),
                    address: current.evidence.url,
                    ...(goal || imageOutput === "paths"
                        ? { screenshot_path: current.evidence.screenshot_path }
                        : {}),
                    ...(imageOutput === "paths"
                        ? {
                            image_path: join(runDir, current.evidence.screenshot_path),
                        }
                        : {}),
                    steps_used: state.stepsUsed,
                    steps_left: Math.max(0, steps - state.stepsUsed),
                    transitions_recorded: state.events.length,
                    unrecorded_act: Boolean(state.pending),
                    ...(recorded ? { recorded } : {}),
                    ...(recordedEvents ? { recorded_events: recordedEvents } : {}),
                    ...(state.captureFailure ? { capture_error: state.captureFailure } : {}),
                    ...(state.scopeExit ? { boundary_stop: state.scopeExit } : {}),
                    ...(state.walled ? { wall: state.walled } : {}),
                    ...acquireSteer(),
                }, null, 2),
            },
            ...currentImage,
        ];
        return { content };
    }
    async function act(args = {}) {
        if (state.finished)
            return toolError("this run is finished; its map is already packaged");
        sampleCaptureScope();
        if (state.scopeExit)
            return toolError(state.scopeExit);
        if (browserClosed || browserCloseFailure)
            return toolError(browserCloseFailure ?? "the browser is closed; finish packaging or close this capture");
        if (!state.session || !state.current)
            return toolError("call observe first: nothing has been looked at yet");
        if (state.captureFailure)
            return toolError(state.captureFailure);
        if (captureTransitions && state.pending)
            return toolError("a transition is already pending: call record (or observe with record_previous: true) before another act so captured frames are not overwritten");
        if (state.stepsUsed >= steps)
            return toolError(`the step budget of ${steps} is spent -- call finish to package what was seen`);
        // A wall is a finding, and it is terminal: nothing honest is left to try on this product.
        if (state.walled)
            return toolError(`${state.walled} Call finish to package what was seen.`);
        const invalid = validateAct(args, { locatorEnabled });
        if (invalid)
            return toolError(invalid);
        const coordinateProblem = coordinateError(args.coordinate, "coordinate") ??
            coordinateError(args.drop_coordinate, "drop_coordinate");
        if (coordinateProblem)
            return toolError(coordinateProblem);
        // Absolute acquisition cutoff: refuse NEW dispatch (including wait) before anything
        // is sent, but never block a pending record, necessary current evidence or finish.
        // Preparation cannot reset this budget: it is compared against the injected wall clock.
        if (acquireExpired())
            return cutoffRefusal();
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
                return toolError("a transition is already pending: call record (or observe with record_previous: true) to keep it before requesting a refresh, so the refresh never overwrites evidence");
            if (!state.staleArmed)
                return toolError('refresh is only valid immediately after a stale-screen refusal: call act with action "wait" without refresh for an ordinary wait');
            if (state.staleRefreshSpent)
                return toolError('the one immediate refresh for this stale screen is spent: call act with action "wait" without refresh to let the screen settle');
            if (acquireExpired())
                return cutoffRefusal();
        }
        if (waiting && !refreshing && waitMs === 0) {
            state.stepsUsed += 1;
            return text(`A run may wait ${RUN_WAIT_BUDGET_MS / 1000} seconds in total and this one has used all of it. Waiting again will not work -- do something else on the screen, or call finish.`);
        }
        // validateAct passed, so action/instruction are present strings on every reachable path;
        // the fallbacks below only satisfy the type checker on unreachable ones.
        const decision = {
            action: args.action ?? "",
            instruction: args.instruction ?? "",
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
            return text(`${authorized.reason} Nothing was dispatched. Find something else on screen.`);
        }
        const before = state.current.evidence;
        // The dispatch closure below cannot see the guard's narrowing, so bind what it reads.
        // No snapshot runs between here and dispatch, so this is the same observation.
        const currentRefs = state.current.refs;
        const mutationsBefore = boundary.sameOriginMutations;
        let identified = {
            tier: "positional",
            ref: null,
        };
        let inputStarted = false;
        const startInput = () => {
            if (acquireExpired())
                throw new CutoffExpiredError();
            requireCaptureScope(decision);
            inputStarted = true;
            state.inputsDispatched += 1;
        };
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
            }
            else {
                state.waitedMs += waitMs;
                await timing.span("wait.requested", () => page.waitForTimeout(waitMs));
            }
        }
        else {
            try {
                await timing.span("action.dispatch", async () => {
                    // Last pre-dispatch recheck per action, after every async resolution (target
                    // lookup, drag-motion import) and before the FIRST browser input. Once that input
                    // starts the in-flight action runs to completion and stays recordable.
                    // Locator mode resolves the dispatch point here, on the exact bytes the last
                    // observe returned: the caller named the target, the runtime points at it, and
                    // any locate failure below dispatches nothing and is never a coordinate fallback.
                    // validateAct already refused missing or non-finite caller points, so the
                    // conversions below only fail on unreachable paths.
                    let point = toPoint(decision.coordinate) ?? undefined;
                    let dropPoint = toPoint(decision.drop_coordinate) ?? undefined;
                    if (locatorEnabled &&
                        ["tap", "type", "drag"].includes(decision.action)) {
                        const shot = observedShot();
                        const located = await locateForDispatch(shot, decision.target ?? "");
                        point = { x: located.x, y: located.y };
                        if (args.action === "drag") {
                            const dropLocated = await locateForDispatch(shot, decision.drop_target ?? "");
                            dropPoint = { x: dropLocated.x, y: dropLocated.y };
                        }
                        // Bind the located points to the observation they were found on: the
                        // page must still show those exact bytes before the first input.
                        await reverifyObservation(before.url, before.screenshot_sha256);
                    }
                    if (args.action === "tap") {
                        const { x, y } = requirePoint(point, args.action);
                        identified = await identifyTarget(page, currentRefs, x, y);
                        startInput();
                        await page.mouse.click(x, y);
                    }
                    else if (args.action === "type") {
                        const { x, y } = requirePoint(point, args.action);
                        identified = await identifyTarget(page, currentRefs, x, y);
                        startInput();
                        await page.mouse.click(x, y);
                        await page.keyboard.insertText(decision.text ?? "");
                    }
                    else if (args.action === "scroll") {
                        startInput();
                        if (point)
                            await page.mouse.move(point.x, point.y);
                        await page.mouse.wheel(0, args.direction === "down" ? 600 : -600);
                    }
                    else if (args.action === "drag") {
                        const { x, y } = requirePoint(point, args.action);
                        identified = await identifyTarget(page, currentRefs, x, y);
                        const { ourDragMotion } = await import("../scripts/vision-explorer-spike.mjs");
                        startInput();
                        await ourDragMotion(page, { x, y }, requirePoint(dropPoint, args.action));
                    }
                    else {
                        throw new Error(`unsupported action ${args.action}`);
                    }
                });
            }
            catch (error) {
                sampleCaptureScope();
                if (captureTransitions && state.scopeExit) {
                    if (!inputStarted)
                        state.stepsUsed -= 1;
                    return toolError(state.scopeExit);
                }
                if (captureTransitions && inputStarted)
                    return captureFailed(error, "dispatch");
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
                        const cause = error.message.replace(/;?\s*call observe again before acting\.?/i, "");
                        if (!state.staleRefreshSpent)
                            return text(`${cause} Nothing was dispatched. Call act with action "wait" and refresh true for one immediate fresh look, then observe with record_previous true to keep it and see the new screen.`);
                        return text(`${cause} Nothing was dispatched. The immediate refresh for this screen is spent: call act with action "wait" without refresh to let the screen settle, then observe with record_previous true to keep it and see the new screen.`);
                    }
                    if (error instanceof LocateMissError) {
                        const why = error.kind === "timeout"
                            ? `locating "${error.target}" timed out`
                            : error.kind === "out-of-bounds"
                                ? `the locator placed "${error.target}" outside the observed screen`
                                : `Nothing on screen matched "${error.target}"`;
                        return text(`${why}, so nothing was done. Try a different phrase, or a different control.`);
                    }
                    throw error;
                }
                // The executor refused to guess a coordinate, so no input was dispatched. An attempted
                // instruction is not evidence.
                return text(`Nothing on screen matched "${decision.target}", so nothing was done. Try a different phrase, or a different control.`);
            }
            if (captureTransitions)
                return captureInputFrames(before, decision, identified, mutationsBefore);
            await timing.span("wait.settle", () => page.waitForTimeout(1_500));
        }
        if (!onBoundOrigin(page.url(), boundary.origins)) {
            if (captureTransitions)
                return toolError(stopAtScopeExit(decision).message);
            const reason = `"${decision.instruction}" led off the product's own site; the run did not follow it.`;
            state.blocked.push({
                instruction: decision.instruction,
                target: decision.target,
                transition_kind: "unknown-terminal",
                reason,
            });
            await timing.span("navigation.restore", () => page.goto(before.url, { waitUntil: "domcontentloaded" }));
            await timing.span("wait.restore", () => page.waitForTimeout(1_000));
            await snapshot();
            return text(`${reason} You are back where you were. Do not try it again.`);
        }
        const after = (await snapshot(decision)).evidence;
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
        const method = RECORDED_METHOD[decision.action];
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
        if (captureTransitions)
            state.pending.cumulative_browser_actions = state.inputsDispatched;
        return completedAct(before, after, identified, waiting, wall);
    }
    function completedAct(before, after, identified, waiting, wall) {
        const changed = before.observation_hash !== after.observation_hash ||
            before.screenshot_sha256 !== after.screenshot_sha256;
        // The breaker: a step that changed nothing -- a wait included, since waiting forever is the
        // same failure as clicking forever -- adds to the streak; any step that did something clears
        // it. From three in a row this says so plainly rather than letting the same idea be rephrased.
        state.noEffectStreak =
            changed ? 0 : state.noEffectStreak + 1;
        // A successful non-wait input (tap/type/drag/scroll) closes any stale-recovery
        // episode: the next stale refusal arms a fresh one with its own single refresh. An
        // ordinary wait only spends time -- it never re-arms a free refresh.
        if (!waiting) {
            state.staleArmed = false;
            state.staleRefreshSpent = false;
        }
        const stuck = noEffectNote(state.noEffectStreak);
        return text({
            screen_changed: changed,
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
    async function writeCaptureDiagnostic(error, phase, recovery = null) {
        try {
            await mkdir(timing.directory, { recursive: true, mode: 0o700 });
            const diagnostic = {
                schema_version: 1,
                phase,
                error: { category: captureFailureCategory(error) },
                ...(recovery ? { recovery } : {}),
            };
            await writeFile(join(timing.directory, "capture-failure.json"), `${JSON.stringify(diagnostic)}\n`, { flag: "wx", mode: 0o600 });
        }
        catch {
            // Failure diagnostics are best effort and never alter the capture stop behavior.
        }
    }
    async function captureFailed(error, phase, recovery = null) {
        state.captureFailure = "Capture failed after input started; its effect is unknown. No more input will be dispatched. Record any pending acquired frames, then finish with goal_reached: false or close; never repeat this input.";
        await writeCaptureDiagnostic(error, phase, recovery);
        return toolError(state.captureFailure);
    }
    async function captureInputFrames(before, decision, identified, mutationsBefore) {
        const session = state.session;
        // Unreachable: captureInputFrames only runs after a dispatched input, which needs a session.
        if (!session)
            throw new Error("call observe first: nothing has been looked at yet");
        const { page, boundary } = session;
        const event = (from, to, method, index) => ({
            ...buildTransitionEvent({
                runId, index, before: from, after: to, method,
                identified: method === "wait" ? { tier: "positional", ref: null } : identified,
                mutated: boundary.sameOriginMutations > mutationsBefore,
                elapsedSeconds: (now() - state.startedAt) / 1000,
                requests: boundary.total,
            }),
            cumulative_browser_actions: state.inputsDispatched,
        });
        const checkFrame = (frame) => {
            const wall = detectWall(frame.url, frame.visible_state_summary);
            if (wall && !state.walled) {
                state.walled = wall.reason;
                state.wallObservation = frame;
                state.blocked.push({
                    instruction: decision.instruction, target: decision.target,
                    transition_kind: "unknown-terminal", reason: wall.reason,
                });
            }
        };
        let phase = "immediate";
        let recoveryError = null;
        let recoveryAttempted = false;
        const pageIsOpen = () => {
            if (browserClosed)
                return false;
            try {
                return typeof page.isClosed !== "function" || !page.isClosed();
            }
            catch {
                return false;
            }
        };
        const canReacquire = (error) => !recoveryAttempted &&
            phase === "immediate" &&
            !state.pending &&
            !state.scopeExit &&
            !acquireExpired() &&
            pageIsOpen() &&
            error instanceof ScreenshotCaptureError &&
            captureFailureCategory(error) === "protocol_error";
        try {
            let immediate;
            try {
                immediate = (await snapshot(decision)).evidence;
            }
            catch (error) {
                if (!canReacquire(error))
                    throw error;
                recoveryAttempted = true;
                recoveryError = error;
                try {
                    immediate = (await timing.span("screenshot.reacquire", () => snapshot(decision))).evidence;
                }
                catch (reacquireError) {
                    if (state.scopeExit) {
                        await writeCaptureDiagnostic(error, "immediate", "failed");
                        return toolError(state.scopeExit);
                    }
                    return captureFailed(reacquireError, "immediate", "failed");
                }
            }
            state.pending = event(before, immediate, RECORDED_METHOD[decision.action], state.events.length + 1);
            checkFrame(immediate);
            phase = "settled";
            await timing.span("wait.settle", () => page.waitForTimeout(1_500));
            const settled = (await snapshot(decision)).evidence;
            state.pendingTail = [event(immediate, settled, "wait", state.events.length + 2)];
            checkFrame(settled);
            if (recoveryError)
                await writeCaptureDiagnostic(recoveryError, "immediate", "recovered");
            return completedAct(before, settled, identified, false, state.walled ? { reason: state.walled } : null);
        }
        catch (error) {
            if (state.scopeExit) {
                if (recoveryError)
                    await writeCaptureDiagnostic(recoveryError, "immediate", "recovered");
                return toolError(state.scopeExit);
            }
            return captureFailed(error, phase, recoveryAttempted ? "recovered" : null);
        }
    }
    async function record() {
        if (state.finished)
            return toolError("this run is finished; its map is already packaged");
        sampleCaptureScope();
        if (!state.pending)
            return toolError("nothing to record: call act first");
        const event = state.pending;
        const events = [event, ...state.pendingTail];
        if (!captureTransitions) {
            state.pending = null;
            state.events.push(event);
        }
        await timing.span("evidence.write", () => writeFile(join(runDir, "observations.jsonl"), events.map((item) => `${JSON.stringify(item)}\n`).join(""), { flag: "a", mode: 0o600 }));
        if (captureTransitions) {
            state.events.push(...events);
            state.pending = null;
            state.pendingTail = [];
        }
        sampleCaptureScope();
        return text({
            recorded: event.event_id,
            ...(captureTransitions ? { recorded_events: events.map((item) => item.event_id) } : {}),
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
        await Promise.all(files
            .filter((name) => !keep.has(`screenshots/${name}`))
            .map((name) => unlink(join(dir, name)).catch(() => { })));
    }
    // The one blocked-screen selection for a nonzero-action blocked finish, shared by the
    // pre-finish refusal, the sealed sidecar marker and the finish response, so the three can
    // never disagree. A blocked finish must bind the ACTUAL observed wall: the current screen
    // when the trace retains it, or an equivalent unrecorded repeat of the last recorded
    // screen (same image bytes AND same address -- a wait that changed nothing). A current
    // screen that differs is not evidence yet: the caller must record it first, so this
    // returns an actionable error instead of blessing a stale screen as the blocked wall.
    // Returns null when this is not a nonzero-action blocked finish at all.
    function selectNonzeroBlockedShot({ why: wallReason, unreached: wallUnreached, selected: wallSelected, }) {
        if (!goal || !wallUnreached || wallSelected || state.events.length === 0)
            return null;
        if (typeof wallReason !== "string" || !wallReason.trim())
            return null;
        // A scope exit has no captured foreign wall. Do not label its last in-scope
        // frame as that wall; an actual earlier wall, if observed, still binds below.
        if (state.scopeExit && !state.wallObservation)
            return null;
        const retained = new Set();
        for (const event of state.events) {
            if (event.before?.screenshot_path)
                retained.add(event.before.screenshot_path);
            if (event.after?.screenshot_path)
                retained.add(event.after.screenshot_path);
        }
        // A transient terminal wall stays the blocked evidence even if settling removes it.
        const current = state.wallObservation ?? state.current?.evidence;
        if (current?.screenshot_path && retained.has(current.screenshot_path))
            return { shot: current };
        const last = state.events[state.events.length - 1]?.after;
        if (current?.screenshot_sha256 &&
            last?.screenshot_path &&
            retained.has(last.screenshot_path) &&
            current.screenshot_sha256 === last.screenshot_sha256 &&
            current.url === last.url)
            return { shot: last };
        return {
            error: "the current screen is not recorded, so it cannot back a blocked finish: call record to keep what this screen shows, then call finish again with goal_reached: false",
        };
    }
    // The sidecars the packager and the renderer read beside the trace. There is no cost line: option
    // D spends none of our tokens and cannot count the agent's.
    async function writeSidecars(why, publicPackSha256, claimed = null, selected = null, unreached = false) {
        // The sealed wall image for a blocked finish, so the packager, renderer stop annotation and
        // report can verify it against the manifest. Zero-action runs name the single observed wall
        // screenshot; nonzero blocked runs name the actual observed wall bound to the trace by
        // selectNonzeroBlockedShot. Never a transition, never a success claim.
        // observed_at is the immutable acquisition stamp from snapshot(), never file mtime.
        // The blocked-shot branch carries the observed wall; the error branch was already
        // refused by the caller before sealing, so only the shot binds here.
        const blockedSelection = selectNonzeroBlockedShot({
            why,
            unreached,
            selected,
        });
        const nonzeroBlockedShot = blockedSelection && "shot" in blockedSelection
            ? blockedSelection.shot
            : null;
        let blockedMarker = null;
        const blockedShot = state.events.length === 0 ? state.current?.evidence : nonzeroBlockedShot;
        if (blockedShot?.screenshot_path) {
            try {
                const bytes = await readFile(join(runDir, blockedShot.screenshot_path));
                if (bytes.length && digest(bytes) === blockedShot.screenshot_sha256) {
                    blockedMarker = {
                        reason: state.events.length === 0
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
                    if (!blockedMarker.reason ||
                        !blockedMarker.screenshot_sha256 ||
                        !blockedMarker.observed_at)
                        blockedMarker = null;
                }
            }
            catch {
                blockedMarker = null;
            }
        }
        // With no goal this is exactly what it always was: finished, or walled. With one, the run has
        // to answer the question it was asked -- reached at this step, or not reached and here is
        // where it got to instead. A wall stays a wall either way; it just also says it fell short.
        const free = state.captureFailure
            ? { stop_reason: "observation_error", reason: state.captureFailure }
            : state.walled || state.scopeExit
                ? { stop_reason: "wall", reason: state.walled ?? state.scopeExit }
                : {
                    stop_reason: "explorer_finished",
                    reason: why ?? "The agent driving this run said it was finished.",
                };
        const stop = goal && !state.captureFailure
            ? claimed && !state.walled && !state.scopeExit
                ? {
                    stop_reason: "goal_claimed",
                    reason: `Claimed at step ${state.stepsUsed}. ${why ?? "The agent said it was looking at the goal."}`,
                }
                : {
                    stop_reason: state.walled || state.scopeExit ? "wall" : "goal_not_reached",
                    reason: `${selected ? "Goal evidence was selected earlier." : "The goal was not reached."} ${free.reason} The last screen it stood on was ${state.current?.evidence.url ?? state.entryUrl}.`,
                }
            : free;
        await writeFile(join(runDir, "explorer-result.json"), `${JSON.stringify({
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
                            goal_screenshots: selected.map((item) => item.screenshot_path),
                        }
                        : {}),
                    ...(policy ? { policy } : {}),
                    ...(continues ? { continues } : {}),
                    ...(precondition ? { precondition } : {}),
                    ...(expect ? { expected: expect } : {}),
                    ...(stop.stop_reason === "goal_claimed"
                        ? {
                            goal_claimed_at_step: state.stepsUsed,
                            goal_screenshot_path: selected?.[0]?.screenshot_path ??
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
        }, null, 2)}\n`, { mode: 0o600 });
        await writeFile(join(runDir, "request-events.jsonl"), (state.session?.boundary.events ?? [])
            .map((event) => `${JSON.stringify(event)}\n`)
            .join(""), { mode: 0o600 });
        const boundary = state.session?.boundary;
        await writeFile(join(runDir, "metrics.json"), `${JSON.stringify({
            schema_version: 1,
            run_id: runId,
            explorer_model: "the coding agent driving this MCP server",
            // Locator mode grounds the caller's noun phrase on the observed bytes
            // through the operator's own configured model; coordinate mode keeps the
            // historical null (the coding agent supplies visible coordinates).
            grounding_model: locateTarget
                ? "programmatic screenshot-bound locator"
                : locatorEnabled
                    ? `midscene aiLocate on the observed screenshot bytes (${locatorModelName}); the caller names the target`
                    : null,
            browser: {
                active_seconds: Number(((now() - state.startedAt) / 1000).toFixed(3)),
                actions: captureTransitions ? state.inputsDispatched : state.events.length,
                requests_seen_by_action_boundary: boundary?.total ?? 0,
                mutating_requests_allowed: boundary?.allowed ?? 0,
                same_origin_mutating_requests: boundary?.sameOriginMutations ?? 0,
                requests_refused_by_action_boundary: boundary?.refused.length ?? 0,
            },
            action_boundary: {
                installed: "raw CDP Fetch.requestPaused, attached before the executor",
                // "owner" when the run was started with --mine, "stranger" otherwise -- see
                // docs/ARCHITECTURE.md.
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
            model_cost_basis: locateTarget
                ? { covers: "programmatic screenshot-bound locator; coding-agent cost unknown" }
                : locatorEnabled
                    ? {
                        covers: "server-side target grounding per act; the coding agent drives",
                    }
                    : {
                        covers: "nothing: the coding agent drives and grounds this run",
                    },
        }, null, 2)}\n`, { mode: 0o600 });
        await writeFile(join(runDir, "production-run-report.json"), `${JSON.stringify({
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
            model_actual_eur: locateTarget ? null : 0,
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
        }, null, 2)}\n`, { mode: 0o600 });
    }
    async function finish(args = {}) {
        if (state.finished)
            return text(state.finished);
        if (browserStartupFailure)
            throw browserStartupFailure;
        sampleCaptureScope();
        if (browserCloseFailure)
            return toolError(browserCloseFailure);
        if (captureTransitions && state.pending)
            return toolError("record the pending captured frames before finish; they must not be swept away");
        if (state.scopeExit && (args.goal_reached !== false || state.events.length === 0))
            return toolError(`${state.scopeExit} No complete in-scope transition supports sealing this attempt as requested. Acquired files are retained at ${runDir}; close this capture if nothing is recordable.`);
        if (state.captureFailure && (args.goal_reached === true || state.events.length === 0))
            return toolError(`${state.captureFailure} No complete post-input evidence supports a goal claim. Acquired files are retained at ${runDir}; close this capture without retrying the input.`);
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
            if (args.goal_reached !== false ||
                !wallWhy ||
                !observed?.screenshot_path ||
                state.stepsUsed !== 0 ||
                state.pending) {
                return toolError("nothing was recorded, so there is no map to package: act and record first");
            }
            try {
                const bytes = await readFile(join(runDir, observed.screenshot_path));
                if (!bytes.length || digest(bytes) !== observed.screenshot_sha256)
                    throw new Error("unreadable");
            }
            catch {
                return toolError("the observed wall screenshot is not readable; re-observe before finishing");
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
                return toolError("goal_screenshots requires a directed goal and goal_reached: true");
            try {
                selected = recordedSelection(state.events, args.goal_screenshots);
                for (const item of selected) {
                    const bytes = await readFile(join(runDir, item.screenshot_path));
                    if (!bytes.length || digest(bytes) !== item.screenshot_sha256)
                        throw new Error(`selected screenshot ${item.screenshot_path} is empty or differs from its recorded hash`);
                }
            }
            catch (error) {
                // Strict selection stays strict: no silent dedupe, no reordering, no unknown
                // substitution. The run is retained with its recorded trace intact, so retry finish
                // on this same instance with corrected recorded ordered unique refs.
                return toolError(`${thrownMessage(error)} The run is retained with its recorded trace intact: ` +
                    `retry finish with corrected goal_screenshots that are recorded, ordered and unique, without abandoning the originals.`);
            }
        }
        if (goal && args.goal_reached === true && !selected) {
            const claimPath = state.current?.evidence.screenshot_path;
            const claimIsRecorded = state.events.some((event) => event.before.screenshot_path === claimPath ||
                event.after.screenshot_path === claimPath);
            // A claim may name only the image that the sealed trace retains. In the normal case an act
            // is pending, so the agent can simply record it; an off-site/unrecordable attempt must not
            // be papered over by silently claiming against an older image.
            if (!claimIsRecorded)
                return toolError(state.pending
                    ? "record the current act first: a goal claim must use a screenshot retained by the trace"
                    : "the current goal screenshot is not retained by the trace, so this run cannot claim the goal");
        }
        // A blocked finish must bind the actual observed wall to the trace. When the current
        // screen differs from every retained screenshot this refuses BEFORE sealing, cleanup or
        // packaging, so the caller can record it and finish again correctly.
        const blockedSelection = selectNonzeroBlockedShot({
            why: args.why,
            unreached: goal ? args.goal_reached === false : false,
            selected,
        });
        if (blockedSelection && "error" in blockedSelection)
            return toolError(blockedSelection.error);
        // finish only reaches packaging with an observed entry URL (observe ran before any act,
        // and the zero-event path above returns early without one), so this throw is unreachable.
        const entryUrl = state.entryUrl;
        if (!entryUrl)
            throw new Error("no URL yet: pass one to observe, or start the server with a URL");
        if (captureTransitions) {
            // Stop the product before any positive sidecar is written. The session remains
            // available for boundary metrics, but no input or second native close is allowed.
            await closeCaptureBrowser();
            if (state.scopeExit && (args.goal_reached !== false || state.events.length === 0))
                return toolError(`${state.scopeExit} Browser closed without sealing a goal; retained evidence is at ${runDir}.`);
        }
        // The public pack is read from the product's own landing page by plain code -- no model call,
        // no journeys, just what that page says about itself. The packager binds the map to it.
        const pack = await timing.span("pack.author", () => authorPack(entryUrl));
        const packBytes = `${JSON.stringify(pack, null, 2)}\n`;
        const packDir = join(resolve(outputRoot), "packs", runId);
        await mkdir(packDir, { recursive: true });
        const packPath = join(packDir, "public-pack.json");
        await writeFile(packPath, packBytes, { mode: 0o600 });
        const publicPackSha256 = sha256Text(Buffer.from(packBytes));
        await timing.span("evidence.sidecars", () => writeSidecars(args.why, publicPackSha256, goal ? args.goal_reached === true : null, selected, goal ? args.goal_reached === false : false));
        // An attempt that never became a recorded event never happened -- so any screenshot it left
        // behind must not either, or the packager (correctly) refuses the whole candidate over it.
        // The one exception is an observation-only blocked finish, whose single observed wall
        // screenshot is explicit sealed evidence (see the blocked marker in explorer-result.json).
        if (!captureTransitions)
            await timing.span("evidence.sweep", () => sweepUnreferencedScreenshots(state.events.length === 0 && state.current?.evidence?.screenshot_path
                ? [state.current.evidence.screenshot_path]
                : []));
        if (!captureTransitions) {
            await timing.span("browser.cleanup", async () => {
                await state.session?.close();
            });
        }
        state.session = null;
        await timing.span("session.cleanup", cleanupSession);
        let result;
        try {
            result = await timing.span("packaging", () => packageRun({
                runId,
                runPath: runDir,
                outputPath: join(resolve(outputRoot), "maps", runId),
                publicPackPath: packPath,
                publicPackSha256,
            }));
        }
        catch (error) {
            // The run's screenshots, trace and sidecars are all still on disk at runDir -- nothing here
            // was deleted or half-applied. This is not a transient error: retrying finish() unchanged
            // will fail the same way every time. Say so plainly instead of looking like something worth
            // five retries.
            throw new Error(`packaging failed and was not retried: ${thrownMessage(error)}. ` +
                `The run's evidence is intact at ${runDir} -- fix what the message names there, or hand ` +
                `that directory to someone who can, rather than calling finish again unchanged.`);
        }
        // Directed runs only: the same screens as one picture, in order. The candidate is sealed and
        // read-only once packaged, so it is written beside it. A failure here is cosmetic.
        let stripPath = null;
        if (goal) {
            const stripOutput = `${result.output_path}-strip.png`;
            stripPath = stripOutput;
            const { renderStrip } = await import("./flow-strip.mjs");
            await timing
                .span("render.strip", () => renderStrip({
                candidateDir: result.output_path,
                outputPath: stripOutput,
                heading: goal,
                subheading: new URL(entryUrl).host,
            }))
                .catch(() => {
                stripPath = null;
            });
        }
        // This route has no key of ours: the coding agent driving it IS the model, so handing it
        // dated candidates from the store is exactly the judgment it can make and we cannot. Same
        // rule as the CLI handoff -- report what was found, never claim the product lacks anything.
        // Mirrors exactly what writeSidecars seals as stop_reason above: goal_claimed is
        // `args.goal_reached === true` and no wall. Anything else fell short, walls included.
        let alternatives = null;
        if (goal &&
            !(args.goal_reached === true && !state.walled && !state.scopeExit && !state.captureFailure)) {
            let origin = null;
            try {
                origin = new URL(entryUrl).origin;
            }
            catch {
                origin = null;
            }
            alternatives = await alternativesFromStore({
                mapsRoot: join(resolve(outputRoot), "maps"),
                goal,
                origin,
                excludeRunId: runId,
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
            ...(alternatives
                ? {
                    already_captured: alternatives,
                    already_captured_markdown: formatAlternatives(alternatives).join("\n"),
                }
                : {}),
        };
        const markdownLink = (label, path) => `[${label}](<${path.replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll("\n", "%0A")}>)`;
        if (selected) {
            state.finished.evidence_markdown = selected
                .map((item, index) => markdownLink(`Captured screen ${index + 1} — ${item.captured_at ?? "date unavailable"}`, join(result.output_path, item.screenshot_path)))
                .join("\n\n");
            if (declarationWritten)
                state.finished.evidence_markdown += `\n\n${markdownLink("Preparation declaration (not independent verification)", declarationPath)}`;
            state.finished.evidence_markdown += `\n\n${markdownLink("Local timing", join(timing.directory, "summary.md"))}`;
        }
        else if (state.events.length === 0 &&
            state.current?.evidence?.screenshot_path) {
            // Observation-only blocked evidence through the standard markdown contract: the sealed
            // wall image with NOT-reached and its original timestamp, never a success claim.
            const observed = state.current.evidence;
            state.finished.evidence_markdown =
                `${markdownLink(`Blocked wall — ${observed.observed_at ?? "date unavailable"}`, join(result.output_path, observed.screenshot_path))}\n\n` +
                    `Goal NOT reached: ${typeof args.why === "string" ? args.why.trim() : "unstated"}\n\n` +
                    markdownLink("Local timing", join(timing.directory, "summary.md"));
        }
        else if (goal && args.goal_reached === false && state.events.length > 0) {
            // Nonzero-action blocked evidence through the same standard markdown contract: the
            // actual observed wall bound by selectNonzeroBlockedShot (already refused above when
            // the current screen differs from the trace) with NOT-reached and its original
            // timestamp. The image is already sealed in the candidate via the trace; this names
            // it without claiming success.
            const blockedShotSelection = selectNonzeroBlockedShot({
                why: args.why,
                unreached: true,
                selected,
            });
            const shot = blockedShotSelection && "shot" in blockedShotSelection
                ? blockedShotSelection.shot
                : undefined;
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
            if (captureTransitions)
                await closeCaptureBrowser();
            else
                await timing.span("browser.cleanup", async () => {
                    await state.session?.close();
                });
        }
        finally {
            removeScopeListener?.();
            removeScopeListener = null;
            state.session = null;
            try {
                await timing.span("session.cleanup", cleanupSession);
            }
            finally {
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
                return toolError("this capture is closed; start a new prepared attempt");
            if (name === "observe")
                return await observe(args);
            if (name === "act")
                return await act(args);
            if (name === "record")
                return await record();
            if (name === "finish")
                return await finish(args);
            return toolError(`unknown tool ${name}`);
        }
        catch (error) {
            return toolError(`${thrownMessage(error)}\nLocal timing: ${timing.directory}` +
                (declarationWritten
                    ? `\nPreparation declaration: ${declarationPath}`
                    : ""));
        }
    }
    function handleCall(name, args = {}) {
        // This browser has one current observation. Concurrent callers must not authenticate or act twice.
        const result = callQueue.then(async () => {
            let response;
            let timingReceipt;
            try {
                const label = TOOLS.some((tool) => tool.name === name)
                    ? name
                    : "unknown";
                response = await timing.span(`tool.${label}`, () => dispatchCall(name, args));
            }
            finally {
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
        callQueue = result.catch(() => { });
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
            throw new Error(`caller target locator is not configured: ${resolution.reason}. ` +
                `Set RELEASHED_LOCATOR=midscene with MIDSCENE_MODEL_BASE_URL, MIDSCENE_MODEL_NAME and ` +
                `MIDSCENE_MODEL_FAMILY (verified: codex://app-server with gpt-5.6-sol and gpt-5, plus ` +
                `MIDSCENE_MODEL_REASONING_ENABLED=true and MIDSCENE_MODEL_REASONING_EFFORT=low; confirm access ` +
                `with \`codex login status\`). Caller-supplied coordinates remain available only as an ` +
                `explicit legacy mode for tests and compatible callers.`);
        options = { ...options, locator: resolution };
    }
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const explorer = createExplorer(options);
    const server = new Server({ name: "releashed-explore", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, (request) => explorer.handleCall(request.params.name, request.params.arguments ?? {}));
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
            .catch(() => process.stderr.write("Capture cleanup failed; inspect the local timing report.\n"));
    };
    if (!options.timing)
        process.stderr.write(`Local capture timing: ${explorer.timing.directory}\n`);
    await explorer.timing.flush();
    await server.connect(new StdioServerTransport());
    return explorer;
}
