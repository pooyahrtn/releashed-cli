// The vision loop, emitting the SAME evidence the candidate packager already consumes.
//
// scripts/vision-explorer-spike.mjs proved the loop works: screenshot -> our source-blind explorer
// decides in plain English -> Midscene grounds the noun phrase -> our code dispatches the input ->
// screenshot. It wrote its own ad-hoc trace.json. This runner keeps that loop verbatim (it imports
// the spike's pieces rather than re-implementing them) and replaces the ad-hoc trace with the
// production evidence format: runs/<id>/target-session-1/{observations.jsonl, screenshots/, ...},
// so `npm run package-candidate` and the renderer work unchanged.
//
// What is and is not shown to the explorer:
//   * SHOWN: one PNG per turn, the plain-English instructions it has already given, and -- to fix a
//     real burrowing bug (see the page-identity paragraph in MISSION below) -- the current page's
//     bare address (origin + path, no query string) plus the set of addresses already visited.
//   * NOT SHOWN: the DOM, the accessibility tree, any route name, any product vocabulary. The
//     address is an opaque string to the explorer, same as a screenshot pixel -- it is given only so
//     "a page I have not seen" means a genuinely different address, not just a different picture of
//     the one it is already on (a toggled switch or an opened tab is a new picture, same address).
// The accessibility tree IS read every turn, but only as harness instrumentation -- it is the
// retained visible-state evidence the renderer hashes and the reviewer reads, exactly as in the
// old stack, and it never enters a model prompt. Same standing as the spike's DOM verification.
//
// Usage: every target needs a --target-config file naming its auth mode (clerk / saved-session /
// public) and the public pack it packages against -- there is no built-in default target.
//   SPIKE_APP_URL=https://app.cal.com \
//     node --env-file=/path/to/.env.local scripts/vision-explorer-run.mjs --steps 60 \
//     --target-config targets/calcom.json
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  budgetExhausted,
  checkActionAuthorized,
  detectWall,
  onBoundOrigin,
  FORBIDDEN_VERBS,
  OWNER_FORBIDDEN_VERBS,
} from "../lib/run-limits.mjs";
import {
  buildTransitionEvent,
  identifyTarget,
  observeScreen,
  pad,
  redactContactDetails,
} from "../lib/explorer-evidence.mjs";
import { defineActionDragAndDrop } from "@midscene/core/device";
import { PlaywrightAgent } from "@midscene/web/playwright";
import { chromium } from "playwright";
import { explorerModel } from "../lib/explorer-client.mjs";
import { isAuthFlowUrl, modelCostEur, priceSourceFor, sha256Text } from "../lib/scaffold.mjs";
import {
  EXPLORER_MODEL,
  EXPLORER_SYSTEM,
  clerk,
  decide,
  execute,
  installActionBoundary,
  ourDragMotion,
  signIn,
} from "./vision-explorer-spike.mjs";

// Fallback viewport for a target that names no --target-config, or one whose config omits
// "viewport" -- unchanged, so the original inburgering.coach path keeps this exact phone size.
const DEFAULT_VIEWPORT = { width: 390, height: 844 };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Midscene failures quote internal file paths; the packager refuses any retained text carrying one.
const scrub = (text) =>
  String(text)
    .replace(/\/(?:Users|home|private|var)\/[^\s"']+/g, "<path>")
    .slice(0, 200);

// The target ORIGIN is read from SPIKE_APP_URL, not a flag: the imported signIn (used by clerk-mode
// auth) closes over the spike module's own copy of that variable, so a flag here could silently
// disagree with it. What --target-config adds is everything ELSE about a target (whether it's
// worth an allow-list entry at all, how to sign in, which public-pack hash it packages against).
// There is no built-in default target -- every target, including a local one, is approved by
// writing it a --target-config file.

// A malformed hash (not 64 hex chars) was already rejected before this existed. A well-formed but
// WRONG hash was not: it passed config-load, ran the whole exploration, and only failed at
// packaging time (lib/candidate-packager.mjs), long after the model spend. Hashing the actual pack
// file here closes that gap at config-load time instead.
async function verifyPublicPackHash(packPath, expectedSha256, source) {
  let bytes;
  try {
    bytes = await readFile(packPath);
  } catch (error) {
    throw new Error(`Could not read the public pack named by ${source} (${packPath}): ${error?.message ?? error}`);
  }
  const actual = sha256(bytes);
  if (actual !== expectedSha256)
    throw new Error(
      `${source} publicPackSha256 (${expectedSha256}) does not match the actual bytes of ${packPath} (sha256 ${actual})`,
    );
}

export function options(argv) {
  const values = {
    app: process.env.SPIKE_APP_URL,
    steps: 24,
    targetConfigPath: null,
    // The other two budgets. Null means unbounded, which is exactly today's behavior.
    minutes: null,
    maxEur: null,
    // Where the retained run is written. The default is the installation's own runs/ directory,
    // byte-for-byte where every existing run went; the CLI passes a directory in the user's project
    // instead, so a global install never writes inside node_modules.
    runDirRoot: process.env.RELEASHED_RUN_DIR ?? join(import.meta.dirname, "..", "runs"),
  };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--steps") values.steps = Number(argv[i + 1]);
    else if (argv[i] === "--target-config") values.targetConfigPath = argv[i + 1];
    else if (argv[i] === "--minutes") values.minutes = Number(argv[i + 1]);
    else if (argv[i] === "--budget-eur") values.maxEur = Number(argv[i + 1]);
    else if (argv[i] === "--run-dir") values.runDirRoot = resolve(argv[i + 1]);
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(values.steps) || values.steps < 1 || values.steps > 60)
    throw new Error("--steps must be 1..60");
  if (values.minutes !== null && !(values.minutes > 0)) throw new Error("--minutes must be a positive number");
  if (values.maxEur !== null && !(values.maxEur > 0)) throw new Error("--budget-eur must be a positive number");
  return values;
}

// Resolves everything about WHICH target this run drives, beyond the origin itself (already fixed
// by SPIKE_APP_URL): the auth mode, the saved-session file (if any), and the public-pack hash the
// run report will carry. There is no built-in default target -- a target is approved by writing it
// a --target-config file, full stop.
export async function resolveTarget(app, targetConfigPath) {
  if (!targetConfigPath) {
    throw new Error("Pass --target-config for this target -- there is no built-in default target");
  }
  let config;
  try {
    config = JSON.parse(await readFile(resolve(targetConfigPath), "utf8"));
  } catch (error) {
    throw new Error(`Could not read --target-config ${targetConfigPath}: ${error?.message ?? error}`);
  }
  // Tying the config to SPIKE_APP_URL, rather than letting the config's own "url" field drive
  // navigation, is deliberate: signIn() closes over the spike module's SPIKE_APP_URL directly, so
  // if the two ever disagreed, clerk-mode sign-in would silently navigate somewhere the rest of
  // this script thinks it isn't.
  if (config.url !== app)
    throw new Error(
      `--target-config's "url" (${config.url}) does not match SPIKE_APP_URL (${app}) -- set SPIKE_APP_URL to match the config`,
    );
  if (config.authMode !== "clerk" && config.authMode !== "saved-session" && config.authMode !== "public")
    throw new Error('--target-config "authMode" must be "clerk", "saved-session", or "public"');
  if (!/^[0-9a-f]{64}$/.test(config.publicPackSha256 ?? ""))
    throw new Error(
      "--target-config publicPackSha256 must be a 64-char hex sha256 -- author this target's public pack first (scripts/author-public-pack.mjs) rather than reusing another target's hash",
    );
  if (typeof config.publicPackPath !== "string")
    throw new Error(
      '--target-config must set "publicPackPath" (the exact pack file publicPackSha256 is checked against) -- ' +
        "a well-formed-but-wrong hash must be caught here, not at packaging time",
    );
  await verifyPublicPackHash(
    resolve(dirname(resolve(targetConfigPath)), config.publicPackPath),
    config.publicPackSha256,
    `--target-config ${targetConfigPath}`,
  );
  if (config.authMode === "saved-session" && typeof config.savedSessionPath !== "string")
    throw new Error('--target-config with authMode "saved-session" must set "savedSessionPath"');
  // The bound-origin guard (see the "left the bound origin" check below) refuses navigation off
  // the target's own host(s) -- the same safety story as the original single-origin binding, just
  // widened to an explicit list. A product can legitimately span more than one host (cal.com's
  // marketing site vs. app.cal.com's product), so a config MAY name more of its own origins under
  // "additionalOrigins"; it must still be an exact allow-list, never a wildcard or a third party's
  // host, so each entry is validated as a normalized origin exactly like the primary one.
  const additionalOrigins = config.additionalOrigins ?? [];
  if (!Array.isArray(additionalOrigins))
    throw new Error('--target-config "additionalOrigins" must be an array of origin strings');
  for (const raw of additionalOrigins) {
    if (typeof raw !== "string" || new URL(raw).origin !== raw)
      throw new Error(`--target-config "additionalOrigins" entry is not a normalized origin: ${raw}`);
  }
  const allowedOrigins = [...new Set([new URL(app).origin, ...additionalOrigins])];
  // Per-target viewport, defaulting to the original phone size so every existing target (including
  // inburgering.coach) is unaffected unless it opts in.
  const viewport = config.viewport ?? DEFAULT_VIEWPORT;
  if (
    !Number.isInteger(viewport.width) ||
    viewport.width <= 0 ||
    !Number.isInteger(viewport.height) ||
    viewport.height <= 0
  )
    throw new Error('--target-config "viewport" must be { width, height } positive integers');
  // Default OFF: a target config that never mentions "readOnly" gets exactly today's behavior
  // (classifyRequest's ONE_WAY_PATH denylist, unchanged). A target we don't own opts in explicitly.
  if (config.readOnly !== undefined && typeof config.readOnly !== "boolean")
    throw new Error('--target-config "readOnly" must be a boolean');
  const readOnly = config.readOnly === true;
  // Owner mode (--mine): the run may use the product like a user, so the forbidden-verb default
  // shrinks to money-and-destruction only, and the request boundary allows same-origin mutations.
  // Default OFF, same reasoning as readOnly above: a config that never mentions "mine" is a
  // stranger's product.
  if (config.mine !== undefined && typeof config.mine !== "boolean")
    throw new Error('--target-config "mine" must be a boolean');
  const mine = config.mine === true;
  // Path globs, both optional and both empty by default: with neither, scope is origin membership
  // and nothing else, exactly as before. "/tools/**" is the product; "/blog/**" is not.
  const pathScope = { include: stringList(config, "pathInclude"), exclude: stringList(config, "pathExclude") };
  // Named verbs never performed on a product we do not own. Only meaningful on a read-only target,
  // and defaulted there rather than left to each config to remember.
  const forbidden =
    config.forbiddenActions === undefined
      ? readOnly
        ? mine
          ? OWNER_FORBIDDEN_VERBS
          : FORBIDDEN_VERBS
        : []
      : stringList(config, "forbiddenActions");
  // Values the USER supplied for this product's own fields, and one file it may upload. The
  // explorer may type these; it may never invent one, and it still never submits.
  const seeds = config.seedValues ?? {};
  if (typeof seeds !== "object" || Array.isArray(seeds)) throw new Error('--target-config "seedValues" must be an object of field -> value');
  const seedValues = Object.values(seeds).map(String);
  if (config.uploadPath !== undefined && typeof config.uploadPath !== "string")
    throw new Error('--target-config "uploadPath" must be a path to one file');
  // One phone and one desktop in a single run: the loop switches once, halfway through the budget.
  const viewports = config.viewports ?? [viewport];
  if (!Array.isArray(viewports) || viewports.length === 0) throw new Error('--target-config "viewports" must be a non-empty array');
  for (const item of viewports)
    if (!Number.isInteger(item?.width) || item.width <= 0 || !Number.isInteger(item?.height) || item.height <= 0)
      throw new Error('--target-config "viewports" entries must be { width, height } positive integers');
  return {
    pathScope,
    forbidden,
    mine,
    seeds,
    seedValues,
    viewports,
    uploadPath: config.uploadPath ? resolve(dirname(resolve(targetConfigPath)), config.uploadPath) : null,
    authMode: config.authMode,
    publicPackSha256: config.publicPackSha256,
    savedSessionPath:
      config.authMode === "saved-session"
        ? resolve(dirname(resolve(targetConfigPath)), config.savedSessionPath)
        : null,
    allowedOrigins,
    viewport,
    readOnly,
  };
}

function stringList(config, key) {
  const value = config[key] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`--target-config "${key}" must be an array of strings`);
  return value;
}

// Bring-your-own-session sign-in, a sibling of the clerk-mode signIn() imported from
// vision-explorer-spike.mjs: loads cookies/localStorage a human captured by hand (see
// scripts/capture-session.mjs) instead of minting a Clerk identity, for a target that isn't on
// Clerk at all. Confirms the session actually authenticated the first navigation rather than
// assuming it did -- silently exploring as a signed-out visitor would produce a map that lies
// about what it saw.
export async function loadSavedSession(page, cdp, app, savedSessionPath) {
  let session;
  try {
    session = JSON.parse(await readFile(savedSessionPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read saved-session file ${savedSessionPath}: ${error?.message ?? error}`);
  }
  const cookies = savedSessionCookies(session);
  if (cookies.length > 0) await cdp.send("Network.setCookies", { cookies });
  for (const entry of session.origin_storage ?? []) {
    const local = entry.local_storage ?? {};
    const sess = entry.session_storage ?? {};
    // Registered before the navigate below so it runs before the target's own scripts do.
    await page.addInitScript(
      ({ local, sess }) => {
        for (const [key, value] of Object.entries(local)) window.localStorage.setItem(key, value);
        for (const [key, value] of Object.entries(sess)) window.sessionStorage.setItem(key, value);
      },
      { local, sess },
    );
  }
  await page.goto(app, { waitUntil: "networkidle" });
  await page.waitForTimeout(3_000);
  if (isAuthFlowUrl(page.url()))
    throw new Error(
      `saved session did not authenticate: landed on ${page.url()}, which looks like a sign-in page`,
    );
}

// The third auth mode: no identity at all, just whatever a logged-out visitor can reach. Unlike
// loadSavedSession(), landing on something that looks like a sign-in/reset page is not an error --
// exploring exactly that logged-out surface (marketing pages, signup steps, sign-in, password
// reset) is the point of this mode, so there is no isAuthFlowUrl() check here.
// "networkidle" is not a promise a stranger's site makes. brandfetch.com never goes idle -- an
// analytics beacon, a chat widget or an autoplaying video keeps a request in flight -- so a hard
// `waitUntil: "networkidle"` threw `page.goto: Timeout 30000ms exceeded` and ended the run before
// the first screenshot. Land on domcontentloaded, which every page reaches, then give idle a short
// best-effort window for the SPAs it genuinely helps, then the settle wait that was always here.
export async function loadPublicEntry(page, app) {
  await page.goto(app, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
}

// Minimal shape check on a captured-session file -- the same fields scripts/capture-session.mjs
// writes. Exported standalone (no CDP/network involved) so it can be checked without a browser.
// The pre-dispatch action-boundary check, pulled out as a pure function so its exact refusal
// wording and boolean can be asserted without a browser or a model (see
// tests/vision-explorer-refusal.test.mjs). `decision.action` must be one of the four reversible
// input kinds, and the page must currently be on one of the target's own bound origins -- nothing
// else reaches the browser. A refusal here is NOT fatal to the run; see the call site.
// The pre-dispatch gate and the scope question both live in lib/run-limits.mjs -- they are pure,
// and importing them from there means a caller that only needs the rules (a test, the option-D MCP
// server) does not have to load a browser and two model SDKs to ask.
export { checkActionAuthorized, onBoundOrigin };

// A single transient hiccup -- an empty/malformed model reply, a CDP call that times out taking
// the next screenshot -- should cost the one step it happened on, not the whole run (three runs in
// a row were lost to exactly this shape of bug before the retry was added: a second host, a refused
// off-site click, and an empty model response, each treated as fatal). Retries the same `fn` up to
// `attempts` times, logging every retry so it is visible in the run log, and only throws once every
// attempt has failed -- at which point the caller decides how to end the run for a REAL reason.
export async function withRetries(label, attempts, fn, delayMs = 500) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.log(
          `    retrying ${label} (attempt ${attempt + 1} of ${attempts}) after: ${error?.message ?? error}`,
        );
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

// The page-identity signal handed to the explorer: origin + pathname, no query string. Query
// strings are drawer/detail state (see the renderer's own `shortUrl`), not a different destination,
// so they are dropped here for the same reason -- otherwise every filter tweak would look like a
// brand-new "unvisited" page and the preference below would reward doing nothing.
function pageAddress(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

export function savedSessionCookies(session) {
  if (!session || typeof session !== "object" || !Array.isArray(session.cookies))
    throw new Error("saved-session file has an unexpected shape (expected a cookies array)");
  return session.cookies.map((cookie) => ({
    name: cookie?.name,
    value: cookie?.value,
    domain: cookie?.domain,
    path: typeof cookie?.path === "string" && cookie.path ? cookie.path : "/",
    expires: cookie?.expires,
    httpOnly: Boolean(cookie?.httpOnly),
    secure: Boolean(cookie?.secure),
    ...(typeof cookie?.sameSite === "string" ? { sameSite: cookie.sameSite } : {}),
  }));
}

// The explorer's whole brief, on top of the spike's source-blind system prompt. The extra rule is
// deliberately generic: it says "when one thing is finished, go find a different KIND of thing",
// with no route, no screen name and no list of what exists. Discovering that a second area exists
// at all is part of what is being tested.
const MISSION = `${EXPLORER_SYSTEM}

You are mapping the whole product, not one task. When the thing you were doing is finished, or is
blocked, or is just repeating itself, deliberately go and find a DIFFERENT part of the product with
a different purpose -- look for whatever navigation the screen offers -- instead of stopping.

Favor screens you can actually DO something on -- sign up, create, configure, search, book, buy --
over screens that only describe the product, such as documentation, blog posts, changelogs, help
articles, or legal/policy pages. Reading material tells you what the product claims; only an
interactive screen tells you what it does. If you notice you have been reading several screens of
that kind in a row with nothing new to click, stop reading forward and go back to try an
unexplored interactive part of the product instead. Likewise, when the area you are in stops
producing screens you have not seen before, that is a reason to backtrack to an earlier unexplored
option, not a reason to conclude there is nothing left -- an untried area elsewhere in the product
is not the same as this one being exhausted.

The first time you meet a KIND of task, carry it all the way to its end before you go looking for a
different kind. A product's most telling screens only appear when something is finished: the result,
the score, the confirmation, the receipt, whatever it offers you next. Opening a quiz and closing it
after two questions records the door and never the room. Later examples of a kind you have already
finished you may sample and leave.

Before you weigh screens for novelty, check the page you are actually on: after every action you
are told the current page's address and every address you have visited so far. Toggling a switch,
opening a tab, or expanding a section can change the picture completely while leaving you on the
very same address -- that is a new view of an old page, not a new page, no matter how different it
looks. When you have a choice of what to try next, prefer whatever takes you to an address you have
not visited before over anything that only redraws the address you are already on. Once an address
has given you several changes without ever producing a new address, treat it as covered for now and
go find a control that leads somewhere else, the way a person who has tried out one section of a
product moves on to see what else is there rather than reopening every setting on the same page.
This is about order, not prohibition -- depth is still worth pursuing, so come back and go deeper
once breadth runs out.

Keep each instruction to one action on one control, described the way a person would point at it
on the screen, so that whoever carries it out cannot mistake which control you mean.

Only set "done":true when you genuinely cannot see any unexplored part left, and then put the
reason in "why".`;
// The brief must stay above Anthropic's 1024-token minimum cacheable prefix; at 1022 tokens the
// cache breakpoint was silently ignored on every turn (W2-9, 2026-09-06).


// Re-exported from lib/explorer-evidence.mjs, where the option-D MCP server shares it.
export { redactContactDetails };


// An off-site drift is detected at the TOP of a step, which means it committed after the previous
// step's post-action screenshot was already taken -- the screenshot caught the tab mid-navigation.
// Walking back re-reads the screen, and that re-read is a real observation with no authorized
// action in front of it, so recording it as its own event would invent a transition, while
// discarding it leaves a gap: the renderer requires every event's `before` to be the previous
// event's `after`, and val.town broke exactly there (event-0020). The settled screen IS the honest
// outcome of the last recorded action, so re-point that event's `after` at it rather than at the
// premature snapshot, and recompute everything derived from it.
// Returns the screenshot the re-anchor superseded, so the caller can delete it: retention here is
// "keep exactly the evidence the trace cites", and the packager enforces it (it refuses a candidate
// carrying a retained screenshot no event references).
export function reanchorLastEvent(events, evidence) {
  const last = events[events.length - 1];
  if (!last) return null;
  const superseded =
    last.after.screenshot_path !== evidence.screenshot_path &&
    last.before.screenshot_path !== last.after.screenshot_path
      ? last.after.screenshot_path
      : null;
  last.after = evidence;
  last.current_url = evidence.url;
  last.current_origin = evidence.origin;
  last.visible_state_summary = evidence.visible_state_summary;
  last.screenshot_path = evidence.screenshot_path;
  const changed =
    last.before.observation_hash !== evidence.observation_hash ||
    last.before.screenshot_sha256 !== evidence.screenshot_sha256;
  last.transition_kind = changed ? "solid" : "none";
  last.observed_outcome = changed
    ? { click: "clicked", type: "typed", scroll: "scrolled" }[last.intended_action.method]
    : "no-visible-effect";
  last.outcome_detail = changed
    ? null
    : "The action ran but the visible state did not change.";
  return superseded;
}


async function main() {
  const { app, steps: maxSteps, targetConfigPath, minutes, maxEur, runDirRoot } = options(process.argv.slice(2));
  const target = await resolveTarget(app, targetConfigPath);
  // sk_live is the production instance that owns clerk.inburgering.coach. Both are accepted; which
  // one is in the environment is what decides whether the disposable identity is a dev or a real
  // account, and the identity is deleted on every terminal path either way. Only checked in
  // clerk mode -- a saved-session target isn't on Clerk at all and needs no such key.
  if (target.authMode === "clerk" && !/^sk_(test|live)_/.test(process.env.CLERK_SECRET_KEY ?? ""))
    throw new Error("CLERK_SECRET_KEY (sk_test_ or sk_live_) is required");
  // Either key, never both: SPIKE_EXPLORER_BASE_URL routes the explorer at an OpenAI-compatible
  // host instead of Anthropic (lib/explorer-client.mjs).
  if (!process.env.SPIKE_EXPLORER_BASE_URL && !process.env.ANTHROPIC_API_KEY)
    throw new Error("ANTHROPIC_API_KEY is required (or SPIKE_EXPLORER_BASE_URL for an OpenAI-compatible host)");
  // gemini-3.6-flash is the grounding model scripts/grounding-offset-probe.mjs validated against
  // this app's real DOM boxes. Do not swap it without re-running that probe: a grounder that is
  // confidently 50px off clicks the neighbouring control and every success signal still reads green.
  process.env.MIDSCENE_MODEL_NAME ??= "gemini-3.6-flash";
  process.env.MIDSCENE_MODEL_FAMILY ??= "gemini";
  process.env.MIDSCENE_MODEL_BASE_URL ??=
    "https://generativelanguage.googleapis.com/v1beta/openai/";
  process.env.MIDSCENE_MODEL_API_KEY ??= process.env.GEMINI_API_KEY;
  // Midscene writes its own report folder to the CURRENT directory unless told otherwise, which
  // litters whatever repo the run was launched from. Keep it beside the run's own output.
  process.env.MIDSCENE_RUN_DIR ??= join(process.env.RELEASHED_OUT ?? join(process.cwd(), "releashed"), "midscene");
  if (!process.env.MIDSCENE_MODEL_API_KEY)
    throw new Error("GEMINI_API_KEY is required for grounding");

  const runId = `vision-${new URL(app).protocol === "https:" ? "prod" : "local"}-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}`;
  const runDir = join(runDirRoot, runId, "target-session-1");
  await mkdir(join(runDir, "screenshots"), { recursive: true });

  const anthropic = explorerModel(EXPLORER_MODEL);
  const explorerUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const boundary = {
    allowed: 0,
    refused: [],
    events: [],
    total: 0,
    sameOriginMutations: 0,
    origin: new URL(app).origin,
    // The navigation boundary below checks membership in this set; installActionBoundary's own
    // same-origin mutation counter still uses `origin` alone (evidence, not enforcement).
    origins: new Set(target.allowedOrigins),
    // Read by classifyRequest inside installActionBoundary: when true, every non-GET/HEAD request
    // to one of `origins` above is refused before dispatch, regardless of the ONE_WAY_PATH denylist.
    readOnly: target.readOnly,
    // Owner mode: same-origin mutating requests are allowed except money paths and DELETE -- see
    // classifyRequest's "mine" branch in vision-explorer-spike.mjs.
    mine: target.mine,
  };
  // Everything the pre-dispatch gate needs beyond the origin list. Empty for a target that names
  // none of it, which is every target config written before these controls existed.
  const limits = { pathScope: target.pathScope, forbidden: target.forbidden, seedValues: target.seedValues, mine: target.mine };
  const events = [];
  const unexecutable = [];
  // `unexecutable` above is the run report's full record and never shrinks, so reading its LENGTH as
  // the stop condition meant "three unlocatable instructions anywhere in sixty steps", while the
  // stop message said "three in a row". Three targets died on that: Brandfetch at step 8, Geocodio
  // at 32, Val Town at 60. This is the counter the message always described -- reset by any step
  // that actually dispatched.
  let consecutiveUnexecutable = 0;
  // Doors the guard below refuses to walk through (e.g. a social sign-in button that leaves the
  // bound origin). Nothing is dispatched, so -- exactly like `unexecutable` above -- there is no
  // observed transition to add to the trace; this is bookkeeping, not evidence. Reusing the
  // "unknown terminal" language already established for observed-but-untrusted outcomes (see
  // renderer/render-map.mjs's "Outcome unknown" node) rather than inventing a new status.
  const blocked = [];
  let stopReason = "step_budget_exhausted";
  let stopDetail = "The step budget ran out before the explorer said it was finished.";
  let failure = null;

  // VISION_CLERK_USER_ID reuses a disposable identity already created for this run -- the grounding
  // probe has to sign in as somebody too, and one authorized identity doing both is fewer real
  // accounts than one per script. It is still deleted here, on every terminal path. Only minted in
  // clerk mode; a saved-session target has no disposable identity to create or clean up.
  const identity =
    target.authMode === "clerk"
      ? process.env.VISION_CLERK_USER_ID
        ? await clerk(`/users/${process.env.VISION_CLERK_USER_ID}`)
        : await clerk("/users", {
            method: "POST",
            body: JSON.stringify({
              username: `visionmap${Date.now().toString(36)}`,
              first_name: "Vision map",
            }),
          })
      : null;
  if (identity) console.log(`disposable Clerk user: ${identity.id}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: target.viewports[0] });
  const page = await context.newPage();
  // The ONE file the user seeded, handed over only when the product itself opens a file chooser.
  // No new action vocabulary: the explorer taps "Choose file" like a person would, and this answers.
  if (target.uploadPath)
    page.on("filechooser", (chooser) => {
      chooser.setFiles(target.uploadPath).catch(() => {});
    });
  const startedAt = Date.now();
  let agent = null;
  // A saved-session run has no identity to retire, so cleanup is trivially already "done".
  let identityDeleted = target.authMode !== "clerk";

  try {
    await page.setViewportSize(target.viewports[0]);
    const cdp = await installActionBoundary(context, page, boundary);
    await cdp.send("Accessibility.enable").catch(() => {});

    if (target.authMode === "clerk") {
      const { token } = await clerk("/sign_in_tokens", {
        method: "POST",
        body: JSON.stringify({ user_id: identity.id, expires_in_seconds: 3600 }),
      });
      await signIn(page, token);
    } else if (target.authMode === "saved-session") {
      await loadSavedSession(page, cdp, app, target.savedSessionPath);
    } else {
      await loadPublicEntry(page, app);
    }
    console.log(`signed in, landed on ${page.url()}`);

    agent = new PlaywrightAgent(page, {
      // Cache id is scoped to the TARGET. The cache is keyed on the plain-English prompt alone, so
      // a shared id would replay a coordinate grounded on one deployment onto a different one --
      // a confident, cache-fast click at a point nothing verified, which is the exact failure the
      // grounding probe exists to catch and the one thing a cache can reintroduce for free.
      cache: { id: `vision-explorer-run-${new URL(app).host.replace(/[^a-z0-9]+/gi, "-")}`, strategy: "read-write" },
      customActions: [defineActionDragAndDrop((from, to) => ourDragMotion(page, from, to))],
    });

    const history = [];
    // Evidence continuity: state N is one object, used as event N's `after` AND event N+1's
    // `before`. Nothing can drift between the two because there is nothing between them.
    let state = await observeScreen(page, cdp, runDir, 1, target.readOnly);
    let stateIndex = 1;
    // A wall at the front door: a bot check, or (for a signed-out run) a login screen that is all
    // there is. It is a finding, not an obstacle -- recorded, and the run stops rather than looking
    // for a way around it.
    const entryWall = detectWall(state.evidence.url, state.evidence.visible_state_summary, { entry: true });
    if (entryWall) {
      blocked.push({ instruction: "open the product", target: null, transition_kind: "unknown-terminal", reason: entryWall.reason });
      stopReason = entryWall.kind;
      stopDetail = entryWall.reason;
      console.log(`    WALL: ${entryWall.reason}`);
    }
    // The page-identity ledger the MISSION's breadth preference relies on -- every address the
    // explorer has actually landed on, seeded with the very first screen.
    const visitedPages = new Set([pageAddress(state.evidence.url)]);

    for (let step = 1; entryWall === null && step <= maxSteps; step += 1) {
      // Minutes and euros, checked before the step is paid for. Steps are the loop bound itself.
      const spent = budgetExhausted({
        elapsedSeconds: (Date.now() - startedAt) / 1000,
        minutes,
        costEur: modelCostEur(EXPLORER_MODEL, explorerUsage),
        maxEur,
      });
      if (spent) {
        stopReason = spent.reason;
        stopDetail = spent.detail;
        console.log(`    BUDGET: ${spent.detail}`);
        break;
      }
      // One phone and one desktop in one run: switch once, halfway through the budget, and let the
      // explorer carry on from the same page at the new size.
      // ponytail: half the budget at each size, not the same screens revisited at both. A second
      // pass over the recorded screens is the v1 upgrade if the map ever needs pairs.
      if (target.viewports.length > 1 && step === Math.ceil(maxSteps / 2) + 1) {
        const next = target.viewports[1];
        await page.setViewportSize(next);
        await page.waitForTimeout(1_000);
        stateIndex += 1;
        state = await observeScreen(page, cdp, runDir, stateIndex, target.readOnly);
        const superseded = reanchorLastEvent(events, state.evidence);
        if (superseded) await rm(join(runDir, superseded), { force: true });
        history.push(`(the window is now ${next.width}x${next.height}; the same page may be laid out differently)`);
        console.log(`    VIEWPORT: switched to ${next.width}x${next.height}`);
      }
      // The browser can be standing off the target's own origin(s) before we even ask for a
      // decision, and not only as the direct result of the last click: a target="_blank" popup, or
      // a navigation our own boundary failed, can commit Chrome's error page into this tab
      // asynchronously -- after the post-action screenshot was already taken and looked fine.
      // checkActionAuthorized then refuses EVERY later instruction, so left alone one off-site
      // door ends the run: OpenStreetMap's "Donate" link burned eight of sixty steps on refusals
      // and made the explorer declare itself finished. Walk back to the last page we legitimately
      // observed, re-read the screen so the explorer is looking at where it actually is, and carry
      // on. The door is recorded once as an unknown terminal we chose not to follow.
      if (!onBoundOrigin(page.url(), boundary.origins, target.pathScope)) {
        const previous = history[history.length - 1] ?? "the previous instruction";
        const reason = `The page had drifted off the product's own site after ${JSON.stringify(previous)}; the run did not follow it and returned to ${state.evidence.url}.`;
        blocked.push({ instruction: previous, target: null, transition_kind: "unknown-terminal", reason });
        try {
          await withRetries("return to the bound origin", 3, () =>
            page.goto(state.evidence.url, { waitUntil: "domcontentloaded" }),
          );
          await page.waitForTimeout(1_000);
          stateIndex += 1;
          state = await observeScreen(page, cdp, runDir, stateIndex, target.readOnly);
          const superseded = reanchorLastEvent(events, state.evidence);
          if (superseded) await rm(join(runDir, superseded), { force: true });
        } catch (error) {
          stopReason = "off_site_navigation_unrecoverable";
          stopDetail = `The browser left the product's own site and could not be brought back: ${scrub(error?.message ?? error)}`;
          break;
        }
        history.push(
          "(that instruction led off the product's own site, which this run does not follow -- you are back on the page you were on. Do not try it again; find something else on screen.)",
        );
        console.log(`    OFF-SITE: ${reason}`);
      }
      let decision;
      try {
        // A blank or malformed reply from the model is a transient blip, not proof the run is
        // done -- retry a few times before giving up on this step.
        const currentAddress = pageAddress(state.evidence.url);
        const otherVisited = [...visitedPages].filter((a) => a !== currentAddress);
        // Seeded values are DATA the user supplied for this product's own fields. Telling the
        // explorer they exist is not telling it a journey: it names no screen and no next step, and
        // without it the explorer would invent a value and be refused (which is what W1-2 saw).
        const seedLines = Object.entries(target.seeds ?? {}).map(([field, value]) => `  ${field}: ${value}`);
        const seedContext = seedLines.length
          ? `Values you may type, supplied by the person running this map. Use them exactly as written when a field asks for that kind of thing, and never invent one of your own. Do not submit the form afterwards:\n${seedLines.join("\n")}`
          : null;
        const pageContext = [
          `Current page address: ${currentAddress}\nAddresses already visited besides this one (${otherVisited.length}): ${otherVisited.length ? otherVisited.join(", ") : "none yet"}`,
          seedContext,
        ]
          .filter(Boolean)
          .join("\n\n");
        decision = await withRetries("explorer decision", 3, () =>
          decide(anthropic, state.png, history, explorerUsage, MISSION, pageContext),
        );
      } catch (error) {
        stopReason = "explorer_error";
        stopDetail = `The explorer could not produce a next step after 3 attempts: ${scrub(error?.message ?? error)}`;
        break;
      }
      history.push(decision.instruction);
      console.log(
        `\n[${step}] sees "${decision.screen}" -> "${decision.instruction}"\n    why: ${decision.why}`,
      );
      if (decision.done) {
        stopReason = "explicit_done";
        stopDetail = decision.why ?? "The explorer reported it had nothing left to explore.";
        break;
      }


      // Our own pre-dispatch gate. Nothing reaches the browser that is not one of these four
      // reversible input kinds aimed at the bound local origin -- this is the authorization the
      // trace records as supervisor_authorized, and it is checked here, before any input, not
      // inferred afterwards. The guard staying exactly this strict is the point; a refusal used to
      // kill the whole run (three runs in a row lost to a single social-sign-in button), which
      // conflated "this one door is closed" with "stop exploring the product". Every real product
      // has a few doors like this (social sign-in, payment processors, help widgets, app stores),
      // so a refusal here is recorded as a blocked, unknown-terminal door and exploration moves on
      // to the next decision -- it does not end the run.
      const authCheck = checkActionAuthorized(decision, boundary.origins, page.url(), target.readOnly, limits);
      if (!authCheck.authorized) {
        const reason = authCheck.reason;
        blocked.push({ instruction: decision.instruction, target: decision.target ?? null, transition_kind: "unknown-terminal", reason });
        history.push(
          `(that instruction was refused before dispatch -- an unknown terminal, blocked by the run's own safety boundary: ${reason} Do not try it again; find something else on screen.)`,
        );
        console.log(`    BLOCKED: ${reason}`);
        continue;
      }

      const mutationsBefore = boundary.sameOriginMutations;
      let outcome;
      let identified = { tier: "positional", ref: null };
      try {
        if (decision.action === "tap") {
          // Split out of the shared executor on purpose: what sits under the grounded point has to
          // be read while the page is still in its BEFORE state. One grounding call, then identify,
          // then dispatch -- asking afterwards would read whatever the click had already replaced.
          const located = await agent.aiLocate(decision.target);
          const [x, y] = Array.isArray(located.center)
            ? located.center
            : [located.center.x, located.center.y];
          identified = await identifyTarget(page, state.refs, x, y);
          await page.mouse.click(x, y);
          outcome = { executor: "midscene:aiLocate + our click", center: [x, y] };
        } else {
          outcome = await execute(agent, page, decision);
        }
      } catch (error) {
        // The executor refused to guess a coordinate, so no input was dispatched. There is no
        // observed transition to record -- an attempted instruction is not evidence.
        const message = scrub(error?.message ?? error);
        unexecutable.push({ instruction: decision.instruction, target: decision.target, message });
        consecutiveUnexecutable += 1;
        history.push(
          `(the previous instruction could not be carried out: nothing on screen matched "${decision.target}")`,
        );
        console.log(`    NOT EXECUTED: ${message}`);
        if (consecutiveUnexecutable >= 3) {
          stopReason = "executor_could_not_locate_target";
          stopDetail = `Exploration stopped after three instructions in a row that nothing on screen matched, the last being "${decision.instruction}".`;
          break;
        }
        continue;
      }
      consecutiveUnexecutable = 0;
      await page.waitForTimeout(1_500);

      // A dispatched click can commit a top-level navigation off the target's own origin(s) -- an
      // off-site link, or one the executor rewrites from target="_blank" into this same tab. The
      // action boundary fails that request, but Chrome has already left the old document and
      // commits its OWN error page, so from here on page.url() is chrome-error://chromewebdata/
      // and checkActionAuthorized refuses every following instruction. That killed a whole run on
      // OpenStreetMap's "Donate" link: one off-site door, 39 unused steps, three refusals and a
      // premature "done". Every product has doors like this, so put the browser back on the page
      // it was on and record the door exactly as a refused-before-dispatch one -- an unknown
      // terminal we chose not to follow. There is no honest "after" screen for a page we never
      // loaded, so this costs a step and never a transition.
      if (!onBoundOrigin(page.url(), boundary.origins, target.pathScope)) {
        const reason = `"${decision.instruction}" led off the part of the product this run was asked to map; the run did not follow it.`;
        blocked.push({
          instruction: decision.instruction,
          target: decision.target ?? null,
          transition_kind: "unknown-terminal",
          reason,
        });
        try {
          await withRetries("return to the bound origin", 3, () =>
            page.goto(state.evidence.url, { waitUntil: "domcontentloaded" }),
          );
          await page.waitForTimeout(1_000);
        } catch (error) {
          stopReason = "off_site_navigation_unrecoverable";
          stopDetail = `The browser left the product's own site on "${decision.instruction}" and could not be brought back: ${scrub(error?.message ?? error)}`;
          break;
        }
        history.push(
          "(that instruction led off the product's own site, which this run does not follow -- you are back on the page you were on. Do not try it again; find something else on screen.)",
        );
        console.log(`    OFF-SITE: ${reason}`);
        continue;
      }

      const method =
        decision.action === "tap" || decision.action === "drag" ? "click" : decision.action;

      const before = state.evidence;
      stateIndex += 1;
      try {
        // Screenshot/accessibility capture is a CDP round-trip and can time out transiently even
        // though the click/type/scroll already really happened -- retry it a few times before
        // treating the run as broken. Unlike the decision retry above, this can't just "try again
        // from scratch": the dispatch is done, so failing here ends the run cleanly (not via the
        // top-level catch, which would mark the whole candidate non-packageable) rather than
        // discarding every solid transition already captured.
        state = await withRetries("post-action screenshot", 3, () => observeScreen(page, cdp, runDir, stateIndex, target.readOnly));
      } catch (error) {
        stopReason = "observation_error";
        stopDetail = `Could not capture the screen after "${decision.instruction}": ${scrub(error?.message ?? error)}`;
        break;
      }
      visitedPages.add(pageAddress(state.evidence.url));
      const after = state.evidence;
      // The accessibility hash alone misses transitions this app makes only visually (a word
      // filling the answer box, a scroll repainting the viewport): the tree text can stay
      // identical while the pixels plainly changed. Either hash differing is a real observed
      // transition -- a self-loop needs BOTH hashes to match. buildTransitionEvent decides the
      // same way; this copy only feeds the log line below.
      const changed =
        before.observation_hash !== after.observation_hash ||
        before.screenshot_sha256 !== after.screenshot_sha256;
      events.push(
        buildTransitionEvent({
          runId,
          index: events.length + 1,
          before,
          after,
          method,
          identified,
          mutated: boundary.sameOriginMutations > mutationsBefore,
          elapsedSeconds: (Date.now() - startedAt) / 1000,
          requests: boundary.total,
        }),
      );
      console.log(
        `    ${outcome.executor} | ${changed ? "screen CHANGED" : "no visible effect"} | target ${identified.tier}${identified.ref ? ` (${identified.ref})` : ""} | ${after.url}`,
      );
      // A bot check that appears mid-run ends it exactly as one at the front door does -- after the
      // transition that reached it is recorded, so the wall is IN the map rather than only in the log.
      const wall = detectWall(after.url, after.visible_state_summary);
      if (wall) {
        blocked.push({ instruction: decision.instruction, target: decision.target ?? null, transition_kind: "unknown-terminal", reason: wall.reason });
        stopReason = wall.kind;
        stopDetail = wall.reason;
        console.log(`    WALL: ${wall.reason}`);
        break;
      }
    }

    // Boundary proof, fired from inside the page the third-party executor is driving. If the gate
    // is real this request never leaves the browser.
    boundary.probe = await page.evaluate(async (base) => {
      try {
        const res = await fetch(`${base}/api/billing/checkout`, { method: "POST", body: "{}" });
        return { blocked: false, status: res.status };
      } catch (error) {
        return { blocked: true, error: String(error).slice(0, 120) };
      }
    }, app);
    console.log(
      `\nboundary probe (POST /api/billing/checkout): ${boundary.probe.blocked ? "BLOCKED" : `NOT blocked (HTTP ${boundary.probe.status})`}`,
    );
  } catch (error) {
    failure = scrub(error?.message ?? error);
    stopReason = "run_error";
    stopDetail = failure;
    console.log(`RUN ERROR: ${failure}`);
  } finally {
    await agent?.destroy().catch(() => {});
    await browser.close().catch(() => {});
    if (identity) {
      try {
        await clerk(`/users/${identity.id}`, { method: "DELETE" });
        identityDeleted = true;
      } catch {
        console.log(`WARNING: could not delete ${identity.id}`);
      }
    }
  }

  const costEur = modelCostEur(EXPLORER_MODEL, explorerUsage);
  // String fields only: a "<number>" substituted into a numeric field would not be JSON any more.
  const redactRecordText = (value) =>
    target.readOnly && typeof value === "string" ? redactContactDetails(value) : value;
  const redactRecord = (record) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, redactRecordText(value)]));

  await writeFile(
    join(runDir, "observations.jsonl"),
    events.map((event) => `${JSON.stringify(event)}\n`).join(""),
    { mode: 0o600 },
  );
  await writeFile(
    join(runDir, "explorer-result.json"),
    `${JSON.stringify(
      {
        status: failure ? "failed" : "done",
        stop_reason: stopReason,
        // Every one of these quotes the instruction it is about, so a contact detail comes back in
        // through the refusal text even when the action itself never ran: the read-only typing
        // guard correctly blocked "Type 'testmapper2024@example.com' ..." and then the block
        // RECORD was what made the candidate unpackageable. Same rule as the observed evidence --
        // on a target we do not own, nothing contact-shaped is retained anywhere.
        reason: redactRecordText(stopDetail),
        decisions: events.length,
        unexecutable_instructions: unexecutable.map(redactRecord),
        blocked_actions: blocked.map(redactRecord),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(runDir, "request-events.jsonl"),
    boundary.events.map((event) => `${JSON.stringify(event)}\n`).join(""),
    { mode: 0o600 },
  );
  await writeFile(
    join(runDir, "metrics.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        run_id: runId,
        explorer_model: EXPLORER_MODEL,
        grounding_model: process.env.MIDSCENE_MODEL_NAME,
        grounding_validated_by: "scripts/grounding-offset-probe.mjs",
        explorer_tokens: explorerUsage,
        browser: {
          active_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
          actions: events.length,
          requests_seen_by_action_boundary: boundary.total,
          mutating_requests_allowed: boundary.allowed,
          same_origin_mutating_requests: boundary.sameOriginMutations,
          requests_refused_by_action_boundary: boundary.refused.length,
        },
        action_boundary: {
          installed: "raw CDP Fetch.requestPaused, attached before the executor",
          // Honest labeling of what this run was allowed to do to its own origin: "owner" when
          // --mine was set (or the target is fully trusted, e.g. the built-in inburgering.coach
          // path, readOnly: false), "stranger" otherwise -- see docs/CONTROL-SURFACE.md.
          mode: target.mine || !target.readOnly ? "owner" : "stranger",
          one_way_probe: boundary.probe ?? null,
          refused: boundary.refused.map((item) => ({ method: item.method, reason: item.reason })),
        },
        // Explorer spend at the published list price of the exact model called (see
        // lib/scaffold.mjs for the dated price and FX sources). null means "we have not read a
        // price for this model", never a guess. The grounding model's spend is NOT in this figure.
        model_cost_eur: costEur,
        model_cost_basis: { ...priceSourceFor(EXPLORER_MODEL), priced_model: EXPLORER_MODEL, covers: "explorer decisions only, not grounding" },
        // No app money was spent: the boundary refused every one-way path.
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const complete = !failure && identityDeleted;
  await writeFile(
    join(runDir, "production-run-report.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        run_id: runId,
        public_pack_sha256: target.publicPackSha256,
        status: failure ? "failed" : "completed",
        explorer_status: failure ? "failed" : "done",
        explorer_stop_reason: stopReason,
        observed_transitions: events.filter((event) => event.transition_kind === "solid").length,
        no_effect_actions: events.filter((event) => event.transition_kind === "none").length,
        app_one_way_actions: 0,
        app_actual_eur: 0,
        model_actual_eur: costEur,
        outstanding_reservations_eur: 0,
        model_stopped: true,
        browser_stopped: true,
        profile_deleted: true,
        auth_cleanup_complete: identityDeleted,
        identity_retirement_confirmed: identityDeleted,
        cleanup_complete: complete,
        candidate_eligible: complete && events.length > 0,
        non_publishable_reasons:
          complete && events.length > 0 ? [] : ["run did not complete cleanly"],
        failure_stage: failure ? "exploration" : null,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  console.log(`\nrun: ${runDir}`);
  console.log(
    `events: ${events.length} (${events.filter((e) => e.transition_kind === "solid").length} observed transitions)`,
  );
  console.log(`stop: ${stopReason} -- ${stopDetail}`);
  console.log(
    `explorer tokens: ${explorerUsage.input} in / ${explorerUsage.output} out / ${explorerUsage.cacheRead} cache-read / ${explorerUsage.cacheWrite} cache-write`,
  );
  console.log(
    costEur === null
      ? `cost: unpriced (no published price read for ${EXPLORER_MODEL})`
      : `cost: EUR ${costEur.toFixed(4)} (${EXPLORER_MODEL} list price, ECB ${priceSourceFor(EXPLORER_MODEL).usd_per_eur} USD/EUR of ${priceSourceFor(EXPLORER_MODEL).eur_rate_date}; excludes grounding)`,
  );
  if (failure) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("vision-explorer-run.mjs")) await main();
