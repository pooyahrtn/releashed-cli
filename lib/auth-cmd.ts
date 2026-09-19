// --auth-cmd: the product's own backend mints the sign-in, so a signed-in map costs no human.
//
// `releashed login` is a person in a browser window; nobody does that before every run. A team
// that owns the product can already mint a one-shot sign-in link for a test account (a Clerk
// ticket, a magic link, a signed redirect). --auth-cmd runs THEIR command and accepts one of two
// things on stdout:
//
//   a URL   -- a one-shot sign-in link. We open it in a plain headless Chromium with no request
//              boundary (the identity provider is not the product; the boundary belongs to the
//              exploring run), wait until the page has left the sign-in flow, and keep the jar.
//   JSON    -- a schema_version-1 session file, already captured by whatever means they like.
//
// Either way the result is the same file `releashed login` writes, so everything downstream --
// loadSavedSession, the sign-in-landing-page refusal, the boundary -- is untouched.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { isAuthFlowUrl } from "./scaffold.ts";

const execAsync = promisify(exec);

// --auth-cmd runs in whatever directory the caller invoked `releashed` from -- not the directory
// the command itself lives in -- so a script that only resolves relative to its own repo fails
// there with a message that otherwise blames the script. Name the directory too.
const runShell = async (command: string): Promise<string> => {
  try {
    return (await execAsync(command, { maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new Error(
      `--auth-cmd ran in ${process.cwd()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export type AuthCmdOutput =
  | { kind: "session"; session: unknown }
  | { kind: "url"; url: string };

// What the command printed, and nothing else: chatter belongs on stderr.
export function classifyAuthOutput(stdout: unknown): AuthCmdOutput {
  const text = String(stdout ?? "").trim();
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw badOutput(text);
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { schema_version?: unknown }).schema_version !== 1
    )
      throw new Error(
        `--auth-cmd printed JSON that is not a schema_version-1 session file: "${text.slice(0, 80)}"`,
      );
    return { kind: "session", session: parsed };
  }
  if (/^https?:\/\/\S+$/.test(text)) return { kind: "url", url: new URL(text).href };
  throw badOutput(text);
}

const badOutput = (text: string): Error =>
  new Error(
    `--auth-cmd must print a sign-in URL or a schema_version-1 session file, not: "${text.slice(0, 80)}"`,
  );

export type RedeemOptions = {
  name: string;
  outputDir: string;
  timeoutMs?: number;
};

// Opens the one-shot link in a throwaway headless browser and keeps what the sign-in left behind.
// No request boundary here on purpose: this context only visits the identity provider, is closed
// before the exploring run starts, and hands over nothing but a cookie jar.
async function redeemSignInUrl(
  ticketUrl: string,
  { name, outputDir, timeoutMs = 60_000 }: RedeemOptions,
): Promise<string> {
  const { launchVisibleBrowser, saveSession } = await import("../scripts/capture-session.ts");
  const browser = await launchVisibleBrowser(ticketUrl, { headless: true });
  try {
    const deadline = Date.now() + timeoutMs;
    let href: string = ticketUrl;
    for (;;) {
      href =
        (
          await browser.cdp.send(
            "Runtime.evaluate",
            { expression: "location.href", returnByValue: true },
            browser.sessionId,
          )
        ).result?.value ?? "about:blank";
      if (href.startsWith("http") && !isAuthFlowUrl(href)) break;
      if (Date.now() > deadline)
        throw new Error(
          `--auth-cmd's sign-in link never left the sign-in flow (still at ${new URL(href).pathname} after ${Math.round(timeoutMs / 1000)}s): a refusal is a finding, not something to work around`,
        );
      await new Promise((done) => setTimeout(done, 500));
    }
    return await saveSession(browser.cdp, browser.sessionId, { url: ticketUrl, name, outputDir });
  } finally {
    await browser.close();
  }
}

export type AuthCmdRequest = {
  command: string;
  sessionDir: string;
  name: string;
};

export type AuthCmdDeps = {
  shell?: (command: string) => Promise<string>;
  redeem?: (ticketUrl: string, options: RedeemOptions) => Promise<string>;
};

// Runs the user's command and returns the path of the session file it produced.
export async function sessionFromAuthCmd(
  { command, sessionDir, name }: AuthCmdRequest,
  { shell = runShell, redeem = redeemSignInUrl }: AuthCmdDeps = {},
): Promise<string> {
  const result = classifyAuthOutput(await shell(command));
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  if (result.kind === "url") return redeem(result.url, { name, outputDir: sessionDir });
  const path = join(sessionDir, `${name}.json`);
  await writeFile(path, `${JSON.stringify(result.session)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
