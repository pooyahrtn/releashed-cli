import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachBoundedJsonLineReader, stopProcessTree } from "../lib/bounded-child.mjs";
import { BROWSER_READY_GRACE_MS, BROWSER_STARTUP_BUDGET_MS } from "../lib/browser-runtime-limits.mjs";
import { writeJsonLine } from "../lib/scaffold.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function browserBrokerEnvironment(source = process.env) {
  return {
    HOME: source.HOME ?? "",
    PATH: "/usr/bin:/bin",
    ...(source.CHROMIUM_EXECUTABLE ? { CHROMIUM_EXECUTABLE: source.CHROMIUM_EXECUTABLE } : {})
  };
}

export class BrokerProcess {
  constructor(file, configPath, absoluteDeadlineMs, {
    label = "Browser broker",
    environment = browserBrokerEnvironment(),
    readyTimeoutMs = BROWSER_STARTUP_BUDGET_MS + BROWSER_READY_GRACE_MS,
    // The child's own budgets for a single RPC can legitimately run up to 35s
    // (POST_AUTH_READINESS_TIMEOUT_MS in browser-broker.mjs, on the first call
    // after auth) and 15s (INITIAL_TOP_FRAME_LOAD_TIMEOUT_MS, on the initial
    // navigate). This must stay comfortably above the longer of those so the
    // supervisor never kills a child that is still working within its own budget.
    callTimeoutMs = 45_000
  } = {}) {
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.queue = Promise.resolve();
    this.absoluteDeadlineMs = absoluteDeadlineMs;
    this.label = label;
    this.callTimeoutMs = callTimeoutMs;
    this.state = "starting";
    this.terminalError = null;
    this.stopPromise = null;
    this.ready = new Promise((resolveReady, rejectReady) => {
      const readyTimeout = setTimeout(() => {
        const error = new Error(`${this.label} readiness deadline reached`);
        rejectReady(error);
        this.failClosed(error);
      }, Math.max(1, Math.min(readyTimeoutMs, absoluteDeadlineMs - Date.now())));
      this.child = spawn(process.execPath, [file, "--config", configPath], {
        cwd: repository,
        env: environment,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child.stderr.setEncoding("utf8");
      this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-2000); });
      this.child.once("error", (error) => {
        clearTimeout(readyTimeout);
        rejectReady(error);
        this.failClosed(error);
      });
      this.child.once("exit", (code, signal) => {
        clearTimeout(readyTimeout);
        const error = new Error(this.state === "starting" ? `${this.label} exited before readiness` : `${this.label} exited (${code ?? signal})`);
        rejectReady(error);
        this.failClosed(error);
      });
      attachBoundedJsonLineReader(this.child.stdout, {
        onMessage: (message) => {
          if (message.ready !== undefined) {
            if (this.state !== "starting") throw new Error(`${this.label} repeated readiness`);
            clearTimeout(readyTimeout);
            if (message.ready) {
              this.state = "ready";
              resolveReady(message);
            } else {
              const error = new Error(message.error ?? `${this.label} failed to start`);
              rejectReady(error);
              this.failClosed(error);
            }
            return;
          }
          if (this.state !== "ready") throw new Error(`${this.label} responded outside an active session`);
          const waiter = this.pending.get(message.rpc_id);
          if (!waiter) throw new Error(`${this.label} returned an unknown RPC id`);
          this.pending.delete(message.rpc_id);
          clearTimeout(waiter.timer);
          waiter.resolve(message.response);
        },
        onError: (error) => {
          clearTimeout(readyTimeout);
          rejectReady(error);
          this.failClosed(error);
        }
      });
    });
  }

  failClosed(error) {
    this.terminalError ??= error;
    this.state = "failed";
    this.rejectPending(this.terminalError);
    if (this.child) {
      this.stopPromise ??= stopProcessTree(this.child);
      void this.stopPromise.catch(() => {});
    }
  }

  rejectPending(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  call(payload, caller = "supervisor") {
    const work = this.queue.then(() => new Promise((resolveCall, rejectCall) => {
      if (this.terminalError) {
        rejectCall(this.terminalError);
        return;
      }
      const remaining = Math.min(this.callTimeoutMs, this.absoluteDeadlineMs - Date.now());
      if (remaining <= 0) {
        rejectCall(new Error(`${this.label} RPC deadline reached`));
        return;
      }
      const rpcId = this.nextId++;
      const timer = setTimeout(() => this.failClosed(new Error(`${this.label} RPC deadline reached`)), remaining);
      this.pending.set(rpcId, { resolve: resolveCall, reject: rejectCall, timer });
      writeJsonLine(this.child.stdin, { rpc_id: rpcId, caller, payload });
    }));
    this.queue = work.catch(() => {});
    return work;
  }

  async stop() {
    this.state = "stopping";
    this.stopPromise ??= stopProcessTree(this.child);
    await this.stopPromise;
  }
}
