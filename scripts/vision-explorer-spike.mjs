// Vision-explorer spike: does the loop "screenshot -> plain-language decision -> third-party
// browser agent executes it -> screenshot" actually work against a real app?
//
// Standalone and additive. No supervisor, no policy layer, no broker, no driver interface --
// it shares nothing with the existing mapper except this repo's node_modules. LOCAL target only.
//
// The architecture under test:
//   * OUR explorer sees only a PNG. No DOM, no accessibility tree, no URL, no source. It answers
//     "what would you try next, and why" in plain English.
//   * A THIRD-PARTY browser agent (Midscene) turns that English into a screen coordinate. We do not
//     own element-finding. Midscene grounds by looking at the screenshot, so it does not care that
//     this React-Native-Web app renders its controls as role-less <div>s.
//   * OUR code dispatches the actual input at the coordinate Midscene returns (SPIKE_EXEC=locate,
//     the default) -- so every byte of input the browser receives passes through one audited place.
//     SPIKE_EXEC=aitap hands the input to Midscene too, for comparison.
//   * The drag stays ours. Midscene has no typed drag; its generic one is 20 linear steps and has
//     never met react-native-gesture-handler. Ours (threshold nudge + interpolated moves + retry)
//     is registered as a custom action, so Midscene still grounds BOTH endpoints from English and
//     only the motion is ours.
//   * A network-level action boundary sits UNDERNEATH the executor and can abort a request. It
//     reads method + URL, never what a control IS, so it is executor-agnostic.
//
// Usage:
//   CLERK_SECRET_KEY=sk_test_... ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
//     SPIKE_APP_URL=http://localhost:8423 node scripts/vision-explorer-spike.mjs
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineActionDragAndDrop } from "@midscene/core/device";
import { PlaywrightAgent } from "@midscene/web/playwright";
import { chromium } from "playwright";
import { callExplorer, explorerMaxOutputTokens, explorerModel } from "../lib/explorer-client.mjs";

const APP_URL = process.env.SPIKE_APP_URL ?? "http://localhost:8423";
const MAX_STEPS = Number(process.env.SPIKE_MAX_STEPS ?? 10);
// Our explorer's eyes. Sees the screenshot and nothing else.
export const EXPLORER_MODEL = process.env.SPIKE_EXPLORER_MODEL ?? "claude-opus-5";
// The third-party executor's grounding model. Midscene supports no Anthropic family, so this is a
// second provider and a second key -- the price of not owning element-finding.
const GROUNDING_MODEL = process.env.MIDSCENE_MODEL_NAME ?? "gemini-3.6-flash";
const GROUNDING_FAMILY = process.env.MIDSCENE_MODEL_FAMILY ?? "gemini";
const GROUNDING_BASE_URL =
  process.env.MIDSCENE_MODEL_BASE_URL ??
  (GROUNDING_FAMILY === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai/" : "https://api.openai.com/v1");
// "locate" = Midscene says WHERE, we click. "aitap" = Midscene also clicks.
const EXEC_MODE = process.env.SPIKE_EXEC ?? "locate";
const VIEWPORT = { width: 390, height: 844 };
// "drag" walks the known onboarding path to the word-order exercise before the vision loop starts.
const SCAFFOLD = process.env.SPIKE_SCAFFOLD ?? "none";
// Replay a previous run's trace.json instead of asking the explorer -- see the loop.
const REPLAY_FROM = process.env.SPIKE_REPLAY ?? null;
const OUT_ROOT = join(import.meta.dirname, "..", ".runtime", "vision-explorer-spike");

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

// ─────────────────────────── the network action boundary ───────────────────────────
// What survives the executor swap. It reads METHOD + URL, so it does not care whether the thing
// that was clicked was a <button>, a <div>, or a canvas -- nor which agent clicked it.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ONE_WAY_PATH =
  /(purchase|checkout|subscribe|billing|payment|cancel|delete|publish|send|invite|refund)/i;
// A target we don't own (read-only mode) gets no denylist at all: every method except these two
// is refused outright on that target's own origin(s), before the ONE_WAY_PATH denylist below even
// runs. See classifyRequest's "readOnly" branch.
const READ_METHODS = new Set(["GET", "HEAD"]);
// Owner mode (--mine): same-origin mutating requests are allowed -- submitting an answer, posting
// a reply -- because it is the owner's own product, EXCEPT anything money-shaped and EXCEPT
// DELETE. Matched against the path only, same reasoning as ONE_WAY_PATH below.
const OWNER_MONEY_PATH = /(billing|checkout|payment|subscribe|invoice|stripe)/i;

/**
 * The whole boundary, as one pure function -- which is why it can be tested without a browser
 * and why it transplants onto any executor that leaves request interception alone.
 *
 * options.readOnly + options.ownOrigins implement the per-target read-only mode: when a target
 * sets readOnly: true (see resolveTarget in vision-explorer-run.mjs), every non-GET/HEAD request
 * aimed at one of the target's OWN origins is refused by default -- not just the ones the
 * ONE_WAY_PATH denylist below happens to name. A target we don't own (e.g. Booking.com) can have
 * money-moving or account-mutating paths we never anticipated; default-deny is the only version of
 * this that doesn't depend on us having guessed the path. Third-party hosts (analytics, a CDN) are
 * untouched by this branch and keep falling through to the denylist below, exactly as before.
 * options.mine flips that default-deny to a default-ALLOW for same-origin mutating requests --
 * the owner using their own product -- except money-shaped paths and DELETE, which stay refused.
 * All three options default to off, so every existing caller (no options object, or a
 * target-config that never sets readOnly/mine) sees byte-identical behavior.
 */
/**
 * Opaque object ids (Clerk sessions, users, tickets) travel in URL path segments, and the boundary
 * log is retained beside the evidence -- where the candidate packager refuses any credential-shaped
 * value outright. Mask them at the point the log line is written, not later.
 */
export function maskOpaqueIds(path) {
  return (
    path
      .replace(/\/(?:sk|pk|sess|user|ticket|sit|org|client)_[A-Za-z0-9_-]+/g, "/<id>")
      // A long all-digit path segment is an opaque object id too -- ad and analytics hosts are full
      // of them ("/1960765662469/js"). About one in ten passes the Luhn check by chance, and the
      // packager then refuses the whole candidate as a card number; a w3schools run was lost to
      // three such segments. Masking them here, where every other opaque id is already masked,
      // keeps the card check untouched everywhere a card could actually be written down (the
      // visible-state evidence), and loses nothing: the boundary log exists to say WHICH KIND of
      // request was allowed or refused, never to identify a resource. Anywhere in the path, not
      // only as a whole segment -- an uploaded file called "Logopit_1788281408665.jpg" is the same
      // Luhn accident with a prefix and an extension around it.
      .replace(/\d{9,}/g, "<id>")
  );
}

export function classifyRequest({ method, url, resourceType }, { readOnly = false, ownOrigins = null, mine = false } = {}) {
  // A full-page navigation is the one request type that can strand the whole run: land the page
  // somewhere the bound-origin guard (checkActionAuthorized, in vision-explorer-run.mjs) refuses
  // every further action on, with no in-app door back. Refuse it here, BEFORE it loads, so the
  // browser stays on the page it was already on and the explorer just learns that door is closed --
  // the same "leads somewhere we couldn't follow" outcome (a no-visible-effect transition) it would
  // get from any other dead end, not a run-ending trap. This does not change what a bound run can
  // eventually reach -- ownOrigins is the exact same allow-list every other request in this function
  // is already checked against -- only WHEN a disallowed destination is refused: before the browser
  // commits to it, instead of after.
  if (resourceType === "Document" && ownOrigins) {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {
      return { verdict: "refuse", reason: "navigation refused: unparseable destination url" };
    }
    if (!ownOrigins.has(origin))
      return { verdict: "refuse", reason: `navigation refused: would leave the bound origin(s) (${origin})` };
  }
  const upperMethod = String(method).toUpperCase();
  if (readOnly && ownOrigins && !READ_METHODS.has(upperMethod)) {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {
      /* fall through to the ordinary mutating-request handling below, which itself refuses an
         unparseable URL on any non-read method */
    }
    if (origin && ownOrigins.has(origin)) {
      if (mine) {
        // Owner mode: use the product like a user, except money and DELETE, which stay refused
        // whatever verb or path got them here.
        if (upperMethod === "DELETE")
          return { verdict: "refuse", reason: "owner mode: refused DELETE to its own origin" };
        let path = url;
        try {
          path = new URL(url).pathname;
        } catch {
          /* keep the raw url; OWNER_MONEY_PATH still gets a chance to match it */
        }
        if (OWNER_MONEY_PATH.test(path))
          return {
            verdict: "refuse",
            reason: `owner mode: refused ${upperMethod} to a money-shaped path on its own origin`,
          };
        return { verdict: "allow", reason: "owner mode: same-origin mutating request allowed" };
      }
      return {
        verdict: "refuse",
        reason: `read-only target: refused ${upperMethod} to its own origin`,
      };
    }
  }
  if (!MUTATING_METHODS.has(upperMethod)) {
    return { verdict: "allow", reason: "read-only method" };
  }
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return { verdict: "refuse", reason: "unparseable url on a mutating request" };
  }
  if (ONE_WAY_PATH.test(path)) {
    return { verdict: "refuse", reason: "mutating request on a one-way action path" };
  }
  return { verdict: "allow", reason: "mutating but reversible" };
}

/**
 * Install the boundary as a raw CDP Fetch interception rather than Playwright's page.route().
 * Midscene drives the page over CDP too but never touches the Fetch or Network domains, so this
 * stays the only gate; page.route() would enable Fetch a second time and collide with it.
 */
export async function installActionBoundary(context, page, record) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Fetch.requestPaused", async ({ requestId, request, resourceType }) => {
    const { verdict, reason } = classifyRequest(
      { method: request.method, url: request.url, resourceType },
      { readOnly: record.readOnly, ownOrigins: record.origins, mine: record.mine },
    );
    // Counters the evidence trace quotes: every request the gate saw, every mutating one it let
    // through, and separately the mutating ones aimed at the target's own origin -- the only ones
    // that can be an effect of the action we just dispatched.
    record.total = (record.total ?? 0) + 1;
    // Path only, never the query string: a sanitized boundary log can be retained beside the
    // evidence without carrying whatever an app happens to put in a URL.
    let path = request.url;
    try { path = new URL(request.url).pathname; } catch { /* keep the raw value */ }
    path = maskOpaqueIds(path);
    record.events?.push({ method: request.method, path, verdict });
    try {
      if (verdict === "refuse") {
        record.refused.push({ method: request.method, url: request.url, reason });
        console.log(`  BOUNDARY REFUSED ${request.method} ${request.url} (${reason})`);
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
        return;
      }
      if (MUTATING_METHODS.has(request.method)) {
        record.allowed += 1;
        if (record.origin && request.url.startsWith(record.origin))
          record.sameOriginMutations = (record.sameOriginMutations ?? 0) + 1;
      }
      await cdp.send("Fetch.continueRequest", { requestId });
    } catch {
      // The frame can go away mid-flight; a lost continue is not a boundary failure.
    }
  });
  return cdp;
}

// ─────────────────────────── disposable dev Clerk user ───────────────────────────
export async function clerk(path, init = {}) {
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`Clerk ${path} failed: HTTP ${res.status}`);
  return body;
}

export async function signIn(page, ticket) {
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.Clerk), { timeout: 20_000 });
  await page.evaluate(async (token) => {
    const clerkSdk = window.Clerk;
    if (!clerkSdk.loaded) {
      await new Promise((resolve) => clerkSdk.addListener(({ client }) => client && resolve()));
    }
    const result = await clerkSdk.client.signIn.create({ strategy: "ticket", ticket: token });
    await clerkSdk.setActive({ session: result.createdSessionId });
  }, ticket);
  // Where a freshly signed-in account lands is the product's call, not ours: a brand-new account
  // goes to onboarding, one the product considers already set up goes to its home surface. Waiting
  // for only the first made a legitimate redirect look like a broken sign-in.
  await page.waitForURL(/\/(onboarding-coach|today)\b/, { timeout: 25_000 });
  // The first frame after the route change is still blank; without this the explorer's opening
  // screenshot is an empty cream rectangle and it wastes a step poking at nothing.
  await page.waitForTimeout(3_000);
}

// ─────────────────────────── our drag motion ───────────────────────────
// The one browser mechanic we keep. react-native-gesture-handler ignores a plain press-move-release:
// its Pan recognizer only arms after the pointer has travelled past a minimum distance, and it wants
// several intermediate moves before it will treat the gesture as a drag rather than a tap. A generic
// linear interpolation misses both. Registered through Midscene's custom-action hook, so Midscene
// still grounds "the word 'Ik'" and "the empty answer box" from plain English -- only the motion
// between those two points is ours.
const DRAG_ARM_NUDGE_PX = 24;

export async function ourDragMotion(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + DRAG_ARM_NUDGE_PX, from.y, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(900); // let the reflow spring settle before anything reads the DOM
}

// ─────────────────────────── scaffolding to the hard case ───────────────────────────
// NOT part of the architecture under test. The word-order exercise sits several screens into one
// onboarding track, and letting the explorer wander there costs money without testing anything new.
// SPIKE_SCAFFOLD=drag walks the known path with plain testid clicks and hands the vision loop a
// browser already parked on the exercise.
async function waitForUsable(page, selector, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const usable = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return (
        el.getAttribute("aria-disabled") !== "true" &&
        getComputedStyle(el).pointerEvents !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }, selector);
    if (usable) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for usable ${selector}`);
}

async function scaffoldToDragExercise(page) {
  const click = async (testId) => {
    const selector = `[data-testid="${testId}"]`;
    await waitForUsable(page, selector);
    await page.locator(selector).click();
  };
  await waitForUsable(page, '[data-testid="coach-chip-b1"]');
  for (const chip of [
    "coach-chip-a2",
    "coach-chip-speaking",
    "coach-chip-knm",
    "coach-chip-reading",
    "coach-chips-cta-writing",
  ]) {
    await click(chip);
  }
  // Warm-up reading quiz: on this track the first rendered option is the correct answer. Earlier
  // steps leave disabled radios in the DOM, so pick the first USABLE one, not the first one.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const index = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="radio"]')).findIndex((el) => {
        const rect = el.getBoundingClientRect();
        return (
          el.getAttribute("aria-disabled") !== "true" &&
          getComputedStyle(el).pointerEvents !== "none" &&
          rect.width > 0
        );
      }),
    );
    if (index >= 0) {
      await page.locator('[role="radio"]').nth(index).click();
      break;
    }
    await page.waitForTimeout(200);
  }
  await waitForUsable(page, '[data-testid="build_card.answer_box"]');
  await page.locator('[data-testid="build_card.answer_box"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1_000);
}

// ─────────────────────────── the explorer (images in, English out) ───────────────────────────
export const EXPLORER_SYSTEM = `You are shown screenshots of a product you know nothing about. You cannot
see its code, its address, its HTML or any text description of it -- only the picture, the way a
person sitting in front of the screen would.

Your job each turn: decide the ONE next thing a curious new user would try, say it as a single plain
English instruction, and also name the thing to point at as a short noun phrase someone could find by
looking ("the orange Continue button at the bottom", "the word 'Ik' in the word bank"). Never a
technical selector. Keep making progress -- do not repeat an instruction that already ran.

Reply with JSON only:
{"screen":"<short name for what you are looking at>",
 "instruction":"<one action, plain English>",
 "action":"tap" | "type" | "scroll" | "drag",
 "target":"<noun phrase for the thing to point at; for a drag, what you pick up>",
 "drop_target":"<for a drag only: noun phrase for where it lands, else null>",
 "text":"<for type only: what to type, else null>",
 "why":"<one sentence>",
 "done":false}`;

// The word-order exercise accepts a TAP as well as a drag, and left to itself the explorer taps --
// which is what a person would do, and which sails past the mechanic that defeated our own driver.
// SPIKE_FORCE_DRAG=1 makes it phrase the same action as a drag, so the executor is actually put on
// the hard case instead of routed around it.
const FORCE_DRAG_RULE = `\n\nThis screen's words MUST be moved by dragging, not tapping. Use
"action":"drag" every turn, with "target" the word to pick up and "drop_target" where it lands.`;

function parseJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Explorer did not return JSON: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

// Prompt caching. Every turn resends the same long system prompt plus an append-only instruction
// history, and only then one fresh screenshot -- on a 60-step run that was the great majority of
// ~200k input tokens, reprocessed at full price each time. Caching matches on a byte prefix, so the
// STABLE bytes have to come first: the system prompt is one breakpoint, and the instruction history
// (turn N's text is literally turn N-1's text plus one line) is the second, ahead of the screenshot.
// Everything that changes every turn -- the screenshot, the current page address, the question --
// sits after the last breakpoint. Steps are seconds apart, well inside the 5-minute ephemeral TTL.
// The image deliberately still comes before the question text, which is the documented order for
// vision quality; only the stable history moved ahead of it.
export async function decide(model, screenshot, history, usage, systemOverride = null, pageContext = null) {
  const { text, usage: called } = await callExplorer({
    model,
    maxOutputTokens: explorerMaxOutputTokens(1500),
    system:
      systemOverride ??
      (process.env.SPIKE_FORCE_DRAG === "1" ? EXPLORER_SYSTEM + FORCE_DRAG_RULE : EXPLORER_SYSTEM),
    history: history.length
      ? `Instructions you already gave, oldest first:\n${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
      : "This is the first screen.",
    screenshot,
    question: [pageContext, "What would you try next, and why?"].filter(Boolean).join("\n\n"),
  });
  usage.input += called.input;
  usage.output += called.output;
  // Cached tokens are billed at their own rates (see lib/scaffold.mjs), so they are counted apart
  // from plain input -- folding them in would overstate the run's cost by an order of magnitude.
  usage.cacheWrite = (usage.cacheWrite ?? 0) + called.cacheWrite;
  usage.cacheRead = (usage.cacheRead ?? 0) + called.cacheRead;
  return parseJson(text);
}

// ─────────────────────────── harness instrumentation (NOT explorer input) ───────────────────────
// These read the DOM to VERIFY what happened. The explorer never sees any of it -- if it did, the
// source-blind claim would be dead. They exist so the trace can say "the sentence was actually
// assembled" rather than "the model said it was".
const onDragExercise = (page) =>
  page
    .locator('[data-testid="build_card.answer_box"]')
    .count()
    .then((n) => n > 0);

function assembledSentence(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="build_card.chip."]'))
      .filter(
        (el) =>
          (el.getAttribute("aria-valuetext") ??
            (el.getAttribute("aria-label") ?? "").split("|")[1]) === "answer",
      )
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          word: el.getAttribute("data-testid").slice("build_card.chip.".length),
          x: r.x,
          y: r.y,
        };
      })
      .sort((a, b) => Math.round(a.y / 4) - Math.round(b.y / 4) || a.x - b.x)
      .map((c) => c.word)
      .join(" "),
  );
}

// ─────────────────────────── executing one plain-language decision ───────────────────────────
export async function execute(agent, page, decision) {
  if (decision.action === "drag" && decision.target && decision.drop_target) {
    // Midscene grounds both endpoints from English; the motion between them is ours.
    await agent.callActionInActionSpace("DragAndDrop", {
      from: { prompt: decision.target },
      to: { prompt: decision.drop_target },
    });
    return { executor: "midscene:DragAndDrop + our drag motion" };
  }
  if (decision.action === "type" && decision.text) {
    await agent.aiInput(decision.target, { value: decision.text });
    return { executor: "midscene:aiInput" };
  }
  if (decision.action === "scroll") {
    await agent.aiScroll(
      { direction: "down", scrollType: "once", distance: 400 },
      decision.target ?? undefined,
    );
    return { executor: "midscene:aiScroll" };
  }
  if (EXEC_MODE === "aitap") {
    await agent.aiTap(decision.target);
    return { executor: "midscene:aiTap" };
  }
  // Default: the executor only says WHERE. Our code is the single place input is dispatched.
  const located = await agent.aiLocate(decision.target);
  const [x, y] = Array.isArray(located.center) ? located.center : [located.center.x, located.center.y];
  await page.mouse.click(x, y);
  // rect and dpr are recorded because the coordinate SPACE is the thing under suspicion: a
  // grounded point that is confidently returned but systematically offset clicks the neighbouring
  // control and reports success, which is the worst failure a mapper can have.
  return { executor: "midscene:aiLocate + our click", center: [x, y], rect: located.rect, dpr: located.dpr };
}

// ─────────────────────────── the loop ───────────────────────────
async function main() {
  if (!APP_URL.startsWith("http://localhost"))
    throw new Error(`Refusing a non-local target: ${APP_URL}`);
  if (!process.env.CLERK_SECRET_KEY?.startsWith("sk_test"))
    throw new Error("CLERK_SECRET_KEY (sk_test) is required");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
  // Midscene resolves its grounding model entirely from env, and the CHOICE OF MODEL is the whole
  // ballgame: a general-purpose model returns confident coordinates that are ~50-80px off on this
  // app and silently clicks the neighbouring row, while a model trained for GUI grounding lands
  // inside the real element. Default to the latter. `.runtime/offset-probe.mjs` measures any
  // candidate against the DOM's own bounding box -- run it before trusting a new one.
  process.env.MIDSCENE_MODEL_NAME ??= GROUNDING_MODEL;
  process.env.MIDSCENE_MODEL_FAMILY ??= GROUNDING_FAMILY;
  process.env.MIDSCENE_MODEL_BASE_URL ??= GROUNDING_BASE_URL;
  process.env.MIDSCENE_MODEL_API_KEY ??= GROUNDING_FAMILY === "gemini" ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY;
  if (GROUNDING_FAMILY === "gpt-5") {
    // The gpt-5 family sends reasoning_effort "none" unless reasoning is explicitly ENABLED, and
    // temperature 0 -- the mini variants reject both outright.
    process.env.MIDSCENE_MODEL_REASONING_ENABLED ??= "true";
    process.env.MIDSCENE_MODEL_REASONING_EFFORT ??= "minimal";
    process.env.MIDSCENE_MODEL_TEMPERATURE ??= "1";
  }
  if (!process.env.MIDSCENE_MODEL_API_KEY) throw new Error(`No API key for grounding family ${GROUNDING_FAMILY}`);

  const runDir = join(OUT_ROOT, new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"));
  await mkdir(runDir, { recursive: true });
  const anthropic = explorerModel(EXPLORER_MODEL);
  const explorerUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  const username = `vision_spike_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const user = await clerk("/users", {
    method: "POST",
    body: JSON.stringify({ username, first_name: "Vision spike" }),
  });
  console.log(`disposable Clerk user: ${user.id}`);

  const trace = {
    app_url: APP_URL,
    explorer_model: EXPLORER_MODEL,
    grounding_model: GROUNDING_MODEL,
    exec_mode: EXEC_MODE,
    steps: [],
    boundary: { allowed: 0, refused: [] },
  };

  // We launch the browser; Midscene attaches to the page we hand it. That ordering is what keeps
  // the action boundary underneath the executor rather than beside it.
  // We launch the browser and own the page; Midscene attaches to the page we hand it. That
  // ordering is what keeps the action boundary underneath the executor rather than beside it.
  const browser = await chromium.launch({ headless: true });
  // A run that ends with "target closed" mid-loop is almost always something OUTSIDE this script
  // taking the browser away; log it so the trace says so instead of blaming the executor.
  browser.on("disconnected", () => console.log("WARNING: browser disconnected"));
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  let agent;

  try {
    await page.setViewportSize(VIEWPORT);
    await installActionBoundary(context, page, trace.boundary);

    const { token } = await clerk("/sign_in_tokens", {
      method: "POST",
      body: JSON.stringify({ user_id: user.id, expires_in_seconds: 3600 }),
    });
    await signIn(page, token);
    console.log(`signed in, landed on ${page.url()}`);

    if (SCAFFOLD === "drag") {
      await scaffoldToDragExercise(page);
      trace.scaffolded_to = "word-order drag exercise";
      console.log(
        "scaffolded to the word-order drag exercise (harness clicks, not explorer decisions)",
      );
    }

    agent = new PlaywrightAgent(page, {
      // A cache hit replays a grounded coordinate with no model call, keyed on the plain-language
      // prompt -- the closest this architecture gets to a reproducible run.
      cache: { id: "vision-explorer-spike", strategy: "read-write" },
      customActions: [defineActionDragAndDrop((from, to) => ourDragMotion(page, from, to))],
    });

    const history = [];
    let reachedDrag = false;
    let dragVerified = null;
    const replay = REPLAY_FROM ? JSON.parse(await readFile(REPLAY_FROM, "utf8")).steps : null;
    const stepCount = replay ? Math.min(replay.length, MAX_STEPS) : MAX_STEPS;

    for (let step = 1; step <= stepCount; step += 1) {
      const beforePath = join(runDir, `step-${String(step).padStart(2, "0")}-before.png`);
      const beforeShot = await page.screenshot({ path: beforePath });
      const urlBefore = page.url();

      // Replay mode reuses a previous run's plain-language decisions verbatim and makes NO explorer
      // call, so the only variable left between the two runs is Midscene's grounding cache.
      const decision = replay
        ? replay[step - 1]
        : await decide(anthropic, beforeShot, history, explorerUsage);
      history.push(decision.instruction);
      console.log(
        `\n[${step}] ${replay ? "replay" : `sees "${decision.screen}"`} -> "${decision.instruction}"${replay ? "" : `\n    why: ${decision.why}`}`,
      );

      const before = agent.metrics;
      let executed = { success: false, executor: "none", message: "" };
      try {
        const outcome = await execute(agent, page, decision);
        executed = { success: true, ...outcome, message: "" };
      } catch (error) {
        executed = {
          success: false,
          executor: decision.action,
          // "failed to locate element" is Midscene refusing to guess; anything else is a different
          // class of failure and the report needs to tell them apart.
          failure: /failed to locate element/i.test(String(error?.message ?? ""))
            ? "no-element-found"
            : "other",
          message: String(error?.message ?? error).slice(0, 300),
        };
      }
      const after = agent.metrics;
      const grounding = {
        calls: after.calls - before.calls,
        prompt_tokens: after.totalPromptTokens - before.totalPromptTokens,
        completion_tokens: after.totalCompletionTokens - before.totalCompletionTokens,
        ms: after.totalTimeCostMs - before.totalTimeCostMs,
      };
      grounding.cache_hit = executed.success && grounding.calls === 0;
      await page.waitForTimeout(1200);

      const afterPath = join(runDir, `step-${String(step).padStart(2, "0")}-after.png`);
      const afterShot = await page.screenshot({ path: afterPath });
      // A step that ran without error but left the screen byte-identical is the dangerous case:
      // the executor reported success and nothing happened, or it clicked the wrong dead pixel.
      const visibleChange = sha256(beforeShot) !== sha256(afterShot);

      const atDrag = await onDragExercise(page);
      if (atDrag) {
        reachedDrag = true;
        dragVerified = await assembledSentence(page);
      }

      trace.steps.push({
        step,
        screen_named_by_explorer: decision.screen,
        instruction: decision.instruction,
        action: decision.action,
        target: decision.target,
        drop_target: decision.drop_target ?? null,
        why: decision.why,
        executed,
        grounding,
        outcome: !executed.success
          ? `error:${executed.failure}`
          : visibleChange
            ? "acted"
            : "no-visible-change",
        url_before: urlBefore,
        url_after: page.url(),
        before_image: beforePath,
        after_image: afterPath,
        harness_check: { on_drag_exercise: atDrag, answer_row: dragVerified },
      });
      console.log(
        `    ${executed.executor} ok=${executed.success} ${visibleChange ? "screen CHANGED" : "screen unchanged"} | grounding calls=${grounding.calls}${grounding.cache_hit ? " (CACHE HIT)" : ""} tok=${grounding.prompt_tokens}/${grounding.completion_tokens}${atDrag ? ` | answer row: "${dragVerified}"` : ""}${executed.message ? ` | ${executed.message}` : ""}`,
      );

      if (decision.done) break;
    }

    // Boundary evidence: fire one request the run must never be allowed to make, from inside the
    // page the third-party executor is driving. If the hook is real, it never leaves the browser.
    const probe = await page.evaluate(async (base) => {
      try {
        const res = await fetch(`${base}/api/billing/checkout`, { method: "POST", body: "{}" });
        return { blocked: false, status: res.status };
      } catch (error) {
        return { blocked: true, error: String(error).slice(0, 120) };
      }
    }, APP_URL);
    trace.boundary.probe = probe;
    console.log(
      `\nboundary probe (POST /api/billing/checkout): ${probe.blocked ? "BLOCKED" : `NOT blocked (HTTP ${probe.status})`}`,
    );

    trace.reached_drag_exercise = reachedDrag;
    trace.assembled_sentence = dragVerified;
    trace.explorer_usage = explorerUsage;
    trace.grounding_metrics = agent.metrics;
    trace.outcome_counts = trace.steps.reduce((acc, s) => ({ ...acc, [s.outcome]: (acc[s.outcome] ?? 0) + 1 }), {});
  } catch (error) {
    trace.error = String(error?.stack ?? error);
  } finally {
    await agent?.destroy().catch(() => {});
    await browser.close().catch(() => {});
    await clerk(`/users/${user.id}`, { method: "DELETE" }).catch(() =>
      console.log(`WARNING: could not delete ${user.id}`),
    );
  }

  const tracePath = join(runDir, "trace.json");
  await writeFile(tracePath, JSON.stringify(trace, null, 2));
  console.log(`\ntrace: ${tracePath}`);
  console.log(
    `explorer tokens: ${trace.explorer_usage?.input ?? 0} in / ${trace.explorer_usage?.output ?? 0} out`,
  );
  if (trace.error) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("vision-explorer-spike.mjs")) await main();
