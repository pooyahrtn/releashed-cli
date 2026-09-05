import { spawn } from "node:child_process";

const MAX_JSONL_LINE_BYTES = 1_000_000;

function signalProcessTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!["ESRCH", "EPERM"].includes(error?.code)) throw error;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(10, Math.max(1, deadline - Date.now()))));
  }
  return true;
}

export async function stopProcessTree(child, graceMs = 500) {
  if (!child?.pid || !Number.isSafeInteger(child.pid)) throw new Error("Process tree has no owned group identifier");
  if (!processGroupExists(child.pid)) return;
  signalProcessTree(child, "SIGTERM");
  if (await waitForProcessGroupExit(child.pid, graceMs)) return;
  signalProcessTree(child, "SIGKILL");
  if (!(await waitForProcessGroupExit(child.pid, graceMs))) throw new Error("Process tree did not exit after SIGKILL");
}

export function attachBoundedJsonLineReader(stream, { onMessage, onError }) {
  let buffer = "";
  let terminal = false;
  let failed = false;
  let routing = Promise.resolve();
  let endResolve;
  const ended = new Promise((resolveEnd) => { endResolve = resolveEnd; });
  const fail = (error) => {
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
      let message;
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
    async drained() {
      await ended;
      await routing;
    }
  };
}

export async function runBoundedJsonlChild({ command, args, options, timeoutMs, label, onMessage, graceMs = 250 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`${label} deadline reached`);
  const child = spawn(command, args, { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let protocolError = null;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  const reader = attachBoundedJsonLineReader(child.stdout, {
    onMessage: (message) => onMessage(message, {
      send(value) {
        if (child.stdin.destroyed) throw new Error(`${label} input closed`);
        child.stdin.write(`${JSON.stringify(value)}\n`);
      }
    }),
    onError(error) {
      protocolError ??= error;
      void stopProcessTree(child, graceMs).catch((stopError) => { protocolError ??= stopError; });
    }
  });
  const exitPromise = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let timeout;
  const deadline = new Promise((_, rejectDeadline) => {
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
    child.stdin.destroy();
    await stopProcessTree(child, graceMs).catch(() => {});
  }
}

export function readOnlySandboxProfile({ nodePath, readableFiles }) {
  const literal = (value) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
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
