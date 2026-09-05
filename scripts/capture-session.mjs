// Bring-your-own-session capture: opens a VISIBLE browser at a URL, waits for a human to log
// in by hand, and saves the resulting cookies + localStorage/sessionStorage to a private file
// outside this repo. That file is a real credential -- it grants whatever the exploring run
// later does the exact same powers as the logged-in account. Reuses the same raw-CDP plumbing
// the trusted browser broker already uses (see supervisor/browser-broker.mjs) instead of
// inventing a second way to drive Chromium.
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { CdpConnection, waitForDevToolsPort } from "../supervisor/browser-broker.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

function parseArgs(argv) {
  const args = Object.fromEntries(
    Array.from({ length: argv.length / 2 }, (_, index) => argv.slice(index * 2, index * 2 + 2)),
  );
  if (!args["--url"] || !args["--name"] || !NAME_PATTERN.test(args["--name"])) {
    throw new Error(
      "Usage: node scripts/capture-session.mjs --url <login-url> --name <session-name> [--output-dir <dir>]",
    );
  }
  const url = new URL(args["--url"]);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--url must be http(s)");
  return {
    url: url.href,
    name: args["--name"],
    outputDir: resolve(
      args["--output-dir"] ?? join(repository, "..", "flow-map-lab-private", "sessions"),
    ),
  };
}

// A visible (non-headless) Chromium build, distinct from the headless_shell the trusted
// browser broker drives during a real run -- a human needs an actual window to log in.
async function findVisibleChromium() {
  if (process.env.CAPTURE_SESSION_CHROMIUM_EXECUTABLE)
    return resolve(process.env.CAPTURE_SESSION_CHROMIUM_EXECUTABLE);
  const cache = join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
  const directories = (await readdir(cache))
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .reverse();
  for (const directory of directories) {
    for (const platformDir of ["chrome-mac-x64", "chrome-mac"]) {
      const base = join(cache, directory, platformDir);
      let entries;
      try {
        entries = await readdir(base);
      } catch {
        continue;
      }
      const app = entries.find((name) => name.endsWith(".app"));
      if (!app) continue;
      const binary = join(base, app, "Contents", "MacOS", app.slice(0, -4));
      try {
        await readdir(dirname(binary));
        return binary;
      } catch {}
    }
  }
  throw new Error(
    "No visible Chromium build found under ~/Library/Caches/ms-playwright; set CAPTURE_SESSION_CHROMIUM_EXECUTABLE",
  );
}

async function connectCdp(profileDirectory) {
  const version = await (
    await fetch(
      `http://127.0.0.1:${await waitForDevToolsPort(join(profileDirectory, "DevToolsActivePort"))}/json/version`,
    )
  ).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener("open", () => resolvePromise(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Could not connect to the visible browser's DevTools socket")),
      { once: true },
    );
  });
  return new CdpConnection(socket, {
    commandTimeoutMs: 30_000,
    absoluteDeadlineMs: Date.now() + 30 * 60_000,
  });
}

async function dumpStorage(cdp, sessionId) {
  const script = `(() => {
    const dump = (storage) => {
      const out = {};
      for (let i = 0; i < storage.length; i += 1) { const key = storage.key(i); out[key] = storage.getItem(key); }
      return out;
    };
    return JSON.stringify({ local: dump(localStorage), session: dump(sessionStorage) });
  })()`;
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression: script, returnByValue: true },
    sessionId,
  );
  return JSON.parse(result.result?.value ?? '{"local":{},"session":{}}');
}

// Attaches CDP to a just-spawned browser's one page and enables the domains every caller below
// needs. Shared by launchVisibleBrowser and launchRealChromeWithProfile so the "find the page,
// attach, enable domains" plumbing exists exactly once.
async function attachFirstPage(profileDirectory) {
  const cdp = await connectCdp(profileDirectory);
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const targets = await cdp.send("Target.getTargets");
  const page = targets.targetInfos.find((target) => target.type === "page");
  if (!page) throw new Error("The browser did not open a page");
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  return { cdp, sessionId };
}

// Spawns the fresh-profile visible Chromium and attaches CDP to its one page. Shared by the
// interactive captureSession() below and by any sibling script (e.g. a non-interactive signup
// driver) that needs the exact same un-flagged, human-indistinguishable browser -- reusing this
// instead of Playwright's chromium.launch() avoids the automation banner/navigator.webdriver flag
// that a bot check could key off.
// `headless: true` is for the no-human path (--auth-cmd redeeming a one-shot sign-in link): same
// browser, same profile handling, just no window for a person who is not there.
async function launchVisibleBrowser(url, { headless = false } = {}) {
  const executable = await findVisibleChromium();
  const profileDirectory = await mkdirTemp();
  const chrome = spawn(
    executable,
    [
      ...(headless ? ["--headless=new"] : []),
      "--user-data-dir=" + profileDirectory,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
      url,
    ],
    // detached + unref: a multi-stage driver's "start" process exits right after launching, and
    // Chrome must keep running (in its own process group) after that exit -- not die with it.
    { stdio: "ignore", detached: true },
  );
  chrome.unref();
  const { cdp, sessionId } = await attachFirstPage(profileDirectory);
  return {
    cdp,
    sessionId,
    profileDirectory,
    pid: chrome.pid,
    async close() {
      try {
        cdp.close();
      } catch {}
      chrome.kill("SIGTERM");
      await rm(profileDirectory, { recursive: true, force: true });
    },
  };
}

// Real Google Chrome (not the bundled Playwright Chromium) launched against a COPY of one of the
// user's own Chrome profiles, so it starts already signed into whatever Google account that
// profile holds. Some providers (Google included) reject a fresh, never-authenticated sign-in
// attempt from automation; a profile that is already authenticated just resumes its existing
// session, and real Chrome + a real profile is exactly what makes that resumption look ordinary.
// Never points at the live profile directory (which the user's running Chrome has locked, and
// which nothing here should ever mutate) -- always a throwaway copy, deleted on close().
async function launchRealChromeWithProfile(
  url,
  profileName = "Profile 5",
  {
    chromeUserDataDir = join(process.env.HOME ?? "", "Library/Application Support/Google/Chrome"),
  } = {},
) {
  const executable =
    process.env.CAPTURE_SESSION_REAL_CHROME_EXECUTABLE ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const profileDirectory = await mkdirTemp();
  await cp(join(chromeUserDataDir, "Local State"), join(profileDirectory, "Local State"));
  await cp(join(chromeUserDataDir, profileName), join(profileDirectory, profileName), {
    recursive: true,
  });
  const chrome = spawn(
    executable,
    [
      "--user-data-dir=" + profileDirectory,
      `--profile-directory=${profileName}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions", // the copied profile's real extensions add nothing here and only slow startup
      url,
    ],
    { stdio: "ignore", detached: true },
  );
  chrome.unref();
  const { cdp, sessionId } = await attachFirstPage(profileDirectory);
  return {
    cdp,
    sessionId,
    profileDirectory,
    pid: chrome.pid,
    async close() {
      try {
        cdp.close();
      } catch {}
      chrome.kill("SIGTERM");
      await rm(profileDirectory, { recursive: true, force: true });
    },
  };
}

// Reads whatever the browser currently holds (cookies + localStorage/sessionStorage for the
// current origin) and writes it in the exact shape targets/*.json's "saved-session" auth mode
// expects. Shared tail end of both the interactive and non-interactive capture paths.
async function saveSession(cdp, sessionId, { url, name, outputDir }) {
  const cookies = (await cdp.send("Network.getAllCookies", {}, sessionId)).cookies ?? [];
  const href = (
    await cdp.send(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      sessionId,
    )
  ).result?.value;
  const origin = new URL(href).origin;
  const storage = await dumpStorage(cdp, sessionId);

  const session = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    login_url: url,
    landing_url: href,
    origin,
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    })),
    origin_storage: [{ origin, local_storage: storage.local, session_storage: storage.session }],
  };

  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const outputPath = join(outputDir, `${name}.json`);
  await writeFile(outputPath, `${JSON.stringify(session)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);

  console.log("");
  console.log(`Saved ${session.cookies.length} cookie(s) and storage for ${origin} to:`);
  console.log(`  ${outputPath}`);
  console.log("Use it to prepare a run with:");
  console.log(
    `  node scripts/prepare-target-run.mjs --run-id <run-id> --mode source-blind-bounded-onboarding-v1 --target-origin <origin> --saved-session ${outputPath}`,
  );
  return outputPath;
}

async function captureSession({ url, name, outputDir }) {
  console.log("");
  console.log("=== Bring-your-own-session capture ===");
  console.log(`Opening a VISIBLE browser at: ${url}`);
  console.log(
    "Log in by hand. Use a disposable/test account where you can -- whatever account you use,",
  );
  console.log(
    "this tool will gain the exact same powers that account has (it acts as that logged-in user).",
  );
  console.log("Never use a personal or admin account if a test account is available.");
  console.log("");
  console.log(
    `When you are fully logged in, come back here and press Enter. The captured cookies and`,
  );
  console.log(`localStorage/sessionStorage will be saved -- values never printed -- to:`);
  console.log(`  ${join(outputDir, `${name}.json`)} (mode 600)`);
  console.log("");

  // Google refuses to sign in to a fresh automation profile; CAPTURE_SESSION_CHROME_PROFILE names a
  // real Chrome profile (e.g. "Profile 5") whose existing Google session is resumed instead.
  const browser = process.env.CAPTURE_SESSION_CHROME_PROFILE
    ? await launchRealChromeWithProfile(url, process.env.CAPTURE_SESSION_CHROME_PROFILE)
    : await launchVisibleBrowser(url);
  const { cdp, sessionId } = browser;
  try {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter once you are fully logged in... ");
    rl.close();

    return await saveSession(cdp, sessionId, { url, name, outputDir });
  } finally {
    await browser.close();
  }
}

async function mkdirTemp() {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "flow-map-capture-"));
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  await captureSession(parsed);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Session capture failed"}\n`);
    process.exitCode = 1;
  });
}

export {
  captureSession,
  connectCdp,
  dumpStorage,
  findVisibleChromium,
  launchRealChromeWithProfile,
  launchVisibleBrowser,
  parseArgs,
  saveSession,
};
