import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";

const MAX_JSONL_LINE_BYTES = 1_000_000;

// Node's SystemError carries a string code (ESRCH, EPERM, ...); anything else is
// rethrown unchanged. This reads the property without a cast: only an object or
// function with a string "code" matches, exactly what `error?.code` matched.
function errnoCode(error: unknown): string | undefined {
  if (
    (typeof error === "object" || typeof error === "function") &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return undefined;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  // spawn() always sets pid when it returns; `?? NaN` keeps the original
  // process.kill(-pid) behavior on the impossible undefined path instead of
  // inventing a new error.
  const pid = child.pid ?? NaN;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = errnoCode(error);
    if (code !== "ESRCH" && code !== "EPERM") throw error;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(10, Math.max(1, deadline - Date.now()))));
  }
  return true;
}

export async function stopProcessTree(child: ChildProcess | null | undefined, graceMs = 500): Promise<void> {
  if (!child || !child.pid || !Number.isSafeInteger(child.pid)) throw new Error("Process tree has no owned group identifier");
  if (!processGroupExists(child.pid)) return;
  signalProcessTree(child, "SIGTERM");
  if (await waitForProcessGroupExit(child.pid, graceMs)) return;
  signalProcessTree(child, "SIGKILL");
  if (!(await waitForProcessGroupExit(child.pid, graceMs))) throw new Error("Process tree did not exit after SIGKILL");
}

type JsonMessage = Record<string, unknown>;
type MessageCompletion = { complete?: unknown };
type ChildChannel = {
  send(value: unknown): void;
};
// The channel is only offered by runBoundedJsonlChild; a bare reader takes the
// message alone. Both shapes accept any object result and only read `complete`.
type ReaderMessageHandler = (
  message: JsonMessage,
) => MessageCompletion | null | undefined | Promise<MessageCompletion | null | undefined>;
export type BoundedChildMessageHandler = (
  message: JsonMessage,
  channel: ChildChannel,
) => MessageCompletion | null | undefined | Promise<MessageCompletion | null | undefined>;

export function attachBoundedJsonLineReader(stream: Readable, { onMessage, onError }: { onMessage: ReaderMessageHandler; onError: (error: Error) => void }): { drained(): Promise<void> } {
  let buffer = "";
  let terminal = false;
  let failed = false;
  let routing: Promise<void> = Promise.resolve();
  let endResolve: () => void;
  const ended = new Promise<void>((resolveEnd) => { endResolve = resolveEnd; });
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    onError(error instanceof Error ? error : new Error("Child protocol failed"));
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    if (failed) return;
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const rawLine = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(rawLine) > MAX_JSONL_LINE_BYTES) {
        fail(new Error("Child protocol line exceeded its bound"));
        return;
      }
      const line = rawLine.trim();
      if (!line) continue;
      let message: JsonMessage;
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
      } catch {
        fail(new Error("Child returned malformed JSONL"));
        return;
      }
      routing = routing.then(async () => {
        if (terminal) throw new Error("Child returned a message after completion");
        const result = await onMessage(message);
        if (result?.complete === true) terminal = true;
      }).catch(fail);
    }
    if (Buffer.byteLength(buffer) > MAX_JSONL_LINE_BYTES) fail(new Error("Child protocol line exceeded its bound"));
  });
  stream.on("end", () => {
    if (!failed && buffer.trim()) fail(new Error("Child returned truncated JSONL"));
    endResolve();
  });
  stream.on("error", (error) => {
    fail(error);
    endResolve();
  });
  return {
    async drained(): Promise<void> {
      await ended;
      await routing;
    }
  };
}

export async function runBoundedJsonlChild({ command, args, options, timeoutMs, label, onMessage, graceMs = 250 }: {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  timeoutMs: number;
  label: string;
  onMessage: BoundedChildMessageHandler;
  graceMs?: number;
}): Promise<{ exit: { code: number | null; signal: NodeJS.Signals | null }; stderr: string }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`${label} deadline reached`);
  const child = spawn(command, args, { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  // stdio is ["pipe", "pipe", "pipe"], so these are set in practice; the guard
  // keeps the failure a labeled rejection instead of a TypeError on null.
  const stdout = child.stdout;
  const stderrStream = child.stderr;
  const stdin = child.stdin;
  if (!stdout || !stderrStream || !stdin) throw new Error(`${label} child stdio is unavailable`);
  let stderr = "";
  let protocolError: unknown = null;
  stderrStream.setEncoding("utf8");
  stderrStream.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  const reader = attachBoundedJsonLineReader(stdout, {
    onMessage: (message) => onMessage(message, {
      send(value: unknown): void {
        if (stdin.destroyed) throw new Error(`${label} input closed`);
        stdin.write(`${JSON.stringify(value)}\n`);
      }
    }),
    onError(error: Error): void {
      protocolError ??= error;
      void stopProcessTree(child, graceMs).catch((stopError) => { protocolError ??= stopError; });
    }
  });
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, rejectDeadline) => {
    timeout = setTimeout(async () => {
      const error = new Error(`${label} deadline reached`);
      protocolError ??= error;
      try {
        await stopProcessTree(child, graceMs);
      } catch (stopError) {
        protocolError = stopError;
      }
      rejectDeadline(protocolError);
    }, timeoutMs);
  });
  try {
    const completed = exitPromise.then(async (exit) => {
      await reader.drained();
      return exit;
    });
    const exit = await Promise.race([completed, deadline]);
    if (protocolError) throw protocolError;
    return { exit, stderr };
  } finally {
    clearTimeout(timeout);
    stdin.destroy();
    await stopProcessTree(child, graceMs).catch(() => {});
  }
}

export function readOnlySandboxProfile({ nodePath, readableFiles }: { nodePath: string; readableFiles: string[] }): string {
  const literal = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const readable = readableFiles.map((file) => `(literal "${literal(file)}")`).join(" ");
  const ancestors = readableFiles.map((file) => `(path-ancestors "${literal(file)}")`).join(" ");
  return `(version 1)
(deny default)
(import "system.sb")
(allow process-exec (literal "${literal(nodePath)}"))
(allow file-read*
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/private/var/db/timezone")
  (literal "/dev/null")
  (literal "/dev/urandom")
  (literal "${literal(nodePath)}")
  ${readable})
(allow file-read-metadata file-test-existence
  (path-ancestors "${literal(nodePath)}")
  ${ancestors})
(allow sysctl-read)
(allow mach-lookup)
(allow signal (target self))
`;
}
