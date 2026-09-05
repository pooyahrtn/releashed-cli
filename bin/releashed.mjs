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
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffMaps, formatDiff, hasDisappearance } from "../lib/map-diff.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const MODELS = { sonnet: "claude-sonnet-5", opus: "claude-opus-5" };
// The two sizes a v0 run offers. Desktop is 1280 wide because that is the cap a screenshot may
// reach an agent at, so nothing has to be downscaled afterwards.
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };
const LIST = ["include", "exclude", "allow", "viewports"];

const USAGE = `releashed -- an evidence-backed map of a product's user flows, from its URL alone.

  releashed doctor
      Check the keys, the browser and the node version before you spend anything.

  releashed map <url> [options]
      Explore the product and write a map. Needs ANTHROPIC_API_KEY and GEMINI_API_KEY.
      --model sonnet|opus  which Claude drives the exploration (default sonnet)
      --steps N            actions the run may take (1-60, default 40)
      --minutes N          wall-clock budget; the run stops when it is spent
      --budget EUR         model-spend budget; the run stops when it is spent
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

  releashed login <url>
      Open a browser so YOU can log in; the session is saved on this machine for --login.

  releashed mcp <candidate-dir>
      Serve a finished map to your coding agent over MCP: list_screens, find_screen, get_screen,
      screen_edges, list_transitions.

  releashed diff <old-map-dir> <new-map-dir>
      Compare two maps of the same product and say what changed. Prints a one-line summary, then
      the detail. --json prints the comparison as data instead of English.
      Exit code 0: nothing that existed before is missing now (new things appearing is not a
                   failure -- a wider or different walk finds more, harmlessly).
      Exit code 1: a screen or a transition that existed before is gone now.

  releashed explore-mcp [<url>] [--steps N] [--login] [--mine]
      Let your coding agent BE the explorer: observe, act, record, finish. No model key of ours.
      --login              use the session you saved with "releashed login <url>" (needs <url>)
      --auth-cmd <cmd>     mint the sign-in yourself instead (needs <url>)
      --mine               you own this product: send/post/submit are allowed; pay, delete and
                           billing/checkout/subscribe/account-destruction still are not
`;

const list = (value) => String(value).split(",").map((item) => item.trim()).filter(Boolean);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help")
    return { command: "help" };
  const positional = [];
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--login" || token === "--mine" || token === "--json") flags[token.slice(2)] = true;
    else if (token.startsWith("--")) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${token} needs a value`);
      flags[token.slice(2)] = value;
      index += 1;
    } else positional.push(token);
  }
  const known = ["model", "steps", "minutes", "budget", "login", "auth-cmd", "mine", "seed", "upload", "json", ...LIST];
  const unknown = Object.keys(flags).filter((key) => !known.includes(key));
  if (unknown.length) throw new Error(`unknown option --${unknown[0]}`);
  // Two ways in, never both: one is a person at a window, the other is your own backend.
  if (flags.login === true && flags["auth-cmd"] !== undefined)
    throw new Error("--login and --auth-cmd are two ways to sign in; pick one");
  const authCmd = flags["auth-cmd"] ?? null;

  if (command === "map") {
    if (positional.length !== 1) throw new Error("usage: releashed map <url> [options]");
    const url = new URL(positional[0]);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("the url must be http or https");
    const model = flags.model ?? "sonnet";
    if (!MODELS[model]) throw new Error('--model must be "sonnet" or "opus"');
    const steps = flags.steps === undefined ? 40 : Number(flags.steps);
    if (!Number.isInteger(steps) || steps < 1 || steps > 60) throw new Error("--steps must be a whole number 1-60");
    const minutes = flags.minutes === undefined ? null : Number(flags.minutes);
    if (minutes !== null && !(minutes > 0)) throw new Error("--minutes must be a positive number");
    const budgetEur = flags.budget === undefined ? null : Number(flags.budget);
    if (budgetEur !== null && !(budgetEur > 0)) throw new Error("--budget must be a positive number of euros");
    const viewports = flags.viewports === undefined ? ["desktop"] : list(flags.viewports);
    for (const name of viewports) if (!VIEWPORTS[name]) throw new Error(`--viewports takes ${Object.keys(VIEWPORTS).join(" and ")}`);
    const allow = flags.allow === undefined ? [] : list(flags.allow);
    for (const origin of allow) if (new URL(origin).origin !== origin) throw new Error(`--allow takes origins, not ${origin}`);
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
      seedPath: flags.seed ? resolve(flags.seed) : null,
      uploadPath: flags.upload ? resolve(flags.upload) : null,
      include: flags.include === undefined ? [] : list(flags.include),
      exclude: flags.exclude === undefined ? [] : list(flags.exclude),
      allow,
      viewports: viewports.map((name) => VIEWPORTS[name]),
    };
  }
  if (command === "login") {
    if (positional.length !== 1) throw new Error("usage: releashed login <url>");
    return { command, url: new URL(positional[0]).href };
  }
  if (command === "doctor") return { command };
  if (command === "mcp") {
    if (positional.length !== 1) throw new Error("usage: releashed mcp <candidate-dir>");
    return { command, candidateDir: resolve(positional[0]) };
  }
  if (command === "diff") {
    if (positional.length !== 2) throw new Error("usage: releashed diff <old-map-dir> <new-map-dir>");
    return { command, oldDir: resolve(positional[0]), newDir: resolve(positional[1]), json: flags.json === true };
  }
  if (command === "explore-mcp") {
    if (positional.length > 1) throw new Error("usage: releashed explore-mcp [<url>] [--steps N]");
    const steps = flags.steps === undefined ? 40 : Number(flags.steps);
    if (!Number.isInteger(steps) || steps < 1 || steps > 60) throw new Error("--steps must be a whole number 1-60");
    if (positional[0]) new URL(positional[0]);
    if (flags.login === true && !positional[0]) throw new Error("explore-mcp --login needs the <url> you logged in to");
    if (authCmd && !positional[0]) throw new Error("explore-mcp --auth-cmd needs the <url> it signs in to");
    return { command, url: positional[0] ?? null, steps, login: flags.login === true, authCmd, mine: flags.mine === true };
  }
  throw new Error(`unknown command "${command}"\n\n${USAGE}`);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const slug = (url) => new URL(url).hostname.replace(/[^a-z0-9]+/gi, "-");
export const outputRoot = () => resolve(process.env.RELEASHED_OUT ?? join(process.cwd(), "releashed"));

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit", ...options });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise(out) : reject(new Error(`${args[0]} exited with ${code}`))));
  });
}

// A human logs in by hand in a visible browser; the cookies land in a file only this machine has.
// We never ask for a password and never store one.
export async function captureLogin(url, sessionDir) {
  await mkdir(sessionDir, { recursive: true });
  const name = slug(url);
  await run(process.execPath, [
    join(ROOT, "scripts/capture-session.mjs"),
    "--url", url,
    "--name", name,
    "--output-dir", sessionDir,
  ]);
  return join(sessionDir, `${name}.json`);
}

// The explorer itself: SPIKE_APP_URL fixes the origin, the config fixes everything else, and the
// run directory is ours to name so a global install never writes inside node_modules. It prints the
// run directory it wrote; that line is how we find it.
async function runExplorer({ url, configPath, steps, model, minutes, budgetEur, runDir }) {
  const args = [join(ROOT, "scripts/vision-explorer-run.mjs"), "--steps", String(steps), "--target-config", configPath, "--run-dir", runDir];
  if (minutes) args.push("--minutes", String(minutes));
  if (budgetEur) args.push("--budget-eur", String(budgetEur));
  const out = await run(process.execPath, args, {
    capture: true,
    env: { ...process.env, SPIKE_APP_URL: url, SPIKE_EXPLORER_MODEL: MODELS[model] },
  });
  const match = out.match(/^run: (\S+)$/m);
  if (!match) throw new Error("the explorer did not report a run directory");
  return resolve(match[1]);
}

// The wedge: an agent that reads this block asks the map before it reads the code. Appended once,
// idempotent, to whichever instruction file the project already has.
const BLOCK_MARK = "<!-- releashed-map -->";
export function agentsBlock(candidateDir) {
  return `${BLOCK_MARK}
## The product's flow map

A map of this product's real screens and transitions, built by walking the deployed site, lives in
\`${candidateDir}\`. **Ask it before you read the code or guess at a journey.** Serve it over MCP with:

    releashed mcp ${candidateDir}

Tools: \`list_screens\`, \`find_screen\` (search by what a user would call it), \`get_screen\`
(returns the screenshot), \`screen_edges\` (how you get to a screen and where it leads),
\`list_transitions\`. \`${candidateDir}/map.json\` is the same graph as data, and \`map.html\` opens
in a browser. Every screen in it was observed; anything not in it was not seen.
${BLOCK_MARK}`;
}

export async function writeAgentsBlock(candidateDir, directory = process.cwd(), log = console.log) {
  const block = agentsBlock(candidateDir);
  // Only a project that will HOLD the map gets its instructions edited. Run from somewhere else --
  // a scratch folder, somebody else's repo -- and we print the block instead of writing a pointer
  // into a file that has nothing to do with this run. (Dogfood night, 2026-09-06: a run launched
  // from the atwoexam checkout appended a pointer to a scratch dogfood folder to ITS AGENTS.md.)
  const holdsTheMap = resolve(candidateDir).startsWith(`${resolve(directory)}/`);
  for (const name of holdsTheMap ? ["AGENTS.md", "CLAUDE.md"] : []) {
    const path = join(directory, name);
    const existing = await readFile(path, "utf8").catch(() => null);
    if (existing === null) continue;
    if (existing.includes(BLOCK_MARK)) {
      // Replace the old block rather than stacking a second one, so re-mapping updates the pointer.
      const [before, , after] = existing.split(BLOCK_MARK);
      await writeFile(path, `${before}${block}${after ?? ""}`);
    } else await writeFile(path, `${existing.trimEnd()}\n\n${block}\n`);
    log(`told ${name} to ask the map first`);
    return path;
  }
  log(`\nadd this to your AGENTS.md or CLAUDE.md so your agent asks the map first:\n\n${block}\n`);
  return null;
}

// How `explore-mcp` gets an identity. An MCP server has no window to log in through, so --login
// only reuses a session `releashed login <url>` already saved (a missing one is an error, never a
// silent public run) and --auth-cmd mints one on the spot from the user's own command.
export async function exploreSessionPath(options, deps = {}) {
  const {
    authSession = (args) => import("../lib/auth-cmd.mjs").then((m) => m.sessionFromAuthCmd(args)),
    out = outputRoot(),
  } = deps;
  if (options.authCmd)
    return authSession({ command: options.authCmd, sessionDir: join(out, "sessions"), name: slug(options.url) });
  if (!options.login) return null;
  const path = join(out, "sessions", `${slug(options.url)}.json`);
  await access(path).catch(() => {
    throw new Error(`no saved session at ${path}: run  releashed login ${options.url}  first`);
  });
  return path;
}

export async function mapCommand(options, deps = {}) {
  const {
    authorPack = (url) => import("../scripts/author-target-pack.mjs").then((m) => m.authorTargetPack(url)),
    login = captureLogin,
    authSession = (args) => import("../lib/auth-cmd.mjs").then((m) => m.sessionFromAuthCmd(args)),
    explore = runExplorer,
    caption = (args) => import("../scripts/caption-screens.mjs").then((m) => m.captionScreens(args)),
    packageRun = (args) => import("../lib/candidate-packager.mjs").then((m) => m.packageCandidate(args)),
    sha256 = (bytes) => import("../lib/scaffold.mjs").then((m) => m.sha256Text(bytes)),
    agents = writeAgentsBlock,
    log = console.log,
  } = deps;
  const out = deps.out ?? outputRoot();
  const id = `${slug(options.url)}-${stamp()}`;

  // Somebody else's product gets the strict defaults, and the run says so out loud rather than
  // leaving the user to assume it. --mine widens what the run may DO (send, post, submit, reply --
  // ordinary product use) but never what it may spend or destroy: pay, delete, billing, checkout,
  // subscribe and account destruction stay refused either way. See docs/CONTROL-SURFACE.md.
  if (!options.mine)
    log(
      `${new URL(options.url).origin} is not marked as yours (--mine): this run is read-only, never signs in, never sends, posts, pays or deletes, and redacts contact details out of the evidence.`,
    );
  else
    log(
      `${new URL(options.url).origin} is marked as yours (--mine): this run may use the product like a user (send, post, submit, reply), but never pays, deletes, or touches billing, checkout, subscriptions or account destruction.`,
    );

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
  const seeds = options.seedPath ? JSON.parse(await readFile(options.seedPath, "utf8")) : {};
  if (typeof seeds !== "object" || Array.isArray(seeds)) throw new Error("--seed must be a JSON object of field -> value");
  if (options.uploadPath) await access(options.uploadPath);

  // 3. Whether this run has an identity at all. Public by default: whatever a logged-out visitor
  //    can reach. --login means the user logged in themselves, in their own browser; --auth-cmd
  //    means their own backend minted a sign-in for an account they own. Same file either way.
  const savedSessionPath = options.authCmd
    ? await authSession({ command: options.authCmd, sessionDir: join(out, "sessions"), name: slug(options.url) })
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

  // 4. The source-blind run: screenshot in, one plain-English instruction out, our code clicks.
  log(`exploring, up to ${options.steps} steps on ${MODELS[options.model]} ...`);
  const runPath = await explore({
    url: options.url,
    configPath,
    steps: options.steps,
    model: options.model,
    minutes: options.minutes,
    budgetEur: options.budgetEur,
    runDir: join(out, "runs"),
  });
  const runId = runPath.split("/").at(-2);

  // 5. A short description of every screen, written from the screenshot. A reading aid, never
  //    evidence: it is kept in its own file and the trace is untouched.
  const captionsPath = join(out, "captions", `${runId}.json`);
  let captions = {};
  try {
    await caption({ tracePath: join(runPath, "observations.jsonl"), outputPath: captionsPath });
    captions = JSON.parse(await readFile(captionsPath, "utf8")).captions ?? {};
  } catch (error) {
    log(`screens could not be captioned (${error.message}); each card keeps the title read off its own screen`);
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
  await agents(result.output_path, process.cwd(), log);
  log(`serve it to your agent with:  releashed mcp ${result.output_path}`);
  return { candidateDir: result.output_path, mapPath };
}

// One tiny model call, because a run that dies on an empty balance wastes a browser and an evening.
export async function doctor(deps = {}) {
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
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    },
    browser = async () => {
      const { chromium } = await import("playwright");
      await access(chromium.executablePath());
    },
    log = console.log,
  } = deps;
  const checks = [];
  const check = async (name, fn, fix) => {
    try {
      await fn();
      checks.push({ name, ok: true });
      log(`  ok    ${name}`);
    } catch (error) {
      const message = error?.message ?? String(error);
      checks.push({ name, ok: false, message });
      log(`  FAIL  ${name}: ${message}\n        ${fix}`);
    }
  };
  log("releashed doctor");
  await check(
    "node 22 or newer",
    () => {
      if (Number(process.versions.node.split(".")[0]) < 22) throw new Error(`this is node ${process.versions.node}`);
    },
    "install node 22+",
  );
  await check(
    "ANTHROPIC_API_KEY works and has credit",
    async () => {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("not set");
      await ask(process.env.ANTHROPIC_API_KEY);
    },
    "set a key from console.anthropic.com with a positive balance; a 400 about credit means the balance is empty",
  );
  await check(
    "GEMINI_API_KEY works (points at controls, until the Claude grounder lands)",
    async () => {
      if (!process.env.GEMINI_API_KEY) throw new Error("not set");
      await ground(process.env.GEMINI_API_KEY);
    },
    "set a key from aistudio.google.com",
  );
  await check("chromium installed", browser, "run: npx playwright install chromium");
  const failed = checks.filter((entry) => !entry.ok);
  log(failed.length === 0 ? "\nall good -- try: releashed map https://example.com" : `\n${failed.length} problem(s) to fix first`);
  return checks;
}

// Reads two candidates' map.json (docs/map-schema.md) and reports what changed. The exit code IS
// the product here: a nightly job reads it, not the prose. See lib/map-diff.mjs for the matching
// rule and for why disappearance, not appearance, is the failure signal.
export async function diffCommand(options, deps = {}) {
  const {
    readMap = async (dir) => JSON.parse(await readFile(join(dir, "map.json"), "utf8")),
    log = console.log,
  } = deps;
  const [oldMap, newMap] = await Promise.all([readMap(options.oldDir), readMap(options.newDir)]);
  const diff = diffMaps(oldMap, newMap);
  log(options.json ? JSON.stringify(diff, null, 2) : formatDiff(diff));
  return { diff, exitCode: hasDisappearance(diff) ? 1 : 0 };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (options.command === "map") {
    await mapCommand(options);
    return;
  }
  if (options.command === "login") {
    const path = await captureLogin(options.url, join(outputRoot(), "sessions"));
    console.log(`\nsaved. map the signed-in product with:  releashed map ${options.url} --login`);
    return path;
  }
  if (options.command === "doctor") {
    const checks = await doctor();
    if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
    return;
  }
  if (options.command === "mcp") {
    await run(process.execPath, [join(ROOT, "scripts/map-mcp.mjs"), options.candidateDir]);
    return;
  }
  if (options.command === "diff") {
    const { exitCode } = await diffCommand(options);
    process.exitCode = exitCode;
    return;
  }
  const { serveExplorer } = await import("../lib/explore-mcp.mjs");
  const savedSessionPath = await exploreSessionPath(options);
  await serveExplorer({
    url: options.url,
    steps: options.steps,
    savedSessionPath,
    mine: options.mine === true,
    runsRoot: join(outputRoot(), "runs"),
    outputRoot: outputRoot(),
  });
}

// resolve() alone misses this file when it is reached through a symlink (npx, npm link,
// node_modules/.bin): argv[1] stays the symlink path while import.meta.url is already the real
// one, so the paths never match. realpathSync both sides so a symlinked invocation still counts.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
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
