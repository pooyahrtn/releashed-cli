#!/usr/bin/env node
// releashed -- map a deployed product's user flows from its URL alone.
//
//   releashed doctor
//   releashed map <url> [options]
//   releashed login <url>
//   releashed mcp <candidate-dir>
//   releashed explore-mcp [<url>] [--steps N]
//
// This file is an entry layer and nothing else: every stage below already exists and is tested on
// its own. `map` authors the target's public pack from its landing page (no model call), runs the
// source-blind explorer, captions the screens, and packages the evidence into a candidate holding
// map.html (for people) and map.json (for programs). Everything is written under ./releashed in the
// current directory; RELEASHED_OUT overrides it. Nothing is ever sent anywhere: no telemetry.
import type { SpawnOptions } from "node:child_process";
import type { Dirent } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { diffMaps, formatDiff, hasDisappearance } from "../lib/map-diff.ts";
import { MAX_STEPS } from "../lib/run-limits.mjs";
import { hasGeminiKey } from "../lib/scaffold.ts";
import {
  BROWSER_REFUSAL,
  MIN_NODE_MAJOR,
  missingModelKeys,
  nodeRefusal,
  spendNotice,
} from "../lib/first-run.ts";
import {
  assertRunId,
  validateCaptureMetadata,
} from "../lib/capture-metadata.ts";
import { selectCapture } from "../lib/capture-selection.ts";
import {
  MAX_NOTE_INPUT_BYTES,
  findMemory,
  findNotes,
  formatCompactNotes,
  formatNotesNotices,
  formatRememberResult,
  rememberFlow,
} from "../lib/product-notebook.ts";
import { createLocalTiming } from "../lib/local-timing.mjs";
import { captureDoctor } from "../lib/capture-doctor.ts";
import { captureReport } from "../lib/capture-report.ts";
import { startPhases, stampPhase } from "../lib/capture-phases.ts";
import {
  alternativesFromStore,
  formatAlternatives,
} from "../lib/goal-alternatives.ts";

type FlagValue = string | true | string[];
type Flags = Record<string, FlagValue | undefined>;

interface ReportOptions {
  command: "report";
  runId: string;
  preparation: string;
  cleanup: string;
  timing: string;
  phases: string;
  inspection: string;
  json: boolean;
}

interface CaptureReportResult {
  markdown: string;
  [key: string]: unknown;
}

interface PhaseOptions {
  command: "phases";
  boundary: "start" | "preparation" | "capture" | "cleanup";
  record: string;
  runId?: string;
}

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const require = createRequire(import.meta.url);
const MODELS: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
};
// The two sizes a v0 run offers. Desktop is 1280 wide because that is the cap a screenshot may
// reach an agent at, so nothing has to be downscaled afterwards.
const VIEWPORTS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
};
const LIST = ["include", "exclude", "allow", "viewports"];

const USAGE = `releashed -- an evidence-backed map of a product's user flows, from its URL alone.

  releashed doctor
      Check API keys/credit (makes a small paid call), Chromium and Node for API-driven map.

  releashed doctor --capture <url> --goal "<request>" --mcp-config <file.json>
      --server <name> --preparation <file> [--json]
      Inspect local directed MCP configuration and preparation-record presence before login.
      No browser, authentication, account checks or model calls. Client tool permission remains
      unverified; check it in the calling client before observe.

  releashed map <url> [options]
      Explore the product and write a map, driven by OUR model key: needs ANTHROPIC_API_KEY (the
      explorer) and GEMINI_API_KEY (grounding) by default, plus Chromium from
      "releashed install-browser" and Node 22 or newer. This is the one command that spends: a
      40-step run is roughly EUR 0.33 on sonnet or EUR 0.67 on opus, on your key. Screen
      captions are written by a
      small Claude on the ANTHROPIC_API_KEY you already have; if GEMINI_API_KEY is set, it
      captions them instead, exactly as it always did.
      No key of ours at all: use "releashed explore-mcp" instead (below) -- your own coding agent
      drives the walk, over MCP, with no Anthropic or Gemini key from this tool.
      Any key of yours instead of ours: SPIKE_EXPLORER_BASE_URL + SPIKE_EXPLORER_API_KEY route the
      explorer at any OpenAI-compatible host (Together, OpenRouter, DashScope, ...) instead of
      Anthropic; CAPTION_BASE_URL + CAPTION_API_KEY (+ optional CAPTION_MODEL) do the same for
      screen captions instead. Both pairs are all-or-nothing: set the URL and the key
      together, or leave both unset. See lib/explorer-client.mjs and scripts/caption-screens.mjs
      for exact behavior.
      --model sonnet|opus  which Claude drives the exploration (default sonnet)
      --steps N            actions the run may take (1-250, default 40; a survey needs ~40, a
                           capture aimed at a screen deep in a long journey needs more)
      --minutes N          wall-clock budget; the run stops when it is spent
      --budget EUR         model-spend cap, e.g. --budget 0.50; the run stops the moment that
                           much model spend is gone. The run prints its own estimate before
                           it starts either way
      --login              use the session you saved with "releashed login"
      --auth-cmd <cmd>     a command of YOURS that prints a one-shot sign-in URL, or a session
                           file, for a test account you own -- no browser window, no human
      --seed <file.json>   values you supply for this product's fields: { "email": "you@..." }
      --upload <file>      the one file the run may hand to a file picker
      --include <globs>    only these paths are the product, e.g. "/tools/**,/app/**"
      --exclude <globs>    never these paths, e.g. "/blog/**,/docs/**"
      --allow <origins>    more origins of the same product, e.g. "https://app.example.com"
      --viewports <list>   desktop, phone, or "desktop,phone" for both in one run
      --mine               you own this product (suppresses the third-party warning)
      --goal "<English>"   capture mode, for a product you own and have already mapped: the one
                           thing this run is to reach, in your own words. The run pursues it
                           instead of roaming, stops when it is looking at it, and the map is
                           labelled as directed. Without it the run is source-blind discovery.
      --policy "<English>" how to behave on the way -- conduct, not a route (needs --goal)
      --continues <run-id>  this capture follows an existing run; records a pointer, never replays it
      --precondition "<English>" state arranged outside the walk; refer to prior runs as "run <id>"
      --expect "<English>"   what the owner expects to see when the goal is reached; sealed with the run
      --identity-label <label> nonsecret opaque account label, recorded without reading session names
      --force-map-pointer  point AGENTS.md/CLAUDE.md at this run's map anyway: even with fewer
                           screens than the map already pointed to, and even for a directed
                           (--goal) capture, which otherwise never repoints it (default:
                           leave the pointer alone and say why)

  releashed login <url>
      Open a browser so YOU can log in; the session is saved on this machine for --login.

  releashed select <run-id> --screenshots <paths...> --why "<reason>"
      Select recorded goal images without modifying a sealed run.

  releashed memory <url> --goal "<English>" [--json]
      Search this product's sealed local captures. This is read-only: it never opens a browser,
      signs in, or makes a model call. Results are evidence to inspect, not verified coverage.
      Separately labelled product notes (if any) follow the candidates; they never change
      selection, freshness or next_step.

  releashed remember <url> --note <note.json> --expected-revision N [--json]
      Remember one evidence-backed flow note. Every claim cites retained selected originals
      (run_id plus a lookup-returned screenshot path). Revision 0 creates; higher revisions
      update and stale revisions fail. Human-readable by default, --json prints the result.

  releashed notes <url> --goal "<customer evidence question>" [--json]
      Consult this product's remembered flow notes for one explicit question. This is
      read-only: it never opens a browser, signs in, captures, or makes a model call.
      Returns a compact active-claim view under product_notes (retired claims excluded,
      fully retired notes omitted; no capture candidates, no raw cited urls). Inspect
      each dated supporting original before relying on a claim.

  releashed report <run-id> --preparation <file> --cleanup <file> --timing <summary.json>
      --phases <file> --inspection "<English>" [--json]
      Assemble the local preparation, cleanup, timing, phase and inspection record for a capture.

  releashed phases <start|preparation|capture|cleanup> <absolute-record> [--run-id <run-id>]
      Create a private phase record, then stamp each boundary once. Tracking start is not the
      user request time; reports label it separately when the actual request time is unknown.

  releashed install-skills [--destination <directory>] [--replace]
      Copy packaged agent skills into .claude/skills in this project, or a directory you name.
      Existing skill folders are left untouched unless --replace is explicit.

  releashed install-browser
      Install Chromium using this installed package's Playwright version.

  releashed mcp [candidate-dir]
      With a candidate, serve that finished map: list_screens, find_screen, get_screen, get_flow,
      screen_edges, list_transitions. With no candidate, serve shared capture memory:
      find_capture, remember_flow, find_notes.

  releashed diff <old-map-dir> <new-map-dir>
      Compare two maps of the same product and say what changed. Prints a one-line summary, then
      the detail. --json prints the comparison as data instead of English.
      Exit code 0: nothing that existed before is missing now (new things appearing is not a
                   failure -- a wider or different walk finds more, harmlessly).
      Exit code 1: a screen or a transition that existed before is gone now.

  releashed explore-mcp [<url>] [--steps N] [--login] [--mine]
      Let your coding agent BE the explorer: observe, act, record, finish. No model key of ours.
      The server locates the agent's target noun phrase itself and needs a configured
      locator: RELEASHED_LOCATOR=midscene with MIDSCENE_MODEL_BASE_URL/_NAME/_FAMILY
      (verified: codex://app-server, gpt-5.6-sol, gpt-5, reasoning enabled low; confirm
      with "codex login status"). Caller-supplied coordinates are an explicit legacy
      mode only, refused when the locator is active.
      --image-output inline|paths  inline MCP images (default), or original image paths for a
                           persistent shell client with its own native image reader
      --login              use the session you saved with "releashed login <url>" (needs <url>)
      --auth-cmd <cmd>     mint the sign-in yourself instead (needs <url>)
      --mine               you own this product: send/post/submit are allowed; pay, delete and
                           billing/checkout/subscribe/account-destruction still are not
      --goal "<English>"   capture mode: the standing objective, handed back to you on every
                           observe, and the label the finished map carries
      --policy "<English>" how to behave on the way -- conduct, not a route (needs --goal)
      --continues <run-id>  this capture follows an existing run; records a pointer, never replays it
      --precondition "<English>" state arranged outside the walk; refer to prior runs as "run <id>"
      --expect "<English>"   what the owner expects to see when the goal is reached; sealed with the run
      --identity-label <label> nonsecret opaque account label, recorded without reading session names
      --acquire-until <ISO> absolute acquisition cutoff, e.g. 2026-09-10T11:20:00.000Z: after it
                            no new act (including wait) is dispatched; pending record, observe
                            for necessary current evidence, finish, seal and cleanup stay available
`;

const list = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

// Absolute acquisition cutoff parsing for explore-mcp only. Date.parse alone accepts
// ambiguous non-ISO values (e.g. "1"), so require an explicit ISO timestamp with a timezone
// (Z or a numeric offset) that parses to a real representable instant.
const ACQUIRE_UNTIL_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
function parseAcquireUntil(value: string): number {
  if (!ACQUIRE_UNTIL_RE.test(value))
    throw new Error(
      "--acquire-until must be an ISO timestamp with an explicit timezone, e.g. 2026-09-10T11:20:00.000Z",
    );
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(
      "--acquire-until must be a real representable timestamp, e.g. 2026-09-10T11:20:00.000Z",
    );
  return parsed;
}

// S19-1: side-effect-free per-command help for the saved-lookup entry. Printed by main()
// without validation, store creation, authentication or paid checks.
export const COMMAND_HELP: Record<string, string> = {
  memory: `releashed memory <url> --goal "<English>" [--json]

  Search this product's sealed local captures. This is read-only: it never opens a
  browser, signs in, or makes a model call, and needs no model key.

  The installed command works from the npm archive with its own dependencies; it needs
  no developer checkout, no copied node_modules, no install-browser and neither doctor
  mode. Run it from the product checkout (or any directory sharing its store).

  --goal is the one thing to find, in your own words. The product origin comes from
  <url> (origin only, e.g. https://app.example.com). --json prints the lookup as data.

  Captures live in the shared store: <git-common-dir>/releashed (every worktree of the
  product shares it); RELEASHED_OUT overrides it. Results list sealed originals with
  their capture dates and source references. Open each returned original PNG directly
  (your viewer, or the image tool) and inspect it before relying on it.
  A differently worded query may also return matching_observations: verified
  intermediate frames with their own dates, for visible-content inspection only.
`,
  mcp: `releashed mcp [candidate-dir]

  Serve sealed local evidence over MCP (stdio). With a candidate directory, serve that
  finished map (list_screens, find_screen, get_screen, get_flow, screen_edges,
  list_transitions). With no candidate, serve the shared capture memory (find_capture),
  read-only: no browser, no sign-in, no model call, no model key needed.

  The installed command works from the npm archive with its own dependencies. The
  default memory root is <shared-store>/maps (the product's shared Git store, shared
  across worktrees; RELEASHED_OUT overrides it). Returned originals carry file paths
  and capture dates; open the PNG files directly to inspect them.
`,
  remember: `releashed remember <url> --note <note.json> --expected-revision N [--json]

  Remember one evidence-backed flow note for this product. Every claim cites retained
  selected originals: run_id plus a lookup-returned screenshot path. The server binds
  each citation to its sealed manifest, image digest and observation event, and rejects
  unselected, missing, changed or cross-origin citations.

  --expected-revision 0 creates a new note; otherwise pass the revision a fresh read
  returned, or the write fails. Human-readable by default, --json prints the result.
  Notes are interpretations of the cited originals, never verified truth or certification.

  Illustrative note.json: replace flow/title/text with your observed facts,
  INSPECTION_DATE with your actual inspection date, and RUN_ID/SCREENSHOT_PATH
  with goal_screenshots values from \`releashed memory <url> --goal "<request>" --json\`.
  Inspect those originals first; the example is not a claim about your product:

    {
      "flow_id": "day-wrap",
      "title": "Day wrap wind-down",
      "author_context": "Evidence-only reading of the retained run RUN_ID originals inspected INSPECTION_DATE.",
      "claims": [
        { "id": "wrap-lists",
          "text": "The wrap screen lists the exercises completed that day.",
          "references": [{ "run_id": "RUN_ID", "screenshot_path": "SCREENSHOT_PATH" }] }
      ]
    }

    releashed remember https://app.example.com --note note.json --expected-revision 0

  Updates, corrections and retirements: see the installed releashed-memory skill.
`,
  notes: `releashed notes <url> --goal "<customer evidence question>" [--json]

  Consult this product's remembered flow notes for one explicit question. This is
  read-only: it never opens a browser, signs in, captures, or makes a model call,
  and needs no model key. The explicit --goal makes the consultation
  purpose-specific: without it there is no question to answer.

  The response is a compact active-claim view under the product_notes key:
  retired claims are excluded, fully retired notes are omitted, there are no
  capture candidates and no raw cited urls. Each supporting reference keeps the
  dated absolute original path plus the immutable run, manifest/image digest,
  event and side bindings needed to inspect the evidence. Similar claims are
  never merged; an ok integrity check only means the bytes still match the
  seal. Full claim history, including retired claims, remains through memory.

  --json prints the lookup as data (product_notes, notes_guidance, notes_errors,
  notes_scope). Human-readable by default.

    releashed notes https://app.example.com --goal "Does the day wrap list completed exercises?"
`,
  "install-skills": `releashed install-skills [--destination <directory>] [--replace]

  Copy the packaged agent skills from the installed archive into .claude/skills in this
  project, or a directory you name. Works from the npm archive with its own
  dependencies; no browser, no keys, no model call.

  Add missing skills and leave existing entries untouched. Repeating this command
  succeeds without changing existing skills. Use --replace to overwrite packaged
  files in existing skill folders; customer-only files remain.
`,
};

const SAVED_HELP_COMMANDS = [
  "memory",
  "mcp",
  "install-skills",
  "remember",
  "notes",
];

export function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  )
    return { command: "help" } as const;
  if (
    command === "phases" &&
    rest.length === 1 &&
    ["--help", "-h", "help"].includes(rest[0])
  )
    return { command: "help" } as const;
  // Recognize saved-lookup help before any argument validation or store creation.
  // Only the --help/-h flags count: a positional or value token such as
  // `--goal help` or `--destination help` is an ordinary argument value, and
  // `mcp help` names a candidate directory. The bare `help` alias stays valid
  // only in command position (first token, handled above).
  if (
    SAVED_HELP_COMMANDS.includes(command) &&
    rest.some((token) => token === "--help" || token === "-h")
  )
    return { command: "help", for: command } as const;
  const positional = [];
  const flags: Flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (
      ["--login", "--mine", "--json", "--replace", "--capture"].includes(token)
    )
      flags[token.slice(2)] = true;
    else if (token === "--screenshots") {
      const values = [];
      while (rest[index + 1] && !rest[index + 1].startsWith("--"))
        values.push(rest[++index]);
      if (!values.length)
        throw new Error("--screenshots needs recorded screenshot paths");
      flags.screenshots = values;
    } else if (token.startsWith("--")) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${token} needs a value`);
      flags[token.slice(2)] = value;
      index += 1;
    } else positional.push(token);
  }
  const known = [
    "model",
    "steps",
    "minutes",
    "budget",
    "login",
    "auth-cmd",
    "mine",
    "seed",
    "upload",
    "json",
    "replace",
    "destination",
    "goal",
    "policy",
    "continues",
    "precondition",
    "expect",
    "identity-label",
    "screenshots",
    "why",
    "capture",
    "mcp-config",
    "server",
    "preparation",
    "cleanup",
    "timing",
    "phases",
    "inspection",
    "run-id",
    "acquire-until",
    "note",
    "expected-revision",
    ...LIST,
  ];
  known.push("image-output");
  if (command !== "explore-mcp" && "image-output" in flags)
    throw new Error("--image-output is only supported with explore-mcp");
  if (command !== "explore-mcp" && "acquire-until" in flags)
    throw new Error("--acquire-until is only supported with explore-mcp");
  const unknown = Object.keys(flags).filter((key) => !known.includes(key));
  if (unknown.length) throw new Error(`unknown option --${unknown[0]}`);
  if (command !== "phases" && "run-id" in flags)
    throw new Error("--run-id is only supported with phases capture.");
  if (
    command !== "report" &&
    ["cleanup", "timing", "phases", "inspection"].some((key) => key in flags)
  )
    throw new Error(
      "--cleanup, --timing, --phases and --inspection are report options",
    );
  if (command !== "doctor" && command !== "report" && "preparation" in flags)
    throw new Error("--preparation is a doctor or report option");
  if (
    command !== "doctor" &&
    command !== "report" &&
    ["capture", "mcp-config", "server", "preparation"].some(
      (key) => key in flags,
    )
  )
    throw new Error(
      "--capture, --mcp-config, --server and --preparation are doctor options",
    );
  if (command === "doctor") {
    if (!flags.capture) {
      if (positional.length || Object.keys(flags).length)
        throw new Error(
          "use doctor --capture <url> --goal <request> --mcp-config <file.json> --server <name> --preparation <file> for local capture checks",
        );
      return { command } as const;
    }
    if (
      Object.keys(flags).some(
        (key) =>
          ![
            "capture",
            "goal",
            "mcp-config",
            "server",
            "preparation",
            "json",
          ].includes(key),
      )
    )
      throw new Error(
        "capture doctor reads run options from --mcp-config; only --goal is supplied independently for comparison",
      );
    if (
      positional.length !== 1 ||
      !String(flags.goal ?? "").trim() ||
      !flags["mcp-config"] ||
      !flags.server ||
      !flags.preparation
    )
      throw new Error(
        "usage: releashed doctor --capture <url> --goal <request> --mcp-config <file.json> --server <name> --preparation <file> [--json]",
      );
    const url = new URL(positional[0]);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "capture doctor needs an http(s) product URL without credentials, query or fragment",
      );
    return {
      command,
      capture: true,
      url: url.href,
      goal: String(flags.goal),
      mcpConfig: resolve(String(flags["mcp-config"])),
      server: String(flags.server),
      preparation: resolve(String(flags.preparation)),
      json: flags.json === true,
    } as const;
  }
  if (command === "report") {
    if (
      Object.keys(flags).some(
        (key) =>
          ![
            "preparation",
            "cleanup",
            "timing",
            "phases",
            "inspection",
            "json",
          ].includes(key),
      )
    )
      throw new Error(
        "usage: releashed report <run-id> --preparation <file> --cleanup <file> --timing <summary.json> --phases <file> --inspection <English> [--json]",
      );
    if (
      positional.length !== 1 ||
      !flags.preparation ||
      !flags.cleanup ||
      !flags.timing ||
      !flags.phases ||
      !String(flags.inspection ?? "").trim()
    )
      throw new Error(
        "usage: releashed report <run-id> --preparation <file> --cleanup <file> --timing <summary.json> --phases <file> --inspection <English> [--json]",
      );
    return {
      command,
      runId: assertRunId(positional[0], "report"),
      preparation: resolve(flags.preparation as string),
      cleanup: resolve(flags.cleanup as string),
      timing: resolve(flags.timing as string),
      phases: resolve(flags.phases as string),
      inspection: flags.inspection as string,
      json: flags.json === true,
    } satisfies ReportOptions;
  }
  if (command === "phases") {
    if (Object.keys(flags).some((key) => key !== "run-id"))
      throw new Error(
        "usage: releashed phases <start|preparation|capture|cleanup> <absolute-record> [--run-id <run-id>]",
      );
    if (
      positional.length !== 2 ||
      !["start", "preparation", "capture", "cleanup"].includes(positional[0])
    )
      throw new Error(
        "usage: releashed phases <start|preparation|capture|cleanup> <absolute-record> [--run-id <run-id>]",
      );
    if (!String(positional[1]).startsWith("/"))
      throw new Error("phases needs an absolute record path.");
    if (positional[0] === "capture" && !flags["run-id"])
      throw new Error("phases capture needs --run-id.");
    if (positional[0] !== "capture" && flags["run-id"])
      throw new Error("--run-id is only supported with phases capture.");
    return {
      command,
      boundary: positional[0],
      record: resolve(positional[1]),
      runId: flags["run-id"],
    } as PhaseOptions;
  }
  // Capture mode, and the only door a goal comes through. No goal is discovery, unchanged: the
  // walk is source-blind and nothing the user knows about the product reaches it. A policy is how
  // to behave while pursuing a goal, so on its own it is just source knowledge with no objective.
  const goal = typeof flags.goal === "string" ? flags.goal : null;
  const policy = typeof flags.policy === "string" ? flags.policy : null;
  const continues =
    typeof flags.continues === "string" ? assertRunId(flags.continues) : null;
  const precondition =
    typeof flags.precondition === "string" ? flags.precondition : null;
  const expect = typeof flags.expect === "string" ? flags.expect : null;
  const identityLabel =
    typeof flags["identity-label"] === "string"
      ? flags["identity-label"]
      : null;
  if (precondition !== null && !precondition.trim())
    throw new Error("--precondition must be non-empty plain English");
  if (expect !== null && !expect.trim())
    throw new Error("--expect must be non-empty plain English");
  if (policy && !goal)
    throw new Error(
      "--policy says how to behave while pursuing a --goal; pass one",
    );
  if ((continues || precondition || expect || identityLabel) && !goal)
    throw new Error(
      "--continues, --precondition, --expect, and --identity-label need --goal",
    );
  // Two ways in, never both: one is a person at a window, the other is your own backend.
  if (flags.login === true && flags["auth-cmd"] !== undefined)
    throw new Error("--login and --auth-cmd are two ways to sign in; pick one");
  const authCmd =
    typeof flags["auth-cmd"] === "string" ? flags["auth-cmd"] : null;

  if (command === "map") {
    if (positional.length !== 1)
      throw new Error("usage: releashed map <url> [options]");
    const url = new URL(positional[0]);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("the url must be http or https");
    const model = typeof flags.model === "string" ? flags.model : "sonnet";
    if (!MODELS[model]) throw new Error('--model must be "sonnet" or "opus"');
    const steps = flags.steps === undefined ? 40 : Number(flags.steps);
    if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS)
      throw new Error(`--steps must be a whole number 1-${MAX_STEPS}`);
    const minutes = flags.minutes === undefined ? null : Number(flags.minutes);
    if (minutes !== null && !(minutes > 0))
      throw new Error("--minutes must be a positive number");
    const budgetEur = flags.budget === undefined ? null : Number(flags.budget);
    if (budgetEur !== null && !(budgetEur > 0))
      throw new Error("--budget must be a positive number of euros");
    const viewports =
      flags.viewports === undefined
        ? ["desktop"]
        : list(String(flags.viewports));
    for (const name of viewports)
      if (!VIEWPORTS[name])
        throw new Error(
          `--viewports takes ${Object.keys(VIEWPORTS).join(" and ")}`,
        );
    const allow = flags.allow === undefined ? [] : list(String(flags.allow));
    for (const origin of allow)
      if (new URL(origin).origin !== origin)
        throw new Error(`--allow takes origins, not ${origin}`);
    return {
      command,
      url: url.href,
      model,
      steps,
      minutes,
      budgetEur,
      login: flags.login === true,
      authCmd,
      mine: flags.mine === true,
      seedPath: flags.seed ? resolve(String(flags.seed)) : null,
      uploadPath: flags.upload ? resolve(String(flags.upload)) : null,
      include: flags.include === undefined ? [] : list(String(flags.include)),
      exclude: flags.exclude === undefined ? [] : list(String(flags.exclude)),
      allow,
      viewports: viewports.map((name) => VIEWPORTS[name]),
      goal,
      policy,
      continues,
      precondition,
      expect,
      identityLabel,
      forceMapPointer: flags["force-map-pointer"] === true,
    } as const;
  }
  if (command === "login") {
    if (positional.length !== 1)
      throw new Error("usage: releashed login <url>");
    return { command, url: new URL(positional[0]).href } as const;
  }
  if (command === "install-skills") {
    if (positional.length)
      throw new Error(
        "usage: releashed install-skills [--destination <directory>] [--replace]",
      );
    return {
      command,
      destination: resolve(
        String(flags.destination ?? join(process.cwd(), ".claude", "skills")),
      ),
      replace: flags.replace === true,
    } as const;
  }
  if (command === "install-browser") {
    if (positional.length) throw new Error("usage: releashed install-browser");
    return { command } as const;
  }
  if (command === "select") {
    if (
      positional.length !== 1 ||
      !Array.isArray(flags.screenshots) ||
      !String(flags.why ?? "").trim()
    )
      throw new Error(
        "usage: releashed select <run-id> --screenshots <paths...> --why <reason>",
      );
    return {
      command,
      runId: assertRunId(positional[0], "select"),
      screenshots: flags.screenshots,
      why: String(flags.why),
    } as const;
  }
  if (command === "memory") {
    if (positional.length !== 1)
      throw new Error("usage: releashed memory <url> --goal <English>");
    if (!goal) throw new Error("releashed memory needs --goal <English>");
    const url = new URL(positional[0]);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("the url must be http or https");
    return {
      command,
      url: url.origin,
      goal,
      json: flags.json === true,
    } as const;
  }
  if (command === "remember") {
    if (positional.length !== 1)
      throw new Error(
        "usage: releashed remember <url> --note <note.json> --expected-revision N [--json]",
      );
    if (!flags.note)
      throw new Error("releashed remember needs --note <note.json>");
    if (flags["expected-revision"] === undefined)
      throw new Error(
        "releashed remember needs --expected-revision N (0 to create)",
      );
    const revision = Number(flags["expected-revision"]);
    if (!Number.isInteger(revision) || revision < 0)
      throw new Error("--expected-revision must be a whole number 0 or higher");
    const url = new URL(positional[0]);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("the url must be http or https");
    if (url.username || url.password)
      throw new Error("the url must not contain credentials");
    return {
      command,
      url: url.origin,
      notePath: resolve(String(flags.note)),
      expectedRevision: revision,
      json: flags.json === true,
    } as const;
  }
  if (command === "notes") {
    if (positional.length !== 1)
      throw new Error(
        "usage: releashed notes <url> --goal <customer evidence question>",
      );
    if (!goal)
      throw new Error(
        "releashed notes needs --goal '<customer evidence question>' naming what the notes should answer",
      );
    const url = new URL(positional[0]);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("the url must be http or https");
    if (url.username || url.password)
      throw new Error("the url must not contain credentials");
    return {
      command,
      url: url.origin,
      goal,
      json: flags.json === true,
    } as const;
  }
  if (command === "mcp") {
    if (positional.length > 1)
      throw new Error("usage: releashed mcp [candidate-dir]");
    return {
      command,
      candidateDir: positional[0] ? resolve(positional[0]) : null,
    } as const;
  }
  if (command === "diff") {
    if (positional.length !== 2)
      throw new Error("usage: releashed diff <old-map-dir> <new-map-dir>");
    return {
      command,
      oldDir: resolve(positional[0]),
      newDir: resolve(positional[1]),
      json: flags.json === true,
    } as const;
  }
  if (command === "explore-mcp") {
    if (positional.length > 1)
      throw new Error("usage: releashed explore-mcp [<url>] [--steps N]");
    const steps = flags.steps === undefined ? 40 : Number(flags.steps);
    if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS)
      throw new Error(`--steps must be a whole number 1-${MAX_STEPS}`);
    if (positional[0]) new URL(positional[0]);
    if (flags.login === true && !positional[0])
      throw new Error("explore-mcp --login needs the <url> you logged in to");
    if (authCmd && !positional[0])
      throw new Error("explore-mcp --auth-cmd needs the <url> it signs in to");
    if (flags.minutes !== undefined || flags.budget !== undefined)
      throw new Error(
        "explore-mcp is driven by your coding agent; use --steps to bound the browser run. Midscene makes target-location calls through your configured model; --minutes and --budget are not supported here.",
      );
    const imageOutput = flags["image-output"] ?? "inline";
    if (imageOutput !== "inline" && imageOutput !== "paths")
      throw new Error("--image-output must be inline or paths");
    let acquireUntil: number | null = null;
    if (flags["acquire-until"] !== undefined) {
      acquireUntil = parseAcquireUntil(String(flags["acquire-until"]));
    }
    return {
      command,
      url: positional[0] ?? null,
      steps,
      imageOutput,
      login: flags.login === true,
      authCmd,
      mine: flags.mine === true,
      goal,
      policy,
      continues,
      precondition,
      expect,
      identityLabel,
      acquireUntil,
    } as const;
  }
  throw new Error(`unknown command "${command}"\n\n${USAGE}`);
}

type ParsedOptions = ReturnType<typeof parseArgs>;
type MapOptions = Extract<ParsedOptions, { command: "map" }>;
type ExplorerOptions = Pick<
  MapOptions,
  | "url"
  | "steps"
  | "model"
  | "minutes"
  | "budgetEur"
  | "goal"
  | "policy"
  | "continues"
  | "precondition"
  | "expect"
  | "identityLabel"
> & { configPath: string; runDir: string };
type SessionOptions = {
  url: string | null;
  login?: boolean;
  authCmd?: string | null;
};
type SessionDeps = {
  out?: string;
  sessionDir?: string;
  authSession?: typeof import("../lib/auth-cmd.mjs").sessionFromAuthCmd;
};
// Legacy JavaScript defaults infer null-only fields; describe the implemented string inputs here.
type PackageFn = (args: {
  runId: string;
  runPath: string;
  outputPath: string;
  publicPackPath: string;
  publicPackSha256: string;
  captions: Record<string, unknown>;
}) => Promise<{ output_path: string }>;
type StripFn = (args: {
  candidateDir: string;
  outputPath: string;
  heading: string;
  subheading: string;
}) => Promise<unknown>;
type MapDeps = SessionDeps & {
  authorPack?: typeof import("../scripts/author-target-pack.ts").authorTargetPack;
  login?: typeof captureLogin;
  explore?: typeof runExplorer;
  caption?: typeof import("../scripts/caption-screens.ts").captionScreens;
  packageRun?: PackageFn;
  strip?: StripFn;
  sha256?: (bytes: Buffer) => Promise<string>;
  agents?: typeof writeAgentsBlock;
  log?: typeof console.log;
};
type DoctorDeps = {
  ask?: (key: string) => Promise<void>;
  ground?: (key: string) => Promise<void>;
  browser?: () => Promise<void>;
  log?: typeof console.log;
};

const stamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
const slug = (url: string) =>
  new URL(url).hostname.replace(/[^a-z0-9]+/gi, "-");
// The one place every command reaches for ./releashed. It never leaves this directory to be found
// by `git add -A` and committed with a live signed-in session inside it -- so creating it always
// drops a `.gitignore` that ignores everything under it, before any caller writes a single file.
export function gitCommonDir(cwd = process.cwd()) {
  try {
    return (
      execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() || null
    );
  } catch {
    return null;
  }
}

// A product's worktrees share Git's common directory, while an explicit output root remains the
// escape hatch for a non-Git project or a deliberately separate store.
export const outputRoot = ({ cwd = process.cwd(), env = process.env } = {}) => {
  const root = resolve(
    env.RELEASHED_OUT ??
      (gitCommonDir(cwd)
        ? join(gitCommonDir(cwd)!, "releashed")
        : join(cwd, "releashed")),
  );
  mkdirSync(root, { recursive: true });
  const gitignorePath = join(root, ".gitignore");
  if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, "*\n");
  return root;
};

function run(
  command: string,
  args: string[],
  options: SpawnOptions & { capture?: boolean } = {},
) {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
      ...options,
    });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise(out)
        : reject(new Error(`${args[0]} exited with ${code}`)),
    );
  });
}

// A human logs in by hand in a visible browser; the cookies land in a file only this machine has.
// We never ask for a password and never store one.
export async function captureLogin(url: string, sessionDir: string) {
  await mkdir(sessionDir, { recursive: true });
  const name = slug(url);
  await run(process.execPath, [
    join(ROOT, "scripts/capture-session.mjs"),
    "--url",
    url,
    "--name",
    name,
    "--output-dir",
    sessionDir,
  ]);
  return join(sessionDir, `${name}.json`);
}

// The explorer itself: SPIKE_APP_URL fixes the origin, the config fixes everything else, and the
// run directory is ours to name so a global install never writes inside node_modules. It prints the
// run directory it wrote; that line is how we find it.
async function runExplorer({
  url,
  configPath,
  steps,
  model,
  minutes,
  budgetEur,
  runDir,
  goal = null,
  policy = null,
  continues = null,
  precondition = null,
  expect = null,
  identityLabel = null,
}: ExplorerOptions) {
  const args = [
    join(ROOT, "scripts/vision-explorer-run.mjs"),
    "--steps",
    String(steps),
    "--target-config",
    configPath,
    "--run-dir",
    runDir,
  ];
  if (minutes) args.push("--minutes", String(minutes));
  if (budgetEur) args.push("--budget-eur", String(budgetEur));
  // Only a run the user aimed carries these at all, so a discovery run's command line is the one
  // it has always been.
  if (goal) args.push("--goal", goal);
  if (policy) args.push("--policy", policy);
  if (continues) args.push("--continues", continues);
  if (precondition) args.push("--precondition", precondition);
  if (expect) args.push("--expect", expect);
  if (identityLabel) args.push("--identity-label", identityLabel);
  const out = await run(process.execPath, args, {
    capture: true,
    env: {
      ...process.env,
      SPIKE_APP_URL: url,
      SPIKE_EXPLORER_MODEL: MODELS[model],
    },
  });
  const match = out.match(/^run: (\S+)$/m);
  if (!match) throw new Error("the explorer did not report a run directory");
  return resolve(match[1]);
}

// The wedge: an agent that reads this block asks the map before it reads the code. Appended once,
// idempotent, to whichever instruction file the project already has.
const BLOCK_MARK = "<!-- releashed-map -->";
export function agentsBlock(candidateDir: string) {
  return `${BLOCK_MARK}
## The product's flow map

A map of this product's real screens and transitions, built by walking the deployed site, lives in
\`${candidateDir}\`. **Ask it before you read the code or guess at a journey.** Serve it over MCP with:

    releashed mcp ${candidateDir}

Tools: \`list_screens\`, \`find_screen\` (search by what a user would call it), \`get_screen\`
(returns the screenshot), \`get_flow\` (a whole flow by name: its screens, their pictures, and how
you enter and leave it), \`screen_edges\` (how you get to a screen and where it leads),
\`list_transitions\`. \`${candidateDir}/map.json\` is the same graph as data, and \`map.html\` opens
in a browser. Every screen in it was observed; anything not in it was not seen.
${BLOCK_MARK}`;
}

// The pointer line inside an emitted block, e.g. "    releashed mcp ../maps/one". Used only to
// read back what a PREVIOUSLY written block was pointing at, so a re-map can compare it.
const POINTER_LINE_RE = /^ {4}releashed mcp (\S+)$/m;

// `map.json`'s counts.screens for the map at `mapDir`, or null when it cannot be read -- missing,
// unparsable, or simply not the shape we expect. Null always means "no comparison possible", never
// "zero screens": an unreadable old map must never block a new pointer from landing.
async function readMapScreenCount(mapDir: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(join(mapDir, "map.json"), "utf8"));
    const screens = parsed?.counts?.screens;
    return typeof screens === "number" && Number.isFinite(screens)
      ? screens
      : null;
  } catch {
    return null;
  }
}

// The command-line flag that overrides the thinner-map guard (and is the only way to move the
// pointer at all for a directed capture). Named once so the returned outcome and the log lines
// that mention it can never drift apart.
const FORCE_MAP_POINTER_FLAG = "--force-map-pointer";

// What a call to writeAgentsBlock actually decided, in a shape a caller can branch on without
// parsing prose. `moved` is the one fact that matters most; everything else is why, and what the
// file said before and after.
export type PointerOutcome = {
  moved: boolean;
  // Why the pointer was left alone. Null when it moved, or when there was nothing to compare
  // (first-ever write, or no instruction file to hold it at all).
  reason: "directed-capture" | "thinner-map" | null;
  // The instruction file this decision concerns -- null when this run's map does not live inside
  // `directory` at all, so no file was even considered.
  path: string | null;
  // The resolved map directory the instruction file points at once this call returns. Null when
  // no pointer exists there (nothing written yet, or `path` itself is null).
  pointsAt: string | null;
  // The resolved directory of the candidate this call was about, whether or not it won.
  candidateDir: string;
  screens: number | null;
  previousScreens: number | null;
  override: typeof FORCE_MAP_POINTER_FLAG;
};

export async function writeAgentsBlock(
  candidateDir: string,
  directory = process.cwd(),
  log = console.log,
  {
    force = false,
    dryRun = false,
    reason = null,
  }: {
    force?: boolean;
    // A dry run computes and returns the same outcome a real call would, but never writes the
    // file and never logs on its own -- the caller already knows why (it decided not to call this
    // for real) and says so in its own words. Used for a directed capture without
    // --force-map-pointer, which must never touch the pointer but still owes the coding agent a
    // legible reason, not just a missing side effect.
    dryRun?: boolean;
    reason?: "directed-capture" | null;
  } = {},
): Promise<PointerOutcome> {
  const resolvedCandidateDir = resolve(candidateDir);
  const newScreens = await readMapScreenCount(resolvedCandidateDir);
  // Only a project that will HOLD the map gets its instructions edited. Run from somewhere else --
  // a scratch folder, somebody else's repo -- and we print the block instead of writing a pointer
  // into a file that has nothing to do with this run. (Dogfood night, 2026-09-06: a run launched
  // from an unrelated checkout appended a pointer to a scratch dogfood folder to ITS AGENTS.md.)
  const holdsTheMap = resolve(candidateDir).startsWith(
    `${resolve(directory)}/`,
  );
  for (const name of holdsTheMap ? ["AGENTS.md", "CLAUDE.md"] : []) {
    const path = join(directory, name);
    const existing = await readFile(path, "utf8").catch(() => null);
    if (existing === null) continue;
    // Embed the map's location relative to the instruction file that names it, not as an absolute
    // path -- an absolute path only works on the machine and worktree that wrote it, and breaks for
    // every other clone, worktree or person reading the same AGENTS.md/CLAUDE.md.
    const relativeCandidateDir = relative(dirname(path), resolvedCandidateDir);
    const block = agentsBlock(relativeCandidateDir);
    if (existing.includes(BLOCK_MARK)) {
      // Replace the old block rather than stacking a second one, so re-mapping updates the pointer
      // -- but never let a thinner run silently clobber a pointer to a better map. (2026-09-17: a
      // failed capture loop's last, worst run overwrote a week-old 5-screen map's pointer with no
      // comparison and no notice.)
      const [before, oldBlockBody, after] = existing.split(BLOCK_MARK);
      const oldPointerRaw = oldBlockBody?.match(POINTER_LINE_RE)?.[1] ?? null;
      const oldCandidateDir = oldPointerRaw
        ? resolve(dirname(path), oldPointerRaw)
        : null;
      const oldScreens = oldCandidateDir
        ? await readMapScreenCount(oldCandidateDir)
        : null;
      if (dryRun)
        return {
          moved: false,
          reason,
          path,
          pointsAt: oldCandidateDir,
          candidateDir: resolvedCandidateDir,
          screens: newScreens,
          previousScreens: oldScreens,
          override: FORCE_MAP_POINTER_FLAG,
        };
      if (
        !force &&
        oldCandidateDir &&
        oldScreens !== null &&
        newScreens !== null &&
        newScreens < oldScreens
      ) {
        log(
          `left ${name} alone: the new map at ${resolvedCandidateDir} has ${newScreens} screen(s), fewer than the ${oldScreens} screen(s) in the map it already points to, ${oldCandidateDir}. ` +
            `If the new map is the one you want, pass ${FORCE_MAP_POINTER_FLAG}.`,
        );
        return {
          moved: false,
          reason: "thinner-map",
          path,
          pointsAt: oldCandidateDir,
          candidateDir: resolvedCandidateDir,
          screens: newScreens,
          previousScreens: oldScreens,
          override: FORCE_MAP_POINTER_FLAG,
        };
      }
      await writeFile(path, `${before}${block}${after ?? ""}`);
      if (oldCandidateDir && oldCandidateDir !== resolvedCandidateDir) {
        const describe = (count: number | null) =>
          count === null ? "screen count unknown" : `${count} screen(s)`;
        log(
          `map pointer in ${name} moved from ${oldCandidateDir} (${describe(oldScreens)}) to ${resolvedCandidateDir} (${describe(newScreens)})`,
        );
      }
      log(`told ${name} to ask the map first`);
      return {
        moved: true,
        reason: null,
        path,
        pointsAt: resolvedCandidateDir,
        candidateDir: resolvedCandidateDir,
        screens: newScreens,
        previousScreens: oldScreens,
        override: FORCE_MAP_POINTER_FLAG,
      };
    }
    if (dryRun)
      return {
        moved: false,
        reason,
        path,
        pointsAt: null,
        candidateDir: resolvedCandidateDir,
        screens: newScreens,
        previousScreens: null,
        override: FORCE_MAP_POINTER_FLAG,
      };
    await writeFile(path, `${existing.trimEnd()}\n\n${block}\n`);
    log(`told ${name} to ask the map first`);
    return {
      moved: true,
      reason: null,
      path,
      pointsAt: resolvedCandidateDir,
      candidateDir: resolvedCandidateDir,
      screens: newScreens,
      previousScreens: null,
      override: FORCE_MAP_POINTER_FLAG,
    };
  }
  if (!dryRun)
    log(
      `\nadd this to your AGENTS.md or CLAUDE.md so your agent asks the map first:\n\n${agentsBlock(resolve(candidateDir))}\n`,
    );
  return {
    moved: false,
    reason,
    path: null,
    pointsAt: null,
    candidateDir: resolvedCandidateDir,
    screens: newScreens,
    previousScreens: null,
    override: FORCE_MAP_POINTER_FLAG,
  };
}

// A capture's result belongs to the sealed map, not to a hopeful reading of the explorer's log.
// Old candidates did not always carry `stop`, so absence remains an honest unknown rather than an
// error that hides the evidence they did retain.
export function captureHandoff(
  stop: { reason?: string; detail?: string } | null,
  { runId, goal }: { runId?: string; goal?: string } = {},
) {
  if (stop?.reason === "goal_claimed" || stop?.reason === "goal_reached")
    return {
      reached: true,
      stripHeading: `Goal claimed (not verified): ${goal}`,
      lines: [
        "capture result: goal claimed by the explorer (not verified); inspect the retained evidence before relying on it.",
      ],
    };

  const reason = typeof stop?.reason === "string" ? stop.reason : null;
  const detail = typeof stop?.detail === "string" ? stop.detail : null;
  const notReached = new Set([
    "goal_not_reached",
    "step_budget_exhausted",
    "time_budget_exhausted",
    "cost_budget_exhausted",
    "bot-wall",
    "login-wall",
    "explorer_error",
    "observation_error",
    "run_error",
    "executor_could_not_locate_target",
    "executor_locator_error",
    "off_site_navigation_unrecoverable",
  ]);
  const lines = [
    notReached.has(reason ?? "")
      ? `capture result: goal not reached; this is partial evidence (${reason}${detail ? `: ${detail}` : ""}).`
      : reason
        ? `capture result: goal status unconfirmed; this is partial evidence (${reason}${detail ? `: ${detail}` : ""}).`
        : "capture result: goal status unknown; the packaged map has no stop record, so this is partial evidence.",
  ];
  // Only a time or step limit can make another carefully prepared capture useful. A wall, an
  // explorer failure, and the model-spend limit are findings/bounds, not invitations to continue.
  if (
    reason === "step_budget_exhausted" ||
    reason === "time_budget_exhausted"
  ) {
    lines.push(
      "Before another run, inspect this partial evidence and verify that the same account still has the saved progress.",
    );
    lines.push(
      "Before paying for a new run, reuse the same RELEASHED_OUT output root (where its runs and maps live) and the same identity/auth, goal, and policy; choose enough steps and remaining time and spend allowance for the unfinished journey and its auxiliary capture work.",
    );
    lines.push(
      `If that prior state is verified, --continues ${runId} records the relation only: it does not replay a browser or any action.`,
    );
  }
  // Said out loud so the caller does not have to re-derive it from the reason string. A run that
  // fell short owes the asker more than a stop code: see lib/goal-alternatives.ts.
  return {
    reached: false,
    stripHeading: `Partial evidence — goal not confirmed: ${goal}`,
    lines,
  };
}

async function packagedMapStop(candidateDir: string) {
  try {
    const map = JSON.parse(
      await readFile(join(candidateDir, "map.json"), "utf8"),
    );
    return map?.stop && typeof map.stop === "object" ? map.stop : null;
  } catch {
    return null;
  }
}

// How `explore-mcp` gets an identity. An MCP server has no window to log in through, so --login
// only reuses a session `releashed login <url>` already saved (a missing one is an error, never a
// silent public run) and --auth-cmd mints one on the spot from the user's own command.
export async function exploreSessionPath(
  options: SessionOptions,
  deps: SessionDeps = {},
) {
  const {
    authSession = (args) =>
      import("../lib/auth-cmd.mjs").then((m) => m.sessionFromAuthCmd(args)),
    out = outputRoot(),
  } = deps;
  if (options.authCmd)
    return authSession({
      command: options.authCmd,
      sessionDir: deps.sessionDir ?? join(out, "sessions"),
      name: slug(options.url!),
    });
  if (!options.login) return null;
  const path = join(out, "sessions", `${slug(options.url!)}.json`);
  await access(path).catch(() => {
    throw new Error(
      `no saved session at ${path}: run  releashed login ${options.url}  first`,
    );
  });
  return path;
}

export async function mapCommand(options: MapOptions, deps: MapDeps = {}) {
  const {
    authorPack = (url) =>
      import("../scripts/author-target-pack.ts").then((m) =>
        m.authorTargetPack(url),
      ),
    login = captureLogin,
    authSession = (args) =>
      import("../lib/auth-cmd.mjs").then((m) => m.sessionFromAuthCmd(args)),
    explore = runExplorer,
    caption = (args) =>
      import("../scripts/caption-screens.ts").then((m) =>
        m.captionScreens(args),
      ),
    packageRun = (args) =>
      import("../lib/candidate-packager.mjs").then(
        // Boundary is untyped until candidate-packager migrates to .ts (batch C2): label it,
        // don't cast it. Runtime requires the PackageFn string paths (it fails otherwise); the
        // `= null` defaults only narrow the JS inference, so the contract stands regardless.
        (m: { packageCandidate: (args: any) => any }) => m.packageCandidate(args),
      ),
    strip = (args) =>
      import("../lib/flow-strip.ts").then((m) => m.renderStrip(args)),
    sha256 = (bytes) =>
      import("../lib/scaffold.ts").then((m) => m.sha256Text(bytes)),
    agents = writeAgentsBlock,
    log = console.log,
  } = deps;
  const out = deps.out ?? outputRoot();
  const id = `${slug(options.url!)}-${stamp()}`;
  // Filesystem-only provenance validation precedes authoring, login, auth commands, and the walk.
  await validateCaptureMetadata({
    goal: options.goal,
    policy: options.policy,
    continues: options.continues,
    precondition: options.precondition,
    identityLabel: options.identityLabel,
    runsRoot: join(out, "runs"),
    mapsRoot: join(out, "maps"),
  });

  // Somebody else's product gets the strict defaults, and the run says so out loud rather than
  // leaving the user to assume it. --mine widens what the run may DO (send, post, submit, reply --
  // ordinary product use) but never what it may spend or destroy: pay, delete, billing, checkout,
  // subscribe and account destruction stay refused either way. See docs/ARCHITECTURE.md.
  if (!options.mine)
    log(
      `${new URL(options.url).origin} is not marked as yours (--mine): this run is read-only, never signs in, never sends, posts, pays or deletes, and redacts contact details out of the evidence.`,
    );
  else
    log(
      `${new URL(options.url).origin} is marked as yours (--mine): this run may use the product like a user (send, post, submit, reply), but never pays, deletes, or touches billing, checkout, subscriptions or account destruction.`,
    );

  // What this is about to cost, before the landing page is read and before --login opens a browser
  // and waits for a human. A first run used to learn the price only from the README, or afterwards
  // from metrics.json, and --budget was discoverable only by reading the whole usage text.
  log(spendNotice(options.steps, options.model, options.budgetEur));

  // 1. What the product says about itself, quoted verbatim from its own landing page. Plain code,
  //    no model call, and no journeys -- the explorer never sees any of it.
  log(`reading ${options.url} ...`);
  const pack = await authorPack(options.url);
  const packBytes = `${JSON.stringify(pack, null, 2)}\n`;
  const packPath = join(out, "packs", id, "public-pack.json");
  await mkdir(join(out, "packs", id), { recursive: true });
  await writeFile(packPath, packBytes, { mode: 0o600 });
  const packSha256 = await sha256(Buffer.from(packBytes));

  // 2. The values the USER supplied. The explorer may type these; it may never invent one, and the
  //    boundary still refuses the submit.
  const seeds = options.seedPath
    ? JSON.parse(await readFile(options.seedPath, "utf8"))
    : {};
  if (typeof seeds !== "object" || Array.isArray(seeds))
    throw new Error("--seed must be a JSON object of field -> value");
  if (options.uploadPath) await access(options.uploadPath);

  // 3. Whether this run has an identity at all. Public by default: whatever a logged-out visitor
  //    can reach. --login means the user logged in themselves, in their own browser; --auth-cmd
  //    means their own backend minted a sign-in for an account they own. Same file either way.
  const savedSessionPath = options.authCmd
    ? await authSession({
        command: options.authCmd,
        sessionDir: join(out, "sessions"),
        name: slug(options.url!),
      })
    : options.login
      ? await login(options.url, join(out, "sessions"))
      : null;
  const configPath = join(out, "targets", `${id}.json`);
  await mkdir(join(out, "targets"), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        url: options.url,
        authMode: savedSessionPath ? "saved-session" : "public",
        // Always: the boundary refuses every mutating request to the product, the run never types a
        // contact detail it was not given, and it never sends, posts, pays or deletes -- unless
        // --mine says the user owns this product (see "mine" below), in which case send/post/submit
        // are allowed but pay/delete and money-shaped paths (billing, checkout, subscribe, ...)
        // stay refused.
        readOnly: true,
        mine: options.mine,
        ...(savedSessionPath ? { savedSessionPath } : {}),
        publicPackSha256: packSha256,
        publicPackPath: packPath,
        viewport: options.viewports[0],
        viewports: options.viewports,
        ...(options.allow.length ? { additionalOrigins: options.allow } : {}),
        ...(options.include.length ? { pathInclude: options.include } : {}),
        ...(options.exclude.length ? { pathExclude: options.exclude } : {}),
        ...(Object.keys(seeds).length ? { seedValues: seeds } : {}),
        ...(options.uploadPath ? { uploadPath: options.uploadPath } : {}),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  // 4. The run: screenshot in, one plain-English instruction out, our code clicks. Source-blind,
  //    unless the owner aimed it with --goal -- then that one sentence of theirs, and nothing else
  //    they know, is the standing objective and the map is labelled as directed.
  if (options.goal)
    log(
      `aimed at: ${options.goal}\ncapture mode is for a product you own and have already mapped: this run pursues that one sentence instead of surveying the product, so its map is labelled as directed, is not evidence that anything is discoverable, and cannot be diffed against a free walk.`,
    );
  log(
    `exploring, up to ${options.steps} steps on ${MODELS[options.model]} ...`,
  );
  const runPath = await explore({
    url: options.url,
    configPath,
    steps: options.steps,
    model: options.model,
    minutes: options.minutes,
    budgetEur: options.budgetEur,
    runDir: join(out, "runs"),
    goal: options.goal ?? null,
    policy: options.policy ?? null,
    continues: options.continues ?? null,
    precondition: options.precondition ?? null,
    expect: options.expect ?? null,
    identityLabel: options.identityLabel ?? null,
  });
  const runId = runPath.split("/").at(-2)!;

  // 5. A short description of every screen, written from the screenshot. A reading aid, never
  //    evidence: it is kept in its own file and the trace is untouched.
  const captionsPath = join(out, "captions", `${runId}.json`);
  let captions = {};
  try {
    await caption({
      tracePath: join(runPath, "observations.jsonl"),
      outputPath: captionsPath,
    });
    captions = JSON.parse(await readFile(captionsPath, "utf8")).captions ?? {};
  } catch (error) {
    log(
      `screens could not be captioned (${error instanceof Error ? error.message : String(error)}); each card keeps the title read off its own screen`,
    );
  }

  // 6. Seal it: scan for credentials and personal data, render map.html and map.json, hash it all.
  const result = await packageRun({
    runId,
    runPath,
    outputPath: join(out, "maps", runId),
    publicPackPath: packPath,
    publicPackSha256: packSha256,
    captions,
  });
  const mapPath = join(result.output_path, "map.html");
  log(`\nmap:       ${mapPath}`);
  log(`data:      ${join(result.output_path, "map.json")}`);
  log(`candidate: ${result.output_path}`);
  // This is deliberately read back from the packaged map, after sealing. The run's transient
  // result may be historical or incomplete; the map is the artifact we are handing off.
  const handoff = options.goal
    ? captureHandoff(await packagedMapStop(result.output_path), {
        runId,
        goal: options.goal,
      })
    : null;
  // 7. Directed runs only: the same screens as one picture, in order, to paste into a message. The
  //    candidate itself is sealed and read-only once packaged, so it is written beside it.
  if (options.goal) {
    const stripPath = `${result.output_path}-strip.png`;
    try {
      await strip({
        candidateDir: result.output_path,
        outputPath: stripPath,
        heading: handoff!.stripHeading,
        subheading: `${new URL(options.url).host} -- ${new Date().toISOString().slice(0, 10)}`,
      });
      log(`strip:     ${stripPath}`);
    } catch (error) {
      log(
        `the strip could not be drawn (${error instanceof Error ? error.message : String(error)}); the map itself is fine`,
      );
    }
  }
  // A directed capture is aimed at one screen, not a survey of the product -- AGENTS.md/CLAUDE.md's
  // pointer says "the map of this product's real screens" and "anything not in it was not seen",
  // claims a directed run has no standing to make (see AGENTS.md: capture output "is labelled as
  // directed" and is "never evidence that anything is discoverable"). The 2026-09-17 incident's
  // first run already had more screens than the discovery map it overwrote -- the screen-count
  // guard alone would have let it through. So a directed run never repoints the project's
  // instructions on its own; --force-map-pointer, which already overrides the screen-count guard,
  // is the one deliberate way to point them at a capture anyway.
  let pointer: PointerOutcome;
  if (options.goal && !options.forceMapPointer) {
    log(
      `directed capture: left AGENTS.md/CLAUDE.md's map pointer untouched -- a run aimed at "${options.goal}" is labelled as directed, not a survey, and is not evidence of what the product discoverably has. Serve this capture directly with releashed mcp ${result.output_path}, or pass --force-map-pointer to point the project's instructions at it anyway.`,
    );
    // A directed capture never touches the pointer on its own, but the coding agent reading this
    // result still needs a machine-readable reason and the file/directories involved -- not just
    // the prose line above. A dry run gets that for free from the same lookup writeAgentsBlock
    // would otherwise do, without writing anything.
    pointer = await agents(result.output_path, process.cwd(), log, {
      dryRun: true,
      reason: "directed-capture",
    });
  } else {
    pointer = await agents(result.output_path, process.cwd(), log, {
      force: options.forceMapPointer,
    });
  }
  for (const line of handoff?.lines ?? []) log(line);
  // A run that fell short still owes the asker an answer. On 2026-09-17 a capture spent its whole
  // budget failing to find "a theory lesson", and the screen it wanted was already sealed on disk
  // from a run six minutes earlier -- nothing looked. So before handing back a stop code, search
  // what has already been captured using the asker's own words and name the candidates, with their
  // dates, because staleness is the caller's judgment. This never asserts the product LACKS
  // anything: that exact conclusion would have been false that morning.
  const alternatives =
    options.goal && handoff && !handoff.reached
      ? await alternativesFromStore({
          mapsRoot: join(out, "maps"),
          goal: options.goal,
          origin: new URL(options.url).origin,
          excludeRunId: runId,
        })
      : null;
  if (alternatives) for (const line of formatAlternatives(alternatives)) log(line);
  log(`serve it to your agent with:  releashed mcp ${result.output_path}`);
  // `alternatives` rides back with `pointer`: a calling agent gets the candidates as data, not
  // only as the prose printed above.
  return { candidateDir: result.output_path, mapPath, pointer, alternatives };
}

// Everything a `map` run needs, checked before it reads the product, writes a file, opens a login
// browser or spends a cent. Free and offline: no model call, no network, no browser launch.
//
// It reports every problem at once rather than the first one. Before 2026-09-17 a reader with a
// fresh machine met these one at a time, each as a stack trace out of a child process: no explorer
// key, fix it, re-run, no grounding key, fix it, re-run, no Chromium. Three refusals for one setup,
// and the Chromium one was answered by Playwright's own banner naming the wrong install command.
export async function mapPreflight(
  deps: {
    env?: Record<string, string | undefined>;
    nodeVersion?: string;
    browser?: () => Promise<void>;
    // `login` opens a browser but calls no model, so it checks everything except the keys.
    keys?: boolean;
  } = {},
): Promise<string[]> {
  const {
    env = process.env,
    keys = true,
    nodeVersion = process.versions.node,
    browser = async () => {
      const { chromium } = await import("playwright");
      await access(chromium.executablePath());
    },
  } = deps;
  const problems: string[] = [];
  const outdatedNode = nodeRefusal(nodeVersion);
  if (outdatedNode) problems.push(outdatedNode);
  if (keys) problems.push(...missingModelKeys(env));
  try {
    await browser();
  } catch {
    problems.push(BROWSER_REFUSAL);
  }
  return problems;
}

// One tiny model call, because a run that dies on an empty balance wastes a browser and an evening.
export async function doctor(deps: DoctorDeps = {}) {
  const {
    ask = async (key) => {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      await new Anthropic({ apiKey: key }).messages.create({
        model: MODELS.sonnet,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
    },
    ground = async (key) => {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    },
    browser = async () => {
      const { chromium } = await import("playwright");
      await access(chromium.executablePath());
    },
    log = console.log,
  } = deps;
  const checks: Array<{ name: string; ok: boolean; message?: string }> = [];
  const check = async (
    name: string,
    fn: () => unknown | Promise<unknown>,
    fix: string,
  ) => {
    try {
      await fn();
      checks.push({ name, ok: true });
      log(`  ok    ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name, ok: false, message });
      log(`  FAIL  ${name}: ${message}\n        ${fix}`);
    }
  };
  log("releashed doctor");
  await check(
    `node ${MIN_NODE_MAJOR} or newer`,
    () => {
      if (Number(process.versions.node.split(".")[0]) < MIN_NODE_MAJOR)
        throw new Error(`this is node ${process.versions.node}`);
    },
    `install node ${MIN_NODE_MAJOR}+ from https://nodejs.org/en/download, or run: nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}`,
  );
  await check(
    "ANTHROPIC_API_KEY works and has credit",
    async () => {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("not set");
      await ask(process.env.ANTHROPIC_API_KEY);
    },
    "get a key at https://console.anthropic.com/settings/keys with a positive balance and export ANTHROPIC_API_KEY; a 400 about credit means the balance is empty -- or set SPIKE_EXPLORER_BASE_URL with SPIKE_EXPLORER_API_KEY for an OpenAI-compatible host, or skip our keys entirely with: releashed explore-mcp",
  );
  await check(
    // No "until the Claude grounder lands" any more. Claude points accurately enough (8 of 8
    // controls inside the real element, artifacts/grounding-probe-claude-20260905), but it did so
    // through a direct Anthropic call; the browser-automation library we ground through accepts
    // only its own listed model families and none of them is Anthropic's. Naming the real blocker
    // beats implying a swap is imminent. See resolveGroundingEnv in scripts/vision-explorer-run.mjs.
    "GEMINI_API_KEY works (points at controls; Midscene has no Anthropic grounding family)",
    async () => {
      if (!hasGeminiKey()) throw new Error("not set");
      await ground(process.env.GEMINI_API_KEY!);
    },
    "get a free key at https://aistudio.google.com/apikey -- or set MIDSCENE_MODEL_API_KEY with MIDSCENE_MODEL_NAME/_FAMILY/_BASE_URL for another grounder, or skip our keys entirely with: releashed explore-mcp",
  );
  await check(
    "chromium installed",
    browser,
    // Not `npx playwright install chromium`: that fetches whatever Playwright the registry serves
    // today, whose browser revision may not be the one this package is pinned to, so the check can
    // go green while `map` still cannot launch. install-browser uses this package's own Playwright.
    "run: releashed install-browser",
  );
  const failed = checks.filter((entry) => !entry.ok);
  log(
    failed.length === 0
      ? `\nall good -- try: releashed map https://example.com\n${spendNotice(
          40,
          "sonnet",
          null,
          "that default 40-step run",
        )}`
      : `\n${failed.length} problem(s) to fix first`,
  );
  return checks;
}

// Reads two candidates' map.json (docs/map-schema.md) and reports what changed. The exit code IS
// the product here: a nightly job reads it, not the prose. See lib/map-diff.ts for the matching
// rule and for why disappearance, not appearance, is the failure signal.
export async function diffCommand(
  options: Extract<ParsedOptions, { command: "diff" }>,
  deps: {
    readMap?: (dir: string) => Promise<Parameters<typeof diffMaps>[0]>;
    log?: typeof console.log;
  } = {},
) {
  const {
    readMap = async (dir) =>
      JSON.parse(await readFile(join(dir, "map.json"), "utf8")),
    log = console.log,
  } = deps;
  const [oldMap, newMap] = await Promise.all([
    readMap(options.oldDir),
    readMap(options.newDir),
  ]);
  const diff = diffMaps(oldMap, newMap);
  log(options.json ? JSON.stringify(diff, null, 2) : formatDiff(diff));
  return { diff, exitCode: hasDisappearance(diff) ? 1 : 0 };
}

export async function reportCommand(
  options: ReportOptions,
): Promise<CaptureReportResult> {
  return captureReport({
    mapsRoot: join(outputRoot(), "maps"),
    runId: options.runId,
    preparation: options.preparation,
    cleanup: options.cleanup,
    timing: options.timing,
    phases: options.phases,
    inspection: options.inspection,
  });
}

export async function phasesCommand(options: PhaseOptions) {
  return options.boundary === "start"
    ? startPhases(options.record)
    : stampPhase(options.record, options.boundary, { runId: options.runId });
}

// Skills travel in the archive beside the executable so an ordinary install has no dependency on
// a developer checkout. Preserve existing entries by default, including customer skill links.
export async function installSkills(
  { destination, replace = false }: { destination: string; replace?: boolean },
  deps: { source?: string; entries?: Dirent[]; log?: typeof console.log } = {},
) {
  const source = deps.source ?? join(ROOT, "skills");
  const entries =
    deps.entries ?? (await readdir(source, { withFileTypes: true }));
  const skills = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const preserved: string[] = [];
  for (const name of skills) {
    const target = join(destination, name);
    let existing;
    try {
      existing = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!existing) continue;
    if (!replace) preserved.push(name);
    else if (!existing.isDirectory())
      throw new Error(
        `cannot replace skill at ${target}: expected a directory, found a file or symbolic link. Choose another --destination or move this entry before retrying.`,
      );
  }
  await mkdir(destination, { recursive: true });
  const installed = skills.filter((name) => !preserved.includes(name));
  for (const name of installed)
    await cp(join(source, name), join(destination, name), {
      recursive: true,
      force: replace,
      errorOnExist: !replace,
    });
  const message = `installed ${installed.length} skills in ${destination}; preserved ${preserved.length} existing entries${preserved.length ? `: ${preserved.join(", ")}` : ""}`;
  (deps.log ?? console.log)(message);
  return { destination, skills: installed, preserved };
}

export async function installBrowser(
  deps: { cli?: string; run?: typeof run } = {},
) {
  const cli =
    deps.cli ??
    join(dirname(require.resolve("playwright/package.json")), "cli.js");
  const runner = deps.run ?? run;
  await runner(process.execPath, [cli, "install", "chromium"]);
  return { browser: "chromium" };
}

// Start the protocol without authenticating. Only the first observe may resolve a session.
export async function exploreCommand(
  options: Extract<ParsedOptions, { command: "explore-mcp" }>,
  deps: SessionDeps & {
    timing?: ReturnType<typeof createLocalTiming>;
    serve?: typeof import("../lib/explore-mcp.mjs").serveExplorer;
  } = {},
) {
  const out = deps.out ?? outputRoot();
  const timing = deps.timing ?? createLocalTiming({ outputRoot: out });
  const sessionDir = join(out, "sessions", timing.attemptId);
  process.stderr.write(`Local capture timing: ${timing.directory}\n`);
  const serve =
    deps.serve ??
    ((args) =>
      import("../lib/explore-mcp.mjs").then((module) =>
        module.serveExplorer(args),
      ));
  try {
    await timing.span("metadata.validate", () =>
      validateCaptureMetadata({
        goal: options.goal,
        policy: options.policy,
        continues: options.continues,
        precondition: options.precondition,
        identityLabel: options.identityLabel,
        runsRoot: join(out, "runs"),
        mapsRoot: join(out, "maps"),
      }),
    );
    return await serve({
      url: options.url,
      steps: options.steps,
      mine: options.mine === true,
      imageOutput: options.imageOutput,
      goal: options.goal,
      policy: options.policy,
      continues: options.continues,
      precondition: options.precondition,
      expect: options.expect,
      identityLabel: options.identityLabel,
      acquireUntil:
        (options as { acquireUntil?: number | null }).acquireUntil ?? null,
      runsRoot: join(out, "runs"),
      outputRoot: out,
      timing,
      resolveSession:
        options.authCmd || options.login
          ? () => exploreSessionPath(options, { ...deps, out, sessionDir })
          : null,
      // Only this attempt's freshly minted private files; --login's existing session is preserved.
      cleanupSession: async () => {
        if (options.authCmd)
          await rm(sessionDir, { recursive: true, force: true });
      },
    });
  } finally {
    await timing.flush();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === "help") {
    const topic = (options as { for?: string }).for;
    if (topic && COMMAND_HELP[topic]) {
      process.stdout.write(COMMAND_HELP[topic]);
      return;
    }
    process.stdout.write(USAGE);
    return;
  }
  if (options.command === "map") {
    const problems = await mapPreflight();
    if (problems.length)
      throw new Error(
        `releashed map cannot start. ${problems.length} thing${
          problems.length === 1 ? "" : "s"
        } to fix first:\n\n${problems.join(
          "\n\n",
        )}\n\nConfirm the fix, including whether the keys have credit, with: releashed doctor`,
      );
    await mapCommand(options);
    return;
  }
  if (options.command === "login") {
    // login is the first command in the README and the only one before map that opens a browser, so
    // it owes the same named answer rather than Playwright's own banner. No key check here: signing
    // in yourself needs no model at all.
    const problems = await mapPreflight({ keys: false });
    if (problems.length) throw new Error(problems.join("\n\n"));
    const path = await captureLogin(
      options.url,
      join(outputRoot(), "sessions"),
    );
    console.log(
      `\nsaved. map the signed-in product with:  releashed map ${options.url} --login`,
    );
    return path;
  }
  if (options.command === "doctor") {
    if (options.capture) {
      const result = await captureDoctor(options, { parseArgs });
      console.log(
        options.json
          ? JSON.stringify(result, null, 2)
          : [
              `Local capture checks (${result.cwd})`,
              ...result.checks.map(
                (check) =>
                  `  ${check.ok ? "ok" : "FAIL"}  ${check.name}: ${check.detail}`,
              ),
              ...result.unverified.map((item) => `  UNVERIFIED  ${item}`),
              result.ok
                ? "Local configuration checks passed; external readiness and client permissions remain unverified."
                : "Fix the local failures before authentication.",
            ].join("\n"),
      );
      if (!result.ok) process.exitCode = 1;
      return result;
    }
    const checks = await doctor();
    if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
    return;
  }
  if (options.command === "install-skills") return installSkills(options);
  if (options.command === "install-browser") return installBrowser();
  if (options.command === "report") {
    const result = await reportCommand(options);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${result.markdown}\n`,
    );
    return result;
  }
  if (options.command === "phases") {
    const result = await phasesCommand(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (options.command === "select") {
    const result = await selectCapture({
      mapsRoot: join(outputRoot(), "maps"),
      ...options,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (options.command === "memory") {
    const result = await findMemory({
      mapsRoot: join(outputRoot(), "maps"),
      url: options.url,
      query: options.goal,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (options.command === "remember") {
    // Bound the note file before reading: the notebook validates proposal
    // bytes again, but an unbounded read here would pre-empt that limit.
    const noteSize = (await stat(options.notePath)).size;
    if (noteSize > MAX_NOTE_INPUT_BYTES)
      throw new Error(
        `note file is too large (${noteSize} bytes; limit ${MAX_NOTE_INPUT_BYTES})`,
      );
    const note = JSON.parse(await readFile(options.notePath, "utf8"));
    const result = await rememberFlow({
      mapsRoot: join(outputRoot(), "maps"),
      url: options.url,
      expected_revision: options.expectedRevision,
      note,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatRememberResult(result)}\n`,
    );
    return result;
  }
  if (options.command === "notes") {
    const result = await findNotes({
      mapsRoot: join(outputRoot(), "maps"),
      url: options.url,
      query: options.goal,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const notices = formatNotesNotices(result);
      process.stdout.write(
        `${formatCompactNotes(result.product_notes)}\n${result.notes_guidance}\n${notices ? `${notices}\n` : ""}`,
      );
    }
    return result;
  }
  if (options.command === "mcp") {
    await run(
      process.execPath,
      options.candidateDir
        ? [join(ROOT, "scripts/map-mcp.mjs"), options.candidateDir]
        : [
            join(ROOT, "scripts/capture-memory-mcp.mjs"),
            join(outputRoot(), "maps"),
          ],
    );
    return;
  }
  if (options.command === "diff") {
    const { exitCode } = await diffCommand(options);
    process.exitCode = exitCode;
    return;
  }
  return exploreCommand(options);
}

// resolve() alone misses this file when it is reached through a symlink (npx, npm link,
// node_modules/.bin): argv[1] stays the symlink path while import.meta.url is already the real
// one, so the paths never match. realpathSync both sides so a symlinked invocation still counts.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
