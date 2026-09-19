import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isNodeOnScreen } from "../lib/ax-visibility.mjs";
import { formatAxLine } from "../lib/ax-line-format.mjs";
import { CLERK_BOUNDED_ROUTE_FAILURE_CODES, CLERK_BOUNDED_ROUTE_FAILURE_POINTS, CLERK_TICKET_EXCHANGE_FAILURE_STAGES, isPermittedClerkMutation, OneShotClerkPageAuthenticator, provisionalClerkBootstrapTouchSessionId } from "../lib/clerk-auth.mjs";
import { appendJsonl, attachJsonLineReader, combinedReservedAndActual, isoNow, isAuthFlowUrl, monotonicSeconds, mutateCapState, normalizeOrigin, readJson, refusal, rollingCount, sanitizeUrl, sha256File, sha256Text, writeJsonLine } from "../lib/scaffold.mjs";
import { BROWSER_STARTUP_BUDGET_MS, CDP_COMMAND_TIMEOUT_MS, INITIAL_NAVIGATION_FAILURE_POINTS, INITIAL_TOP_FRAME_LOAD_TIMEOUT_MS } from "../lib/browser-runtime-limits.mjs";
import { revalidateOwnedBrowserProfile } from "./browser-profile-custody.mjs";
export function isRecord(value) {
    return typeof value === "object" && value !== null;
}
/** One untyped field hop over cap state or CDP records. Keeps validation
 * expressions structurally identical without casts: missing levels read as
 * undefined, exactly as the original optional chaining did. */
function field(value, key) {
    return isRecord(value) ? value[key] : undefined;
}
/** Thrown where private identity material would otherwise enter retained evidence. */
class PrivateIdentityExposureError extends Error {
    privateIdentityExposure = true;
}
function hasPrivateIdentityExposure(error) {
    return error instanceof PrivateIdentityExposureError;
}
/** Thrown when an effectful page call races a latched background abort. */
class BackgroundAbortError extends Error {
    backgroundAbortLatched = true;
}
const BROKER_ID = "spike-a-browser-broker-v1";
const ALLOWED_METHODS = new Set(["ping", "navigate", "observe", "click", "type", "scroll", "metrics", "close"]);
const CALIBRATION_MODE = "trusted-reversible-control-v1";
const CLERK_READY_TIMEOUT_MS = 4_000;
const CLERK_BOOTSTRAP_TRANSPORT_TIMEOUT_MS = 8_000;
const AUTH_LANDING_TIMEOUT_MS = 5_000;
const AUTH_LANDING_SETTLE_MS = 50;
// A brand-new user's first screen is the onboarding chat, whose opening coach
// message streams in over several seconds -- the accessibility tree and screenshot
// keep changing well past a short budget. This must comfortably outlast that.
const POST_AUTH_READINESS_TIMEOUT_MS = 35_000;
const POST_AUTH_NETWORK_QUIET_MS = 50;
const POST_AUTH_STABLE_WINDOW_MS = 500;
const POST_AUTH_STABLE_SAMPLES = 3;
const POST_AUTH_NON_AUTH_HOP_CAP = 3;
const PRIVATE_AUTH_HANDOFF = Symbol("private-auth-handoff");
const BOUNDED_ONBOARDING_MODE = "source-blind-bounded-onboarding-v1";
const BOUNDED_ONBOARDING_CLASS = "Bounded own-account bound-route progress";
const SAFE_DIAGNOSTIC_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const SAFE_DIAGNOSTIC_CLERK_PHASES = new Set(["bootstrap", "activating", "active"]);
function containsExactPrivateText(value, needles, seen = new Set()) {
    if (typeof value === "string")
        return needles.some((needle) => value.includes(needle));
    if (!value || typeof value !== "object" || seen.has(value))
        return false;
    seen.add(value);
    if (Array.isArray(value))
        return value.some((entry) => containsExactPrivateText(entry, needles, seen));
    return Object.values(value).some((entry) => containsExactPrivateText(entry, needles, seen));
}
function privateIdentityExposureError() {
    return new PrivateIdentityExposureError("Private identity exposure prevented evidence retention");
}
function publicCapState(state) {
    if (!isRecord(state))
        return state;
    const abort = state.abort;
    if (!isRecord(abort) || !abort.operator_diagnostic)
        return state;
    const clone = structuredClone(state);
    const cloneAbort = clone.abort;
    if (isRecord(cloneAbort))
        delete cloneAbort.operator_diagnostic;
    return clone;
}
function sanitizeCalibrationText(value) {
    let text = String(value ?? "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, "[redacted-email]")
        .replace(/\b(?:user|sess|sit)_[A-Za-z0-9_-]+\b/g, "[redacted-id]")
        .replace(/\beyJ[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, "[redacted-token]");
    while (Buffer.byteLength(text) > 160)
        text = text.slice(0, -1);
    return text;
}
function axValue(value) {
    if (!value || typeof value !== "object")
        return null;
    const normalized = { type: value.type ?? null, value: value.value ?? null };
    if (Array.isArray(value.relatedNodes)) {
        normalized.related_nodes = value.relatedNodes.map((node) => ({ text: node?.text ?? null }));
    }
    return normalized;
}
export function hashAccessibilityTree(nodes = []) {
    const positions = new Map(nodes.map((node, index) => [node.nodeId, index]));
    const normalized = nodes.map((node) => ({
        ignored: node.ignored === true,
        ignored_reasons: (node.ignoredReasons ?? []).map((reason) => ({ name: reason.name ?? null, value: axValue(reason.value) })),
        role: axValue(node.role),
        name: axValue(node.name),
        description: axValue(node.description),
        value: axValue(node.value),
        properties: (node.properties ?? []).map((property) => ({ name: property.name ?? null, value: axValue(property.value) })),
        parent_index: positions.has(node.parentId) ? positions.get(node.parentId) : null,
        child_indices: (node.childIds ?? []).map((id) => positions.get(id) ?? null)
    }));
    return sha256Text(JSON.stringify(normalized));
}
export function evaluateCalibrationRestoration({ baseline, open, final, guard = {} }) {
    const openStateObserved = Boolean(baseline && open &&
        (baseline.raw_url_sha256 !== open.raw_url_sha256 || baseline.accessibility_sha256 !== open.accessibility_sha256));
    const exactRawUrlRestore = Boolean(baseline && final && baseline.raw_url_sha256 === final.raw_url_sha256);
    const exactSemanticRestore = Boolean(baseline && final && baseline.accessibility_sha256 === final.accessibility_sha256);
    const storageUnchanged = Boolean(baseline && final && baseline.storage_sha256 === final.storage_sha256);
    const durableStorageAbsent = Boolean(baseline?.durable_storage_absent && open?.durable_storage_absent && final?.durable_storage_absent);
    const storageCertain = Boolean(baseline?.storage_certain && open?.storage_certain && final?.storage_certain);
    const proofBase = {
        open_state_observed: openStateObserved,
        exact_reverse_control_used: true,
        reversal_attempted: true,
        exact_raw_url_restore: exactRawUrlRestore,
        exact_semantic_restore: exactSemanticRestore,
        storage_unchanged: storageUnchanged,
        durable_storage_absent: durableStorageAbsent,
        request_observed: guard.request_attempted === true,
        all_requests_blocked_before_dispatch: guard.all_requests_blocked_before_dispatch !== false,
        transport_attempt_observed: guard.transport_attempted === true,
        storage_mutation_attempted: guard.storage_mutation_attempted === true,
        guard_installation_confirmed: guard.installation_complete === true || guard.installation_complete === undefined
    };
    const safe = Object.entries(proofBase).every(([key, value]) => {
        if (["request_observed", "transport_attempt_observed", "storage_mutation_attempted"].includes(key))
            return value === false;
        return value === true;
    }) && storageCertain;
    return { ...proofBase, safe };
}
export const CLERK_PAGE_FUNCTIONS = Object.freeze({
    ready: `async function(timeoutMs) {
    try {
      const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(4000, timeoutMs)) : 0;
      const deadline = Date.now() + boundedTimeoutMs;
      while (!(globalThis.Clerk?.loaded && globalThis.Clerk?.client) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return Boolean(globalThis.Clerk?.loaded && globalThis.Clerk?.client);
    } catch {
      return false;
    }
  }`,
    preAuth: `function() {
    try {
      const clerk = globalThis.Clerk;
      const sessions = clerk?.client?.sessions;
      return {
        clerk_ready: Boolean(clerk?.loaded && clerk?.client),
        signed_out: clerk?.user == null && clerk?.session == null,
        session_absent: Array.isArray(sessions) && sessions.length === 0,
        sign_in_clean: clerk?.client?.signIn?.status == null
      };
    } catch {
      return { clerk_ready: false, signed_out: false, session_absent: false, sign_in_clean: false };
    }
  }`,
    identityAbsent: `function(needles) {
    const failed = () => ({ inspection_complete: false, identity_absent: false });
    try {
      if (!Array.isArray(needles) || needles.length !== 2 || needles.some((value) => typeof value !== "string" || !value)) return failed();
      const contains = (value) => typeof value === "string" && needles.some((needle) => value.includes(needle));
      const seenRoots = new Set();
      const scanRoot = (root) => {
        if (!root || seenRoots.has(root)) return true;
        seenRoots.add(root);
        if (contains(root.textContent)) return false;
        for (const element of root.querySelectorAll("*")) {
          for (const attribute of element.attributes ?? []) if (contains(attribute.value)) return false;
          if (element.shadowRoot && !scanRoot(element.shadowRoot)) return false;
          if (element.localName === "iframe" || element.localName === "frame") {
            let child;
            try { child = element.contentDocument; } catch { return null; }
            if (!child) return null;
            const nested = scanRoot(child);
            if (nested !== true) return nested;
          }
        }
        return true;
      };
      const result = scanRoot(document);
      return {
        inspection_complete: result === true,
        identity_absent: result === true
      };
    } catch {
      return failed();
    }
  }`,
    start: `async function(ticket, expectedUserId, expectedCurrentHref) {
    const failure = (failure_stage) => ({ failure_stage });
    const ticketFailureStages = ${JSON.stringify(CLERK_TICKET_EXCHANGE_FAILURE_STAGES)};
    const existingSignInStatuses = new Set([
      "needs_identifier",
      "needs_first_factor",
      "needs_second_factor",
      "needs_new_password",
      "complete"
    ]);
    let clerk = null;
    try {
      clerk = globalThis.Clerk;
    } catch {
      return failure("sdk_unavailable");
    }
    if (!(clerk?.loaded && clerk?.client)) return failure("sdk_unavailable");
    try {
      if (
        (clerk.user?.id && clerk.user.id !== expectedUserId) ||
        typeof clerk.client?.signIn?.create !== "function" ||
        typeof clerk.setActive !== "function"
      ) return failure("precondition_failed");
    } catch {
      return failure("precondition_failed");
    }
    let priorSignInState = null;
    try {
      const status = clerk.client.signIn.status;
      if (status === null || status === undefined) priorSignInState = "clean";
      else if (existingSignInStatuses.has(status)) priorSignInState = "existing";
    } catch {
      return failure("ticket_exchange_failed");
    }
    if (priorSignInState === null) return failure("ticket_exchange_failed");
    let signIn;
    try {
      if (typeof expectedCurrentHref !== "string" || globalThis.location?.href !== expectedCurrentHref) {
        return failure("precondition_failed");
      }
      signIn = await clerk.client.signIn.create({ strategy: "ticket", ticket });
    } catch (error) {
      let bucket = null;
      try {
        if ((typeof error !== "object" && typeof error !== "function") || error === null) {
          return failure("ticket_exchange_failed");
        }
        const status = error.status;
        if (status === undefined) bucket = "transport_or_runtime";
        else if (!Number.isSafeInteger(status)) return failure("ticket_exchange_failed");
        else if (status === 401 || status === 403) bucket = "unauthorized";
        else if (status === 409) bucket = "conflict";
        else if (status === 429) bucket = "rate_limited";
        else if (status >= 500 && status <= 599) bucket = "provider_5xx";
        else if (status >= 400 && status <= 499) bucket = "rejected";
        else return failure("ticket_exchange_failed");
      } catch {
        return failure("ticket_exchange_failed");
      }
      return failure(ticketFailureStages[priorSignInState][bucket]);
    }
    let createdSessionId;
    try {
      createdSessionId = signIn?.createdSessionId;
    } catch {
      return failure("session_missing");
    }
    if (typeof createdSessionId !== "string" || !createdSessionId) return failure("session_missing");
    return { created_session_id: createdSessionId };
  }`,
    activate: `async function(createdSessionId, expectedUserId) {
    const failure = (failure_stage) => ({ failure_stage });
    let clerk = null;
    try { clerk = globalThis.Clerk; } catch { return failure("sdk_unavailable"); }
    try {
      if (!(clerk?.loaded && clerk?.client) || typeof clerk.setActive !== "function") {
        return failure("precondition_failed");
      }
      await clerk.setActive({ session: createdSessionId });
    } catch {
      return failure("activation_failed");
    }
    try {
      const token = await clerk.session?.getToken?.();
      const userId = clerk.user?.id ?? null;
      const sessionId = clerk.session?.id ?? null;
      if (
        userId !== expectedUserId ||
        sessionId !== createdSessionId ||
        typeof token !== "string" ||
        token.length === 0
      ) return failure("token_confirmation_failed");
      return { user_id: userId, session_id: sessionId, token_present: true };
    } catch {
      return failure("token_confirmation_failed");
    }
  }`,
    inspect: `async function() {
    const clerk = globalThis.Clerk;
    let token = null;
    try { token = await clerk?.session?.getToken(); } catch {}
    return { user_id: clerk?.user?.id ?? null, session_id: clerk?.session?.id ?? null, token_present: typeof token === "string" && token.length > 0 };
  }`,
    postAuthReady: `function() {
    try {
      if (document.readyState !== "complete") return false;
      if (document.querySelector('[aria-busy="true"]')) return false;
      const animations = typeof document.getAnimations === "function" ? document.getAnimations() : [];
      return !animations.some((animation) => animation.playState === "running" || animation.playState === "pending");
    } catch {
      return false;
    }
  }`,
    lock: `function() {
    const clerk = globalThis.Clerk;
    if (!clerk) return { locked: false };
    const blocked = () => Promise.reject(new DOMException("Disabled by supervised browser policy", "NotAllowedError"));
    const replace = (owner, key) => {
      if (!owner || typeof owner[key] !== "function") return true;
      try { Object.defineProperty(owner, key, { value: blocked, writable: false, configurable: false }); }
      catch { try { owner[key] = blocked; } catch {} }
      return owner[key] === blocked;
    };
    const locked = [replace(clerk, "setActive"), replace(clerk, "signOut"), replace(clerk.client?.signIn, "create"), replace(clerk.client?.signUp, "create")].every(Boolean);
    Object.defineProperty(globalThis, "__FLOW_MAP_CLERK_AUTH_LOCKED__", { value: locked, writable: false, configurable: false });
    return { locked };
  }`
});
export const CALIBRATION_PAGE_FUNCTIONS = Object.freeze({
    storage: `async function() {
    const readStorage = (storage) => Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key) => typeof key === "string").sort().map((key) => [key, storage.getItem(key)]);
    try {
      if (!globalThis.indexedDB || typeof globalThis.indexedDB.databases !== "function" || !globalThis.caches || typeof globalThis.caches.keys !== "function") {
        return { certain: false, durable_absent: false, payload: null, guard: globalThis.__FLOW_MAP_CALIBRATION_GUARD__ ?? null };
      }
      const databases = await globalThis.indexedDB.databases();
      const cacheNames = await globalThis.caches.keys();
      if (!Array.isArray(databases) || !Array.isArray(cacheNames)) throw new Error("storage inventory unavailable");
      return {
        certain: true,
        durable_absent: databases.length === 0 && cacheNames.length === 0,
        payload: { local: readStorage(globalThis.localStorage), session: readStorage(globalThis.sessionStorage), cookie: document.cookie },
        guard: globalThis.__FLOW_MAP_CALIBRATION_GUARD__ ?? null
      };
    } catch {
      return { certain: false, durable_absent: false, payload: null, guard: globalThis.__FLOW_MAP_CALIBRATION_GUARD__ ?? null };
    }
  }`,
    activate: `function() {
    const guard = globalThis.__FLOW_MAP_CALIBRATION_GUARD__;
    if (!guard || guard.installation_complete !== true || guard.active) return { activated: false };
    guard.transport_attempted = false;
    guard.storage_mutation_attempted = false;
    guard.active = true;
    return { activated: true, installation_complete: true };
  }`
});
export function calibrationGuardSource({ calibration, allowFixtureServiceWorker }) {
    if (!calibration)
        return `{
    const blocked = class { constructor() { throw new DOMException('Disabled by supervised browser policy', 'NotAllowedError'); } };
    const blockedPromise = () => Promise.reject(new DOMException('Disabled by supervised browser policy', 'NotAllowedError'));
    ${allowFixtureServiceWorker ? "" : "if (navigator.serviceWorker) navigator.serviceWorker.register = blockedPromise;"}
    globalThis.Worker = blocked; globalThis.SharedWorker = blocked; globalThis.WebSocket = blocked; globalThis.EventSource = blocked;
    globalThis.RTCPeerConnection = blocked; globalThis.WebTransport = blocked;
    if (navigator.sendBeacon) navigator.sendBeacon = () => false;
    const blockedPermission = () => Promise.reject(new DOMException('Disabled by supervised browser policy', 'NotAllowedError'));
    if (globalThis.Notification) globalThis.Notification.requestPermission = blockedPermission;
    if (navigator.permissions) navigator.permissions.query = blockedPermission;
    if (navigator.geolocation) { navigator.geolocation.getCurrentPosition = () => { throw new DOMException('Disabled by supervised browser policy', 'NotAllowedError'); }; navigator.geolocation.watchPosition = () => { throw new DOMException('Disabled by supervised browser policy', 'NotAllowedError'); }; }
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = blockedPermission;
  }`;
    return `{
    const guard = { active: false, installation_complete: true, transport_attempted: false, storage_mutation_attempted: false };
    Object.defineProperty(globalThis, '__FLOW_MAP_CALIBRATION_GUARD__', { value: guard, writable: false, configurable: false });
    const note = (key) => { if (guard.active) guard[key] = true; };
    const replace = (owner, key, value) => {
      if (!owner) { guard.installation_complete = false; return false; }
      try { Object.defineProperty(owner, key, { value, writable: false, configurable: false }); }
      catch { try { owner[key] = value; } catch {} }
      const installed = owner[key] === value; guard.installation_complete &&= installed; return installed;
    };
    const deniedTransport = class { constructor() { note('transport_attempted'); throw new DOMException('Disabled by supervised browser policy', 'NotAllowedError'); } };
    for (const key of ['Worker', 'SharedWorker', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'WebTransport']) replace(globalThis, key, deniedTransport);
    if (navigator.sendBeacon) replace(navigator, 'sendBeacon', () => { note('transport_attempted'); return false; });
    ${allowFixtureServiceWorker ? "" : "if (navigator.serviceWorker) replace(navigator.serviceWorker, 'register', () => { note('transport_attempted'); return Promise.reject(new DOMException('Disabled by supervised browser policy', 'NotAllowedError')); });"}
    const wrapMutation = (owner, key) => {
      if (!owner || typeof owner[key] !== 'function') { guard.installation_complete = false; return; }
      const original = owner[key];
      replace(owner, key, function(...args) { note('storage_mutation_attempted'); return Reflect.apply(original, this, args); });
    };
    for (const key of ['setItem', 'removeItem', 'clear']) wrapMutation(globalThis.Storage?.prototype, key);
    for (const key of ['open', 'deleteDatabase']) wrapMutation(globalThis.IDBFactory?.prototype, key);
    for (const key of ['add', 'put', 'delete', 'clear']) wrapMutation(globalThis.IDBObjectStore?.prototype, key);
    for (const key of ['open', 'delete']) wrapMutation(globalThis.CacheStorage?.prototype, key);
    for (const key of ['add', 'addAll', 'put', 'delete']) wrapMutation(globalThis.Cache?.prototype, key);
  }`;
}
function parseArgs() {
    const values = {};
    for (let index = 2; index < process.argv.length; index += 2)
        values[process.argv[index]] = process.argv[index + 1];
    if (!values["--config"])
        throw new Error("--config is required");
    return values;
}
async function findChromium(explicit) {
    if (explicit)
        return resolve(explicit);
    const cache = join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
    const directories = (await readdir(cache)).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const directory of directories) {
        const candidate = join(cache, directory, "chrome-mac", "headless_shell");
        try {
            await readFile(candidate);
            return candidate;
        }
        catch { }
    }
    throw new Error("No Chromium headless shell found; set CHROMIUM_EXECUTABLE in the supervisor environment");
}
export async function waitForDevToolsPort(devtoolsFile, { readFileImpl = readFile, retryDelayMs = 50, attempts = null, deadlineMs = Date.now() + BROWSER_STARTUP_BUDGET_MS } = {}) {
    for (let attempt = 0; attempts === null || attempt < attempts; attempt += 1) {
        try {
            const [rawPort, browserPath] = (await readFileImpl(devtoolsFile, "utf8")).trim().split(/\r?\n/);
            if (/^[0-9]{1,5}$/.test(rawPort) && browserPath?.startsWith("/devtools/browser/")) {
                const port = Number(rawPort);
                if (Number.isSafeInteger(port) && port >= 1 && port <= 65_535)
                    return port;
            }
        }
        catch { }
        if ((attempts !== null && attempt + 1 >= attempts) || Date.now() >= deadlineMs)
            break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(retryDelayMs, Math.max(1, deadlineMs - Date.now()))));
    }
    throw new Error("Chromium did not publish its DevTools endpoint");
}
export class CdpConnection {
    socket;
    nextId;
    pending;
    listeners;
    commandTimeoutMs;
    absoluteDeadlineMs;
    terminalError;
    constructor(socket, { commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS, absoluteDeadlineMs = Date.now() + 60_000 } = {}) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Set();
        this.commandTimeoutMs = commandTimeoutMs;
        this.absoluteDeadlineMs = absoluteDeadlineMs;
        this.terminalError = null;
        socket.addEventListener("message", (event) => {
            let message;
            try {
                message = JSON.parse(String(event.data));
            }
            catch {
                this.terminate(new Error("CDP connection failed"));
                return;
            }
            if (message.id) {
                const pending = this.pending.get(message.id);
                if (!pending)
                    return;
                this.pending.delete(message.id);
                clearTimeout(pending.timer);
                const responseError = message.error;
                if (responseError) {
                    const detail = isRecord(responseError) ? responseError : null;
                    const reason = detail?.message;
                    pending.reject(new Error(reason === undefined ? undefined : String(reason)));
                }
                else
                    pending.resolve(message.result ?? {});
                return;
            }
            try {
                for (const listener of this.listeners)
                    listener(message);
            }
            catch {
                this.terminate(new Error("CDP connection failed"));
            }
        });
        socket.addEventListener("close", () => this.terminate(new Error("CDP connection closed")), { once: true });
        socket.addEventListener("error", () => this.terminate(new Error("CDP connection failed")), { once: true });
    }
    send(method, params = {}, sessionId) {
        if (this.terminalError)
            return Promise.reject(this.terminalError);
        const id = this.nextId++;
        const message = { id, method, params };
        if (sessionId)
            message.sessionId = sessionId;
        return new Promise((resolvePromise, reject) => {
            const remaining = Math.min(this.commandTimeoutMs, this.absoluteDeadlineMs - Date.now());
            if (remaining <= 0) {
                reject(new Error("CDP operation deadline reached"));
                return;
            }
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error("CDP operation deadline reached"));
            }, remaining);
            this.pending.set(id, { resolve: resolvePromise, reject, timer });
            try {
                this.socket.send(JSON.stringify(message));
            }
            catch {
                clearTimeout(timer);
                this.pending.delete(id);
                this.terminate(new Error("CDP connection failed"));
                reject(this.terminalError);
            }
        });
    }
    onEvent(listener) {
        this.listeners.add(listener);
    }
    setLimits({ commandTimeoutMs, absoluteDeadlineMs }) {
        if (this.pending.size !== 0)
            throw new Error("CDP limits cannot change while a command is pending");
        if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs <= 0 || !Number.isFinite(absoluteDeadlineMs)) {
            throw new Error("CDP limits are invalid");
        }
        this.commandTimeoutMs = commandTimeoutMs;
        this.absoluteDeadlineMs = absoluteDeadlineMs;
    }
    close() {
        this.socket.close();
    }
    terminate(error) {
        if (this.terminalError)
            return;
        this.terminalError = error;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
function isBrokerConfig(value) {
    if (!isRecord(value))
        return false;
    return (typeof value.run_directory === "string" &&
        typeof value.profile_directory === "string" &&
        Array.isArray(value.allowed_request_origins) &&
        Array.isArray(value.allowed_navigation_origins));
}
/** Extracts the post-auth readiness refusal carried by a restarted-readiness error. */
function postAuthReadinessRefusalOf(error) {
    if (!isRecord(error))
        return null;
    const refusal = error.postAuthReadinessRefusal;
    if (!isRecord(refusal) || typeof refusal.ok !== "boolean")
        return null;
    return { ok: refusal.ok, ...refusal };
}
/** CDP event params, fail-closed: the socket listener terminates the connection on
 * any throw, so a missing-params event throws here exactly as dereferencing it did. */
function eventParams(message) {
    if (!isRecord(message.params))
        throw new Error("CDP event params are unavailable");
    return message.params;
}
/** CDP target info, fail-closed like event params above. */
function eventTargetInfo(message) {
    const params = eventParams(message);
    if (!isRecord(params.targetInfo))
        throw new Error("CDP target info is unavailable");
    return params.targetInfo;
}
export class BrowserBroker {
    config;
    startupBudgetMs;
    findChromium;
    spawnBrowser;
    waitForDevToolsPort;
    fetch;
    WebSocket;
    runDirectory;
    profileDirectory;
    allowedOrigins;
    allowedNavigationOrigins;
    suppressedOrigins;
    operationTimes;
    requestTimes;
    requestQueue;
    refs;
    currentUrl;
    eventSequence;
    sessionTypes;
    sessionReady;
    redirectIds;
    effectRegistry;
    reversibleActionRegistry;
    boundedOnboarding;
    boundedScopeHref;
    boundedScopeRawUrlSha256;
    boundedScopeIdentity;
    boundedScopeComplete;
    boundedPostAuthStartPending;
    boundedPostAuthHandoff;
    boundedExpectedClerkUserId;
    boundedPostAuthResumeAttempted;
    boundedPrivateAuthStart;
    savedSessionConfig;
    privateIdentityNeedles;
    boundedClickDispatchGeneration;
    authBootstrapAdmissions;
    boundedPendingScopeExit;
    actionTokens;
    absoluteDeadlineMs;
    calibrationEnabled;
    calibrationGuard;
    clerkTransportPhase;
    activeClerkSessionId;
    clerkTransportAttempt;
    clerkBootstrapTransportDeadlineMs;
    provisionalClerkSessionId;
    provisionalClerkTouchCount;
    networkInflight;
    routeBindingNetworkInflight;
    backgroundAbortTasks;
    backgroundAbortLatched;
    networkActivitySequence;
    routeBindingNetworkActivitySequence;
    lastNetworkActivityAt;
    postAuthReadinessTimeoutMs;
    boundedRouteBindingTimeoutMs;
    boundedRouteStableWindowMs;
    boundedRouteStableSamples;
    boundedRouteHopCap;
    boundedRouteFailurePoint;
    navigationSequence;
    initialTopFrameLoadTimeoutMs;
    logicalNavigationSequence;
    topFrameId;
    topFrameLoaderId;
    lastTopNavigation;
    lastLogicalTopNavigation;
    lastTopLogicalLocation;
    topFrameLoadSequence;
    pageLoadWaiters;
    clerkAuthenticator;
    chrome;
    cdp;
    pageTargetId;
    pageSessionId;
    executableIdentity;
    transientAuthInstalled;
    transientAuthCleared;
    activeAction;
    activeNavigation;
    initialLandingIdentity;
    authLandingUrlSha256;
    authLandingNavigationSequence;
    initialNavigationConsumed;
    initialNavigationPredecessor;
    initialLandingEventCandidate;
    lastEvidence;
    lastEvidenceRawUrlSha256;
    lastObservedNodes;
    postAuthReadinessConfirmed;
    postAuthReadinessDeadlineMs;
    postAuthReadinessFingerprint;
    firstPostAuthCapturePending;
    calibrationBaseline;
    calibrationOpenState;
    calibrationBindings;
    calibrationNetworkActive;
    fixtureWorkerReserved;
    fixtureWorkerObserved;
    clerkAuthenticationAttempted;
    constructor(config, { startupBudgetMs = BROWSER_STARTUP_BUDGET_MS, findChromiumImpl = findChromium, spawnBrowserImpl = spawn, waitForDevToolsPortImpl = waitForDevToolsPort, fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
        if (!Number.isSafeInteger(startupBudgetMs) || startupBudgetMs <= 0 || startupBudgetMs > BROWSER_STARTUP_BUDGET_MS) {
            throw new Error("Browser startup budget is invalid");
        }
        this.config = config;
        this.startupBudgetMs = startupBudgetMs;
        this.findChromium = findChromiumImpl;
        this.spawnBrowser = spawnBrowserImpl;
        this.waitForDevToolsPort = waitForDevToolsPortImpl;
        this.fetch = fetchImpl;
        this.WebSocket = WebSocketImpl;
        this.runDirectory = config.run_directory;
        this.profileDirectory = config.profile_directory;
        this.allowedOrigins = new Set(config.allowed_request_origins);
        this.allowedNavigationOrigins = new Set(config.allowed_navigation_origins);
        this.suppressedOrigins = new Set(config.suppressed_request_origins ?? []);
        this.operationTimes = [];
        this.requestTimes = [];
        this.requestQueue = Promise.resolve();
        this.refs = new Map();
        this.currentUrl = "about:blank";
        this.eventSequence = 0;
        this.sessionTypes = new Map();
        this.sessionReady = new Map();
        this.redirectIds = new Set();
        this.effectRegistry = config.effect_registry ?? {};
        this.reversibleActionRegistry = config.reversible_action_registry ?? {};
        this.boundedOnboarding = config.runtime_mode === BOUNDED_ONBOARDING_MODE;
        this.boundedScopeHref = null;
        this.boundedScopeRawUrlSha256 = null;
        this.boundedScopeIdentity = null;
        this.boundedScopeComplete = false;
        this.boundedPostAuthStartPending = false;
        this.boundedPostAuthHandoff = null;
        this.boundedExpectedClerkUserId = null;
        this.boundedPostAuthResumeAttempted = false;
        this.boundedPrivateAuthStart = this.boundedOnboarding && Boolean(config.clerk_auth);
        // Bring-your-own-session: set only when the run carries a private saved-session binding
        // (path + hash) instead of clerk_auth. loadSavedSession() reads the raw file itself, once,
        // during start() -- its contents never travel any further than this trusted process.
        this.savedSessionConfig = config.saved_session ?? null;
        const privateIdentity = config.clerk_auth?.approved_disposable_identity;
        this.privateIdentityNeedles = this.boundedPrivateAuthStart &&
            typeof privateIdentity?.provider_user_id === "string" &&
            typeof privateIdentity?.username === "string"
            ? Object.freeze([privateIdentity.provider_user_id, privateIdentity.username])
            : null;
        this.boundedClickDispatchGeneration = 0;
        // Owner-declared, exact-URL allowance for the handful of same-origin mutations a
        // target fires automatically during the private-auth-start window, before any
        // session is bound. Keyed by "METHOD\nexact-href"; each entry's count is a
        // remaining budget that decrements on admission and denies at zero.
        this.authBootstrapAdmissions = new Map((config.auth_bootstrap_admissions ?? []).map((entry) => [
            `${entry.method}\n${entry.url}`,
            { id: entry.id, remaining: entry.maximum_count }
        ]));
        this.boundedPendingScopeExit = null;
        this.actionTokens = new Map();
        const operationDeadlineMs = config.operation_deadline_ms;
        this.absoluteDeadlineMs = typeof operationDeadlineMs === "number" && Number.isFinite(operationDeadlineMs) ? operationDeadlineMs : Date.now() + 60_000;
        this.calibrationEnabled = config.calibration_probe?.mode === CALIBRATION_MODE;
        this.calibrationGuard = {};
        this.clerkTransportPhase = null;
        this.activeClerkSessionId = null;
        this.clerkTransportAttempt = null;
        this.clerkBootstrapTransportDeadlineMs = null;
        this.provisionalClerkSessionId = null;
        this.provisionalClerkTouchCount = 0;
        this.networkInflight = new Set();
        this.routeBindingNetworkInflight = new Set();
        this.backgroundAbortTasks = new Set();
        this.backgroundAbortLatched = false;
        this.networkActivitySequence = 0;
        this.routeBindingNetworkActivitySequence = 0;
        this.lastNetworkActivityAt = 0;
        this.postAuthReadinessTimeoutMs = POST_AUTH_READINESS_TIMEOUT_MS;
        this.boundedRouteBindingTimeoutMs = AUTH_LANDING_TIMEOUT_MS;
        this.boundedRouteStableWindowMs = POST_AUTH_STABLE_WINDOW_MS;
        this.boundedRouteStableSamples = POST_AUTH_STABLE_SAMPLES;
        this.boundedRouteHopCap = POST_AUTH_NON_AUTH_HOP_CAP;
        this.boundedRouteFailurePoint = null;
        this.navigationSequence = 0;
        this.initialTopFrameLoadTimeoutMs = INITIAL_TOP_FRAME_LOAD_TIMEOUT_MS;
        this.logicalNavigationSequence = 0;
        this.topFrameId = null;
        this.topFrameLoaderId = null;
        this.lastTopNavigation = null;
        this.lastLogicalTopNavigation = null;
        this.lastTopLogicalLocation = null;
        this.topFrameLoadSequence = 0;
        this.pageLoadWaiters = new Set();
        this.clerkAuthenticator = new OneShotClerkPageAuthenticator({
            start: ({ ticket, expectedUserId, expectedCurrentHref }) => this.startClerkAuthentication(ticket, expectedUserId, expectedCurrentHref),
            inspect: () => this.inspectClerkAuthentication(),
            lock: () => this.lockClerkAuthenticationMethods()
        });
    }
    async start() {
        const startupDeadlineMs = Math.min(this.absoluteDeadlineMs, Date.now() + this.startupBudgetMs);
        if (!(this.boundedOnboarding && this.config.clerk_auth)) {
            const profileEntries = await readdir(this.profileDirectory);
            if (profileEntries.length !== 0)
                throw new Error("The exclusively created browser profile is not empty");
        }
        const existingRunFiles = await readdir(this.runDirectory);
        if (existingRunFiles.length !== 0)
            throw new Error("Run directory must be new and empty");
        await mkdir(join(this.runDirectory, "screenshots"), { recursive: true, mode: 0o700 });
        await appendJsonl(this.config.startup_log_path, { phase: "run-directory-ready", timestamp: isoNow() });
        const executable = await this.findChromium(this.config.chromium_executable ?? process.env.CHROMIUM_EXECUTABLE);
        this.executableIdentity = basename(executable);
        if (this.boundedOnboarding && this.config.clerk_auth) {
            await revalidateOwnedBrowserProfile(this.config.profile_ownership, { requireEmpty: true });
        }
        this.chrome = this.spawnBrowser(executable, [
            "--headless",
            "--remote-debugging-port=0",
            `--user-data-dir=${this.profileDirectory}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-sync",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-client-side-phishing-detection",
            "--disable-default-apps",
            "--disable-domain-reliability",
            "--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,Translate",
            "--disable-notifications",
            "--block-new-web-contents",
            "--password-store=basic",
            "--use-mock-keychain",
            "--noerrdialogs",
            "about:blank"
        ], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" }, stdio: ["ignore", "ignore", "pipe"] });
        this.chrome.stderr.setEncoding("utf8");
        this.chrome.stderr.on("data", () => { });
        this.chrome.once("error", () => this.cdp?.terminate(new Error("Browser process failed")));
        this.chrome.once("exit", () => this.cdp?.terminate(new Error("Browser process closed")));
        await appendJsonl(this.config.startup_log_path, { phase: "chromium-started", timestamp: isoNow() });
        const devtoolsFile = join(this.profileDirectory, "DevToolsActivePort");
        const port = await this.waitForDevToolsPort(devtoolsFile, { deadlineMs: startupDeadlineMs });
        const connectRemaining = startupDeadlineMs - Date.now();
        if (connectRemaining <= 0)
            throw new Error("Browser startup deadline reached");
        const version = await (await this.fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(connectRemaining)
        })).json();
        const debuggerUrl = version.webSocketDebuggerUrl;
        if (typeof debuggerUrl !== "string" || !debuggerUrl)
            throw new Error("Chromium did not publish its DevTools endpoint");
        const socket = new this.WebSocket(debuggerUrl);
        await new Promise((resolvePromise, reject) => {
            const timer = setTimeout(() => reject(new Error("CDP connection deadline reached")), connectRemaining);
            socket.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
            socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
            socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("CDP connection closed")); }, { once: true });
        });
        this.cdp = new CdpConnection(socket, {
            commandTimeoutMs: this.startupBudgetMs,
            absoluteDeadlineMs: startupDeadlineMs
        });
        await appendJsonl(this.config.startup_log_path, { phase: "cdp-connected", timestamp: isoNow() });
        this.cdp.onEvent((message) => this.onCdpEvent(message));
        await this.cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
        await this.cdp.send("Target.setDiscoverTargets", { discover: true });
        const targets = await this.cdp.send("Target.getTargets");
        const targetInfos = targets.targetInfos;
        const page = Array.isArray(targetInfos)
            ? targetInfos.find((target) => isRecord(target) && target.type === "page")
            : undefined;
        if (!page)
            throw new Error("Chromium did not create an initial page target");
        const pageTargetId = page.targetId;
        if (typeof pageTargetId !== "string" || !pageTargetId)
            throw new Error("Chromium did not create an initial page target");
        const attached = await this.cdp.send("Target.attachToTarget", { targetId: pageTargetId, flatten: true });
        const attachedSessionId = attached.sessionId;
        if (typeof attachedSessionId !== "string" || !attachedSessionId)
            throw new Error("Chromium did not attach to the initial page target");
        this.pageTargetId = pageTargetId;
        this.pageSessionId = attachedSessionId;
        this.sessionTypes.set(attachedSessionId, { targetId: pageTargetId, type: "page" });
        await this.configureSession(attachedSessionId, "page", false);
        await appendJsonl(this.config.startup_log_path, { phase: "page-configured", timestamp: isoNow() });
        await this.cdp.send("Target.setAutoAttach", {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
            filter: [{ type: "service_worker", exclude: false }, { exclude: true }]
        });
        await appendJsonl(this.config.startup_log_path, { phase: "auto-attach-configured", timestamp: isoNow() });
        if (this.savedSessionConfig) {
            await this.loadSavedSession();
            await appendJsonl(this.config.startup_log_path, { phase: "saved-session-loaded", timestamp: isoNow() });
        }
        this.cdp.setLimits({ commandTimeoutMs: CDP_COMMAND_TIMEOUT_MS, absoluteDeadlineMs: this.absoluteDeadlineMs });
    }
    // Polls the real navigation state until it stops changing (or plainly becomes a
    // sign-in-shaped URL, which exits early) instead of trusting a single fixed-delay read --
    // a client-side auth redirect on an unauthenticated visit can take a couple of seconds to
    // fire, well past the short pause the generic navigate handler already waited above.
    async waitForSavedSessionLanding(deadlineMs) {
        // Compares the FULL private navigation identity (entry/frame/loader/sequence), not just
        // the URL string: a real app can keep issuing same-URL history churn (an internal
        // replaceState as async data resolves) well after the visible URL looks settled, and the
        // caller freezes this exact identity as the bound route's scope -- so it must actually be
        // the last one, not just the same-looking one.
        let previous = null;
        let stableSamples = 0;
        let snapshot = await this.privateNavigationSnapshot();
        while (Date.now() < deadlineMs) {
            if (isAuthFlowUrl(snapshot.exactUrl))
                return snapshot;
            if (previous && this.samePrivateNavigation(snapshot, previous)) {
                stableSamples += 1;
                if (stableSamples >= 4)
                    return snapshot;
            }
            else {
                stableSamples = 0;
            }
            previous = snapshot;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
            snapshot = await this.privateNavigationSnapshot();
        }
        return snapshot;
    }
    // Bring-your-own-session: reads the private saved-session file directly (this trusted
    // broker process is its only reader) and seeds the isolated browser profile with its
    // cookies and per-origin storage before any exploration begins. Never writes the file's
    // content anywhere -- not to a log, not to cap state, not back to disk. Whether it actually
    // authenticated anything is checked later, against the real first navigation, not here.
    async loadSavedSession() {
        const bound = this.savedSessionConfig;
        if (!bound)
            throw new Error("saved_session_unreadable: the saved session file could not be read");
        let raw;
        try {
            raw = await readFile(bound.path);
        }
        catch {
            throw new Error("saved_session_unreadable: the saved session file could not be read");
        }
        if (sha256Text(raw) !== bound.sha256)
            throw new Error("saved_session_hash_mismatch: the saved session file changed after preparation");
        let session;
        try {
            session = JSON.parse(raw.toString("utf8"));
        }
        catch {
            throw new Error("saved_session_invalid: the saved session file is not valid JSON");
        }
        const cookiesSource = session.cookies;
        const originStorageSource = session.origin_storage;
        if (!session || typeof session !== "object" || !Array.isArray(cookiesSource) || (originStorageSource !== undefined && !Array.isArray(originStorageSource))) {
            throw new Error("saved_session_invalid: the saved session file has an unexpected shape");
        }
        const cookies = cookiesSource.map((cookie) => {
            const fields = isRecord(cookie) ? cookie : {};
            return {
                name: fields.name,
                value: fields.value,
                domain: fields.domain,
                path: typeof fields.path === "string" && fields.path ? fields.path : "/",
                expires: fields.expires,
                httpOnly: Boolean(fields.httpOnly),
                secure: Boolean(fields.secure),
                ...(typeof fields.sameSite === "string" ? { sameSite: fields.sameSite } : {})
            };
        });
        if (cookies.some((cookie) => typeof cookie.name !== "string" || !cookie.name || typeof cookie.value !== "string" || typeof cookie.domain !== "string" || !cookie.domain)) {
            throw new Error("saved_session_invalid: a captured cookie is missing a required field");
        }
        const originStorage = Array.isArray(originStorageSource) ? originStorageSource : [];
        if (cookies.length === 0 && originStorage.length === 0)
            throw new Error("saved_session_invalid: the saved session contains no cookies or storage");
        const nowSeconds = Date.now() / 1000;
        // CDP expiry is seconds since epoch, or a negative/absent value for a session-only cookie
        // (never expired by clock, only by browser close). A cookie is "live" if it is session-only
        // or its expiry has not yet passed.
        const hasLiveCookie = cookies.some((cookie) => {
            const expires = cookie.expires;
            return typeof expires !== "number" || !Number.isFinite(expires) || expires < 0 || expires > nowSeconds;
        });
        if (cookies.length > 0 && !hasLiveCookie)
            throw new Error("saved_session_expired: every captured cookie has already expired");
        if (cookies.length > 0)
            await this.cdp.send("Network.setCookies", { cookies }, this.pageSessionId);
        for (const entry of originStorage) {
            if (!isRecord(entry) || typeof entry.origin !== "string")
                throw new Error("saved_session_invalid: an origin-storage entry is missing its origin");
            let origin;
            try {
                origin = new URL(entry.origin).origin;
            }
            catch {
                throw new Error("saved_session_invalid: an origin-storage entry has an invalid origin");
            }
            const local = entry.local_storage && typeof entry.local_storage === "object" ? entry.local_storage : {};
            const session_ = entry.session_storage && typeof entry.session_storage === "object" ? entry.session_storage : {};
            // Registered once per origin-storage entry; it re-runs (idempotently) on every future
            // navigation to that origin for the life of this browser process, which is harmless --
            // the same values are simply set again before the page's own scripts run.
            await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
                source: `if (location.origin === ${JSON.stringify(origin)}) { const seed = (storage, values) => { for (const key of Object.keys(values)) { try { storage.setItem(key, String(values[key])); } catch {} } }; seed(localStorage, ${JSON.stringify(local)}); seed(sessionStorage, ${JSON.stringify(session_)}); }`
            }, this.pageSessionId);
        }
    }
    async installTransientAuth(request) {
        if (this.transientAuthInstalled)
            return refusal("transient_auth_already_consumed", "Transient authentication can be installed only once");
        const policy = this.config.transient_auth;
        const sentinel = request?.sentinel;
        if (policy?.mode !== "header" ||
            policy.origin !== normalizeOrigin(this.config.initial_url) ||
            this.allowedOrigins.size !== 1 ||
            typeof policy.origin !== "string" ||
            !this.allowedOrigins.has(policy.origin) ||
            typeof policy.header_name !== "string" ||
            !/^[a-z][a-z0-9-]{0,63}$/.test(policy.header_name) ||
            typeof sentinel !== "string" ||
            sentinel.length < 16 ||
            sentinel.length > 512 ||
            /[\r\n]/.test(sentinel))
            return refusal("transient_auth_invalid", "Transient authentication did not match the supervisor policy");
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        await this.cdp.send("Network.setExtraHTTPHeaders", { headers: { [policy.header_name]: sentinel } }, this.pageSessionId);
        this.transientAuthInstalled = true;
        return { ok: true, consumed: true };
    }
    async clearTransientAuth() {
        if (!this.transientAuthInstalled || this.transientAuthCleared)
            return refusal("transient_auth_not_active", "Transient authentication is not active");
        await this.cdp.send("Network.setExtraHTTPHeaders", { headers: {} }, this.pageSessionId);
        this.transientAuthCleared = true;
        return { ok: true, cleared: true };
    }
    async callPageFunction(functionDeclaration, values = [], effectful = false) {
        if (effectful)
            this.assertEffectfulAdmissionOpen();
        const root = await this.cdp.send("Runtime.evaluate", { expression: "globalThis", returnByValue: false }, this.pageSessionId);
        const rootResult = isRecord(root.result) ? root.result : null;
        const rootObjectId = rootResult?.objectId;
        if (!rootObjectId)
            throw new Error("The page JavaScript context is unavailable");
        if (effectful)
            this.assertEffectfulAdmissionOpen();
        const response = await this.cdp.send("Runtime.callFunctionOn", {
            objectId: rootObjectId,
            functionDeclaration,
            arguments: values.map((value) => ({ value })),
            awaitPromise: true,
            returnByValue: true
        }, this.pageSessionId);
        if (response.exceptionDetails)
            throw new Error("The page rejected Clerk authentication");
        const responseResult = isRecord(response.result) ? response.result : null;
        return responseResult?.value;
    }
    async startClerkAuthentication(ticket, expectedUserId, expectedCurrentHref) {
        const attempt = this.clerkTransportAttempt;
        if (!attempt)
            return { failure_stage: "precondition_failed" };
        this.clerkTransportPhase = "bootstrap";
        if (this.backgroundAbortLatched)
            return { failure_stage: "precondition_failed" };
        const exchange = await this.callPageFunction(CLERK_PAGE_FUNCTIONS.start, [ticket, expectedUserId, expectedCurrentHref], true);
        if (this.clerkTransportAttempt !== attempt)
            return { failure_stage: "precondition_failed" };
        if (isRecord(exchange) && "failure_stage" in exchange)
            return exchange;
        const createdSessionId = isRecord(exchange) ? exchange.created_session_id : undefined;
        if (typeof createdSessionId !== "string" || !/^[A-Za-z0-9_-]{4,256}$/.test(createdSessionId))
            return { failure_stage: "session_missing" };
        const continuation = await this.admitPrivateAuthContinuation();
        if (!continuation.ok || this.clerkTransportAttempt !== attempt)
            return { failure_stage: "precondition_failed" };
        if (this.provisionalClerkSessionId !== null && this.provisionalClerkSessionId !== createdSessionId) {
            return { failure_stage: "session_mismatch" };
        }
        this.activeClerkSessionId = createdSessionId;
        this.clerkTransportPhase = "activating";
        if (this.backgroundAbortLatched)
            return { failure_stage: "precondition_failed" };
        const activated = await this.callPageFunction(CLERK_PAGE_FUNCTIONS.activate, [createdSessionId, expectedUserId], true);
        if (this.clerkTransportAttempt !== attempt)
            return { failure_stage: "precondition_failed" };
        return isRecord(activated) ? activated : null;
    }
    inspectClerkAuthentication() {
        return this.callPageFunction(CLERK_PAGE_FUNCTIONS.inspect).then((value) => (isRecord(value) ? value : null));
    }
    assertEffectfulAdmissionOpen() {
        if (!this.backgroundAbortLatched)
            return;
        throw new BackgroundAbortError("The browser run is not live");
    }
    async lockClerkAuthenticationMethods() {
        const result = await this.callPageFunction(CLERK_PAGE_FUNCTIONS.lock);
        if (!isRecord(result) || result.locked !== true)
            throw new Error("The page Clerk methods could not be locked");
    }
    async privateNavigationSnapshot() {
        const history = await this.cdp.send("Page.getNavigationHistory", {}, this.pageSessionId);
        const rawIndex = history.currentIndex;
        const rawEntries = history.entries;
        const safeEntries = Array.isArray(rawEntries) ? rawEntries : [];
        const safeIndex = typeof rawIndex === "number" && Number.isSafeInteger(rawIndex) ? rawIndex : -1;
        const current = safeIndex >= 0 ? safeEntries[safeIndex] : null;
        const currentFields = isRecord(current) ? current : null;
        const exactUrl = currentFields?.url;
        const entryId = currentFields?.id;
        const frameId = this.topFrameId;
        const loaderId = this.topFrameLoaderId;
        if (typeof exactUrl !== "string" ||
            !exactUrl ||
            typeof entryId !== "number" ||
            !Number.isSafeInteger(entryId) ||
            typeof frameId !== "string" ||
            !frameId ||
            typeof loaderId !== "string" ||
            !Number.isSafeInteger(this.navigationSequence) ||
            !Number.isSafeInteger(this.logicalNavigationSequence))
            throw new Error("The private navigation identity is unavailable");
        const predecessor = safeIndex > 0 ? safeEntries[safeIndex - 1] : null;
        const twoBack = safeIndex > 1 ? safeEntries[safeIndex - 2] : null;
        const predecessorFields = isRecord(predecessor) ? predecessor : null;
        const twoBackFields = isRecord(twoBack) ? twoBack : null;
        const predecessorId = predecessorFields?.id;
        const predecessorUrl = predecessorFields?.url;
        const twoBackId = twoBackFields?.id;
        const twoBackUrl = twoBackFields?.url;
        return {
            exactUrl,
            entryId,
            entryIndex: safeIndex,
            entryCount: safeEntries.length,
            predecessorId: typeof predecessorId === "number" && Number.isSafeInteger(predecessorId) ? predecessorId : null,
            predecessorUrl: typeof predecessorUrl === "string" ? predecessorUrl : null,
            twoBackId: typeof twoBackId === "number" && Number.isSafeInteger(twoBackId) ? twoBackId : null,
            twoBackUrl: typeof twoBackUrl === "string" ? twoBackUrl : null,
            frameId,
            loaderId,
            sequence: this.navigationSequence,
            logicalSequence: this.logicalNavigationSequence
        };
    }
    samePrivateNavigation(left, right) {
        return Boolean(left &&
            right &&
            left.exactUrl === right.exactUrl &&
            left.entryId === right.entryId &&
            left.entryIndex === right.entryIndex &&
            left.entryCount === right.entryCount &&
            left.predecessorId === right.predecessorId &&
            left.predecessorUrl === right.predecessorUrl &&
            left.twoBackId === right.twoBackId &&
            left.twoBackUrl === right.twoBackUrl &&
            left.frameId === right.frameId &&
            left.loaderId === right.loaderId &&
            left.sequence === right.sequence &&
            left.logicalSequence === right.logicalSequence);
    }
    sameCurrentPrivateNavigation(snapshot) {
        return Boolean(snapshot &&
            this.lastTopLogicalLocation?.urlSha256 === sha256Text(snapshot.exactUrl) &&
            this.lastTopLogicalLocation.frameId === snapshot.frameId &&
            this.lastTopLogicalLocation.loaderId === snapshot.loaderId &&
            this.topFrameId === snapshot.frameId &&
            this.topFrameLoaderId === snapshot.loaderId &&
            this.navigationSequence === snapshot.sequence &&
            this.logicalNavigationSequence === snapshot.logicalSequence);
    }
    samePrivateLogicalNavigation(left, right) {
        return Boolean(left &&
            right &&
            left.exactUrl === right.exactUrl &&
            left.entryId === right.entryId &&
            left.entryIndex === right.entryIndex &&
            left.entryCount === right.entryCount &&
            left.predecessorId === right.predecessorId &&
            left.predecessorUrl === right.predecessorUrl &&
            left.twoBackId === right.twoBackId &&
            left.twoBackUrl === right.twoBackUrl &&
            left.frameId === right.frameId &&
            left.loaderId === right.loaderId &&
            left.logicalSequence === right.logicalSequence);
    }
    sameAdmittedAuthTransit(left, right) {
        try {
            if (!left || !right)
                return false;
            return Boolean(isAuthFlowUrl(left.exactUrl) &&
                isAuthFlowUrl(right.exactUrl) &&
                this.samePrivateLogicalNavigation(left, right));
        }
        catch {
            return false;
        }
    }
    nextPrivateLogicalNavigation(left, right) {
        if (!left ||
            !right ||
            left.exactUrl === right.exactUrl ||
            left.frameId !== right.frameId ||
            right.logicalSequence !== left.logicalSequence + 1 ||
            right.sequence <= left.sequence)
            return false;
        const replacedCurrentEntry = right.entryId === left.entryId &&
            right.entryIndex === left.entryIndex &&
            right.entryCount === left.entryCount &&
            right.predecessorId === left.predecessorId &&
            right.predecessorUrl === left.predecessorUrl &&
            right.twoBackId === left.twoBackId &&
            right.twoBackUrl === left.twoBackUrl;
        const appendedEntry = right.entryIndex === left.entryIndex + 1 &&
            right.entryCount === left.entryCount + 1 &&
            right.predecessorId === left.entryId &&
            right.predecessorUrl === left.exactUrl &&
            right.twoBackId === left.predecessorId &&
            right.twoBackUrl === left.predecessorUrl;
        return replacedCurrentEntry || appendedEntry;
    }
    noteBoundedRouteFailure(point) {
        // The points table maps every point to itself, so admitting the key admits its value.
        if (Object.hasOwn(CLERK_BOUNDED_ROUTE_FAILURE_POINTS, point)) {
            this.boundedRouteFailurePoint = point;
        }
        return null;
    }
    advanceBoundedRouteChain(chain, sample) {
        if (!chain?.last) {
            this.noteBoundedRouteFailure("route_lineage");
            return false;
        }
        if (this.samePrivateLogicalNavigation(chain.last, sample)) {
            chain.last = sample;
            return true;
        }
        if (!this.nextPrivateLogicalNavigation(chain.last, sample)) {
            this.noteBoundedRouteFailure("route_lineage");
            return false;
        }
        chain.hops += 1;
        if (chain.hops > this.boundedRouteHopCap) {
            this.noteBoundedRouteFailure("route_hop_limit");
            return false;
        }
        chain.last = sample;
        return true;
    }
    isExactLanding(snapshot, sequence = this.authLandingNavigationSequence) {
        if (this.boundedOnboarding && this.boundedScopeIdentity) {
            return this.samePrivateNavigation(snapshot, this.boundedScopeIdentity);
        }
        if (this.boundedOnboarding && !this.config.clerk_auth && this.boundedScopeHref) {
            if (!snapshot)
                return false;
            return Boolean(snapshot.exactUrl === this.boundedScopeHref && normalizeOrigin(snapshot.exactUrl) === normalizeOrigin(this.config.initial_url));
        }
        const landing = this.initialLandingIdentity;
        if (!landing || !snapshot)
            return false;
        return Boolean(snapshot.exactUrl === landing.exactUrl &&
            snapshot.entryId === landing.entryId &&
            snapshot.entryIndex === landing.entryIndex &&
            snapshot.frameId === landing.frameId &&
            snapshot.loaderId === landing.loaderId &&
            snapshot.logicalSequence === sequence);
    }
    matchesClerkTransitContract(rawUrl, landingUrl) {
        let transit;
        let landing;
        try {
            transit = new URL(rawUrl);
            landing = new URL(landingUrl);
        }
        catch {
            return false;
        }
        const pairs = [...transit.searchParams.entries()];
        if (transit.origin !== landing.origin ||
            transit.origin !== normalizeOrigin(this.config.initial_url) ||
            transit.username ||
            transit.password ||
            transit.pathname !== "/sign-in" ||
            rawUrl.includes("#") ||
            pairs.length !== 1 ||
            pairs[0][0] !== "next")
            return false;
        const next = pairs[0][1];
        if (!next.startsWith("/") || next.startsWith("//"))
            return false;
        try {
            const destination = new URL(next, landing.origin);
            return destination.origin === landing.origin && !isAuthFlowUrl(destination.href) && destination.href === landing.href;
        }
        catch {
            return false;
        }
    }
    bindInitialLanding(snapshot) {
        if (this.initialLandingIdentity)
            return this.isExactLanding(snapshot, this.initialLandingIdentity.sequence);
        if (!snapshot)
            return false;
        let origin;
        try {
            origin = normalizeOrigin(snapshot.exactUrl);
        }
        catch {
            return false;
        }
        if (!this.initialNavigationConsumed ||
            !snapshot.loaderId ||
            origin !== normalizeOrigin(this.config.initial_url) ||
            !this.allowedNavigationOrigins.has(origin) ||
            isAuthFlowUrl(snapshot.exactUrl))
            return false;
        this.initialLandingIdentity = Object.freeze({
            exactUrl: snapshot.exactUrl,
            entryId: snapshot.entryId,
            entryIndex: snapshot.entryIndex,
            frameId: snapshot.frameId,
            loaderId: snapshot.loaderId,
            sequence: snapshot.logicalSequence
        });
        return true;
    }
    initialAuthHistoryShape(snapshot, landingUrl) {
        const predecessor = this.initialNavigationPredecessor;
        if (!predecessor ||
            predecessor.entryIndex !== predecessor.entryCount - 1 ||
            snapshot.entryIndex !== snapshot.entryCount - 1)
            return null;
        const replaced = snapshot.entryIndex === predecessor.entryIndex + 1 &&
            snapshot.entryCount === predecessor.entryCount + 1 &&
            snapshot.entryId !== predecessor.entryId &&
            snapshot.predecessorId === predecessor.entryId &&
            snapshot.predecessorUrl === predecessor.exactUrl;
        if (replaced)
            return "replace";
        const pushed = this.initialLandingEventCandidate?.sameUrlHistoryApiNotifications === 0 &&
            snapshot.entryIndex === predecessor.entryIndex + 2 &&
            snapshot.entryCount === predecessor.entryCount + 2 &&
            snapshot.entryId !== snapshot.predecessorId &&
            snapshot.predecessorId !== null &&
            snapshot.predecessorUrl === landingUrl &&
            snapshot.twoBackId === predecessor.entryId &&
            snapshot.twoBackUrl === predecessor.exactUrl;
        return pushed ? "push" : null;
    }
    deriveInitialLandingFromAuthTransit(snapshot) {
        if (this.initialLandingIdentity)
            return true;
        const candidate = this.initialLandingEventCandidate;
        const predecessor = this.initialNavigationPredecessor;
        if (!candidate ||
            !predecessor ||
            snapshot.frameId !== candidate.frameId ||
            snapshot.loaderId !== candidate.loaderId ||
            snapshot.logicalSequence !== candidate.sequence + 1 ||
            this.lastLogicalTopNavigation?.kind !== "same-document" ||
            this.lastLogicalTopNavigation.sequence !== snapshot.logicalSequence ||
            this.lastLogicalTopNavigation.navigationType !== "historyApi" ||
            !this.matchesClerkTransitContract(snapshot.exactUrl, candidate.exactUrl))
            return false;
        const historyShape = this.initialAuthHistoryShape(snapshot, candidate.exactUrl);
        if (!historyShape)
            return false;
        this.initialLandingIdentity = Object.freeze({
            exactUrl: candidate.exactUrl,
            entryId: historyShape === "push" ? snapshot.predecessorId : snapshot.entryId,
            entryIndex: historyShape === "push" ? snapshot.entryIndex - 1 : snapshot.entryIndex,
            frameId: candidate.frameId,
            loaderId: candidate.loaderId,
            sequence: candidate.sequence
        });
        return true;
    }
    privateInitialAuthHandoff(snapshot) {
        try {
            if (!snapshot || !isAuthFlowUrl(snapshot.exactUrl))
                return false;
            if (!this.deriveInitialLandingFromAuthTransit(snapshot))
                return false;
            return this.admitPrivateClerkLocation(snapshot)?.kind === "transit";
        }
        catch {
            return false;
        }
    }
    clearUnretainedObservation() {
        this.refs.clear();
        this.lastObservedNodes = [];
    }
    admitPrivateClerkLocation(snapshot) {
        const landing = this.initialLandingIdentity;
        if (!landing || snapshot.frameId !== landing.frameId || snapshot.loaderId !== landing.loaderId)
            return null;
        if (this.isExactLanding(snapshot, landing.sequence)) {
            return { kind: "direct", exactCurrentHref: snapshot.exactUrl, sequence: snapshot.logicalSequence, navigation: snapshot };
        }
        let exactAuthTransit = false;
        try {
            exactAuthTransit = isAuthFlowUrl(snapshot.exactUrl) && this.matchesClerkTransitContract(snapshot.exactUrl, landing.exactUrl);
        }
        catch { }
        if (!exactAuthTransit ||
            snapshot.logicalSequence !== landing.sequence + 1 ||
            this.lastLogicalTopNavigation?.kind !== "same-document" ||
            this.lastLogicalTopNavigation.sequence !== snapshot.logicalSequence ||
            this.lastLogicalTopNavigation.navigationType !== "historyApi")
            return null;
        const historyShape = this.initialAuthHistoryShape(snapshot, landing.exactUrl);
        const pushed = historyShape === "push" &&
            snapshot.entryIndex === landing.entryIndex + 1 &&
            snapshot.entryId !== landing.entryId &&
            snapshot.predecessorId === landing.entryId &&
            snapshot.predecessorUrl === landing.exactUrl;
        const replaced = historyShape === "replace" && snapshot.entryIndex === landing.entryIndex && snapshot.entryId === landing.entryId;
        return pushed || replaced
            ? { kind: "transit", exactCurrentHref: snapshot.exactUrl, sequence: snapshot.logicalSequence, navigation: snapshot }
            : null;
    }
    async confirmPrivateAuthLanding(admission) {
        const deadline = Math.min(this.absoluteDeadlineMs, Date.now() + AUTH_LANDING_TIMEOUT_MS);
        const expectedLandingSequence = admission.kind === "direct" ? admission.sequence : admission.sequence + 1;
        while (Date.now() < deadline) {
            let snapshot;
            try {
                snapshot = await this.privateNavigationSnapshot();
            }
            catch {
                return null;
            }
            if (this.isExactLanding(snapshot, expectedLandingSequence)) {
                const remaining = deadline - Date.now();
                if (remaining < AUTH_LANDING_SETTLE_MS)
                    return null;
                await new Promise((resolvePromise) => setTimeout(resolvePromise, AUTH_LANDING_SETTLE_MS));
                try {
                    const stable = await this.privateNavigationSnapshot();
                    return this.isExactLanding(stable, expectedLandingSequence) ? stable : null;
                }
                catch {
                    return null;
                }
            }
            const stillAtAdmittedTransit = admission.kind === "transit" &&
                this.samePrivateLogicalNavigation(snapshot, admission.navigation);
            if (!stillAtAdmittedTransit)
                return null;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(25, deadline - Date.now())));
        }
        return null;
    }
    async settleBeforeRouteDeadline(deadline, operation) {
        if (!Number.isFinite(deadline) || Date.now() >= deadline)
            return { ok: false };
        let timer;
        const settled = Promise.resolve()
            .then(operation)
            .then((value) => ({ ok: true, value }), () => ({ ok: false }));
        const expired = new Promise((resolvePromise) => {
            timer = setTimeout(() => resolvePromise({ ok: false }), Math.max(1, deadline - Date.now()));
        });
        try {
            return await Promise.race([settled, expired]);
        }
        finally {
            clearTimeout(timer);
        }
    }
    routeBindingRequestRelevant(rawUrl) {
        try {
            return typeof rawUrl === "string" && !this.suppressedOrigins.has(normalizeOrigin(rawUrl));
        }
        catch {
            return true;
        }
    }
    async admitPrivateRouteState(deadline, { sealNetwork = false } = {}) {
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        const initialDrain = await this.settleBeforeRouteDeadline(deadline, () => this.drainBackgroundAbortTasks());
        if (!initialDrain.ok || this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        const networkActivitySequence = this.routeBindingNetworkActivitySequence;
        const pendingRequests = this.requestQueue;
        const requestsSettled = await this.settleBeforeRouteDeadline(deadline, () => pendingRequests);
        if (!requestsSettled.ok || this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        const finalDrain = await this.settleBeforeRouteDeadline(deadline, () => this.drainBackgroundAbortTasks());
        if (!finalDrain.ok || this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        const loaded = await this.settleBeforeRouteDeadline(deadline, () => this.loadState());
        if (!loaded.ok || this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        const state = loaded.value;
        if (isRecord(state) && state.abort)
            return refusal("run_aborted", "The browser run is not live");
        const workingDayDeadline = isRecord(state) && typeof state.working_day_deadline === "string" ? Date.parse(state.working_day_deadline) : NaN;
        if (!Number.isFinite(workingDayDeadline) ||
            Date.now() >= workingDayDeadline ||
            Date.now() >= this.absoluteDeadlineMs)
            return refusal("working_day_deadline", "Working-day deadline reached");
        if (!this.boundedCapsValid(state))
            return refusal("run_aborted", "The browser run is not live");
        if (sealNetwork &&
            (networkActivitySequence !== this.routeBindingNetworkActivitySequence ||
                this.routeBindingNetworkInflight.size !== 0 ||
                this.backgroundAbortTasks.size !== 0))
            return refusal("route_seal_raced", "The authenticated route proof must be retried");
        return { ok: true, network_activity_sequence: networkActivitySequence };
    }
    async confirmBoundedOnboardingScope(deadline, { initialSample = null, chain = { hops: 0 } } = {}) {
        if (!Number.isFinite(deadline))
            return null;
        let admittedTransit = null;
        let candidate = null;
        let pendingSample = initialSample;
        let stableSamples = 0;
        let stableSince = null;
        while (Date.now() < deadline) {
            if (this.activeNavigation)
                return this.noteBoundedRouteFailure("route_admission");
            const continuation = await this.admitPrivateRouteState(deadline);
            if (!continuation.ok || Date.now() >= deadline)
                return this.noteBoundedRouteFailure("route_admission");
            const sampled = pendingSample
                ? { ok: true, value: pendingSample }
                : await this.settleBeforeRouteDeadline(deadline, () => this.privateNavigationSnapshot());
            pendingSample = null;
            if (!sampled.ok || Date.now() >= deadline)
                return this.noteBoundedRouteFailure("route_admission");
            const sample = sampled.value;
            let sameOrigin = false;
            try {
                sameOrigin = normalizeOrigin(sample.exactUrl) === normalizeOrigin(this.config.initial_url);
            }
            catch { }
            if (!sameOrigin)
                return this.noteBoundedRouteFailure("route_off_origin");
            if (isAuthFlowUrl(sample.exactUrl)) {
                const transit = this.admitPrivateClerkLocation(sample);
                let returnedToAuth = Boolean(candidate || chain.hops > 0);
                try {
                    returnedToAuth ||= Boolean(chain.last && !isAuthFlowUrl(chain.last.exactUrl));
                }
                catch { }
                if (returnedToAuth ||
                    this.boundedPostAuthHandoff?.kind !== "transit" ||
                    transit?.kind !== "transit" ||
                    !this.sameAdmittedAuthTransit(this.boundedPostAuthHandoff.navigation, sample) ||
                    (admittedTransit && !this.sameAdmittedAuthTransit(admittedTransit, sample)))
                    return this.noteBoundedRouteFailure(returnedToAuth ? "route_returned_to_auth" : "auth_transit_lineage");
                admittedTransit ??= sample;
                chain.last = sample;
                await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, Math.min(25, deadline - Date.now()))));
                continue;
            }
            const sameLogicalCandidate = candidate && this.samePrivateLogicalNavigation(candidate, sample);
            if (!this.advanceBoundedRouteChain(chain, sample))
                return null;
            if (candidate && !sameLogicalCandidate) {
                candidate = sample;
                stableSamples = 0;
                stableSince = null;
            }
            else if (candidate && !this.samePrivateNavigation(candidate, sample)) {
                candidate = sample;
                stableSamples = 0;
                stableSince = null;
            }
            if (!candidate) {
                candidate = sample;
                stableSamples = 0;
                stableSince = null;
            }
            stableSamples += 1;
            stableSince ??= Date.now();
            if (stableSamples >= this.boundedRouteStableSamples &&
                Date.now() - stableSince >= this.boundedRouteStableWindowMs) {
                const finalSnapshot = await this.settleBeforeRouteDeadline(deadline, () => this.privateNavigationSnapshot());
                if (!finalSnapshot.ok || Date.now() >= deadline)
                    return this.noteBoundedRouteFailure("route_admission");
                const final = finalSnapshot.value;
                if (!this.samePrivateLogicalNavigation(candidate, final)) {
                    let finalSameOrigin = false;
                    try {
                        finalSameOrigin = normalizeOrigin(final.exactUrl) === normalizeOrigin(this.config.initial_url);
                    }
                    catch { }
                    if (!finalSameOrigin)
                        return this.noteBoundedRouteFailure("route_off_origin");
                    if (isAuthFlowUrl(final.exactUrl))
                        return this.noteBoundedRouteFailure("route_returned_to_auth");
                    if (!this.advanceBoundedRouteChain(chain, final))
                        return null;
                    candidate = final;
                    stableSamples = 0;
                    stableSince = null;
                    continue;
                }
                if (!this.samePrivateNavigation(candidate, final)) {
                    candidate = final;
                    stableSamples = 0;
                    stableSince = null;
                    continue;
                }
                if (!this.sameCurrentPrivateNavigation(final))
                    continue;
                return Object.freeze(final);
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, Math.min(25, deadline - Date.now()))));
        }
        return this.noteBoundedRouteFailure("route_stability_timeout");
    }
    async finalizeBoundedRouteBinding(candidate, deadline) {
        if (!Number.isFinite(deadline) || Date.now() >= deadline)
            return null;
        const beforeSnapshot = await this.admitPrivateRouteState(deadline, { sealNetwork: true });
        if (!beforeSnapshot.ok || Date.now() >= deadline)
            return null;
        const spanningNetworkSequence = beforeSnapshot.network_activity_sequence;
        const sealedSnapshot = await this.settleBeforeRouteDeadline(deadline, () => this.privateNavigationSnapshot());
        if (!sealedSnapshot.ok || Date.now() >= deadline)
            return null;
        const sealed = sealedSnapshot.value;
        if (Date.now() >= deadline || !this.samePrivateNavigation(candidate, sealed))
            return null;
        const finalAdmission = await this.admitPrivateRouteState(deadline, { sealNetwork: true });
        if (!finalAdmission.ok ||
            Date.now() >= deadline ||
            spanningNetworkSequence !== finalAdmission.network_activity_sequence ||
            spanningNetworkSequence !== this.routeBindingNetworkActivitySequence ||
            this.routeBindingNetworkInflight.size !== 0 ||
            this.backgroundAbortTasks.size !== 0 ||
            this.backgroundAbortLatched ||
            !this.sameCurrentPrivateNavigation(sealed))
            return null;
        return Object.freeze(sealed);
    }
    async confirmBoundedScopeExit() {
        let first;
        try {
            first = await this.privateNavigationSnapshot();
        }
        catch {
            return null;
        }
        const scopeHref = this.boundedScopeHref;
        if (!this.boundedOnboarding || first.exactUrl === scopeHref || isAuthFlowUrl(first.exactUrl) || normalizeOrigin(first.exactUrl) !== normalizeOrigin(typeof scopeHref === "string" ? scopeHref : ""))
            return null;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, AUTH_LANDING_SETTLE_MS));
        try {
            const final = await this.privateNavigationSnapshot();
            return this.samePrivateNavigation(first, final) ? Object.freeze(final) : null;
        }
        catch {
            return null;
        }
    }
    async boundedScopeIsCurrent() {
        if (!this.boundedOnboarding || this.boundedScopeComplete)
            return false;
        try {
            const snapshot = await this.privateNavigationSnapshot();
            if (this.boundedScopeIdentity)
                return this.samePrivateNavigation(snapshot, this.boundedScopeIdentity);
            return !this.config.clerk_auth && snapshot.exactUrl === this.boundedScopeHref && sha256Text(snapshot.exactUrl) === this.boundedScopeRawUrlSha256;
        }
        catch {
            return false;
        }
    }
    waitForTopFrameLoad(afterSequence) {
        if (this.topFrameLoadSequence > afterSequence)
            return Promise.resolve();
        const remaining = Math.min(this.initialTopFrameLoadTimeoutMs, this.absoluteDeadlineMs - Date.now());
        if (remaining <= 0)
            return Promise.reject(new Error("The initial page load deadline was reached"));
        return new Promise((resolvePromise, rejectPromise) => {
            let timer;
            const finish = (error = null) => {
                clearTimeout(timer);
                this.pageLoadWaiters.delete(finish);
                if (error)
                    rejectPromise(error);
                else
                    resolvePromise();
            };
            timer = setTimeout(() => finish(new Error("The initial page load deadline was reached")), remaining);
            this.pageLoadWaiters.add(finish);
        });
    }
    async waitForClerkReadiness(deadline = this.absoluteDeadlineMs) {
        const remaining = Math.max(0, Math.min(CLERK_READY_TIMEOUT_MS, deadline - Date.now(), this.absoluteDeadlineMs - Date.now()));
        return this.callPageFunction(CLERK_PAGE_FUNCTIONS.ready, [remaining]);
    }
    async lockClerkAfterPreTicketFailure() {
        try {
            await this.clerkAuthenticator.lockMethods();
        }
        catch { }
    }
    async inspectClerkPreAuth() {
        const policy = this.config.clerk_auth;
        if (!this.boundedOnboarding ||
            policy?.mode !== "one-use-ticket" ||
            this.clerkAuthenticationAttempted ||
            !this.initialNavigationConsumed ||
            !this.initialLandingIdentity)
            return refusal("clerk_auth_policy_mismatch", "Clerk authentication is not admitted in the current browser state");
        let admission = null;
        try {
            admission = this.admitPrivateClerkLocation(await this.privateNavigationSnapshot());
        }
        catch { }
        if (!admission)
            return refusal("clerk_auth_policy_mismatch", "Clerk authentication is not admitted in the current browser state");
        let state;
        try {
            const ready = await this.waitForClerkReadiness();
            state = ready === true
                ? await this.callPageFunction(CLERK_PAGE_FUNCTIONS.preAuth)
                : null;
        }
        catch { }
        const continuation = await this.admitPrivateAuthContinuation();
        let finalAdmission = null;
        if (continuation.ok) {
            try {
                finalAdmission = this.admitPrivateClerkLocation(await this.privateNavigationSnapshot());
            }
            catch { }
        }
        const finallyAdmitted = continuation.ok === true && finalAdmission !== null && !this.backgroundAbortLatched;
        const stateFields = isRecord(state) ? state : null;
        return {
            ok: finallyAdmitted,
            clerk_ready: stateFields?.clerk_ready === true,
            signed_out: stateFields?.signed_out === true,
            session_absent: stateFields?.session_absent === true,
            sign_in_clean: stateFields?.sign_in_clean === true,
            caps_valid: finallyAdmitted
        };
    }
    async authenticateClerkTicket(request) {
        const policy = this.config.clerk_auth;
        if (policy?.mode !== "one-use-ticket" ||
            typeof policy.frontend_api_origin !== "string" ||
            !this.allowedOrigins.has(policy.frontend_api_origin) ||
            !this.initialNavigationConsumed ||
            !this.initialLandingIdentity)
            return refusal("clerk_auth_policy_mismatch", "Clerk authentication is not admitted in the current browser state");
        if (this.clerkAuthenticationAttempted) {
            return refusal("clerk_auth_locked", "Clerk authentication is already locked");
        }
        this.clerkAuthenticationAttempted = true;
        let ready;
        try {
            ready = await this.waitForClerkReadiness();
        }
        catch {
            await this.lockClerkAfterPreTicketFailure();
            return refusal("clerk_auth_failed", "Clerk authentication failed");
        }
        if (ready !== true) {
            await this.lockClerkAfterPreTicketFailure();
            return refusal("clerk_auth_sdk_unavailable", "Clerk authentication failed");
        }
        let admission = null;
        try {
            admission = this.admitPrivateClerkLocation(await this.privateNavigationSnapshot());
        }
        catch { }
        if (!admission) {
            await this.lockClerkAfterPreTicketFailure();
            return refusal("clerk_auth_policy_mismatch", "Clerk authentication is not admitted in the current browser state");
        }
        const continuation = await this.admitPrivateAuthContinuation();
        if (!continuation.ok) {
            await this.lockClerkAfterPreTicketFailure();
            return continuation;
        }
        try {
            admission = this.admitPrivateClerkLocation(await this.privateNavigationSnapshot());
        }
        catch {
            admission = null;
        }
        if (!admission) {
            await this.lockClerkAfterPreTicketFailure();
            return refusal("clerk_auth_policy_mismatch", "Clerk authentication is not admitted in the current browser state");
        }
        const finalContinuation = await this.admitPrivateAuthContinuation();
        if (!finalContinuation.ok) {
            await this.lockClerkAfterPreTicketFailure();
            return finalContinuation;
        }
        const boundedHandoff = this.boundedOnboarding
            ? Object.freeze({
                kind: admission.kind,
                navigation: Object.freeze({ ...admission.navigation })
            })
            : null;
        const transportAttempt = Object.freeze({});
        this.clerkTransportAttempt = transportAttempt;
        this.clerkTransportPhase = "bootstrap";
        this.clerkBootstrapTransportDeadlineMs = Math.min(this.absoluteDeadlineMs, Date.now() + CLERK_BOOTSTRAP_TRANSPORT_TIMEOUT_MS);
        this.provisionalClerkSessionId = null;
        this.provisionalClerkTouchCount = 0;
        let result;
        try {
            result = await this.clerkAuthenticator.authenticate({
                ticket: request.ticket,
                expectedUserId: request.expected_user_id,
                expectedCurrentHref: admission.exactCurrentHref
            });
        }
        finally {
            if (this.clerkTransportAttempt === transportAttempt) {
                this.clerkTransportAttempt = null;
                this.clerkBootstrapTransportDeadlineMs = null;
                this.provisionalClerkSessionId = null;
                this.provisionalClerkTouchCount = 0;
            }
        }
        const authOutcome = result;
        const outcomeFields = isRecord(authOutcome) ? authOutcome : null;
        const exactSessionBinding = Boolean(outcomeFields?.ok &&
            /^[A-Za-z0-9_-]{4,256}$/.test(typeof outcomeFields.active_session_id === "string" ? outcomeFields.active_session_id : "") &&
            outcomeFields.active_session_id === this.activeClerkSessionId);
        if (!exactSessionBinding) {
            this.clerkTransportPhase = null;
            this.activeClerkSessionId = null;
            return outcomeFields?.ok
                ? refusal("clerk_auth_failed", "Clerk authentication failed")
                : result;
        }
        // Proven above (ok plus an exact session-id match admits only the success
        // shape), narrowed here so the session id below provably comes from the
        // authenticator result and never from broker state. Fail-closed if reached.
        if (!("authenticated" in result))
            return refusal("clerk_auth_failed", "Clerk authentication failed");
        this.clerkTransportPhase = "active";
        const postAuthContinuation = await this.admitPrivateAuthContinuation();
        if (!postAuthContinuation.ok || result.active_session_id !== this.activeClerkSessionId) {
            this.clerkTransportPhase = null;
            this.activeClerkSessionId = null;
            return postAuthContinuation.ok
                ? refusal("clerk_auth_failed", "Clerk authentication failed")
                : postAuthContinuation;
        }
        const confirmedLanding = this.boundedOnboarding ? null : await this.confirmPrivateAuthLanding(admission);
        if (!this.boundedOnboarding && !confirmedLanding) {
            this.clerkTransportPhase = null;
            this.activeClerkSessionId = null;
            return refusal("clerk_auth_landing_unconfirmed", "Clerk authentication landing could not be confirmed");
        }
        const landedContinuation = await this.admitPrivateAuthContinuation();
        if (!landedContinuation.ok || result.active_session_id !== this.activeClerkSessionId) {
            this.clerkTransportPhase = null;
            this.activeClerkSessionId = null;
            return landedContinuation.ok
                ? refusal("clerk_auth_failed", "Clerk authentication failed")
                : landedContinuation;
        }
        if (this.boundedOnboarding) {
            this.boundedPostAuthHandoff = boundedHandoff;
            this.boundedExpectedClerkUserId = typeof request.expected_user_id === "string" ? request.expected_user_id : null;
            this.boundedPostAuthStartPending = true;
        }
        else {
            this.authLandingNavigationSequence = confirmedLanding.logicalSequence;
            this.authLandingUrlSha256 = sha256Text(this.initialLandingIdentity.exactUrl);
            this.firstPostAuthCapturePending = true;
        }
        return {
            ok: true,
            authenticated: true,
            current_context_auth_methods_locked: true,
            persistent_clerk_network_filter: true,
            outcome_confirmed_after_timeout: result.outcome_confirmed_after_timeout,
            active_session_id: result.active_session_id
        };
    }
    async bindBoundedPostAuthRoute() {
        if (!this.boundedOnboarding ||
            !this.boundedPostAuthStartPending ||
            this.clerkTransportPhase !== "active" ||
            !/^[A-Za-z0-9_-]{4,256}$/.test(this.activeClerkSessionId ?? "") ||
            !/^[A-Za-z0-9_-]{4,256}$/.test(this.boundedExpectedClerkUserId ?? "") ||
            !this.boundedPostAuthHandoff ||
            this.boundedScopeIdentity)
            return refusal("clerk_auth_policy_mismatch", "The bounded authenticated route cannot be bound");
        this.boundedRouteFailurePoint = null;
        const fail = (stage, point = null) => {
            this.clerkTransportPhase = null;
            this.activeClerkSessionId = null;
            this.boundedPostAuthHandoff = null;
            this.boundedExpectedClerkUserId = null;
            return {
                ...refusal("clerk_auth_landing_unconfirmed", "Clerk authentication landing could not be confirmed"),
                failure_stage: stage,
                failure_code: CLERK_BOUNDED_ROUTE_FAILURE_CODES[stage],
                failure_point: point ?? this.boundedRouteFailurePoint
            };
        };
        const postAuthHandoff = this.boundedPostAuthHandoff;
        let directHandoff = false;
        try {
            directHandoff = postAuthHandoff.kind === "direct" &&
                !isAuthFlowUrl(postAuthHandoff.navigation.exactUrl);
        }
        catch { }
        const routeChain = {
            hops: directHandoff ? 1 : 0,
            last: postAuthHandoff.navigation
        };
        const deadline = Math.min(this.absoluteDeadlineMs, Date.now() + this.boundedRouteBindingTimeoutMs);
        const initialAdmission = await this.admitPrivateRouteState(deadline);
        const initialSample = initialAdmission.ok
            ? await this.settleBeforeRouteDeadline(deadline, () => this.privateNavigationSnapshot())
            : { ok: false };
        if (!initialAdmission.ok)
            return fail("candidate_wait", "initial_route_admission");
        if (!initialSample.ok)
            return fail("candidate_wait", "initial_route_snapshot");
        const initialNavigation = initialSample.value;
        let initialIsAuth = false;
        try {
            initialIsAuth = isAuthFlowUrl(initialNavigation.exactUrl);
        }
        catch {
            return fail("candidate_wait", "initial_route_snapshot");
        }
        let candidate = null;
        if (initialIsAuth) {
            const admittedTransit = this.admitPrivateClerkLocation(initialNavigation);
            const exactPriorTransit = Boolean(postAuthHandoff.kind === "transit" &&
                admittedTransit?.kind === "transit" &&
                this.sameAdmittedAuthTransit(postAuthHandoff.navigation, initialNavigation) &&
                this.sameCurrentPrivateNavigation(initialNavigation));
            if (!exactPriorTransit || this.boundedPostAuthResumeAttempted)
                return fail("candidate_wait", "auth_transit_lineage");
            const landingUrl = this.initialLandingIdentity?.exactUrl;
            if (typeof landingUrl !== "string")
                return fail("candidate_wait", "resume_target");
            let exactLandingTarget = false;
            try {
                exactLandingTarget = Boolean(new URL(landingUrl).href === landingUrl &&
                    normalizeOrigin(landingUrl) === normalizeOrigin(this.config.initial_url) &&
                    this.allowedNavigationOrigins.has(normalizeOrigin(landingUrl)) &&
                    !isAuthFlowUrl(landingUrl) &&
                    this.matchesClerkTransitContract(initialNavigation.exactUrl, landingUrl));
            }
            catch { }
            if (!exactLandingTarget || this.activeNavigation)
                return fail("candidate_wait", "resume_target");
            const inspected = await this.settleBeforeRouteDeadline(deadline, () => this.inspectClerkAuthentication());
            const authentication = inspected.ok ? inspected.value : null;
            const explicitMismatch = Boolean((authentication?.user_id != null && authentication.user_id !== this.boundedExpectedClerkUserId) ||
                (authentication?.session_id != null && authentication.session_id !== this.activeClerkSessionId));
            if (explicitMismatch)
                return fail("exact_clerk_inspection", "clerk_initial_inspection");
            const exactAuthentication = Boolean(authentication?.user_id === this.boundedExpectedClerkUserId &&
                authentication?.session_id === this.activeClerkSessionId &&
                authentication?.token_present === true);
            const routeRecheck = await this.admitPrivateRouteState(deadline);
            const stillCurrent = routeRecheck.ok
                ? await this.settleBeforeRouteDeadline(deadline, () => this.privateNavigationSnapshot())
                : { ok: false };
            if (!stillCurrent.ok)
                return fail("candidate_wait", "auth_transit_recheck");
            if (!this.sameAdmittedAuthTransit(initialNavigation, stillCurrent.value)) {
                let changedToNonAuth = false;
                try {
                    changedToNonAuth =
                        !isAuthFlowUrl(stillCurrent.value.exactUrl) &&
                            normalizeOrigin(stillCurrent.value.exactUrl) === normalizeOrigin(this.config.initial_url);
                }
                catch { }
                if (!changedToNonAuth)
                    return fail("candidate_wait", "auth_transit_recheck");
                candidate = await this.confirmBoundedOnboardingScope(deadline, { initialSample: stillCurrent.value, chain: routeChain });
            }
            else {
                if (!exactAuthentication || !this.sameCurrentPrivateNavigation(stillCurrent.value)) {
                    return fail("exact_clerk_inspection", "clerk_initial_inspection");
                }
                const beforeResume = await this.admitPrivateRouteState(deadline, { sealNetwork: true });
                const sealedTransit = beforeResume.ok
                    ? await this.settleBeforeRouteDeadline(deadline, () => this.privateNavigationSnapshot())
                    : { ok: false };
                const afterResumeSeal = sealedTransit.ok
                    ? await this.admitPrivateRouteState(deadline, { sealNetwork: true })
                    : { ok: false };
                const sealedSample = sealedTransit.ok ? sealedTransit.value : null;
                if (!afterResumeSeal.ok ||
                    beforeResume.network_activity_sequence !== afterResumeSeal.network_activity_sequence ||
                    !sealedSample ||
                    !this.sameAdmittedAuthTransit(initialNavigation, sealedSample) ||
                    !this.sameCurrentPrivateNavigation(sealedSample))
                    return fail("candidate_wait", "auth_transit_recheck");
                this.boundedPostAuthResumeAttempted = true;
                this.activeNavigation = { allowed_urls: new Set([landingUrl]), last_url: null, reject_redirects: true };
                try {
                    this.assertEffectfulAdmissionOpen();
                    const navigated = await this.settleBeforeRouteDeadline(deadline, () => this.cdp.send("Page.navigate", { url: landingUrl }, this.pageSessionId));
                    if (!navigated.ok || navigated.value?.errorText)
                        return fail("candidate_wait", "resume_navigation");
                }
                finally {
                    this.activeNavigation = null;
                }
                candidate = await this.confirmBoundedOnboardingScope(deadline, { chain: routeChain });
            }
        }
        else {
            candidate = await this.confirmBoundedOnboardingScope(deadline, { initialSample: initialNavigation, chain: routeChain });
        }
        if (!candidate)
            return fail("candidate_wait");
        let failureStage = "exact_clerk_inspection";
        let finalDestination = null;
        let clerkLockedLoaderId = postAuthHandoff.navigation.loaderId;
        while (Date.now() < deadline) {
            if (this.activeNavigation)
                return fail(failureStage, "route_admission");
            const ready = await this.settleBeforeRouteDeadline(deadline, () => this.waitForClerkReadiness(deadline));
            if (!ready.ok || ready.value !== true)
                return fail(failureStage, "clerk_readiness");
            const newPageContext = candidate.loaderId !== clerkLockedLoaderId;
            if (newPageContext) {
                const relocked = await this.settleBeforeRouteDeadline(deadline, () => this.lockClerkAuthenticationMethods());
                if (!relocked.ok)
                    return fail("post_inspection_reseal", "clerk_context_relock");
                clerkLockedLoaderId = candidate.loaderId;
            }
            const inspected = await this.settleBeforeRouteDeadline(deadline, () => this.inspectClerkAuthentication());
            const authentication = inspected.ok ? inspected.value : null;
            const explicitMismatch = Boolean((authentication?.user_id != null && authentication.user_id !== this.boundedExpectedClerkUserId) ||
                (authentication?.session_id != null && authentication.session_id !== this.activeClerkSessionId));
            if (explicitMismatch)
                return fail("exact_clerk_inspection", "clerk_final_inspection");
            const exactAuthentication = Boolean(authentication?.user_id === this.boundedExpectedClerkUserId &&
                authentication?.session_id === this.activeClerkSessionId &&
                authentication?.token_present === true);
            if (exactAuthentication) {
                failureStage = "post_inspection_reseal";
                finalDestination = await this.finalizeBoundedRouteBinding(candidate, deadline);
                if (finalDestination && !this.backgroundAbortLatched)
                    break;
            }
            if (Date.now() >= deadline || this.backgroundAbortLatched)
                return fail(failureStage, failureStage === "post_inspection_reseal" ? "clerk_final_reseal" : "clerk_final_inspection");
            const routeAdmission = await this.admitPrivateRouteState(deadline);
            const sampled = routeAdmission.ok
                ? await this.settleBeforeRouteDeadline(deadline, () => this.privateNavigationSnapshot())
                : { ok: false };
            if (!sampled.ok)
                return fail(failureStage, "route_admission");
            if (!this.samePrivateNavigation(candidate, sampled.value) || !this.sameCurrentPrivateNavigation(sampled.value)) {
                candidate = await this.confirmBoundedOnboardingScope(deadline, { initialSample: sampled.value, chain: routeChain });
                if (!candidate)
                    return fail(failureStage);
            }
            const remaining = deadline - Date.now();
            if (remaining > 0) {
                await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(25, remaining)));
            }
        }
        if (!finalDestination)
            return fail(failureStage, failureStage === "post_inspection_reseal" ? "clerk_final_reseal" : "clerk_final_inspection");
        this.boundedScopeIdentity = finalDestination;
        this.boundedScopeHref = finalDestination.exactUrl;
        this.boundedScopeRawUrlSha256 = sha256Text(finalDestination.exactUrl);
        this.authLandingNavigationSequence = finalDestination.logicalSequence;
        this.authLandingUrlSha256 = this.boundedScopeRawUrlSha256;
        this.firstPostAuthCapturePending = true;
        this.boundedPostAuthStartPending = false;
        this.boundedPostAuthHandoff = null;
        this.boundedExpectedClerkUserId = null;
        this.boundedPrivateAuthStart = false;
        return { ok: true, route_bound: true };
    }
    async privateIdentityMaterialAbsent(tree, rawMaterial = []) {
        if (!(this.boundedOnboarding && this.config.clerk_auth))
            return true;
        // This is an exact raw-material boundary over AX plus DOM text/attributes.
        // It deliberately makes no OCR claim for identity rendered only into canvas
        // or raster-image pixels; every detectable exact string fails closed here.
        const needles = this.privateIdentityNeedles;
        if (!needles ||
            containsExactPrivateText(tree, needles) ||
            containsExactPrivateText(rawMaterial, needles))
            return false;
        let inspected;
        try {
            inspected = await this.callPageFunction(CLERK_PAGE_FUNCTIONS.identityAbsent, [needles]);
        }
        catch {
            return false;
        }
        const inspectedFields = isRecord(inspected) ? inspected : null;
        return inspectedFields?.inspection_complete === true && inspectedFields.identity_absent === true;
    }
    async assertPrivateIdentityAbsent(tree, rawMaterial = []) {
        if (await this.privateIdentityMaterialAbsent(tree, rawMaterial))
            return;
        await this.abort("private_identity_exposure", "Private identity appeared in page material").catch(() => { });
        throw privateIdentityExposureError();
    }
    async privatePostAuthReadinessSample() {
        const continuation = await this.admitPrivateAuthContinuation();
        if (!continuation.ok)
            return { aborted: true };
        if (this.networkInflight.size !== 0)
            return null;
        const before = await this.privateNavigationSnapshot();
        if (!this.isExactLanding(before))
            return false;
        const networkSequence = this.networkActivitySequence;
        const tree = await this.cdp.send("Accessibility.getFullAXTree", {}, this.pageSessionId);
        const treeNodes = Array.isArray(tree.nodes) ? tree.nodes : [];
        const pageReady = await this.callPageFunction(CLERK_PAGE_FUNCTIONS.postAuthReady);
        if (!await this.privateIdentityMaterialAbsent(tree, [before.exactUrl])) {
            await this.abort("private_identity_exposure", "Private identity appeared in page material").catch(() => { });
            return { identityExposure: true };
        }
        const screenshot = await this.cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, this.pageSessionId);
        const after = await this.privateNavigationSnapshot();
        const finalContinuation = await this.admitPrivateAuthContinuation();
        if (!finalContinuation.ok)
            return { aborted: true };
        if (!this.samePrivateNavigation(before, after) || !this.isExactLanding(after))
            return false;
        // Matches the explorer's own clickable/typeable role set (lib/explorer-protocol.mjs) -- a
        // first screen that opens on a choice (radio/checkbox/tab/option), not just a button or a
        // text field, is just as genuinely interactive and must not be mistaken for "still loading".
        const actionableRole = (node) => {
            const fields = isRecord(node) ? node : null;
            if (fields?.ignored)
                return null;
            const role = isRecord(fields?.role) ? fields.role : null;
            return typeof role?.value === "string" ? role.value : null;
        };
        const actionable = treeNodes.some((node) => {
            const roleValue = actionableRole(node);
            return roleValue !== null && ["button", "link", "textbox", "searchbox", "checkbox", "radio", "tab", "menuitem", "option"].includes(roleValue);
        });
        const accessibilityBusy = treeNodes.some((node) => {
            const busyFields = isRecord(node) ? node : null;
            if (busyFields?.ignored)
                return false;
            const busyRole = isRecord(busyFields?.role) ? busyFields.role : null;
            if (busyRole?.value === "progressbar")
                return true;
            const busyProperties = busyFields?.properties;
            return Array.isArray(busyProperties) && busyProperties.some((busyProperty) => {
                const busyPropertyFields = isRecord(busyProperty) ? busyProperty : null;
                const busyPropertyValue = isRecord(busyPropertyFields?.value) ? busyPropertyFields.value : null;
                return busyPropertyFields?.name === "busy" && busyPropertyValue?.value === true;
            });
        });
        const screenshotData = screenshot?.data;
        if (pageReady !== true ||
            !actionable ||
            accessibilityBusy ||
            this.networkInflight.size !== 0 ||
            this.networkActivitySequence !== networkSequence ||
            Date.now() - this.lastNetworkActivityAt < POST_AUTH_NETWORK_QUIET_MS ||
            typeof screenshotData !== "string" ||
            !screenshotData)
            return null;
        const axSha256 = hashAccessibilityTree(Array.isArray(tree.nodes) ? tree.nodes : []);
        const screenshotSha256 = sha256Text(screenshotData);
        return {
            fingerprint: sha256Text(`${after.exactUrl}\n${axSha256}\n${screenshotSha256}\n${networkSequence}`),
            axSha256,
            screenshotSha256,
            networkSequence
        };
    }
    async confirmPrivatePostAuthReadiness() {
        if (!this.firstPostAuthCapturePending || this.postAuthReadinessConfirmed)
            return { ok: true };
        if (!Number.isFinite(this.postAuthReadinessDeadlineMs)) {
            this.postAuthReadinessDeadlineMs = Math.min(this.absoluteDeadlineMs, Date.now() + this.postAuthReadinessTimeoutMs);
        }
        const deadline = this.postAuthReadinessDeadlineMs;
        let previous = null;
        let stableSamples = 0;
        let stableSince = null;
        while (Date.now() < deadline) {
            let sample;
            try {
                sample = await this.privatePostAuthReadinessSample();
            }
            catch {
                sample = null;
            }
            if (isRecord(sample) && "identityExposure" in sample && sample.identityExposure === true) {
                this.clerkTransportPhase = null;
                this.activeClerkSessionId = null;
                return refusal("private_identity_exposure", "Private identity exposure prevented evidence retention");
            }
            if (sample === false || (isRecord(sample) && "aborted" in sample && sample.aborted === true)) {
                this.clerkTransportPhase = null;
                this.activeClerkSessionId = null;
                await this.abort("post_auth_readiness_unconfirmed", "Post-auth readiness could not be confirmed").catch(() => { });
                return sample === false
                    ? refusal("clerk_auth_landing_unconfirmed", "Clerk authentication landing could not be confirmed")
                    : refusal("clerk_auth_post_auth_readiness_unconfirmed", "The authenticated page did not become ready");
            }
            if (isRecord(sample) && "fingerprint" in sample && typeof sample.fingerprint === "string") {
                const fingerprint = sample.fingerprint;
                if (fingerprint === previous) {
                    stableSamples += 1;
                }
                else {
                    stableSamples = 1;
                    stableSince = Date.now();
                }
                previous = fingerprint;
                if (stableSamples >= POST_AUTH_STABLE_SAMPLES &&
                    Date.now() - (stableSince ?? 0) >= POST_AUTH_STABLE_WINDOW_MS) {
                    this.postAuthReadinessFingerprint = Object.freeze({
                        axSha256: sample.axSha256,
                        screenshotSha256: sample.screenshotSha256,
                        networkSequence: sample.networkSequence
                    });
                    this.postAuthReadinessConfirmed = true;
                    return { ok: true };
                }
            }
            else {
                previous = null;
                stableSamples = 0;
                stableSince = null;
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, Math.min(25, deadline - Date.now()))));
        }
        this.clerkTransportPhase = null;
        this.activeClerkSessionId = null;
        await this.abort("post_auth_readiness_unconfirmed", "Post-auth readiness could not be confirmed").catch(() => { });
        return refusal("clerk_auth_post_auth_readiness_unconfirmed", "The authenticated page did not become ready");
    }
    async privatePostAuthCertificateCurrent() {
        if (!this.postAuthReadinessConfirmed || !this.postAuthReadinessFingerprint)
            return false;
        const continuation = await this.admitPrivateAuthContinuation();
        return Boolean(continuation.ok &&
            this.networkInflight.size === 0 &&
            this.networkActivitySequence === this.postAuthReadinessFingerprint.networkSequence);
    }
    postAuthReadinessError(response) {
        const error = new Error("Post-auth readiness could not be confirmed");
        Object.defineProperty(error, "postAuthReadinessRefusal", { value: response });
        return error;
    }
    async restartPrivatePostAuthReadiness() {
        this.postAuthReadinessConfirmed = false;
        this.postAuthReadinessFingerprint = null;
        const readiness = await this.confirmPrivatePostAuthReadiness();
        if (!readiness.ok)
            throw this.postAuthReadinessError(readiness);
    }
    admitPrivateClerkBootstrapSnapshot(snapshot) {
        if (!snapshot)
            return null;
        try {
            if (isAuthFlowUrl(snapshot?.exactUrl)) {
                if (!this.privateInitialAuthHandoff(snapshot))
                    return null;
            }
            else if (!this.bindInitialLanding(snapshot)) {
                return null;
            }
            return this.admitPrivateClerkLocation(snapshot);
        }
        catch {
            return null;
        }
    }
    async privateClerkBootstrapNavigate(request) {
        this.activeAction = { action_class: request.action_class, allowed_request: null, matched_write: false };
        this.clearUnretainedObservation();
        let failurePoint = INITIAL_NAVIGATION_FAILURE_POINTS.bootstrap_admission;
        const failedAt = (response, point = failurePoint) => ({ ...response, failure_point: point });
        try {
            this.initialNavigationPredecessor = await this.privateNavigationSnapshot();
            const loadSequence = this.topFrameLoadSequence;
            this.initialNavigationConsumed = true;
            const workerReservation = await this.reserveFixedFixtureWorkerRequest();
            if (!workerReservation.ok)
                return failedAt(workerReservation);
            this.activeNavigation = { allowed_urls: new Set([new URL(typeof request.url === "string" ? request.url : "").href]), last_url: null };
            this.assertEffectfulAdmissionOpen();
            failurePoint = INITIAL_NAVIGATION_FAILURE_POINTS.navigate_dispatch;
            const dispatched = await this.cdp.send("Page.navigate", { url: typeof request.url === "string" ? request.url : "" }, this.pageSessionId);
            if (dispatched?.errorText)
                throw new Error("Initial navigation dispatch was refused");
            failurePoint = INITIAL_NAVIGATION_FAILURE_POINTS.load_wait;
            await this.waitForTopFrameLoad(loadSequence);
            failurePoint = INITIAL_NAVIGATION_FAILURE_POINTS.bootstrap_admission;
            let admission = this.admitPrivateClerkBootstrapSnapshot(await this.privateNavigationSnapshot());
            if (!admission)
                throw new Error("The private Clerk bootstrap location was not admitted");
            let continuation = await this.admitPrivateAuthContinuation();
            if (!continuation.ok)
                return failedAt(continuation);
            admission = this.admitPrivateClerkLocation(await this.privateNavigationSnapshot());
            if (!admission)
                throw new Error("The private Clerk bootstrap location changed");
            continuation = await this.admitPrivateAuthContinuation();
            if (!continuation.ok)
                return failedAt(continuation);
            if (!this.admitPrivateClerkLocation(await this.privateNavigationSnapshot())) {
                throw new Error("The private Clerk bootstrap location changed");
            }
            this.clearUnretainedObservation();
            return { ok: true, private_auth_handoff: true };
        }
        catch (error) {
            if ((isRecord(error) && error.backgroundAbortLatched) || this.backgroundAbortLatched) {
                return failedAt(refusal("run_aborted", "The browser run is not live"));
            }
            await this.abort("private_clerk_bootstrap_failed", "Private Clerk bootstrap navigation failed");
            return failedAt(refusal("run_aborted", "The browser run is not live"));
        }
        finally {
            this.activeAction = null;
            this.activeNavigation = null;
            this.boundedPendingScopeExit = null;
        }
    }
    inspectObservedControl(request) {
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        const ref = String(request?.ref ?? "").replace(/^@/, "");
        const semantic = this.refs.get(ref);
        if (!this.lastEvidence || !semantic)
            return refusal("observed_control_missing", "The control is not present in the current retained observation");
        return {
            ok: true,
            control: {
                url: this.lastEvidence.url,
                observation_hash: this.lastEvidence.observation_hash,
                ref,
                role: semantic.role,
                name: semantic.name,
                visible_state_summary: this.lastEvidence.visible_state_summary
            }
        };
    }
    onCdpEvent(message) {
        const method = message.method;
        if (method === "Page.fileChooserOpened") {
            this.trackBackgroundAbort("file_chooser_forbidden", "A file chooser was blocked");
            return;
        }
        if (method === "Network.requestWillBeSent") {
            const params = eventParams(message);
            const requestKey = `${message.sessionId ?? ""}:${params.requestId}`;
            this.networkInflight.add(requestKey);
            this.networkActivitySequence += 1;
            this.lastNetworkActivityAt = Date.now();
            const requestUrl = isRecord(params.request) ? params.request.url : undefined;
            if (this.routeBindingRequestRelevant(requestUrl)) {
                this.routeBindingNetworkInflight.add(requestKey);
                this.routeBindingNetworkActivitySequence += 1;
            }
        }
        if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
            const params = eventParams(message);
            const requestKey = `${message.sessionId ?? ""}:${params.requestId}`;
            this.networkInflight.delete(requestKey);
            this.networkActivitySequence += 1;
            this.lastNetworkActivityAt = Date.now();
            if (this.routeBindingNetworkInflight.delete(requestKey)) {
                this.routeBindingNetworkActivitySequence += 1;
            }
        }
        if (method === "Target.targetCreated") {
            const info = eventTargetInfo(message);
            if (info.type === "page" && this.pageTargetId && info.targetId !== this.pageTargetId) {
                this.trackBackgroundAbort("unexpected_page_target", "A popup or new page target was blocked");
                void this.cdp.send("Target.closeTarget", { targetId: info.targetId });
                return;
            }
            if (typeof info.type !== "string" || !["page", "service_worker"].includes(info.type)) {
                this.trackBackgroundAbort("unhandled_target_type", "An unhandled worker, worklet, or out-of-process frame caused a fail-closed abort");
                void this.cdp.send("Target.closeTarget", { targetId: info.targetId });
                return;
            }
        }
        if (method === "Target.attachedToTarget") {
            const params = eventParams(message);
            const sessionId = params.sessionId;
            const info = eventTargetInfo(message);
            if (info.type === "page")
                return;
            if (typeof sessionId !== "string" || typeof info.targetId !== "string" || typeof info.type !== "string") {
                throw new Error("CDP target session is unavailable");
            }
            this.sessionTypes.set(sessionId, { targetId: info.targetId, type: info.type });
            if (["worker", "shared_worker"].includes(info.type))
                this.trackBackgroundAbort("unexpected_worker_target", "A dedicated or shared worker target caused a fail-closed abort");
            if (info.type === "service_worker") {
                if (!this.config.fixed_preflight_service_worker_request)
                    this.trackBackgroundAbort("unexpected_service_worker", "A service worker target caused a fail-closed abort");
                const exactFixtureWorker = info.url === this.config.fixed_preflight_service_worker_request;
                this.fixtureWorkerObserved = exactFixtureWorker;
                if (this.config.fixed_preflight_service_worker_request && !exactFixtureWorker) {
                    this.trackBackgroundAbort("unexpected_service_worker_url", "A service worker target did not match the one pre-reserved fixture URL");
                }
                try {
                    const workerUrl = info.url;
                    if (typeof workerUrl !== "string")
                        throw new Error("Service worker target had an invalid origin");
                    if (!this.allowedOrigins.has(normalizeOrigin(workerUrl)))
                        this.trackBackgroundAbort("service_worker_origin_allowlist_breach", "Service worker origin was not allowed");
                }
                catch {
                    this.trackBackgroundAbort("service_worker_origin_invalid", "Service worker target had an invalid origin");
                }
            }
            const ready = this.configureSession(sessionId, info.type, true);
            this.sessionReady.set(sessionId, ready);
            void ready.catch(() => { });
            return;
        }
        if (method === "Fetch.requestPaused") {
            const params = eventParams(message);
            this.networkActivitySequence += 1;
            this.lastNetworkActivityAt = Date.now();
            const pausedRequestUrl = isRecord(params.request) ? params.request.url : undefined;
            if (this.routeBindingRequestRelevant(pausedRequestUrl)) {
                this.routeBindingNetworkActivitySequence += 1;
            }
            const receipt = this.boundedRequestReceipt();
            this.requestQueue = this.requestQueue.then(() => this.handlePausedRequest(message, receipt));
            return;
        }
        if (method === "Network.webSocketCreated" || method === "Network.eventSourceMessageReceived") {
            this.trackBackgroundAbort("unhandled_live_channel", "A live network channel was attempted");
            return;
        }
        if (method === "Page.loadEventFired") {
            this.topFrameLoadSequence += 1;
            for (const waiter of [...this.pageLoadWaiters])
                waiter();
            return;
        }
        if (method === "Network.requestWillBeSent") {
            const params = eventParams(message);
            const redirectResponse = isRecord(params.redirectResponse) ? params.redirectResponse : null;
            if (redirectResponse) {
                const activeNavigation = this.activeNavigation;
                if (activeNavigation && params.type === "Document") {
                    try {
                        const redirectSourceUrl = redirectResponse.url;
                        if (typeof redirectSourceUrl !== "string")
                            throw new Error("redirect chain mismatch");
                        if (new URL(redirectSourceUrl).href !== activeNavigation.last_url)
                            throw new Error("redirect chain mismatch");
                        const pausedRedirectRequest = params.request;
                        const pausedRedirectUrl = isRecord(pausedRedirectRequest) ? pausedRedirectRequest.url : undefined;
                        const redirected = new URL(typeof pausedRedirectUrl === "string" ? pausedRedirectUrl : "").href;
                        if (activeNavigation.reject_redirects === true)
                            throw new Error("redirect forbidden");
                        if (this.allowedNavigationOrigins.has(normalizeOrigin(redirected)))
                            activeNavigation.allowed_urls.add(redirected);
                    }
                    catch {
                        this.trackBackgroundAbort("unbound_document_redirect", "A document redirect did not match the active observed navigation");
                    }
                }
                const redirectKey = `${message.sessionId ?? ""}:${params.requestId}:${redirectResponse.url}`;
                if (!this.redirectIds.has(redirectKey)) {
                    this.redirectIds.add(redirectKey);
                    this.requestQueue = this.requestQueue.then(() => this.incrementRedirect());
                }
                return;
            }
        }
        if (method === "Page.frameNavigated") {
            const params = eventParams(message);
            const frameFields = isRecord(params.frame) ? params.frame : null;
            if (frameFields?.parentId === undefined) {
                if (!frameFields)
                    throw new Error("CDP frame is unavailable");
                const frameId = frameFields.id;
                const frameLoaderId = frameFields.loaderId;
                if (typeof frameId !== "string" || typeof frameLoaderId !== "string")
                    throw new Error("CDP frame is unavailable");
                this.navigationSequence += 1;
                this.logicalNavigationSequence += 1;
                this.topFrameId = frameId;
                this.topFrameLoaderId = frameLoaderId;
                this.lastTopNavigation = { kind: "document", sequence: this.navigationSequence };
                this.lastLogicalTopNavigation = { kind: "document", sequence: this.logicalNavigationSequence };
                this.lastTopLogicalLocation = {
                    urlSha256: sha256Text(String(frameFields.url ?? "")),
                    frameId,
                    loaderId: frameLoaderId
                };
                try {
                    const frameUrl = frameFields.url;
                    if (typeof frameUrl !== "string")
                        throw new Error("CDP frame URL is unavailable");
                    if (!isAuthFlowUrl(frameUrl)) {
                        this.currentUrl = frameUrl;
                        if (this.initialNavigationConsumed && !this.initialLandingIdentity && !this.initialLandingEventCandidate) {
                            const origin = normalizeOrigin(frameUrl);
                            if (origin === normalizeOrigin(this.config.initial_url) && this.allowedNavigationOrigins.has(origin)) {
                                this.initialLandingEventCandidate = {
                                    exactUrl: frameUrl,
                                    frameId,
                                    loaderId: frameLoaderId,
                                    sequence: this.logicalNavigationSequence,
                                    sameUrlHistoryApiNotifications: 0
                                };
                            }
                        }
                    }
                }
                catch { }
                return;
            }
        }
        if (method === "Page.navigatedWithinDocument") {
            const params = eventParams(message);
            if (params.frameId !== this.topFrameId)
                return;
            this.navigationSequence += 1;
            const urlSha256 = sha256Text(String(params.url ?? ""));
            const lastLogicalLocation = this.lastTopLogicalLocation;
            const duplicateLogicalLocation = params.navigationType === "historyApi" &&
                lastLogicalLocation?.urlSha256 === urlSha256 &&
                lastLogicalLocation?.frameId === this.topFrameId &&
                lastLogicalLocation?.loaderId === this.topFrameLoaderId;
            this.lastTopNavigation = {
                kind: "same-document",
                navigationType: params.navigationType,
                sequence: this.navigationSequence
            };
            if (!duplicateLogicalLocation) {
                this.logicalNavigationSequence += 1;
                this.lastLogicalTopNavigation = {
                    kind: "same-document",
                    navigationType: params.navigationType,
                    sequence: this.logicalNavigationSequence
                };
            }
            else {
                const landingCandidate = this.initialLandingEventCandidate;
                if (landingCandidate?.sequence === this.logicalNavigationSequence &&
                    sha256Text(landingCandidate.exactUrl) === urlSha256) {
                    landingCandidate.sameUrlHistoryApiNotifications += 1;
                }
            }
            this.lastTopLogicalLocation = {
                urlSha256,
                frameId: this.topFrameId,
                loaderId: this.topFrameLoaderId
            };
            try {
                const documentUrl = params.url;
                if (typeof documentUrl !== "string")
                    throw new Error("CDP document URL is unavailable");
                if (!isAuthFlowUrl(documentUrl)) {
                    this.currentUrl = documentUrl;
                }
            }
            catch { }
        }
    }
    async configureSession(sessionId, type, resumeWaitingTarget) {
        try {
            await this.cdp.send("Network.enable", {}, sessionId);
            await this.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
            if (type === "page") {
                await this.cdp.send("Runtime.enable", {}, sessionId);
                await this.cdp.send("Page.enable", {}, sessionId);
                await this.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
                const frameTree = await this.cdp.send("Page.getFrameTree", {}, sessionId);
                const topFrameFields = isRecord(frameTree.frameTree) && isRecord(frameTree.frameTree.frame) ? frameTree.frameTree.frame : null;
                if (typeof topFrameFields?.id === "string" && typeof topFrameFields?.loaderId === "string" && this.topFrameId === null) {
                    this.topFrameId = topFrameFields.id;
                    this.topFrameLoaderId = topFrameFields.loaderId;
                }
                await this.cdp.send("DOM.enable", {}, sessionId);
                await this.cdp.send("Accessibility.enable", {}, sessionId);
                await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
                    source: calibrationGuardSource({
                        calibration: this.calibrationEnabled,
                        allowFixtureServiceWorker: Boolean(this.config.fixed_preflight_service_worker_request)
                    })
                }, sessionId);
            }
            if (resumeWaitingTarget) {
                this.assertEffectfulAdmissionOpen();
                await this.cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
            }
        }
        catch (error) {
            try {
                const errorMessage = isRecord(error) ? error.message : undefined;
                await this.abort("cdp_session_configuration_failed", errorMessage);
            }
            catch { }
            throw error;
        }
    }
    async loadState() {
        return readJson(this.config.cap_state_path);
    }
    boundedCapsValid(state) {
        const caps = field(state, "caps");
        const browser = field(state, "browser");
        const app = field(state, "app");
        const model = field(state, "model");
        const startedAt = field(browser, "started_at");
        const activeSeconds = startedAt == null
            ? 0
            : monotonicSeconds() - Number(startedAt);
        const combined = Number(field(app, "actual_eur")) + Number(field(app, "outstanding_reservations_eur")) +
            Number(field(model, "actual_eur")) + Number(field(model, "outstanding_reservations_eur"));
        return Boolean(caps &&
            Number.isFinite(activeSeconds) && activeSeconds >= 0 && activeSeconds <= Number(field(caps, "browser_active_seconds")) &&
            Number.isSafeInteger(field(browser, "operations")) && Number(field(browser, "operations")) >= 0 && Number(field(browser, "operations")) <= Number(field(caps, "browser_operations_total")) &&
            Number.isSafeInteger(field(browser, "requests")) && Number(field(browser, "requests")) >= 0 && Number(field(browser, "requests")) <= Number(field(caps, "browser_requests_total")) &&
            rollingCount(this.operationTimes, monotonicSeconds()) <= Number(field(caps, "browser_operations_per_rolling_minute")) &&
            rollingCount(this.requestTimes, monotonicSeconds()) <= Number(field(caps, "browser_requests_per_rolling_minute")) &&
            Number.isSafeInteger(field(app, "one_way_actions")) && Number(field(app, "one_way_actions")) >= 0 && Number(field(app, "one_way_actions")) <= Number(field(caps, "listed_one_way_actions_total")) &&
            Number.isFinite(Number(field(app, "actual_eur"))) && Number(field(app, "actual_eur")) >= 0 &&
            Number.isFinite(Number(field(app, "outstanding_reservations_eur"))) && Number(field(app, "outstanding_reservations_eur")) >= 0 &&
            Number(field(app, "actual_eur")) + Number(field(app, "outstanding_reservations_eur")) <= Number(field(caps, "app_side_cost_cap_eur")) &&
            Number.isFinite(Number(field(model, "actual_eur"))) && Number(field(model, "actual_eur")) >= 0 &&
            Number.isFinite(Number(field(model, "outstanding_reservations_eur"))) && Number(field(model, "outstanding_reservations_eur")) >= 0 &&
            Number(field(model, "actual_eur")) + Number(field(model, "outstanding_reservations_eur")) <= Number(field(caps, "model_cost_cap_eur")) &&
            Number.isFinite(combined) && combined <= Number(field(caps, "combined_actual_plus_reserved_cap_eur")));
    }
    async admitPrivateAuthContinuation(deadline = this.absoluteDeadlineMs) {
        for (;;) {
            if (this.backgroundAbortLatched)
                return refusal("run_aborted", "The browser run is not live");
            const initialDrain = await this.settleBeforeRouteDeadline(deadline, () => this.drainBackgroundAbortTasks());
            if (!initialDrain.ok || this.backgroundAbortLatched)
                return refusal("run_aborted", "The browser run is not live");
            const networkActivitySequence = this.networkActivitySequence;
            const pendingRequests = this.requestQueue;
            const requestsSettled = await this.settleBeforeRouteDeadline(deadline, () => pendingRequests);
            if (!requestsSettled.ok || this.backgroundAbortLatched)
                return refusal("run_aborted", "The browser run is not live");
            const finalDrain = await this.settleBeforeRouteDeadline(deadline, () => this.drainBackgroundAbortTasks());
            if (!finalDrain.ok || this.backgroundAbortLatched)
                return refusal("run_aborted", "The browser run is not live");
            const loaded = await this.settleBeforeRouteDeadline(deadline, () => this.loadState());
            if (!loaded.ok || this.backgroundAbortLatched)
                return refusal("run_aborted", "The browser run is not live");
            const state = loaded.value;
            if (pendingRequests !== this.requestQueue ||
                networkActivitySequence !== this.networkActivitySequence ||
                this.backgroundAbortTasks.size !== 0)
                continue;
            if (isRecord(state) && state.abort)
                return refusal("run_aborted", "The browser run is not live");
            const workingDayDeadline = isRecord(state) && typeof state.working_day_deadline === "string" ? Date.parse(state.working_day_deadline) : NaN;
            if (!Number.isFinite(workingDayDeadline) ||
                Date.now() >= workingDayDeadline ||
                Date.now() >= this.absoluteDeadlineMs)
                return refusal("working_day_deadline", "Working-day deadline reached");
            if (this.boundedOnboarding && !this.boundedCapsValid(state)) {
                return refusal("run_aborted", "The browser run is not live");
            }
            return { ok: true, network_activity_sequence: networkActivitySequence };
        }
    }
    async abort(code, detail, operatorDiagnostic = null) {
        this.backgroundAbortLatched = true;
        await mutateCapState(this.config.cap_state_path, (state) => {
            if (!state.abort) {
                state.abort = { code, timestamp: isoNow(), detail: String(detail).replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 240) };
                if (operatorDiagnostic)
                    state.abort.operator_diagnostic = operatorDiagnostic;
            }
        });
    }
    // CDP event handlers are synchronous, so an abort triggered from one cannot be
    // awaited by its caller. Track it here instead of firing it and forgetting it,
    // so shutdown can drain outstanding cap-state writes before the run directory
    // (and its lockfile) is removed.
    trackBackgroundAbort(code, detail) {
        const task = this.abort(code, detail).catch(() => { });
        this.backgroundAbortTasks.add(task);
        task.finally(() => this.backgroundAbortTasks.delete(task));
    }
    async drainBackgroundAbortTasks() {
        while (this.backgroundAbortTasks.size !== 0) {
            await Promise.allSettled([...this.backgroundAbortTasks]);
        }
    }
    async incrementRedirect() {
        await mutateCapState(this.config.cap_state_path, (state) => {
            state.browser.redirects += 1;
        });
    }
    // Fetch pauses are serialized, so the mutable action state at handler time may
    // describe a later phase than the browser was in when the request was received.
    // Capture the only authorization-relevant phase synchronously with the CDP
    // receipt and carry it privately through the queue.
    boundedRequestReceipt() {
        const action = this.activeAction;
        if (action?.action_class !== BOUNDED_ONBOARDING_CLASS && !this.boundedPrivateAuthStart)
            return null;
        return Object.freeze({
            action_id: action?.bounded_action_id ?? null,
            phase: action?.bounded_mutation_phase ?? "pre-input-dispatch",
            generation: action?.bounded_click_dispatch_generation ?? null,
            suppress_retention: this.boundedPrivateAuthStart,
            clerk_transport_phase: this.clerkTransportPhase,
            clerk_transport_session: this.activeClerkSessionId,
            clerk_transport_attempt: this.clerkTransportAttempt,
            clerk_bootstrap_deadline_ms: this.clerkBootstrapTransportDeadlineMs
        });
    }
    privateAuthUnknownMutationDiagnostic({ rawUrl, origin, method, receipt }) {
        if (!this.boundedOnboarding || !this.boundedPrivateAuthStart || receipt === null || receipt === undefined)
            return null;
        const targetOrigin = normalizeOrigin(this.config.initial_url);
        const clerkOrigin = this.config.clerk_auth?.frontend_api_origin;
        let requestClass = origin === targetOrigin ? "same_origin_mutation" : "other_origin_mutation";
        let requestSessionId = null;
        if (origin === clerkOrigin) {
            requestClass = "clerk_other";
            try {
                const pathname = new URL(rawUrl).pathname;
                if (/^\/v1\/client\/sign_ins(?:\/|$)/.test(pathname))
                    requestClass = "clerk_sign_in";
                const session = /^\/v1\/client\/sessions\/([^/]+)\/(touch|tokens)(?:\/|$)/.exec(pathname);
                if (session) {
                    requestSessionId = /^[A-Za-z0-9_-]{4,256}$/.test(session[1]) ? session[1] : null;
                    requestClass = session[2] === "touch" ? "clerk_touch" : "clerk_token";
                }
            }
            catch { }
        }
        const diagnostic = {
            boundary: "bounded_private_auth",
            request_class: requestClass,
            captured_phase: typeof receipt.clerk_transport_phase === "string" && SAFE_DIAGNOSTIC_CLERK_PHASES.has(receipt.clerk_transport_phase)
                ? receipt.clerk_transport_phase
                : "none",
            session_binding: requestSessionId !== null && requestSessionId === receipt.clerk_transport_session,
            method: SAFE_DIAGNOSTIC_METHODS.has(method) ? method : "OTHER"
        };
        return Object.freeze(diagnostic);
    }
    // Admits a same-origin mutation the owner pre-declared as firing automatically
    // during the private-auth-start window (before any session is bound), e.g. an
    // onboarding surface's scripted first message. The phase is re-proved from the
    // receipt captured at CDP-receipt time (not live state), closing a
    // queue-reordering hole; the Map lookup is an exact "METHOD\nhref" match with
    // no pattern/prefix support, and each entry's remaining budget decrements here.
    admitPrivateAuthBootstrapMutation({ method, href, origin, receipt }) {
        if (this.boundedPrivateAuthStart !== true || receipt?.suppress_retention !== true)
            return null;
        if (href === null || origin !== normalizeOrigin(this.config.initial_url))
            return null;
        const entry = this.authBootstrapAdmissions.get(`${method}\n${href}`);
        if (!entry || entry.remaining <= 0)
            return null;
        entry.remaining -= 1;
        return entry;
    }
    async drainBoundedRequestQueue() {
        for (;;) {
            const pending = this.requestQueue;
            await pending;
            const state = await this.loadState();
            if (pending !== this.requestQueue)
                continue;
            if (!isRecord(state) || state.abort)
                throw new Error("A queued browser request was blocked");
            return;
        }
    }
    async armBoundedMutationWindow() {
        this.assertEffectfulAdmissionOpen();
        // Anything received before this point remains pre-dispatch even if its queued
        // handler gets CPU later. Draining makes that denial observable before input.
        await this.drainBoundedRequestQueue();
        this.assertEffectfulAdmissionOpen();
        const action = this.activeAction;
        if (action?.action_class !== BOUNDED_ONBOARDING_CLASS)
            throw new Error("Bounded action disappeared before dispatch");
        this.assertEffectfulAdmissionOpen();
        action.bounded_click_dispatched = true;
        action.bounded_click_dispatch_generation = ++this.boundedClickDispatchGeneration;
        action.bounded_mutation_phase = "input-dispatch-through-after-evidence";
    }
    async closeBoundedMutationWindow() {
        if (this.activeAction?.action_class !== BOUNDED_ONBOARDING_CLASS)
            return;
        // Close before draining: requests received after after-evidence retain a
        // closed receipt phase and fail even if their handler runs before recordEvent.
        this.activeAction.bounded_mutation_phase = "closed";
        await this.drainBoundedRequestQueue();
    }
    async appendRequestEvent(event, receipt = null) {
        if (this.boundedPrivateAuthStart || receipt?.suppress_retention === true)
            return;
        await appendJsonl(join(this.runDirectory, "request-events.jsonl"), event);
    }
    async handlePausedRequest(message, receipt = null) {
        const params = eventParams(message);
        const requestId = params.requestId;
        const pausedRequest = params.request;
        const resourceType = params.resourceType;
        const eventSessionId = typeof message.sessionId === "string" && message.sessionId ? message.sessionId : undefined;
        if (this.calibrationNetworkActive) {
            this.calibrationGuard.request_attempted = true;
            await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
            this.calibrationGuard.all_requests_blocked_before_dispatch = true;
            return;
        }
        if (this.backgroundAbortLatched) {
            await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
            return;
        }
        let origin;
        let pausedUrl;
        try {
            const pausedUrlProbe = isRecord(pausedRequest) ? pausedRequest.url : undefined;
            if (typeof pausedUrlProbe !== "string")
                throw new Error("invalid_request_origin");
            pausedUrl = pausedUrlProbe;
            origin = normalizeOrigin(pausedUrl);
        }
        catch {
            await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
            await this.abort("invalid_request_origin", "Browser attempted a non-HTTP(S) network request");
            return;
        }
        const timestamp = monotonicSeconds();
        const pausedMethod = isRecord(pausedRequest) ? pausedRequest.method : undefined;
        const method = String(pausedMethod ?? "GET").toUpperCase();
        let privateClerkMutationLike = false;
        try {
            privateClerkMutationLike = /^\/v1\/client\/(?:sign_(?:ins|ups)(?:\/|$)|sessions\/)/.test(new URL(pausedUrl).pathname);
        }
        catch { }
        const receiptClerkPhase = receipt ? receipt.clerk_transport_phase : this.clerkTransportPhase;
        const receiptClerkSessionId = receipt ? receipt.clerk_transport_session : this.activeClerkSessionId;
        // The supervisor's configured origin is unknown-typed at this boundary; only a string
        // is passed on. Any other value behaves exactly as a mismatch (the callee refuses),
        // so omitting the optional property preserves behavior with no cast.
        const configuredClerkOrigin = this.config.clerk_auth?.frontend_api_origin;
        let clerkTransportMutation = this.config.clerk_auth
            ? isPermittedClerkMutation({
                rawUrl: pausedUrl,
                method,
                ...(typeof configuredClerkOrigin === "string" ? { frontendApiOrigin: configuredClerkOrigin } : {}),
                phase: receiptClerkPhase,
                activeSessionId: receiptClerkSessionId
            })
            // No clerk_auth in this run (anonymous or bring-your-own-session): still recognize
            // Clerk's own universally safe, phase-independent bootstrap calls (dev-browser identity
            // mint, its environment-sync tunnel) -- a target whose frontend merely loads clerk-js
            // client-side, with no session of ours to establish, must not have its whole run
            // aborted by them. Passing the request's own already-allowlisted origin as
            // frontendApiOrigin only widens the two phase-independent checks; the phase-gated
            // sign-in/session branches below still never match without a real ticket exchange.
            : isPermittedClerkMutation({ rawUrl: pausedUrl, method, frontendApiOrigin: origin, phase: null, activeSessionId: null });
        // Must be exactly null (not the `false` that `x && f(...)` produces when x is falsy) when
        // there is no clerk_auth: the check right below is `!== null`, so a `false` here would
        // wrongly enter the provisional-session branch and its `else` would clobber the correct
        // `clerkTransportMutation` result computed above back to false for every non-GET request.
        const provisionalSessionId = this.config.clerk_auth
            ? provisionalClerkBootstrapTouchSessionId({
                rawUrl: pausedUrl,
                method,
                ...(typeof configuredClerkOrigin === "string" ? { frontendApiOrigin: configuredClerkOrigin } : {}),
                phase: receiptClerkPhase
            })
            : null;
        let provisionalSessionToBind = null;
        if (provisionalSessionId !== null) {
            const receiptAttempt = receipt?.clerk_transport_attempt;
            const receiptBootstrapDeadline = receipt?.clerk_bootstrap_deadline_ms;
            const provisionalAllowed = receiptAttempt === this.clerkTransportAttempt &&
                typeof receiptBootstrapDeadline === "number" &&
                Number.isFinite(receiptBootstrapDeadline) &&
                Date.now() <= receiptBootstrapDeadline &&
                Date.now() <= this.absoluteDeadlineMs &&
                this.provisionalClerkSessionId === null &&
                this.provisionalClerkTouchCount === 0;
            if (provisionalAllowed) {
                provisionalSessionToBind = provisionalSessionId;
                clerkTransportMutation = true;
            }
            else {
                clerkTransportMutation = false;
            }
        }
        if (typeof resourceType === "string" && ["EventSource", "WebSocket", "Ping", "Beacon"].includes(resourceType)) {
            await this.appendRequestEvent({
                timestamp: isoNow(), outcome: "forbidden-channel-blocked-before-dispatch",
                url: privateClerkMutationLike ? undefined : sanitizeUrl(pausedUrl),
                private_transport: privateClerkMutationLike ? "clerk-session" : undefined,
                method, resource_type: resourceType
            }, receipt);
            await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
            await this.abort("forbidden_request_channel", "A forbidden request channel was blocked");
            return;
        }
        if (this.suppressedOrigins.has(origin)) {
            await mutateCapState(this.config.cap_state_path, (state) => {
                state.browser.blocked_origin_attempts += 1;
            });
            await this.appendRequestEvent({
                timestamp: isoNow(), outcome: "blocked-before-dispatch",
                url: privateClerkMutationLike ? undefined : sanitizeUrl(pausedUrl),
                private_transport: privateClerkMutationLike ? "clerk-session" : undefined,
                method, resource_type: resourceType
            }, receipt);
            await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
            return;
        }
        if (!this.allowedOrigins.has(origin)) {
            await this.appendRequestEvent({
                timestamp: isoNow(), outcome: "allowlist-breach-blocked-before-dispatch",
                url: privateClerkMutationLike ? undefined : sanitizeUrl(pausedUrl),
                private_transport: privateClerkMutationLike ? "clerk-session" : undefined,
                method, resource_type: resourceType
            }, receipt);
            await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
            await this.abort("request_origin_allowlist_breach", origin);
            return;
        }
        if (resourceType === "Document") {
            let exactDocumentUrl;
            try {
                exactDocumentUrl = new URL(pausedUrl).href;
            }
            catch {
                exactDocumentUrl = null;
            }
            if (isAuthFlowUrl(pausedUrl)) {
                await this.appendRequestEvent({
                    timestamp: isoNow(), outcome: "auth-flow-blocked-before-dispatch", private_transport: "auth-flow-navigation", method, resource_type: resourceType
                }, receipt);
                await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
                await this.abort("auth_flow_navigation_forbidden", "An authentication-flow navigation was blocked without retaining its route");
                return;
            }
            const scopeHref = this.boundedScopeHref;
            const boundedScopeExit = this.boundedOnboarding &&
                receipt?.phase === "input-dispatch-through-after-evidence" &&
                receipt?.action_id === this.activeAction?.bounded_action_id &&
                receipt?.generation === this.activeAction?.bounded_click_dispatch_generation &&
                origin === normalizeOrigin(typeof scopeHref === "string" ? scopeHref : "") &&
                exactDocumentUrl !== scopeHref;
            if (!(typeof exactDocumentUrl === "string" && this.activeNavigation?.allowed_urls.has(exactDocumentUrl)) && !boundedScopeExit) {
                await this.appendRequestEvent({
                    timestamp: isoNow(), outcome: "unobserved-navigation-blocked-before-dispatch", url: sanitizeUrl(pausedUrl), method, resource_type: resourceType
                }, receipt);
                await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
                await this.abort("unobserved_document_navigation", "A document navigation not bound to the configured start or an observed link was blocked");
                return;
            }
            if (this.activeNavigation)
                this.activeNavigation.last_url = exactDocumentUrl;
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && this.activeAction?.action_class === BOUNDED_ONBOARDING_CLASS && origin !== normalizeOrigin(typeof this.boundedScopeHref === "string" ? this.boundedScopeHref : "")) {
            await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
            await this.abort("unknown_mutation_request", "A bound-route action attempted an off-origin mutation", this.privateAuthUnknownMutationDiagnostic({ rawUrl: pausedUrl, origin, method, receipt }));
            return;
        }
        if (privateClerkMutationLike && !clerkTransportMutation) {
            await this.appendRequestEvent({
                timestamp: isoNow(), outcome: "unknown-mutation-blocked-before-dispatch",
                private_transport: "clerk-session", method, resource_type: resourceType
            }, receipt);
            await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
            await this.abort("unknown_mutation_request", "An unbound mutation-capable request was blocked", this.privateAuthUnknownMutationDiagnostic({ rawUrl: pausedUrl, origin, method, receipt }));
            return;
        }
        let matchedMutation = null;
        let privateAuthAdmission = null;
        if (!["GET", "HEAD", "OPTIONS"].includes(method) && !clerkTransportMutation) {
            const expected = isRecord(this.activeAction?.allowed_request) ? this.activeAction.allowed_request : null;
            let exactActualUrl = null;
            try {
                exactActualUrl = new URL(pausedUrl).href;
            }
            catch { }
            const persistedUrl = privateClerkMutationLike ? undefined : sanitizeUrl(pausedUrl);
            const boundedMutation = receipt?.phase === "input-dispatch-through-after-evidence" &&
                receipt?.action_id === this.activeAction?.bounded_action_id &&
                receipt?.generation === this.activeAction?.bounded_click_dispatch_generation &&
                origin === normalizeOrigin(typeof this.boundedScopeHref === "string" ? this.boundedScopeHref : "") &&
                Number(this.activeAction.same_origin_mutation_requests_dispatched) < 1;
            privateAuthAdmission = !boundedMutation
                ? this.admitPrivateAuthBootstrapMutation({ method, href: exactActualUrl, origin, receipt })
                : null;
            if (!boundedMutation && !privateAuthAdmission && (this.activeAction?.action_class !== "Listed own-account progress" ||
                this.activeAction.matched_write ||
                !expected ||
                expected.method !== method ||
                expected.url !== exactActualUrl)) {
                await this.appendRequestEvent({
                    timestamp: isoNow(), outcome: "unknown-mutation-blocked-before-dispatch", url: persistedUrl,
                    private_transport: privateClerkMutationLike ? "clerk-session" : undefined, method, resource_type: resourceType
                }, receipt);
                await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
                await this.abort("unknown_mutation_request", "An unbound mutation-capable request was blocked", this.privateAuthUnknownMutationDiagnostic({ rawUrl: pausedUrl, origin, method, receipt }));
                return;
            }
            matchedMutation = { method, url: exactActualUrl, ...(boundedMutation ? { bounded: true } : {}) };
        }
        const rolling = rollingCount(this.requestTimes, timestamp);
        let denied = false;
        await mutateCapState(this.config.cap_state_path, (state) => {
            denied = this.backgroundAbortLatched || Boolean(state.abort) || Date.now() >= Date.parse(state.working_day_deadline) || state.browser.requests + 1 > state.caps.browser_requests_total || rolling + 1 > state.caps.browser_requests_per_rolling_minute;
            if (!denied) {
                state.browser.requests += 1;
                state.browser.peak_requests_per_minute = Math.max(state.browser.peak_requests_per_minute, rolling + 1);
                if (privateAuthAdmission) {
                    // Only the owner-authored id is recorded here, never the request URL.
                    state.browser.auth_bootstrap_admissions = state.browser.auth_bootstrap_admissions ?? {};
                    state.browser.auth_bootstrap_admissions[privateAuthAdmission.id] = (state.browser.auth_bootstrap_admissions[privateAuthAdmission.id] ?? 0) + 1;
                }
            }
        });
        if (this.backgroundAbortLatched) {
            await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
            return;
        }
        if (denied) {
            await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
            if (!this.backgroundAbortLatched)
                await this.abort("browser_request_cap", "A request cap would be exceeded");
            return;
        }
        this.requestTimes.push(timestamp);
        if (provisionalSessionToBind !== null) {
            this.provisionalClerkSessionId = provisionalSessionToBind;
            this.provisionalClerkTouchCount = 1;
        }
        if (matchedMutation && this.activeAction) {
            this.activeAction.matched_write = true;
            this.activeAction.matched_request = matchedMutation;
            if (matchedMutation.bounded)
                this.activeAction.same_origin_mutation_requests_dispatched = Number(this.activeAction.same_origin_mutation_requests_dispatched) + 1;
        }
        const persistedUrl = clerkTransportMutation ? undefined : sanitizeUrl(pausedUrl);
        const matchedRequest = isRecord(this.activeAction?.matched_request) ? this.activeAction.matched_request : null;
        const matchedEffect = matchedRequest?.url === new URL(pausedUrl).href;
        await this.appendRequestEvent({
            timestamp: isoNow(),
            outcome: "allowed-dispatched",
            url: persistedUrl,
            private_transport: clerkTransportMutation ? "clerk-session" : undefined,
            method: pausedMethod,
            resource_type: resourceType,
            bound_effect_id: matchedEffect && !this.config.redact_private_effect_bindings ? this.activeAction.effect_id : undefined,
            bound_effect_class_id: matchedEffect && !this.config.redact_private_effect_bindings ? this.activeAction.effect_class_id : undefined,
            supervisor_authorized_mutation_match: matchedEffect && this.config.redact_private_effect_bindings ? true : undefined
        }, receipt);
        if (this.backgroundAbortLatched) {
            await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, eventSessionId);
            return;
        }
        await this.cdp.send("Fetch.continueRequest", { requestId }, eventSessionId);
    }
    async reserveFixedFixtureWorkerRequest() {
        if (!this.config.fixed_preflight_service_worker_request || this.fixtureWorkerReserved)
            return { ok: true };
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        const workerUrl = this.config.fixed_preflight_service_worker_request;
        if (!this.allowedOrigins.has(normalizeOrigin(workerUrl)))
            return refusal("fixture_worker_origin_not_allowed", "Fixed worker request origin is not allowed");
        const timestamp = monotonicSeconds();
        const rolling = rollingCount(this.requestTimes, timestamp);
        let denied = false;
        await mutateCapState(this.config.cap_state_path, (state) => {
            denied = this.backgroundAbortLatched || state.browser.requests + 1 > state.caps.browser_requests_total || rolling + 1 > state.caps.browser_requests_per_rolling_minute;
            if (!denied) {
                state.browser.requests += 1;
                state.browser.peak_requests_per_minute = Math.max(state.browser.peak_requests_per_minute, rolling + 1);
            }
        });
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        if (denied) {
            return refusal("browser_request_cap", "The fixed fixture worker request reservation would exceed a request cap");
        }
        this.fixtureWorkerReserved = true;
        this.requestTimes.push(timestamp);
        await this.appendRequestEvent({
            timestamp: isoNow(),
            outcome: "allowed-dispatch-pre-reserved",
            url: sanitizeUrl(workerUrl),
            method: "GET",
            resource_type: "ServiceWorker"
        });
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        return { ok: true };
    }
    async reserveOperation(request) {
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        const now = monotonicSeconds();
        const rolling = rollingCount(this.operationTimes, now);
        let denied = null;
        let resultingState;
        await mutateCapState(this.config.cap_state_path, (state) => {
            if (this.backgroundAbortLatched)
                denied = refusal("run_aborted", "The browser run is not live");
            else if (state.abort)
                denied = refusal("run_aborted", state.abort.code);
            else if (Date.now() >= Date.parse(state.working_day_deadline))
                denied = refusal("working_day_deadline", "Working-day deadline reached");
            else {
                if (!state.browser.started_at)
                    state.browser.started_at = now;
                state.browser.active_seconds = now - state.browser.started_at;
                if (state.browser.active_seconds > state.caps.browser_active_seconds)
                    denied = refusal("browser_time_cap", "Browser time cap reached");
                else if (state.browser.operations + 1 > state.caps.browser_operations_total)
                    denied = refusal("browser_operation_cap", "Browser operation cap reached");
                else if (rolling + 1 > state.caps.browser_operations_per_rolling_minute)
                    denied = refusal("browser_operation_rate_cap", "Browser operation rate cap reached");
            }
            if (!denied && request.action_class === "Listed own-account progress") {
                const ledgerClass = this.config.app_cost_ledger.allowed_one_way_classes.find((entry) => entry.id === request.effect_class_id);
                const registered = this.effectRegistry[String(request.effect_id)];
                if (!ledgerClass || registered !== request.effect_class_id)
                    denied = refusal("unproven_one_way_effect", "No owner-proven effect registry entry admits this action");
                else {
                    const count = state.app.class_counts[ledgerClass.id] ?? 0;
                    const reservation = ledgerClass.worst_case_eur_per_action;
                    if (count + 1 > ledgerClass.maximum_count || state.app.one_way_actions + 1 > state.caps.listed_one_way_actions_total)
                        denied = refusal("one_way_action_cap", "One-way action cap reached");
                    else if (state.app.actual_eur + state.app.outstanding_reservations_eur + reservation > state.caps.app_side_cost_cap_eur)
                        denied = refusal("app_cost_cap", "App-side cost cap would be exceeded");
                    else if (combinedReservedAndActual(state) + reservation > state.caps.combined_actual_plus_reserved_cap_eur)
                        denied = refusal("combined_cost_cap", "Combined cost cap would be exceeded");
                    else {
                        state.app.outstanding_reservations_eur += reservation;
                        state.app.one_way_actions += 1;
                        state.app.class_counts[ledgerClass.id] = count + 1;
                    }
                }
            }
            if (!denied && request.action_class === BOUNDED_ONBOARDING_CLASS) {
                const count = state.app.class_counts["bounded-own-account-bound-route-progress"] ?? 0;
                if (!this.boundedOnboarding || count + 1 > 20 || state.app.one_way_actions + 1 > 20 || state.app.one_way_actions + 1 > state.caps.listed_one_way_actions_total)
                    denied = refusal("one_way_action_cap", "Bound-route action cap reached");
                else {
                    state.app.one_way_actions += 1;
                    state.app.class_counts["bounded-own-account-bound-route-progress"] = count + 1;
                }
            }
            if (!denied) {
                state.browser.operations += 1;
                state.browser.peak_operations_per_minute = Math.max(state.browser.peak_operations_per_minute, rolling + 1);
                resultingState = structuredClone(state);
            }
        });
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        if (denied)
            return denied;
        this.operationTimes.push(now);
        return { ok: true, state: resultingState };
    }
    validateAction(request) {
        if (typeof request.method !== "string" || !ALLOWED_METHODS.has(request.method))
            return refusal("method_not_exposed", "The browser broker does not expose this operation");
        if (["ping", "metrics", "close"].includes(request.method))
            return { ok: true };
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        const expectedAction = {
            navigate: "Observe",
            observe: "Observe",
            scroll: "Observe",
            type: "Reversible own-account"
        };
        const expected = expectedAction[request.method];
        if (expected && request.action_class !== expected)
            return refusal("action_matrix_mismatch", `Operation requires ${expected}`);
        if (request.method === "click" && (typeof request.action_class !== "string" || !["Observe", "Reversible own-account", "Listed own-account progress", BOUNDED_ONBOARDING_CLASS].includes(request.action_class))) {
            return refusal("action_matrix_mismatch", "Click does not match an allowed row");
        }
        if (this.boundedOnboarding && (request.method === "type" || (request.method === "click" && request.action_class === "Observe")))
            return refusal("bounded_action_forbidden", "Typing and link-following are outside the bound route action boundary");
        if ((request.method === "type" || request.method === "scroll" || (request.method === "click" && request.action_class === "Observe")) &&
            !/^[0-9a-f]{64}$/.test(typeof request.observation_hash === "string" ? request.observation_hash : ""))
            return refusal("observation_binding_missing", "Explorer actions require the exact retained observation hash");
        return { ok: true };
    }
    async accessibilityObservation(exactUrl, providedTree = null) {
        const tree = providedTree ?? await this.cdp.send("Accessibility.getFullAXTree", { depth: 10 }, this.pageSessionId);
        this.refs.clear();
        const observedNodes = [];
        this.lastObservedNodes = observedNodes;
        const candidates = [];
        const treeNodes = Array.isArray(tree.nodes) ? tree.nodes : [];
        let sequence = 0;
        for (const node of treeNodes) {
            const nodeFields = isRecord(node) ? node : null;
            const nodeRole = isRecord(nodeFields?.role) ? nodeFields.role : null;
            if (nodeFields?.ignored || typeof nodeRole?.value !== "string")
                continue;
            const role = nodeRole.value;
            const nameField = isRecord(nodeFields?.name) ? nodeFields.name : null;
            const valueField = isRecord(nodeFields?.value) ? nodeFields.value : null;
            const name = String(nameField?.value ?? valueField?.value ?? "").replace(/\s+/g, " ").trim();
            if (!name && !["textbox", "searchbox", "button", "link"].includes(role))
                continue;
            const ref = `e${++sequence}`;
            const backendDOMNodeId = nodeFields?.backendDOMNodeId;
            if (backendDOMNodeId)
                this.refs.set(ref, { backendDOMNodeId, role, name });
            observedNodes.push({ ref, role, name });
            candidates.push({ ref, role, name, backendDOMNodeId });
            if (candidates.length >= 200)
                break;
        }
        // Real on-screen status per node: a chat-style surface keeps old turns mounted (scrolled off
        // the top) and can sit a modal over an exercise (the background stays laid out underneath) --
        // both are still "in the tree" but not what a person actually sees. Checked concurrently since
        // this CDP connection multiplexes commands by id.
        const send = (method, params) => this.cdp.send(method, params, this.pageSessionId);
        const onScreenFlags = await Promise.all(candidates.map((candidate) => isNodeOnScreen(send, candidate.backendDOMNodeId)));
        const lines = candidates.map((candidate, index) => formatAxLine(candidate.ref, candidate.role, candidate.name, { onScreen: onScreenFlags[index] }).slice(0, 500));
        return { url: exactUrl, visible_state_summary: lines.join("\n").slice(0, 30_000), refs: lines.length };
    }
    async observe() {
        const before = await this.privateNavigationSnapshot();
        if (isAuthFlowUrl(before.exactUrl))
            throw new Error("Auth-flow evidence retention is forbidden");
        const observation = await this.accessibilityObservation(before.exactUrl);
        const after = await this.privateNavigationSnapshot();
        if (!this.samePrivateNavigation(before, after))
            throw new Error("The page changed during observation");
        this.currentUrl = after.exactUrl;
        return observation;
    }
    async refreshCurrentUrlFromHistory() {
        const snapshot = await this.privateNavigationSnapshot();
        this.currentUrl = snapshot.exactUrl;
        return snapshot.exactUrl;
    }
    // Waits until the accessibility tree reads the same on two consecutive checks with a quiet
    // network in between, so a capture never freezes a mid-reveal frame of an evolving reply.
    // Bounded and best-effort: on timeout it returns null and the caller takes one fresh, final
    // snapshot rather than blocking evidence capture indefinitely.
    async waitForAccessibilitySettle(maxWaitMs = 2000, pollIntervalMs = 150) {
        const deadline = Math.min(Date.now() + maxWaitMs, this.absoluteDeadlineMs);
        let previousHash = null;
        let previousTree = null;
        while (Date.now() < deadline) {
            if (this.networkInflight.size === 0 && Date.now() - this.lastNetworkActivityAt >= POST_AUTH_NETWORK_QUIET_MS) {
                const tree = await this.cdp.send("Accessibility.getFullAXTree", {}, this.pageSessionId);
                const hash = hashAccessibilityTree(Array.isArray(tree.nodes) ? tree.nodes : []);
                if (hash === previousHash)
                    return tree;
                previousHash = hash;
                previousTree = tree;
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
        }
        return previousTree;
    }
    async captureEvidence(eventId, position, expectedNavigation = null) {
        if (this.firstPostAuthCapturePending &&
            this.postAuthReadinessConfirmed &&
            !(await this.privatePostAuthCertificateCurrent())) {
            await this.restartPrivatePostAuthReadiness();
            return this.captureEvidence(eventId, position, expectedNavigation);
        }
        const before = await this.privateNavigationSnapshot();
        if (expectedNavigation && !this.samePrivateNavigation(before, expectedNavigation))
            throw new Error("The bounded scope-exit destination changed before evidence");
        const initialLandingCapture = position === "after" && this.initialNavigationConsumed && !this.initialLandingIdentity;
        const privateInitialCapture = position === "after" &&
            this.initialNavigationConsumed &&
            Boolean(this.config.clerk_auth) &&
            !this.authLandingUrlSha256;
        if (privateInitialCapture) {
            if (isAuthFlowUrl(before.exactUrl)) {
                if (this.privateInitialAuthHandoff(before)) {
                    this.clearUnretainedObservation();
                    return PRIVATE_AUTH_HANDOFF;
                }
                throw new Error("Auth-flow evidence retention is forbidden");
            }
            if (!this.bindInitialLanding(before))
                throw new Error("The initial landing identity is unavailable");
        }
        else if (initialLandingCapture && !this.bindInitialLanding(before)) {
            throw new Error("The initial landing identity is unavailable");
        }
        else if (before.exactUrl.startsWith("http") && isAuthFlowUrl(before.exactUrl)) {
            throw new Error("Auth-flow evidence retention is forbidden");
        }
        if (this.firstPostAuthCapturePending && !this.isExactLanding(before)) {
            throw new Error("The authenticated landing changed before retained evidence");
        }
        let observationTree = null;
        if (this.firstPostAuthCapturePending && this.postAuthReadinessConfirmed) {
            observationTree = await this.cdp.send("Accessibility.getFullAXTree", {}, this.pageSessionId);
            const observationNodes = Array.isArray(observationTree.nodes) ? observationTree.nodes : [];
            if (hashAccessibilityTree(observationNodes) !== this.postAuthReadinessFingerprint?.axSha256) {
                await this.restartPrivatePostAuthReadiness();
                return this.captureEvidence(eventId, position, expectedNavigation);
            }
        }
        // Unbounded, matching every other observation-relevant accessibility fetch in this class
        // (the readiness fingerprint above, the pre-screenshot PII scan below, and the plain
        // "observe" RPC). A depth cap here made this the one inconsistent fetch, and depth in the
        // CDP Accessibility domain counts AX-tree levels, not meaningful nodes -- Expo/React Native
        // Web wraps real content in far more than 10 layers of unnamed generic Views, so a capped
        // fetch silently returned almost nothing after the very first (uncapped) observation.
        // Only the very first post-auth capture waits for the page to settle (above). Every later
        // capture used to snapshot immediately, which could catch a coach reply mid-reveal -- e.g. a
        // click's "after" evidence landing on a half-typed sentence while the very next plain
        // "observe" (moments later, once the model has replied) saw the same reply fully rendered,
        // breaking the trace's before/after continuity even though nothing was actually wrong. Give
        // every capture the same brief settle window the first one gets.
        observationTree ??= await this.waitForAccessibilitySettle() ?? await this.cdp.send("Accessibility.getFullAXTree", {}, this.pageSessionId);
        await this.assertPrivateIdentityAbsent(observationTree, [before.exactUrl]);
        const observation = await this.accessibilityObservation(before.exactUrl, observationTree);
        const beforeScreenshot = await this.privateNavigationSnapshot();
        if (!this.samePrivateNavigation(before, beforeScreenshot)) {
            if (privateInitialCapture && this.privateInitialAuthHandoff(beforeScreenshot)) {
                this.clearUnretainedObservation();
                return PRIVATE_AUTH_HANDOFF;
            }
            throw new Error("The page changed during observation");
        }
        if (this.firstPostAuthCapturePending && !this.isExactLanding(beforeScreenshot)) {
            throw new Error("The authenticated landing changed before retained evidence");
        }
        const sanitizedUrl = observation.url.startsWith("http") ? sanitizeUrl(observation.url) : observation.url;
        const observationHash = sha256Text(JSON.stringify({ url: sanitizedUrl, visible_state_summary: observation.visible_state_summary }));
        const relative = `screenshots/${eventId}-${position}.png`;
        const preScreenshotTree = await this.cdp.send("Accessibility.getFullAXTree", {}, this.pageSessionId);
        await this.assertPrivateIdentityAbsent(preScreenshotTree, [beforeScreenshot.exactUrl]);
        const captured = await this.cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, this.pageSessionId);
        const screenshotData = captured.data ?? "";
        if (typeof screenshotData !== "string")
            throw new Error("The screenshot capture is unavailable");
        if (this.firstPostAuthCapturePending &&
            this.postAuthReadinessConfirmed &&
            sha256Text(screenshotData) !== this.postAuthReadinessFingerprint?.screenshotSha256) {
            await this.restartPrivatePostAuthReadiness();
            return this.captureEvidence(eventId, position, expectedNavigation);
        }
        const afterScreenshot = await this.privateNavigationSnapshot();
        if (expectedNavigation && !this.samePrivateNavigation(afterScreenshot, expectedNavigation))
            throw new Error("The bounded scope-exit destination changed during evidence");
        if (this.firstPostAuthCapturePending &&
            this.postAuthReadinessConfirmed &&
            !this.samePrivateNavigation(beforeScreenshot, afterScreenshot)) {
            await this.restartPrivatePostAuthReadiness();
            return this.captureEvidence(eventId, position, expectedNavigation);
        }
        if (!this.samePrivateNavigation(beforeScreenshot, afterScreenshot)) {
            if (privateInitialCapture && this.privateInitialAuthHandoff(afterScreenshot)) {
                this.clearUnretainedObservation();
                return PRIVATE_AUTH_HANDOFF;
            }
            throw new Error("The page changed during screenshot capture");
        }
        if (this.firstPostAuthCapturePending && !this.isExactLanding(afterScreenshot)) {
            throw new Error("The authenticated landing changed during retained evidence");
        }
        if (this.firstPostAuthCapturePending &&
            this.postAuthReadinessConfirmed &&
            !(await this.privatePostAuthCertificateCurrent())) {
            await this.restartPrivatePostAuthReadiness();
            return this.captureEvidence(eventId, position, expectedNavigation);
        }
        if (this.firstPostAuthCapturePending &&
            this.postAuthReadinessConfirmed &&
            !this.sameCurrentPrivateNavigation(afterScreenshot)) {
            await this.restartPrivatePostAuthReadiness();
            return this.captureEvidence(eventId, position, expectedNavigation);
        }
        const absolute = join(this.runDirectory, relative);
        await writeFile(absolute, Buffer.from(screenshotData, "base64"), { mode: 0o600, flag: "wx" });
        const evidence = {
            url: sanitizedUrl,
            origin: sanitizedUrl.startsWith("http") ? normalizeOrigin(sanitizedUrl) : sanitizedUrl,
            visible_state_summary: observation.visible_state_summary,
            observation_hash: observationHash,
            screenshot_path: relative,
            screenshot_sha256: await sha256File(absolute)
        };
        this.lastEvidenceRawUrlSha256 = sha256Text(observation.url);
        this.lastEvidence = evidence;
        this.currentUrl = afterScreenshot.exactUrl;
        if (this.firstPostAuthCapturePending)
            this.firstPostAuthCapturePending = false;
        return evidence;
    }
    async calibrationPrivateState() {
        const before = await this.privateNavigationSnapshot();
        if (isAuthFlowUrl(before.exactUrl))
            throw new Error("Auth-flow evidence retention is forbidden");
        const [tree, storage, cookies] = await Promise.all([
            this.cdp.send("Accessibility.getFullAXTree", {}, this.pageSessionId),
            this.callPageFunction(CALIBRATION_PAGE_FUNCTIONS.storage),
            this.cdp.send("Storage.getCookies")
        ]);
        const after = await this.privateNavigationSnapshot();
        if (!this.samePrivateNavigation(before, after))
            throw new Error("The page changed during private calibration observation");
        const normalizedCookies = (Array.isArray(cookies.cookies) ? cookies.cookies : []).map((cookie) => {
            const fields = isRecord(cookie) ? cookie : null;
            return {
                name: fields?.name,
                value: fields?.value,
                domain: fields?.domain,
                path: fields?.path,
                expires: fields?.expires,
                size: fields?.size,
                httpOnly: fields?.httpOnly,
                secure: fields?.secure,
                session: fields?.session,
                sameSite: fields?.sameSite ?? null,
                priority: fields?.priority ?? null,
                partitionKey: fields?.partitionKey ?? null
            };
        }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        const storageFields = isRecord(storage) ? storage : null;
        return {
            raw_url_sha256: sha256Text(after.exactUrl),
            authenticated_landing_intact: this.config.clerk_auth ? this.isExactLanding(after) : true,
            accessibility_sha256: hashAccessibilityTree(Array.isArray(tree.nodes) ? tree.nodes : []),
            storage_sha256: sha256Text(JSON.stringify({ page: storageFields?.payload ?? null, cookies: normalizedCookies })),
            durable_storage_absent: storageFields?.durable_absent === true,
            storage_certain: storageFields?.certain === true,
            page_guard: storageFields?.guard ?? null
        };
    }
    async calibrationObservation(position) {
        const evidence = await this.captureEvidence("calibration", position);
        if (!isRecord(evidence))
            throw new Error("Auth-flow evidence retention is forbidden");
        const nodes = (this.lastObservedNodes ?? []).slice(0, 80).map((node) => ({
            ...node,
            role: sanitizeCalibrationText(node.role),
            name: sanitizeCalibrationText(node.name)
        }));
        const roles = nodes.map((node) => ({ role: node.role, accessibility_name: node.name }));
        const bindings = [];
        for (let index = 0; index < nodes.length && bindings.length < 30; index += 1) {
            const node = nodes[index];
            if (node.role !== "button" || !this.refs.has(node.ref))
                continue;
            const nearby = nodes.slice(Math.max(0, index - 3), index).map((entry) => entry.name).filter(Boolean);
            bindings.push({
                ref: node.ref,
                public: { role: "button", accessible_name: node.name, nearby_visible_text: nearby }
            });
        }
        const publicRunPath = String(this.config.calibration_probe?.public_run_path ?? "");
        if (!/^[A-Za-z0-9._/-]{1,240}$/.test(publicRunPath) || publicRunPath.startsWith("/") || publicRunPath.includes("..")) {
            throw new Error("Calibration screenshot path is invalid");
        }
        const publicValue = {
            url: evidence.url,
            roles,
            buttons: bindings.map((binding) => binding.public),
            screenshot: { path: `${publicRunPath}/${evidence.screenshot_path}`, sha256: evidence.screenshot_sha256 }
        };
        const observation = { ...publicValue, observation_sha256: sha256Text(JSON.stringify(publicValue)) };
        this.calibrationBindings = { observation, buttons: bindings };
        return observation;
    }
    calibrationSelectedButton(selection, expectedAction) {
        const expectedKeys = ["action", "observation_sha256", "role", "accessible_name", "nearby_visible_text"].sort();
        if (!isRecord(selection) || Array.isArray(selection) || Object.keys(selection).sort().join("\n") !== expectedKeys.join("\n"))
            return null;
        const bindingsRecord = isRecord(this.calibrationBindings) ? this.calibrationBindings : null;
        const boundObservation = isRecord(bindingsRecord?.observation) ? bindingsRecord.observation : null;
        if (selection.action !== expectedAction || selection.observation_sha256 !== boundObservation?.observation_sha256)
            return null;
        const buttons = bindingsRecord?.buttons ?? [];
        const matches = (Array.isArray(buttons) ? buttons : []).filter((binding) => {
            const bindingFields = isRecord(binding) ? binding : null;
            const publicFields = isRecord(bindingFields?.public) ? bindingFields.public : null;
            return (publicFields?.role === selection.role &&
                publicFields?.accessible_name === selection.accessible_name &&
                JSON.stringify(publicFields?.nearby_visible_text) === JSON.stringify(selection.nearby_visible_text));
        });
        return matches.length === 1 ? matches[0] : null;
    }
    async calibrationObserveStart() {
        if (!this.calibrationEnabled || this.calibrationBaseline)
            return refusal("calibration_state_invalid", "Calibration is unavailable");
        const continuation = await this.admitPrivateAuthContinuation();
        if (!continuation.ok)
            return continuation;
        const readiness = await this.confirmPrivatePostAuthReadiness();
        if (!readiness.ok)
            return readiness;
        if (this.config.clerk_auth) {
            let exactLanding = false;
            try {
                exactLanding = this.isExactLanding(await this.privateNavigationSnapshot());
            }
            catch { }
            if (!exactLanding)
                return refusal("calibration_start_url_changed", "The authenticated start URL changed");
        }
        const evidenceContinuation = await this.admitPrivateAuthContinuation();
        if (!evidenceContinuation.ok)
            return evidenceContinuation;
        let observation;
        try {
            observation = await this.calibrationObservation("authenticated-start");
        }
        catch (error) {
            const readinessRefusal = postAuthReadinessRefusalOf(error);
            if (readinessRefusal)
                return readinessRefusal;
            throw error;
        }
        const baseline = await this.calibrationPrivateState();
        const expectedLanding = this.config.clerk_auth
            ? this.authLandingUrlSha256
            : sha256Text(new URL(this.config.initial_url).href);
        if (baseline.raw_url_sha256 !== expectedLanding ||
            (this.config.clerk_auth && baseline.authenticated_landing_intact !== true)) {
            return refusal("calibration_start_url_changed", "The authenticated start URL changed");
        }
        this.calibrationBaseline = baseline;
        return { ok: true, observation };
    }
    async calibrationOpen(selection) {
        if (!this.calibrationEnabled || !this.calibrationBaseline || this.calibrationOpenState)
            return refusal("calibration_state_invalid", "Calibration is unavailable");
        let continuation = await this.admitPrivateAuthContinuation();
        if (!continuation.ok)
            return continuation;
        const selected = this.calibrationSelectedButton(selection, "probe");
        if (!selected)
            return refusal("calibration_selection_invalid", "The candidate is not exactly bound to the retained observation");
        const fresh = await this.calibrationPrivateState();
        const baseline = this.calibrationBaseline;
        if (["raw_url_sha256", "authenticated_landing_intact", "accessibility_sha256", "storage_sha256", "durable_storage_absent", "storage_certain"].some((key) => fresh[key] !== baseline[key])) {
            return refusal("calibration_observation_stale", "The candidate observation is stale");
        }
        this.calibrationGuard = { request_attempted: false, all_requests_blocked_before_dispatch: true };
        this.calibrationNetworkActive = true;
        const activated = await this.callPageFunction(CALIBRATION_PAGE_FUNCTIONS.activate, [], true);
        const activatedFields = isRecord(activated) ? activated : null;
        this.calibrationGuard.installation_complete = activatedFields?.activated === true && activatedFields?.installation_complete === true;
        continuation = await this.admitPrivateAuthContinuation();
        if (!continuation.ok)
            return continuation;
        await this.clickRef(selected.ref);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
        await this.requestQueue;
        continuation = await this.admitPrivateAuthContinuation();
        if (!continuation.ok)
            return continuation;
        const privateState = await this.calibrationPrivateState();
        const observation = await this.calibrationObservation("open");
        this.calibrationOpenState = privateState;
        return { ok: true, observation };
    }
    async calibrationReverse(selection) {
        if (!this.calibrationEnabled || !this.calibrationOpenState)
            return refusal("calibration_state_invalid", "Calibration is unavailable");
        let continuation = await this.admitPrivateAuthContinuation();
        if (!continuation.ok)
            return continuation;
        const selected = this.calibrationSelectedButton(selection, "reverse");
        if (!selected)
            return refusal("calibration_selection_invalid", "The reverse control is not exactly bound to the retained open observation");
        const fresh = await this.calibrationPrivateState();
        const openState = this.calibrationOpenState;
        if (["raw_url_sha256", "authenticated_landing_intact", "accessibility_sha256", "storage_sha256", "durable_storage_absent", "storage_certain"].some((key) => fresh[key] !== openState[key])) {
            return refusal("calibration_open_state_stale", "The open observation is stale");
        }
        continuation = await this.admitPrivateAuthContinuation();
        if (!continuation.ok)
            return continuation;
        await this.clickRef(selected.ref);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
        await this.requestQueue;
        continuation = await this.admitPrivateAuthContinuation();
        if (!continuation.ok)
            return continuation;
        const final = await this.calibrationPrivateState();
        const pageGuard = isRecord(final.page_guard) ? final.page_guard : null;
        const proof = evaluateCalibrationRestoration({
            baseline: this.calibrationBaseline,
            open: this.calibrationOpenState,
            final,
            guard: {
                ...this.calibrationGuard,
                transport_attempted: pageGuard?.transport_attempted === true,
                storage_mutation_attempted: pageGuard?.storage_mutation_attempted === true,
                installation_complete: this.calibrationGuard.installation_complete && pageGuard?.installation_complete === true
            }
        });
        return { ok: true, proof };
    }
    async issueActionToken(request) {
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        if (typeof request.action_class !== "string" || !["Reversible own-account", "Listed own-account progress", BOUNDED_ONBOARDING_CLASS].includes(request.action_class))
            return refusal("token_class_forbidden", "Only admitted clicks may receive a token");
        const ref = String(request.ref ?? "").replace(/^@/, "");
        const semantic = this.refs.get(ref);
        const evidence = this.lastEvidence;
        if (!evidence || !semantic)
            return refusal("token_binding_missing", "A current retained observation and semantic reference are required");
        const bounded = request.action_class === BOUNDED_ONBOARDING_CLASS;
        if (!bounded && (!request.effect_id || !request.effect_class_id)) {
            return refusal("token_effect_missing", "A click token requires a bound effect ID and effect class ID");
        }
        const rawExpectedRequest = request.expected_request;
        if (request.action_class === "Listed own-account progress" && !rawExpectedRequest) {
            return refusal("token_request_missing", "A listed-action token requires one bound mutation request");
        }
        const semanticRole = semantic?.role;
        if (bounded &&
            (!this.boundedOnboarding ||
                this.boundedScopeComplete ||
                !["button", "checkbox", "radio"].includes(typeof semanticRole === "string" ? semanticRole : "") ||
                request.bounded_progress_mutation_requests !== 1 ||
                this.lastEvidenceRawUrlSha256 !== this.boundedScopeRawUrlSha256 ||
                !(await this.boundedScopeIsCurrent())))
            return refusal("token_scope_invalid", "The bound route is not current");
        let expectedRequest = null;
        if (rawExpectedRequest) {
            const rawExpectedMethod = isRecord(rawExpectedRequest) ? rawExpectedRequest.method : undefined;
            const method = String(rawExpectedMethod ?? "").toUpperCase();
            if (!["POST", "PUT", "PATCH", "DELETE"].includes(method))
                return refusal("token_request_method_invalid", "Bound request must name one mutation-capable method");
            const rawExpectedUrl = isRecord(rawExpectedRequest) ? rawExpectedRequest.url : undefined;
            const exact = new URL(typeof rawExpectedUrl === "string" ? rawExpectedUrl : "");
            if (exact.hash)
                return refusal("token_request_url_invalid", "Bound request URL must not contain a fragment");
            expectedRequest = { method, url: exact.href };
            if (!this.allowedOrigins.has(normalizeOrigin(expectedRequest.url)))
                return refusal("token_request_origin_invalid", "Bound request origin is not allowed");
        }
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        const token = randomUUID();
        this.actionTokens.set(token, {
            url: evidence.url,
            observation_hash: evidence.observation_hash,
            ref,
            role: semantic.role,
            name: semantic.name,
            action_class: request.action_class,
            effect_id: request.effect_id ?? null,
            effect_class_id: request.effect_class_id ?? null,
            allowed_request: expectedRequest,
            same_origin_mutation_requests_dispatched: bounded ? 0 : null,
            bounded_click_dispatched: false,
            authorization_consumed_once: false,
            scope_href: bounded ? this.boundedScopeHref : null
        });
        return { ok: true, authorization_token: token };
    }
    consumeActionToken(request) {
        const authorizationToken = request.authorization_token;
        const token = typeof authorizationToken === "string" ? this.actionTokens.get(authorizationToken) : undefined;
        if (typeof authorizationToken === "string")
            this.actionTokens.delete(authorizationToken);
        const ref = String(request.ref ?? "").replace(/^@/, "");
        const semantic = this.refs.get(ref);
        if (!token ||
            !this.lastEvidence ||
            token.url !== this.lastEvidence.url ||
            token.observation_hash !== this.lastEvidence.observation_hash ||
            token.ref !== ref ||
            token.role !== semantic?.role ||
            token.name !== semantic?.name ||
            token.action_class !== request.action_class ||
            token.effect_id !== (request.effect_id ?? null) ||
            token.effect_class_id !== (request.effect_class_id ?? null) ||
            (token.action_class === BOUNDED_ONBOARDING_CLASS &&
                (request.bounded_progress_mutation_requests !== 1 ||
                    !["button", "checkbox", "radio"].includes(typeof semantic?.role === "string" ? semantic.role : "") ||
                    token.scope_href !== this.boundedScopeHref ||
                    this.lastEvidenceRawUrlSha256 !== this.boundedScopeRawUrlSha256)))
            return refusal("action_token_invalid", "Supervisor token is absent, stale, reused, or does not match the observed action");
        return { ok: true, binding: token };
    }
    async clickRef(ref, beforeDispatch = null) {
        const target = this.refs.get(String(ref).replace(/^@/, ""));
        if (!target)
            throw new Error("Unknown or stale semantic reference");
        this.assertEffectfulAdmissionOpen();
        await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendDOMNodeId }, this.pageSessionId);
        const box = await this.cdp.send("DOM.getBoxModel", { backendNodeId: target.backendDOMNodeId }, this.pageSessionId);
        const quad = isRecord(box.model) ? box.model.border : undefined;
        if (!Array.isArray(quad) || quad.length < 8)
            throw new Error("Element has no clickable box");
        const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
        if (beforeDispatch)
            await beforeDispatch();
        this.assertEffectfulAdmissionOpen();
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, this.pageSessionId);
        this.assertEffectfulAdmissionOpen();
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, this.pageSessionId);
    }
    async followObservedLink(ref) {
        const target = this.refs.get(String(ref).replace(/^@/, ""));
        if (!target || target.role !== "link")
            throw new Error("Observe-class click requires a visible link reference");
        const described = await this.cdp.send("DOM.describeNode", { backendNodeId: target.backendDOMNodeId, depth: 0 }, this.pageSessionId);
        const node = isRecord(described.node) ? described.node : null;
        const rawAttributes = node?.attributes;
        const attributeList = Array.isArray(rawAttributes) ? rawAttributes : [];
        const attributes = Object.fromEntries(Array.from({ length: attributeList.length / 2 }, (_, index) => [attributeList[index * 2], attributeList[index * 2 + 1]]));
        if (node?.localName !== "a" || !attributes.href || attributes.download !== undefined || (attributes.target && attributes.target !== "_self")) {
            throw new Error("Observe-class click is limited to an ordinary same-window anchor");
        }
        const href = attributes.href;
        if (typeof href !== "string")
            throw new Error("Observe-class click is limited to an ordinary same-window anchor");
        const destination = new URL(href, this.currentUrl).href;
        if (!this.allowedNavigationOrigins.has(normalizeOrigin(destination)))
            throw new Error("Observed link destination origin is not navigable");
        this.activeNavigation = { allowed_urls: new Set([destination]), last_url: null };
        this.assertEffectfulAdmissionOpen();
        await this.cdp.send("Page.navigate", { url: destination }, this.pageSessionId);
    }
    async execute(request, caller = "sandbox") {
        if (typeof request.method === "string" && ["calibration_observe_start", "calibration_open", "calibration_reverse"].includes(request.method)) {
            if (caller !== "supervisor" || !this.calibrationEnabled)
                return refusal("method_not_exposed", "Calibration methods are not exposed");
            if (request.method === "calibration_observe_start")
                return this.calibrationObserveStart();
            if (request.method === "calibration_open")
                return this.calibrationOpen(request.selection);
            return this.calibrationReverse(request.selection);
        }
        if (request.method === "authenticate_clerk_ticket") {
            if (caller !== "supervisor")
                return refusal("method_not_exposed", "Only the supervisor may authenticate Clerk");
            return this.authenticateClerkTicket(request);
        }
        if (request.method === "inspect_clerk_pre_auth") {
            if (caller !== "supervisor")
                return refusal("method_not_exposed", "Only the supervisor may inspect pre-authentication state");
            return this.inspectClerkPreAuth();
        }
        if (request.method === "bind_bounded_post_auth_route") {
            if (caller !== "supervisor")
                return refusal("method_not_exposed", "Only the supervisor may bind the authenticated route");
            return this.bindBoundedPostAuthRoute();
        }
        if (request.method === "install_transient_auth") {
            if (caller !== "supervisor")
                return refusal("method_not_exposed", "Only the supervisor may install transient authentication");
            return this.installTransientAuth(request);
        }
        if (request.method === "clear_transient_auth") {
            if (caller !== "supervisor")
                return refusal("method_not_exposed", "Only the supervisor may clear transient authentication");
            return this.clearTransientAuth();
        }
        if (request.method === "inspect_observed_control") {
            if (caller !== "supervisor")
                return refusal("method_not_exposed", "Only the supervisor may inspect a retained control binding");
            return this.inspectObservedControl(request);
        }
        if (request.method === "issue_action_token") {
            if (caller !== "supervisor")
                return refusal("method_not_exposed", "Only the supervisor may issue action tokens");
            return this.issueActionToken(request);
        }
        const validation = this.validateAction(request);
        if (!validation.ok)
            return validation;
        if (this.boundedOnboarding && this.boundedScopeComplete && request.method !== "metrics" && request.method !== "close")
            return refusal("scope_complete", "The run has already left its bound route");
        const privateBootstrapNavigation = caller === "supervisor" && request.method === "navigate" && Boolean(this.config.clerk_auth);
        if (this.boundedOnboarding && this.initialNavigationConsumed && !privateBootstrapNavigation && request.method !== "metrics" && request.method !== "close" && !(await this.boundedScopeIsCurrent())) {
            await this.abort("bounded_scope_not_current", "The exact bound route changed before an operation");
            return refusal("run_aborted", "The browser run is not live");
        }
        if (request.method === "ping") {
            return {
                ok: true,
                broker: BROKER_ID,
                operations: [...ALLOWED_METHODS].sort(),
                profile: "isolated-supervisor-owned",
                blocked_channels: ["service-worker", "dedicated-worker", "shared-worker", "websocket", "eventsource", "beacon", "webrtc", "webtransport"],
                unexpected_target_policy: "abort-and-close"
            };
        }
        if (request.method === "metrics") {
            return {
                ok: true,
                metrics: publicCapState(await this.loadState()),
                fixed_preflight_worker: this.config.fixed_preflight_service_worker_request
                    ? { reserved_before_navigation: Boolean(this.fixtureWorkerReserved), observed_target: Boolean(this.fixtureWorkerObserved) }
                    : null
            };
        }
        if (request.method === "close") {
            await this.shutdown();
            return { ok: true };
        }
        if (request.method === "navigate") {
            let exactUrl;
            try {
                const navigateUrl = request.url;
                exactUrl = new URL(typeof navigateUrl === "string" ? navigateUrl : "").href;
            }
            catch {
                exactUrl = null;
            }
            if (this.initialNavigationConsumed || exactUrl !== new URL(this.config.initial_url).href)
                return refusal("direct_navigation_locked", "Only the exact configured initial URL may be directly navigated once");
        }
        if (request.method === "click" && request.action_class === "Reversible own-account" && this.reversibleActionRegistry[String(request.effect_id)] !== request.effect_class_id) {
            return refusal("unproven_reversible_effect", "No supervisor-owned registry entry admits this reversible click");
        }
        let tokenBinding = null;
        if (request.method === "click" && request.action_class !== "Observe") {
            const consumed = this.consumeActionToken(request);
            if (!consumed.ok)
                return consumed;
            const consumedBinding = consumed.binding;
            if (!isRecord(consumedBinding))
                return refusal("action_token_invalid", "Supervisor token is absent, stale, reused, or does not match the observed action");
            tokenBinding = consumedBinding;
            tokenBinding.authorization_consumed_once = true;
        }
        const reserved = await this.reserveOperation(request);
        if (!reserved.ok)
            return reserved;
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        if (privateBootstrapNavigation)
            return this.privateClerkBootstrapNavigate(request);
        const readiness = await this.confirmPrivatePostAuthReadiness();
        if (!readiness.ok)
            return readiness;
        if (this.backgroundAbortLatched)
            return refusal("run_aborted", "The browser run is not live");
        const eventId = `event-${String(++this.eventSequence).padStart(4, "0")}`;
        let before;
        try {
            before = await this.captureEvidence(eventId, "before");
        }
        catch (error) {
            const readinessRefusal = postAuthReadinessRefusalOf(error);
            if (readinessRefusal)
                return readinessRefusal;
            if (error instanceof PrivateIdentityExposureError) {
                return refusal("private_identity_exposure", "Private identity exposure prevented evidence retention");
            }
            await this.abort("before_evidence_failed", "Before-state evidence could not be retained");
            return this.recordEvent(request, eventId, null, null, "unknown-terminal", "Before-state evidence failed", "unknown-terminal");
        }
        const requiresObservationBinding = request.method === "type" || request.method === "scroll" || (request.method === "click" && request.action_class === "Observe");
        const beforeFields = isRecord(before) ? before : null;
        if (requiresObservationBinding && request.observation_hash !== beforeFields?.observation_hash) {
            const recorded = await this.recordEvent(request, eventId, before, before, "control-observation-stale", "The page changed before the action reached the product", "none");
            return { ok: false, event: recorded.event, refusal: { code: "control_observation_stale", message: "The page changed before the action reached the product" } };
        }
        if (tokenBinding &&
            (tokenBinding.url !== beforeFields?.url ||
                tokenBinding.observation_hash !== beforeFields?.observation_hash ||
                tokenBinding.role !== (typeof tokenBinding.ref === "string" ? this.refs.get(tokenBinding.ref)?.role : undefined) ||
                tokenBinding.name !== (typeof tokenBinding.ref === "string" ? this.refs.get(tokenBinding.ref)?.name : undefined))) {
            await this.abort("action_token_stale_at_dispatch", "The page changed between supervisor authorization and retained before-state evidence");
            return this.recordEvent(request, eventId, before, null, "unknown-terminal", "Supervisor action token became stale before dispatch", "unknown-terminal");
        }
        let outcome = "observed";
        this.activeAction = tokenBinding
            ? {
                ...tokenBinding,
                action_class: tokenBinding.action_class,
                allowed_request: tokenBinding.allowed_request,
                matched_write: false,
                ...(request.action_class === BOUNDED_ONBOARDING_CLASS
                    ? { bounded_action_id: eventId, bounded_mutation_phase: "pre-input-dispatch" }
                    : {})
            }
            : { action_class: request.action_class, allowed_request: null, matched_write: false };
        try {
            if (request.method === "navigate") {
                this.initialNavigationConsumed = true;
                const workerReservation = await this.reserveFixedFixtureWorkerRequest();
                if (!workerReservation.ok)
                    return workerReservation;
                const rawNavigateUrl = request.url;
                const navigateHref = new URL(typeof rawNavigateUrl === "string" ? rawNavigateUrl : "").href;
                this.activeNavigation = { allowed_urls: new Set([navigateHref]), last_url: null };
                this.assertEffectfulAdmissionOpen();
                await this.cdp.send("Page.navigate", { url: typeof rawNavigateUrl === "string" ? rawNavigateUrl : "" }, this.pageSessionId);
                await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
                await this.requestQueue;
                outcome = "navigated";
                // An anonymous bounded run (no clerk_auth) never runs the Clerk landing-confirmation
                // loop that binds the scope for an authenticated run, and this is its one and only
                // allowed direct navigation (direct_navigation_locked forbids a second one) -- so bind
                // the scope here, to wherever the page actually landed.
                if (this.boundedOnboarding && !this.config.clerk_auth) {
                    // A saved-session run's own auth guard often redirects an unauthenticated visitor
                    // client-side (measured well over a second on a real target), not via an immediate
                    // server redirect -- so give it a real chance to settle before trusting the URL,
                    // rather than reading it right after the fixed short post-navigate pause above.
                    const landed = this.savedSessionConfig
                        ? await this.waitForSavedSessionLanding(Math.min(this.absoluteDeadlineMs, Date.now() + AUTH_LANDING_TIMEOUT_MS))
                        : await this.privateNavigationSnapshot();
                    // Verified here, not assumed: if the loaded cookies/storage did not actually
                    // authenticate this browser, the product's own auth guard redirected this first
                    // navigation to a sign-in-shaped URL. Fail closed rather than silently continuing
                    // to explore as a signed-out visitor -- that would produce a map that quietly
                    // claims to be authenticated when it is not.
                    if (this.savedSessionConfig && isAuthFlowUrl(landed.exactUrl)) {
                        await this.abort("saved_session_unauthenticated", "The saved session did not authenticate the initial navigation");
                        return refusal("saved_session_unauthenticated", "The saved session did not authenticate this run");
                    }
                    this.boundedScopeIdentity = landed;
                    this.boundedScopeHref = landed.exactUrl;
                    this.boundedScopeRawUrlSha256 = sha256Text(landed.exactUrl);
                    // The Clerk-authenticated path always waits here for the page to actually settle
                    // (network-quiet, accessibility tree and screenshot stable, no running animation)
                    // before the first evidence capture -- a real app can keep rendering well past the
                    // fixed short pause above. isExactLanding() already has a no-clerk_auth branch for
                    // exactly this case (it compares against boundedScopeHref/boundedScopeIdentity), so
                    // arming the same wait here reuses that existing readiness pipeline unchanged.
                    this.authLandingNavigationSequence = landed.logicalSequence;
                    this.authLandingUrlSha256 = this.boundedScopeRawUrlSha256;
                    this.firstPostAuthCapturePending = true;
                }
            }
            else if (request.method === "click") {
                if (request.action_class === "Observe")
                    await this.followObservedLink(request.ref);
                else
                    await this.clickRef(request.ref, request.action_class === BOUNDED_ONBOARDING_CLASS ? () => this.armBoundedMutationWindow() : null);
                await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
                await this.requestQueue;
                if (request.action_class === BOUNDED_ONBOARDING_CLASS && (await this.refreshCurrentUrlFromHistory()) !== this.boundedScopeHref) {
                    const destination = await this.confirmBoundedScopeExit();
                    if (!destination)
                        throw new Error("The destination outside the bound route did not settle");
                    this.boundedPendingScopeExit = destination;
                }
                outcome = "clicked";
            }
            else if (request.method === "type") {
                if (!request.synthetic || typeof request.text !== "string" || Buffer.byteLength(request.text) > 512)
                    throw new Error("Typing requires bounded synthetic text");
                const target = this.refs.get(String(request.ref).replace(/^@/, ""));
                if (!target || typeof target.role !== "string" || !["textbox", "searchbox"].includes(target.role))
                    throw new Error("Typing requires a visible text input reference");
                this.assertEffectfulAdmissionOpen();
                await this.cdp.send("DOM.focus", { backendNodeId: target.backendDOMNodeId }, this.pageSessionId);
                if (request.replace !== false) {
                    this.assertEffectfulAdmissionOpen();
                    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", modifiers: 2 }, this.pageSessionId);
                    this.assertEffectfulAdmissionOpen();
                    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", modifiers: 2 }, this.pageSessionId);
                }
                this.assertEffectfulAdmissionOpen();
                await this.cdp.send("Input.insertText", { text: request.text }, this.pageSessionId);
                outcome = "typed-unsent-synthetic-input";
            }
            else if (request.method === "scroll") {
                const delta = Math.max(-1000, Math.min(1000, Number(request.delta_y ?? 600)));
                this.assertEffectfulAdmissionOpen();
                await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: delta }, this.pageSessionId);
                outcome = "scrolled";
            }
            let after;
            try {
                after = await this.captureEvidence(eventId, "after", this.boundedPendingScopeExit);
            }
            catch (error) {
                if (error instanceof PrivateIdentityExposureError) {
                    return refusal("private_identity_exposure", "Private identity exposure prevented evidence retention");
                }
                await this.abort("after_evidence_failed", "After-state evidence could not be retained");
                return this.recordEvent(request, eventId, before, null, "unknown-terminal", "After-state evidence failed", "unknown-terminal");
            }
            if (request.action_class === BOUNDED_ONBOARDING_CLASS)
                await this.closeBoundedMutationWindow();
            const afterFields = isRecord(after) ? after : null;
            const changed = beforeFields && afterFields ? beforeFields.observation_hash !== afterFields.observation_hash : true;
            // Any action -- not just scroll -- can legitimately produce no visible change (a click on a
            // control that turns out to be a no-op, e.g. a disabled-looking button or one whose effect
            // needs state this run never reaches). Treating that as "solid" produced an internally
            // inconsistent event (a "solid" transition asserts a real change, checked at render time),
            // so match the change actually observed, not the requested action type.
            let transitionKind = request.method === "observe" || !changed ? "none" : "solid";
            const postActionState = await this.loadState();
            if (!isRecord(postActionState))
                throw new Error("Browser operation failed");
            if (postActionState.abort) {
                transitionKind = "unknown-terminal";
                outcome = "unknown-terminal";
            }
            else if (request.action_class === "Listed own-account progress" && (!this.activeAction.matched_write || !changed)) {
                transitionKind = "unknown-terminal";
                outcome = "unknown-terminal";
                await this.abort("listed_action_evidence_incomplete", "Listed action lacked matching request/effect and changed after-state evidence");
            }
            if (request.action_class === BOUNDED_ONBOARDING_CLASS && this.boundedPendingScopeExit) {
                // The screenshot is not enough: the page could navigate again between its
                // capture and our terminal decision.  Retain the same private navigation
                // identity that settled before evidence through this final refresh.
                const finalDestination = await this.privateNavigationSnapshot();
                if (!this.samePrivateNavigation(finalDestination, this.boundedPendingScopeExit)) {
                    throw new Error("The bounded scope-exit destination changed after evidence");
                }
                this.currentUrl = finalDestination.exactUrl;
                if (normalizeOrigin(finalDestination.exactUrl) === normalizeOrigin(this.config.initial_url)) {
                    // Still inside the target's own origin: confirmBoundedScopeExit() above only ever
                    // confirms a same-origin, non-auth destination (it returns null otherwise), so this
                    // is a route change within the product, not a real exit. Rebind the bound scope to
                    // the new route instead of ending the run, so exploration can keep going into the
                    // rest of the origin (a second surface, a second journey) rather than stopping the
                    // moment it first leaves the initial anchor route. The action-class/mutation
                    // boundary is untouched -- it is already origin-scoped, not route-scoped, elsewhere
                    // in this file, and stays exactly as strict as before.
                    this.boundedScopeIdentity = finalDestination;
                    this.boundedScopeHref = finalDestination.exactUrl;
                    this.boundedScopeRawUrlSha256 = sha256Text(finalDestination.exactUrl);
                }
                else {
                    // Off-origin is unreachable in practice (the origin allowlist blocks the navigation
                    // before it can be dispatched, and confirmBoundedScopeExit() would have returned
                    // null), but this keeps the original fail-closed behavior as a defense-in-depth
                    // fallback if that ever changes.
                    this.boundedScopeComplete = true;
                    outcome = "route-scope-exit";
                }
            }
            return this.recordEvent(request, eventId, before, after, outcome, null, transitionKind);
        }
        catch (error) {
            if ((isRecord(error) && error.backgroundAbortLatched) || this.backgroundAbortLatched) {
                return refusal("run_aborted", "The browser run is not live");
            }
            await this.abort("browser_operation_failed", "Browser operation failed");
            return this.recordEvent(request, eventId, before, null, "unknown-terminal", "Browser operation failed", "unknown-terminal");
        }
        finally {
            this.activeAction = null;
            this.activeNavigation = null;
            this.boundedPendingScopeExit = null;
        }
    }
    async recordEvent(request, eventId, before, after, outcome, detail, transitionKind) {
        // The execute() finally block clears the live action immediately after this async
        // method yields, so snapshot effect evidence before reading the cap ledger.
        const effectEvidence = request.action_class === BOUNDED_ONBOARDING_CLASS
            ? {
                supervisor_authorized: true,
                authorization_consumed_once: this.activeAction?.authorization_consumed_once === true,
                mutation_window: "input-dispatch-through-after-evidence",
                mutation_association: "temporal-only",
                same_origin_mutation_requests_dispatched: this.activeAction?.same_origin_mutation_requests_dispatched ?? 0,
                outside_window_mutation_policy: "block-and-abort"
            }
            : typeof request.action_class === "string" && ["Reversible own-account", "Listed own-account progress"].includes(request.action_class) && this.config.redact_private_effect_bindings
                ? {
                    supervisor_authorized: true,
                    mutation_request_match: request.action_class === "Listed own-account progress" ? Boolean(this.activeAction?.matched_request) : null
                }
                : typeof request.action_class === "string" && ["Reversible own-account", "Listed own-account progress"].includes(request.action_class)
                    ? {
                        effect_id: request.effect_id ?? null,
                        effect_class_id: request.effect_class_id ?? null,
                        matched_request: this.activeAction?.matched_request ?? null
                    }
                    : null;
        const state = await this.loadState();
        if (!isRecord(state))
            throw new Error("Browser operation failed");
        const browserState = isRecord(state.browser) ? state.browser : null;
        const appState = isRecord(state.app) ? state.app : null;
        const modelState = isRecord(state.model) ? state.model : null;
        if (!browserState || !appState || !modelState)
            throw new Error("Browser operation failed");
        const safeIntent = { method: request.method, ref: request.ref, delta_y: request.delta_y, text_bytes: typeof request.text === "string" ? Buffer.byteLength(request.text) : undefined };
        const beforeFields = isRecord(before) ? before : null;
        const afterFields = isRecord(after) ? after : null;
        const event = {
            run_id: this.config.run_id,
            event_id: eventId,
            timestamp: isoNow(),
            current_url: afterFields?.url ?? beforeFields?.url ?? null,
            current_origin: afterFields?.origin ?? beforeFields?.origin ?? null,
            visible_state_summary: afterFields?.visible_state_summary ?? beforeFields?.visible_state_summary ?? "unavailable",
            before,
            after,
            intended_action: safeIntent,
            effect_evidence: effectEvidence,
            action_matrix_class: request.action_class,
            observed_outcome: outcome,
            outcome_detail: detail,
            screenshot_path: afterFields?.screenshot_path ?? beforeFields?.screenshot_path ?? null,
            evidence_provenance: transitionKind === "unknown-terminal" ? "broker-refusal-or-unknown" : "direct-browser-observation",
            transition_kind: transitionKind,
            // Millisecond precision is already more than this figure needs; retaining the full
            // floating-point value let its arbitrary-looking tail of digits occasionally read as a
            // Luhn-valid card number to the packager's PII scanner (a real false positive, confirmed
            // 2026-09-04 -- e.g. 18.172163798008114 s), even though this is our own computed elapsed
            // time and can never contain scraped or user-entered data.
            elapsed_browser_seconds: Math.round(Number(field(browserState, "active_seconds")) * 1000) / 1000,
            cumulative_browser_actions: field(browserState, "operations"),
            cumulative_browser_requests: field(browserState, "requests"),
            cumulative_app_actual_eur: field(appState, "actual_eur"),
            cumulative_model_actual_eur: field(modelState, "actual_eur"),
            outstanding_cost_reservation_eur: Number(field(appState, "outstanding_reservations_eur")) + Number(field(modelState, "outstanding_reservations_eur"))
        };
        await appendJsonl(join(this.runDirectory, "observations.jsonl"), event);
        const ok = transitionKind !== "unknown-terminal";
        return { ok, event, ...(ok ? {} : { refusal: { code: outcome, message: detail } }) };
    }
    async shutdown() {
        const waitForChromeExit = async (timeoutMs) => {
            if (!this.chrome || this.chrome.exitCode !== null || this.chrome.signalCode !== null)
                return true;
            return new Promise((resolvePromise) => {
                const timer = setTimeout(() => {
                    this.chrome.off("exit", onExit);
                    resolvePromise(false);
                }, timeoutMs);
                const onExit = () => {
                    clearTimeout(timer);
                    resolvePromise(true);
                };
                this.chrome.once("exit", onExit);
            });
        };
        try {
            if (this.cdp) {
                const closing = this.cdp.send("Browser.close").catch(() => { });
                await Promise.race([closing, new Promise((resolvePromise) => setTimeout(resolvePromise, 100))]);
                this.cdp.close();
            }
        }
        catch { }
        // The CDP socket is closed above, so no further CDP events can enqueue new
        // background aborts past this point; draining here is safe and guarantees
        // no cap-state lockfile write is still in flight when the caller removes
        // the run directory.
        await this.drainBackgroundAbortTasks();
        if (!(this.boundedOnboarding && this.config.clerk_auth)) {
            if (this.chrome && this.chrome.exitCode === null)
                this.chrome.kill("SIGTERM");
            return;
        }
        if (await waitForChromeExit(1_000))
            return true;
        this.chrome.kill("SIGTERM");
        if (await waitForChromeExit(1_000))
            return true;
        this.chrome.kill("SIGKILL");
        return waitForChromeExit(1_000);
    }
}
const MAX_RETAINED_REFUSALS = 10;
// A refusal (validateAction/reserveOperation/policy checks returning `{ok:false,
// refusal:{code,...}}`) is distinct from abort() -- it doesn't latch state.abort, so
// without this it left no durable trace at all. This is the single point every broker
// response crosses back to the sandbox (see main() below), so it catches every refusal
// regardless of which internal check produced it. Retains only a sanitised code,
// operation type, and timestamp -- never the refusal message, a URL, or page content.
export async function recordRefusal(capStatePath, operation, code) {
    const entry = {
        code: typeof code === "string" && code ? code : "unknown_refusal",
        operation: typeof operation === "string" && operation ? operation : "unknown",
        timestamp: isoNow()
    };
    try {
        await mutateCapState(capStatePath, (state) => {
            state.browser ??= {};
            const refusals = Array.isArray(state.browser.refusals) ? state.browser.refusals : [];
            state.browser.refusals = [...refusals, entry].slice(-MAX_RETAINED_REFUSALS);
        });
    }
    catch { }
}
export async function announceBrowserBrokerReadiness(broker, output = process.stdout) {
    try {
        await broker.start();
        const message = { ready: true, broker: BROKER_ID };
        writeJsonLine(output, message);
        return { ok: true, message };
    }
    catch (error) {
        const errorDetail = isRecord(error) ? error.message : undefined;
        const message = { ready: false, broker: BROKER_ID, error: String(errorDetail).slice(0, 200) };
        writeJsonLine(output, message);
        return { ok: false, message, error };
    }
}
async function main() {
    const args = parseArgs();
    const configPath = args["--config"];
    if (!configPath)
        throw new Error("--config is required");
    const rawConfig = await readJson(configPath);
    if (!isBrokerConfig(rawConfig))
        throw new Error("The browser broker config is invalid");
    const broker = new BrowserBroker(rawConfig);
    const readiness = await announceBrowserBrokerReadiness(broker);
    if (readiness.ok) {
        let inboundQueue = Promise.resolve();
        attachJsonLineReader(process.stdin, (message) => {
            inboundQueue = inboundQueue.catch(() => { }).then(async () => {
                if (!isRecord(message))
                    throw new Error("The browser broker request is invalid");
                const payload = isRecord(message.payload) ? message.payload : {};
                let response;
                try {
                    response = await broker.execute(payload, typeof message.caller === "string" ? message.caller : "sandbox");
                }
                catch {
                    response = refusal("browser_broker_error", "The supervised browser request failed closed");
                }
                if (response?.ok === false && response.refusal?.code) {
                    const payloadMethod = payload.method;
                    await recordRefusal(rawConfig.cap_state_path, payloadMethod, response.refusal.code);
                }
                writeJsonLine(process.stdout, { rpc_id: message.rpc_id, response });
            });
        });
    }
    else {
        process.exitCode = 1;
    }
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, async () => {
            await broker.shutdown();
            process.exit(0);
        });
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await main();
