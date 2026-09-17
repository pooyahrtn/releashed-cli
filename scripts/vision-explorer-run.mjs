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
// Usage:
//   SPIKE_APP_URL=http://localhost:8110 \
//     node --env-file=/path/to/.env.local scripts/vision-explorer-run.mjs --steps 24
//
// A target other than the built-in one (not on Clerk) runs with a --target-config file, either
// with a saved browser session or (authMode "public") no identity at all -- just whatever a
// logged-out visitor can reach:
//   SPIKE_APP_URL=https://app.cal.com \
//     node --env-file=/path/to/.env.local scripts/vision-explorer-run.mjs --steps 60 \
//     --target-config targets/calcom.json
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MODEL_FAMILY_VALUES } from "@midscene/shared/env";
import {
  budgetExhausted,
  checkActionAuthorized,
  detectWall,
  noEffectNote,
  onBoundOrigin,
  waitAllowance,
  FORBIDDEN_VERBS,
  MAX_STEPS,
  OWNER_FORBIDDEN_VERBS,
  RUN_WAIT_BUDGET_MS,
} from "../lib/run-limits.mjs";
import {
  buildTransitionEvent,
  focusedTarget,
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
import { EXPLORER_KEY_REFUSAL, GROUNDING_KEY_REFUSAL } from "../lib/first-run.mjs";
import { assertRunId, validateCaptureMetadata } from "../lib/capture-metadata.mjs";
// Same rule the MCP finish route enforces (lib/explore-mcp.mjs): a goal claim may only cite a
// screenshot the recorded trace retains, and that file must be re-read and match its recorded
// hash. `recordedSelection` and `digest` are the exact functions that route uses -- reused here
// rather than re-implemented, so both explorer engines converge on the one contract.
import { recordedSelection, digest } from "../lib/capture-selection.mjs";
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
// "viewport" -- unchanged, so the original built-in target keeps this exact phone size.
const DEFAULT_VIEWPORT = { width: 390, height: 844 };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Midscene failures quote internal file paths; the packager refuses any retained text carrying one.
const scrub = (text) =>
  String(text)
    .replace(/\/(?:Users|home|private|var)\/[^\s"']+/g, "<path>")
    .slice(0, 200);

// A bad MIDSCENE_MODEL_FAMILY does not fail the run that sets it: Midscene rejects it on every
// aiLocate/aiTap/aiInput call the same way, which this loop's own retry/no-effect logic then reads
// as three steps that could not find their target on screen -- and seals
// executor_could_not_locate_target, blaming the product's UI for a config mistake on the caller's
// machine. Check the installed package's OWN accepted values before the walk starts, so this is a
// crisp failure at step zero instead of a misleading one three steps in.
export function validateLocatorModelFamily(family) {
  if (!MODEL_FAMILY_VALUES.includes(family))
    throw new Error(
      `MIDSCENE_MODEL_FAMILY "${family}" is not one of the families the installed Midscene ` +
        `package accepts: ${MODEL_FAMILY_VALUES.join(", ")}. Fix it before running -- an invalid ` +
        `family fails every locate call identically and, left uncaught, reads as "nothing on ` +
        `screen matched" rather than as the configuration mistake it is.`,
    );
}

// Which model points at the control the explorer names, and on whose key. Pure: a function of the
// environment alone, so the whole selection -- including the refusal -- is testable without a
// browser, a network call or a key.
//
// gemini-3.6-flash is the grounding model scripts/grounding-offset-probe.mjs validated against a
// real app's DOM boxes. Do not swap the default without re-running that probe: a grounder that is
// confidently 50px off clicks the neighbouring control and every success signal still reads green.
//
// Each of the four settings is filled independently, exactly as the `??=` sequence this replaced
// did, so every explicit override a caller already sets keeps working untouched -- including a key
// alone (MIDSCENE_MODEL_API_KEY with the Gemini default) and a whole foreign provider (all four).
//
// ANTHROPIC_API_KEY is deliberately NOT a fallback here. Claude can point accurately -- the probe in
// artifacts/grounding-probe-claude-20260905 put 8 of 8 controls inside the real element -- but it
// pointed through a direct Anthropic call, not through Midscene, and the installed Midscene package
// grounds only through the families it lists (MODEL_FAMILY_VALUES), none of which is Anthropic's.
// Quietly aiming the Anthropic key at a family that is not Anthropic's would fail every locate call
// identically, which is precisely the misleading failure validateLocatorModelFamily above exists to
// prevent. Refusing here, by name, is the honest version.
// The words themselves now live in lib/first-run.mjs, with the explorer-key refusal beside them, so
// `releashed map` can say either one before the walk starts without importing this file (and
// Playwright, and Midscene) to do it. Re-exported here because this is where callers already look.
export { GROUNDING_KEY_REFUSAL };

export function resolveGroundingEnv(env) {
  const resolved = {
    MIDSCENE_MODEL_NAME: env.MIDSCENE_MODEL_NAME ?? "gemini-3.6-flash",
    MIDSCENE_MODEL_FAMILY: env.MIDSCENE_MODEL_FAMILY ?? "gemini",
    MIDSCENE_MODEL_BASE_URL:
      env.MIDSCENE_MODEL_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/",
    MIDSCENE_MODEL_API_KEY: env.MIDSCENE_MODEL_API_KEY ?? env.GEMINI_API_KEY,
  };
  if (!resolved.MIDSCENE_MODEL_API_KEY) throw new Error(GROUNDING_KEY_REFUSAL);
  return resolved;
}

// Distinguishes a genuine "nothing on screen matched" miss from the locator itself being
// misconfigured or failing (a rejected model family, a bad API key, a network or timeout error
// reaching the grounding provider). Conflating the two seals a config problem as a product-UI
// finding -- exactly the misleading self-report this loop exists to avoid.
// "Element not found" is Midscene's own stable phrasing for a genuine miss (thrown by aiTap,
// aiInput, aiScroll and DragAndDrop when nothing grounds); the raw aiLocate() path this loop uses
// for a tap decision instead returns an empty center, which this file's own destructuring then
// throws reading .x/.y/.center of undefined -- also a genuine miss, not a locator failure.
// Anything else thrown is the locator itself, not the screen.
export function classifyExecutorFailure(message) {
  const text = String(message ?? "");
  if (/Element not found/.test(text)) return "miss";
  if (/Cannot read propert(?:y|ies) of undefined \(reading '(?:x|y|center)'\)/.test(text)) return "miss";
  return "locator_error";
}

// The target ORIGIN is read from SPIKE_APP_URL, not a flag: the imported signIn (used by clerk-mode
// auth) closes over the spike module's own copy of that variable, so a flag here could silently
// disagree with it. What --target-config adds is everything ELSE about a target (whether it's
// worth an allow-list entry at all, how to sign in, which public-pack hash it packages against).
// The default (no --target-config) is the ORIGINAL single-entry allow-list, unchanged.
const APPROVED_TARGETS = new Set(["https://app.inburgering.coach"]);
// The run report's public-pack hash the packager has always checked for the built-in target (see
// package-candidate.mjs / lib/candidate-packager.mjs). Any other target must supply its own, via
// --target-config -- silently reusing this one for a different product would let a mismatched
// pack through packaging without ever being noticed.
const DEFAULT_PUBLIC_PACK_SHA256 = "acfdafff0f2dc20d342bab3f7d8a18e40750b50137cd83103c78ea8c5ba9ca37";
// The exact file DEFAULT_PUBLIC_PACK_SHA256 above must hash to -- see verifyPublicPackHash().
const DEFAULT_PUBLIC_PACK_PATH = resolve(
  import.meta.dirname,
  "..",
  "packs/public-pack-spike-a-live-calibration-20260903T164116Z/public-pack.json",
);

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
    // Capture mode (S-5), and ONLY when the owner asks for it: the one standing objective this run
    // pursues, and a short plain-English note on how to behave while pursuing it. Both null is
    // discovery -- source-blind, no goal, no hints -- which is every run that does not pass them.
    goal: null,
    policy: null,
    continues: null,
    precondition: null,
    identityLabel: null,
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
    else if (argv[i] === "--goal") values.goal = argv[i + 1];
    else if (argv[i] === "--policy") values.policy = argv[i + 1];
    else if (argv[i] === "--continues") values.continues = assertRunId(argv[i + 1]);
    else if (argv[i] === "--precondition") values.precondition = argv[i + 1];
    else if (argv[i] === "--identity-label") values.identityLabel = argv[i + 1];
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  // A policy says how to behave while chasing a goal. On its own it would be a sentence of the
  // owner's own words entering a source-blind walk, which discovery mode does not take.
  if (values.policy && !values.goal) throw new Error("--policy describes how to behave while pursuing a --goal; pass one");
  if (values.precondition !== null && !values.precondition.trim()) throw new Error("--precondition must be non-empty plain English");
  if ((values.continues || values.precondition || values.identityLabel) && !values.goal)
    throw new Error("--continues, --precondition, and --identity-label need --goal");
  if (!Number.isInteger(values.steps) || values.steps < 1 || values.steps > MAX_STEPS)
    throw new Error(`--steps must be 1..${MAX_STEPS}`);
  if (values.minutes !== null && !(values.minutes > 0)) throw new Error("--minutes must be a positive number");
  if (values.maxEur !== null && !(values.maxEur > 0)) throw new Error("--budget-eur must be a positive number");
  return values;
}

// Resolves everything about WHICH target this run drives, beyond the origin itself (already fixed
// by SPIKE_APP_URL): the auth mode, the saved-session file (if any), and the public-pack hash the
// run report will carry. This IS the allow-list now -- with no --target-config, only the original
// built-in origin (or localhost) is accepted, exactly as before. A new target is approved
// by writing it a config file, not by editing this function.
export async function resolveTarget(app, targetConfigPath) {
  if (!targetConfigPath) {
    if (!(app?.startsWith("http://localhost") || APPROVED_TARGETS.has(app)))
      throw new Error(
        "SPIKE_APP_URL must be a http://localhost target or an approved production target (or pass --target-config for a new one)",
      );
    await verifyPublicPackHash(DEFAULT_PUBLIC_PACK_PATH, DEFAULT_PUBLIC_PACK_SHA256, "the built-in default target");
    return {
      authMode: "clerk",
      publicPackSha256: DEFAULT_PUBLIC_PACK_SHA256,
      savedSessionPath: null,
      allowedOrigins: [new URL(app).origin],
      viewport: DEFAULT_VIEWPORT,
      viewports: [DEFAULT_VIEWPORT],
      // The original built-in path is unaffected by read-only mode: we own this target,
      // so its normal (denylist-based) mutation handling in classifyRequest keeps applying.
      readOnly: false,
      mine: false,
      pathScope: { include: [], exclude: [] },
      forbidden: [],
      seedValues: [],
      uploadPath: null,
    };
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
  // Per-target viewport, defaulting to the original phone size so every existing target (the
  // built-in one included) is unaffected unless it opts in.
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

Some screens move on by themselves and no click will hurry them along. When that is plainly what
you are looking at, reply with "action":"wait" (no target, no text) and time will pass before your
next look at the screen. There is only so much waiting in a run, so spend it on a screen that is
actually going somewhere on its own, not on one that has simply stopped responding to you.

Only set "done":true when you genuinely cannot see any unexplored part left, and then put the
reason in "why".`;
// The brief must stay above Anthropic's 1024-token minimum cacheable prefix; at 1022 tokens the
// cache breakpoint was silently ignored on every turn (W2-9, 2026-09-06).

// Capture mode's brief, and the ONE place a goal is allowed to exist. Everything above is the
// discovery brief and stays exactly as it is: with no goal this returns MISSION itself, byte for
// byte, so a run without --goal is the run we have always had. With a goal, the objective is
// appended -- the whole brief is one cached system prompt, so it is in front of the model on every
// turn, not just the first -- and it says plainly that it overrides the roaming preference above
// it. The goal is the owner's own sentence, passed through untouched: nothing here reads source,
// names a screen, or suggests a route to it.
export function explorerBrief(goal = null, policy = null) {
  if (!goal) return MISSION;
  return `${MISSION}

Everything above is how to roam a product you are surveying in general. This run is not that run.
It has ONE standing objective, and that objective stands on every turn until it is met:

  ${goal}

Pursue it. Where the guidance above would have you leave for a different part of the product for
breadth's sake, ignore that and keep going towards the objective; a screen that does not bring you
nearer to it is a screen to leave. If what you tried turns out to be a dead end, back out and look
for another way to the same objective rather than taking up something else instead.

Nobody has told you where the objective lives or what it looks like, and nothing here will: find it
the way a person who had been asked for it would, by looking at what is on the screen. The moment
you are looking at it, you are finished -- set "done":true and say in "why" what you can see that
tells you the objective is met.

You are finished only when the screen in front of you IS the objective. Believing the next click
would show it is not being finished: take the click, then look. A screen that says the work is over
is not the screen the product shows afterwards, and "this should confirm it" means you have not
confirmed it. If you stop one action short and say you arrived, the picture you were sent for does
not exist and nobody will know until they open it (2026-09-06: a run did exactly this). If you become certain you cannot get there, set "done":true and say
in "why" what stopped you.${
    policy
      ? `

How the person running this asked you to behave along the way, which is about conduct and never
about where to click: ${policy}`
      : ""
  }`;
}


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
    ? { click: "clicked", type: "typed", scroll: "scrolled", wait: "waited" }[last.intended_action.method]
    : "no-visible-effect";
  last.outcome_detail = changed
    ? null
    : "The action ran but the visible state did not change.";
  return superseded;
}

// This route took `state.evidence.screenshot_path` on trust the moment the explorer said `done`,
// with no check that a goal claim cite retained evidence -- an unenforced hole, not (as first
// suspected while chasing the 2026-09-17 incident) the cause of it: every one of that day's
// `goal_claimed` runs, re-checked against the untouched evidence, cites a screenshot that IS in
// its recorded trace and DOES hash-match the file on disk; their failure was elsewhere. This closes
// the hole anyway and converges both explorer engines onto the one contract the MCP finish route
// already enforces (lib/explore-mcp.mjs): the claimed path must be retained evidence -- named by a
// recorded event's `before`/`after` (`recordedSelection` throws otherwise), or, when no event
// exists yet to name it, the raw pre-loop observation itself (`observedEvidence` below) -- and the
// file it names must still be on disk and hash to what was recorded when it was captured.
// No browser, no network, no model call -- just the trace already in memory and one file read.
export async function verifyGoalClaim({ events, claimScreenshotPath, observedEvidence, readScreenshotBytes }) {
  if (!claimScreenshotPath)
    return { verified: false, reason: "no goal screenshot was captured to claim" };
  let recorded;
  if (events.length === 0) {
    // Step 1, before any action has been dispatched: `events` is still empty, so nothing has gone
    // through the trace yet -- but the entry screen was still observed and written to disk before
    // the loop started, with its own hash recorded the moment it was captured (see observeScreen).
    // That is retained evidence too: a goal genuinely visible on the landing screen ("show me the
    // signed-in dashboard", where sign-in lands straight on it) must still be able to seal
    // `goal_claimed`, the same as the MCP finish route's own zero-event blocked-wall claim binds to
    // the raw observed wall screenshot rather than refusing for want of an event. A single-shot CLI
    // run has no retry to fall back on, so refusing this shape outright (as the MCP route does,
    // recoverably, for its own zero-event goal claim) would terminally fail every one-screen goal.
    if (observedEvidence?.screenshot_path !== claimScreenshotPath)
      return {
        verified: false,
        reason:
          "nothing had been recorded yet, and the claim does not match what was actually observed",
      };
    recorded = observedEvidence;
  } else {
    // Once at least one step has been recorded, the claim must name evidence the TRACE retains,
    // not merely something that was once on screen -- this is the actual hole: a claim can outrun
    // an already-nonempty trace (fall behind the events that update it, be moved back to a screen
    // no event notes, etc.), and that must still refuse, no observedEvidence fallback.
    let selected;
    try {
      selected = recordedSelection(events, [claimScreenshotPath]);
    } catch (error) {
      return { verified: false, reason: error?.message ?? String(error) };
    }
    recorded = selected[0];
  }
  try {
    const bytes = await readScreenshotBytes(recorded.screenshot_path);
    if (!bytes?.length || digest(bytes) !== recorded.screenshot_sha256)
      return {
        verified: false,
        reason: `${recorded.screenshot_path} is empty or no longer matches its recorded hash`,
      };
  } catch (error) {
    return {
      verified: false,
      reason: `${recorded.screenshot_path} could not be re-read: ${error?.message ?? error}`,
    };
  }
  return { verified: true, item: recorded };
}

// The stop-decision and result-sealing logic for an explorer "done" turn, extracted so it is
// reachable from a plain test with no browser, no network and no model call. A pure function of
// its inputs only -- it never seals a claim itself; it reflects the `verification` it is handed.
//
// With no goal this is unchanged: "done" always means "nothing left to explore". With one, an
// UNVERIFIED claim must never become `goal_claimed` -- it is sealed with the CLI's own existing
// not-reached stop reason instead (`goal_not_reached`, the same code lib/candidate-packager.mjs
// and the MCP route already treat as "aimed, retained evidence, not the claimed goal"), and its
// detail keeps the explorer's own claim text rather than discarding it -- labelled, not silenced.
// The generic not-reached wrapping near the end of main() (goal && stopReason !== "goal_claimed")
// then prefixes "The goal was not reached." and appends the last screen, exactly as it already
// does for a wall or a budget stop; this seals through that same path rather than a parallel one.
export function sealDoneDecision({ goal, step, decisionWhy, claimScreenshotPath, verification }) {
  if (!goal) {
    return {
      stopReason: "explicit_done",
      stopDetail: decisionWhy ?? "The explorer reported it had nothing left to explore.",
      goalReachedAtStep: null,
      goalScreenshotPath: null,
    };
  }
  const claimText = decisionWhy ?? "The explorer said it was looking at the goal.";
  if (verification.verified) {
    return {
      stopReason: "goal_claimed",
      stopDetail: `Claimed at step ${step}. ${claimText}`,
      goalReachedAtStep: step,
      goalScreenshotPath: claimScreenshotPath,
    };
  }
  return {
    stopReason: "goal_not_reached",
    stopDetail:
      `The explorer claimed the goal at step ${step} ("${claimText}"), but the claim could not ` +
      `be bound to retained evidence: ${verification.reason}.`,
    goalReachedAtStep: null,
    goalScreenshotPath: null,
  };
}

async function main() {
  const { app, steps: maxSteps, targetConfigPath, minutes, maxEur, runDirRoot, goal, policy, continues, precondition, identityLabel } = options(process.argv.slice(2));
  // Discovery with no goal, capture with one. The brief is built once and never changes mid-run.
  const brief = explorerBrief(goal, policy);
  const target = await resolveTarget(app, targetConfigPath);
  // This is intentionally before credentials, identity creation, browser launch, and model keys.
  // A continuation is a pointer only; no old instruction or click enters this run.
  await validateCaptureMetadata({
    goal, policy, continues, precondition, identityLabel, runsRoot: runDirRoot,
    mapsRoot: join(resolve(runDirRoot), "..", "maps"),
  });
  // sk_live is the production instance that owns the built-in target's own Clerk domain. Both are accepted; which
  // one is in the environment is what decides whether the disposable identity is a dev or a real
  // account, and the identity is deleted on every terminal path either way. Only checked in
  // clerk mode -- a saved-session target isn't on Clerk at all and needs no such key.
  if (target.authMode === "clerk" && !/^sk_(test|live)_/.test(process.env.CLERK_SECRET_KEY ?? ""))
    throw new Error("CLERK_SECRET_KEY (sk_test_ or sk_live_) is required");
  // Either key, never both: SPIKE_EXPLORER_BASE_URL routes the explorer at an OpenAI-compatible
  // host instead of Anthropic (lib/explorer-client.mjs).
  if (!process.env.SPIKE_EXPLORER_BASE_URL && !process.env.ANTHROPIC_API_KEY)
    throw new Error(EXPLORER_KEY_REFUSAL);
  // Who points at the controls, and on whose key -- see resolveGroundingEnv above. It refuses by
  // name when there is no grounding key at all, before the browser launches or an identity is
  // minted, rather than three steps into a walk that cannot locate anything.
  Object.assign(process.env, resolveGroundingEnv(process.env));
  // Midscene writes its own report folder to the CURRENT directory unless told otherwise, which
  // litters whatever repo the run was launched from. Keep it beside the run's own output.
  process.env.MIDSCENE_RUN_DIR ??= join(process.env.RELEASHED_OUT ?? join(process.cwd(), "releashed"), "midscene");
  // Fail fast on a locator misconfiguration before the walk starts (see validateLocatorModelFamily
  // above) rather than three steps and a misleading "could not locate" seal into it.
  validateLocatorModelFamily(process.env.MIDSCENE_MODEL_FAMILY);

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
  // Kinds behind the same streak (see classifyExecutorFailure), reset in lockstep with the counter
  // above: whether the breaker below reports "nothing on screen matched" or "the locator itself is
  // failing" depends on what actually happened in that streak, not a guess.
  let unexecutableKinds = [];
  // The two counters behind the breaker and the wait budget: how many steps in a row have changed
  // nothing on screen, and how much of the run's total waiting time is already spent.
  let consecutiveNoEffect = 0;
  let waitedMs = 0;
  // Doors the guard below refuses to walk through (e.g. a social sign-in button that leaves the
  // bound origin). Nothing is dispatched, so -- exactly like `unexecutable` above -- there is no
  // observed transition to add to the trace; this is bookkeeping, not evidence. Reusing the
  // "unknown terminal" language already established for observed-but-untrusted outcomes (see
  // renderer/render-map.mjs's "Outcome unknown" node) rather than inventing a new status.
  const blocked = [];
  let stopReason = "step_budget_exhausted";
  let stopDetail = "The step budget ran out before the explorer said it was finished.";
  let goalReachedAtStep = null;
  let goalScreenshotPath = null;
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
          decide(anthropic, state.png, history, explorerUsage, brief, pageContext),
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
        // "Done" means one thing in each mode, and the stop reason has to say which: with no goal
        // it is "there is nothing left to explore"; with one it is "I am looking at what you asked
        // for" -- but only when that claim can be bound to retained evidence.
        // This is the image the explorer was looking at when it claimed the goal. It is an
        // existing evidence path, not a new final screenshot or a guessed filename -- but nothing
        // previously checked that the recorded trace (or, at step 1, the raw entry observation)
        // actually retains it, so it is verified rather than just carried through.
        const claimScreenshotPath = goal ? state.evidence.screenshot_path : null;
        const verification = goal
          ? await verifyGoalClaim({
              events,
              claimScreenshotPath,
              observedEvidence: state.evidence,
              readScreenshotBytes: (path) => readFile(join(runDir, path)),
            })
          : { verified: true };
        const sealed = sealDoneDecision({
          goal,
          step,
          decisionWhy: decision.why,
          claimScreenshotPath,
          verification,
        });
        stopReason = sealed.stopReason;
        stopDetail = sealed.stopDetail;
        goalReachedAtStep = sealed.goalReachedAtStep;
        goalScreenshotPath = sealed.goalScreenshotPath;
        break;
      }


      // A wait is not an action: nothing is dispatched, no request crosses the action boundary, and
      // the pre-dispatch gate below has nothing to authorize -- so it is skipped rather than
      // refused (checkActionAuthorized would correctly call "wait" an unsupported action). It still
      // costs a step, still gets its own before/after screenshots, and still runs the wall check at
      // the bottom of this step, so a bot check or a rate limit that appears while time passes ends
      // the run exactly as one after a click does. Waiting is never a way to sit a wall out.
      const waiting = decision.action === "wait";
      const waitMs = waiting ? waitAllowance(waitedMs) : 0;
      if (waiting && waitMs === 0) {
        history.push(
          `(there is no waiting time left: a run may wait ${RUN_WAIT_BUDGET_MS / 1000} seconds in total and this one has used all of it. Waiting again will not work -- do something else on the screen, or say you are done.)`,
        );
        console.log(`    WAIT BUDGET: the run's ${RUN_WAIT_BUDGET_MS / 1000}s of waiting is spent`);
        continue;
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
      const authCheck = waiting
        ? { authorized: true, reason: null }
        : checkActionAuthorized(decision, boundary.origins, page.url(), target.readOnly, limits);
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
      if (waiting) {
        waitedMs += waitMs;
        await page.waitForTimeout(waitMs);
        outcome = { executor: `waited ${(waitMs / 1000).toFixed(1)}s` };
      } else {
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
            // Typing does not have a coordinate to identify beforehand. Read the focused control
            // immediately after the successful dispatch, before the next observation can replace
            // it, so evidence names the field rather than a positional guess.
            if (decision.action === "type") identified = await focusedTarget(page, state.refs);
          }
        } catch (error) {
          // The executor refused to guess a coordinate, so no input was dispatched. There is no
          // observed transition to record -- an attempted instruction is not evidence.
          const message = scrub(error?.message ?? error);
          const kind = classifyExecutorFailure(error?.message ?? error);
          unexecutable.push({ instruction: decision.instruction, target: decision.target, message });
          consecutiveUnexecutable += 1;
          unexecutableKinds.push(kind);
          history.push(
            kind === "locator_error"
              ? `(the previous instruction could not be carried out: the configured locator itself failed, not the product's screen: ${message})`
              : `(the previous instruction could not be carried out: nothing on screen matched "${decision.target}")`,
          );
          console.log(`    NOT EXECUTED: ${message}`);
          if (consecutiveUnexecutable >= 3) {
            // Only call it a genuine miss if at least one failure in the streak actually was one;
            // a streak that is ENTIRELY locator failures is the locator, not the product's screen.
            if (unexecutableKinds.every((k) => k === "locator_error")) {
              stopReason = "executor_locator_error";
              stopDetail = `Exploration stopped after three instructions in a row where the configured locator itself failed (not "nothing on screen matched") -- check MIDSCENE_MODEL_BASE_URL/_NAME/_FAMILY and its API key. Last error: ${message}`;
            } else {
              stopReason = "executor_could_not_locate_target";
              stopDetail = `Exploration stopped after three instructions in a row that nothing on screen matched, the last being "${decision.instruction}".`;
            }
            break;
          }
          continue;
        }
        consecutiveUnexecutable = 0;
        unexecutableKinds = [];
        await page.waitForTimeout(1_500);
      }

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

      const method = waiting
        ? "wait"
        : decision.action === "tap" || decision.action === "drag"
          ? "click"
          : decision.action;

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
      // The breaker. A step that changed nothing -- a click, a type, a scroll, or a wait, since
      // waiting forever is the same failure as clicking forever -- adds to the streak; any step
      // that did something clears it. From three in a row the walk is told plainly, in the same
      // history it reads its own instructions back from, so it arrives on the next turn.
      consecutiveNoEffect = changed ? 0 : consecutiveNoEffect + 1;
      const stuck = noEffectNote(consecutiveNoEffect);
      if (stuck) {
        history.push(stuck);
        console.log(`    STUCK: ${consecutiveNoEffect} steps in a row with no visible effect`);
      }

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

  // A directed run that ran out of budget, hit a wall or errored has to answer the question it was
  // asked, and the honest answer is "not there, and here is where I got to instead" -- never the
  // bare budget line, which reads as if the goal was never the point.
  if (goal && stopReason !== "goal_claimed")
    stopDetail = `The goal was not reached. ${stopDetail} The last screen it stood on was ${
      events.at(-1)?.current_url ?? "the page it started on"
    }.`;

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
        // The label that makes a directed map honest: this run was aimed, and here is the sentence
        // it was aimed with. A free walk carries no such key at all -- see docs/map-schema.md.
        auth_mode: target.authMode ?? null,
        // Only the explicit command-line label is retained. In particular, do not derive one
        // from a saved-session filename or any credential-bearing data.
        identity_label: identityLabel ?? null,
        ...(goal
          ? {
              directed_by: goal,
              ...(policy ? { policy } : {}),
              ...(continues ? { continues } : {}),
              ...(precondition ? { precondition } : {}),
              ...(stopReason === "goal_claimed"
                ? { goal_claimed_at_step: goalReachedAtStep, goal_screenshot_path: goalScreenshotPath }
                : {}),
            }
          : {}),
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
          // --mine was set (or the target is fully trusted, e.g. the built-in APPROVED_TARGETS
          // path, readOnly: false), "stranger" otherwise -- see docs/ARCHITECTURE.md.
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
