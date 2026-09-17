// Opt-in caller-side timing for the OpenCode visual-history plugin.
//
// Off by default. When RELEASHED_CALLER_TIMING_DIR is unset, withCallerTiming()
// returns the original transform reference and no extra hooks, files, or work.
// When set to a separate absolute directory, each supported hook appends one
// metadata-only JSONL receipt per firing. No prompts, images, URLs, headers,
// args, error strings, provider keys, or raw payloads are ever persisted;
// session/message/call identifiers are SHA-256 hashed before persistence.
//
// Supported OpenCode 1.18.30 hooks only (see installed
// @opencode-ai/plugin/dist/index.d.ts). There is no true request-send or
// first-token hook, so request-preparation markers and first-observed-response
// markers are client-observed boundaries, never inference/TTFT. Durations are
// recorded only for genuinely measured spans (awaited transform execution,
// tool before->after interval); marker events carry timestamps, not durations.
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, } from "node:path";
import { realpathSync } from "node:fs";
export const CALLER_TIMING_DIR_ENV = "RELEASHED_CALLER_TIMING_DIR";
export const CALLER_TIMING_VERSION = 1;
export const CALLER_TIMING_FILENAME = "caller-timing.jsonl";
// Visual-history paths receipts must never live under (separate telemetry dir).
const LEDGER_DIR_ENV = "RELEASHED_VISUAL_HISTORY_DIR";
const SCREENSHOT_ROOT_ENV = "RELEASHED_VISUAL_HISTORY_SCREENSHOT_ROOT";
// Static hook/marker enums. Receipts carry only these labels plus numeric
// timestamps, opaque hashes, and measured durations.
export const CALLER_TIMING_HOOKS = [
    "transform",
    "chat.params",
    "tool.execute.before",
    "tool.execute.after",
    "event",
];
export const CALLER_TIMING_MARKERS = [
    "transform-execution",
    "request-preparation",
    "tool-interval",
    "tool-interval-start",
    "tool-interval-end",
    "first-response-activity",
    "message-completion",
    "session-idle",
];
const MAX_TRACKED_MESSAGES = 2000;
const MAX_TOOL_STARTS = 1000;
function hashId(value) {
    if (typeof value !== "string" || value === "")
        return undefined;
    return createHash("sha256").update(value, "utf8").digest("hex");
}
/** Lexical path containment (assumes absolute, normalized inputs). */
function containsPath(parent, child) {
    if (parent === child)
        return true;
    const rel = relative(parent, child);
    return (rel !== "" &&
        rel !== ".." &&
        !rel.startsWith(`..${sep}`) &&
        !isAbsolute(rel));
}
/** Resolve symlinks via the nearest existing ancestor, so non-existent leaf
 * dirs still compare correctly against symlinked roots (/tmp -> /private/tmp). */
function deref(path) {
    const absolute = resolve(path);
    let current = absolute;
    const leaves = [];
    for (;;) {
        try {
            return join(realpathSync(current), ...leaves.reverse());
        }
        catch {
            const parent = dirname(current);
            if (parent === current)
                return absolute;
            leaves.push(basename(current));
            current = parent;
        }
    }
}
function overlapsSensitiveDir(dir, env) {
    const candidates = [
        env[LEDGER_DIR_ENV] ?? "",
        env[SCREENSHOT_ROOT_ENV] ?? "",
    ];
    for (const raw of candidates) {
        const trimmed = raw.trim();
        if (trimmed === "" || !isAbsolute(trimmed))
            continue;
        const other = deref(trimmed);
        if (containsPath(other, dir) || containsPath(dir, other))
            return true;
    }
    return false;
}
function boundedSet(map, key, value, max) {
    if (!map.has(key) && map.size >= max) {
        const oldest = map.keys().next();
        if (!oldest.done)
            map.delete(oldest.value);
    }
    map.set(key, value);
}
export function createCallerTiming(deps = {}) {
    const env = deps.env ?? process.env;
    const clock = deps.clock ?? (() => performance.now());
    const utcNow = deps.utcNow ?? (() => Date.now());
    const instance = deps.instance ?? randomUUID();
    let warned = false;
    const warnOnce = (message) => {
        if (warned)
            return;
        warned = true;
        (deps.warn ?? ((m) => process.stderr.write(`${m}\n`)))(message);
    };
    const disabled = (message) => {
        if (message !== undefined)
            warnOnce(message);
        const noop = () => { };
        return {
            enabled: false,
            instance,
            write: noop,
            clock,
            utcNow,
            warnOnce,
            seenMessages: new Map(),
            completedMessages: new Map(),
            toolStarts: new Map(),
        };
    };
    const rawDir = (env[CALLER_TIMING_DIR_ENV] ?? "").trim();
    if (rawDir === "")
        return disabled();
    if (!isAbsolute(rawDir)) {
        return disabled(`${CALLER_TIMING_DIR_ENV} must be a separate absolute directory; got a non-absolute value. ` +
            `Caller timing is off. Capture continues without caller timing.`);
    }
    const dir = deref(rawDir);
    if (overlapsSensitiveDir(dir, env)) {
        return disabled(`${CALLER_TIMING_DIR_ENV} must be a separate directory outside the visual-history ledger and screenshot root. ` +
            `Caller timing is off. Capture continues without caller timing.`);
    }
    // One shared fail-open path for injected and filesystem writers: on any
    // write failure telemetry turns itself off (maps cleared so hooks skip
    // further timing work) with one static warning. Capture never fails.
    const state = {
        enabled: true,
        instance,
        write: () => { },
        clock,
        utcNow,
        warnOnce,
        seenMessages: new Map(),
        completedMessages: new Map(),
        toolStarts: new Map(),
    };
    let failed = false;
    const failOpen = () => {
        if (failed)
            return;
        failed = true;
        state.enabled = false;
        state.seenMessages.clear();
        state.completedMessages.clear();
        state.toolStarts.clear();
        warnOnce(`${CALLER_TIMING_DIR_ENV} receipts could no longer be written. ` +
            `Caller timing is off. Capture continues without caller timing.`);
    };
    const guardWrite = (writeOne) => {
        return (receipt) => {
            if (failed)
                return;
            try {
                writeOne(receipt);
            }
            catch {
                failOpen();
            }
        };
    };
    // Injected writer (tests) takes precedence; no filesystem use.
    if (deps.writer !== undefined) {
        const inner = deps.writer;
        state.write = guardWrite((receipt) => {
            inner(receipt);
        });
        return state;
    }
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    catch {
        return disabled(`${CALLER_TIMING_DIR_ENV} directory could not be created. ` +
            `Caller timing is off. Capture continues without caller timing.`);
    }
    const file = resolve(dir, `caller-timing-${process.pid}-${instance.slice(0, 8)}.jsonl`);
    state.write = guardWrite((receipt) => {
        appendFileSync(file, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    });
    return state;
}
function emit(state, receipt) {
    if (!state.enabled)
        return;
    try {
        state.write({
            v: CALLER_TIMING_VERSION,
            instance: state.instance,
            utc: state.utcNow(),
            ...receipt,
        });
    }
    catch {
        // Telemetry must never fail capture or override capture errors.
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
/**
 * Hashed session/message correlation from transform output message metadata
 * only (info.sessionID/info.id strings; never payload contents). Returned
 * only when every message with a session agrees on one session; otherwise
 * neither field is returned rather than fabricating concurrent correlation.
 */
function transformCorrelation(args) {
    for (const arg of args) {
        if (!isRecord(arg) || !Array.isArray(arg["messages"]))
            continue;
        const sessions = new Set();
        let lastId;
        for (const item of arg["messages"]) {
            if (!isRecord(item) || !isRecord(item["info"]))
                continue;
            const info = item["info"];
            if (typeof info["sessionID"] === "string" && info["sessionID"] !== "") {
                sessions.add(info["sessionID"]);
            }
            if (typeof info["id"] === "string" && info["id"] !== "")
                lastId = info["id"];
        }
        if (sessions.size !== 1 || lastId === undefined)
            return {};
        const session = hashId([...sessions][0]);
        const message = hashId(lastId);
        return {
            ...(session === undefined ? {} : { session }),
            ...(message === undefined ? {} : { message }),
        };
    }
    return {};
}
/** Wrap the awaited transform: measure execution, record status, rethrow exactly. */
export function wrapTransformWithTiming(transform, state) {
    if (!state.enabled)
        return transform;
    const wrapped = async (...args) => {
        // Telemetry disabled mid-flight: pass through with zero timing work.
        if (!state.enabled)
            return transform(...args);
        // A failing telemetry clock must never skip the transform or replace its error.
        let start;
        try {
            start = state.clock();
        }
        catch {
            start = undefined;
        }
        let status = "succeeded";
        try {
            await transform(...args);
        }
        catch (error) {
            status = "refused";
            throw error;
        }
        finally {
            try {
                // Clock the awaited transform only; telemetry IO below is not included.
                const end = state.clock();
                emit(state, {
                    hook: "transform",
                    marker: "transform-execution",
                    ...(start === undefined ? {} : { t_start: start }),
                    t_end: end,
                    ...(start === undefined
                        ? {}
                        : { duration_ms: Math.max(0, end - start) }),
                    status,
                    ...transformCorrelation(args),
                });
            }
            catch {
                // Telemetry must never fail capture or override capture errors.
            }
        }
    };
    return wrapped;
}
function handleChatParams(state, input) {
    if (!state.enabled)
        return;
    // Request-preparation marker only: hook duration is not dispatch, wire, or inference time.
    const record = isRecord(input) ? input : undefined;
    const session = record === undefined ? undefined : hashId(record["sessionID"]);
    const message = record !== undefined && isRecord(record["message"])
        ? hashId(record["message"]["id"])
        : undefined;
    emit(state, {
        hook: "chat.params",
        marker: "request-preparation",
        t_start: state.clock(),
        ...(session === undefined ? {} : { session }),
        ...(message === undefined ? {} : { message }),
    });
}
/** Composite tool-start key: call IDs may repeat across concurrent sessions. */
function toolStartKey(session, call) {
    if (call === undefined)
        return undefined;
    return `${session ?? ""}\0${call}`;
}
function handleToolBefore(state, input) {
    if (!state.enabled || !isRecord(input))
        return;
    const session = hashId(input["sessionID"]);
    const call = hashId(input["callID"]);
    const now = state.clock();
    const key = toolStartKey(session, call);
    if (key !== undefined)
        boundedSet(state.toolStarts, key, now, MAX_TOOL_STARTS);
    emit(state, {
        hook: "tool.execute.before",
        marker: "tool-interval-start",
        t_start: now,
        ...(session === undefined ? {} : { session }),
        ...(call === undefined ? {} : { call }),
    });
}
function handleToolAfter(state, input) {
    if (!state.enabled || !isRecord(input))
        return;
    const session = hashId(input["sessionID"]);
    const call = hashId(input["callID"]);
    const now = state.clock();
    // Client-observed combined tool interval (transport + server/product), not server duration.
    const key = toolStartKey(session, call);
    const start = key === undefined ? undefined : state.toolStarts.get(key);
    if (key !== undefined)
        state.toolStarts.delete(key);
    emit(state, {
        hook: "tool.execute.after",
        marker: start === undefined ? "tool-interval-end" : "tool-interval",
        t_start: start ?? now,
        t_end: now,
        ...(start === undefined ? {} : { duration_ms: Math.max(0, now - start) }),
        ...(session === undefined ? {} : { session }),
        ...(call === undefined ? {} : { call }),
    });
}
/** Release first-delta/completion dedupe and unmatched tool starts for one session (session idle). */
export function releaseSession(state, sessionHash) {
    for (const [message, session] of state.seenMessages) {
        if (session === sessionHash)
            state.seenMessages.delete(message);
    }
    for (const [message, session] of state.completedMessages) {
        if (session === sessionHash)
            state.completedMessages.delete(message);
    }
    const prefix = `${sessionHash}\0`;
    for (const key of state.toolStarts.keys()) {
        if (key.startsWith(prefix))
            state.toolStarts.delete(key);
    }
}
function handleEvent(state, input) {
    if (!state.enabled || !isRecord(input))
        return;
    const event = input["event"];
    if (!isRecord(event) || typeof event["type"] !== "string")
        return;
    const props = isRecord(event["properties"]) ? event["properties"] : undefined;
    if (props === undefined)
        return;
    const type = event["type"];
    // OpenCode 1.18.30's v2 SDK emits standalone deltas (the legacy SDK puts
    // delta on message.part.updated). Only read the non-empty text-field signal;
    // this event does not identify whether the part is text or reasoning.
    if (type === "message.part.delta") {
        if (props["field"] !== "text" ||
            typeof props["delta"] !== "string" ||
            props["delta"] === "")
            return;
        const message = hashId(props["messageID"]);
        const session = hashId(props["sessionID"]);
        if (message === undefined ||
            state.seenMessages.has(message) ||
            state.completedMessages.has(message))
            return;
        boundedSet(state.seenMessages, message, session ?? "", MAX_TRACKED_MESSAGES);
        emit(state, {
            hook: "event",
            marker: "first-response-activity",
            t_start: state.clock(),
            ...(session === undefined ? {} : { session }),
            message,
        });
        return;
    }
    if (type === "message.part.updated") {
        // First text/reasoning DELTA per message only; never every streaming token.
        const part = isRecord(props["part"])
            ? props["part"]
            : undefined;
        const delta = props["delta"];
        if (part === undefined || typeof delta !== "string" || delta === "")
            return;
        const kind = part["type"];
        if (kind !== "text" && kind !== "reasoning")
            return;
        const message = hashId(part["messageID"]);
        const session = hashId(part["sessionID"]);
        if (message === undefined)
            return;
        if (state.seenMessages.has(message) || state.completedMessages.has(message))
            return;
        // First observed response activity for this message; may not be the model's first token.
        boundedSet(state.seenMessages, message, session ?? "", MAX_TRACKED_MESSAGES);
        emit(state, {
            hook: "event",
            marker: "first-response-activity",
            t_start: state.clock(),
            ...(session === undefined ? {} : { session }),
            message,
            part: kind,
        });
        return;
    }
    if (type === "message.updated") {
        // Coalesce completion once per assistant message, and only on a recorded
        // completion: creation-time firings carry time.created without
        // time.completed and must neither emit nor dedupe, or they would suppress
        // the later first delta. The native completion value is only a gate; the
        // receipt timestamp stays the client-observed event receipt time.
        const info = isRecord(props["info"])
            ? props["info"]
            : undefined;
        if (info === undefined || info["role"] !== "assistant")
            return;
        const time = isRecord(info["time"])
            ? info["time"]
            : undefined;
        const completed = time === undefined ? undefined : time["completed"];
        if (typeof completed !== "number" || !Number.isFinite(completed))
            return;
        const message = hashId(info["id"]);
        const session = hashId(info["sessionID"]);
        if (message === undefined)
            return;
        if (state.completedMessages.has(message))
            return;
        boundedSet(state.completedMessages, message, session ?? "", MAX_TRACKED_MESSAGES);
        emit(state, {
            hook: "event",
            marker: "message-completion",
            t_start: state.clock(),
            ...(session === undefined ? {} : { session }),
            message,
        });
        return;
    }
    if (type === "session.idle") {
        const session = hashId(props["sessionID"]);
        if (session !== undefined)
            releaseSession(state, session);
        emit(state, {
            hook: "event",
            marker: "session-idle",
            t_start: state.clock(),
            ...(session === undefined ? {} : { session }),
        });
        return;
    }
    if (type === "session.status") {
        const status = props["status"];
        const idle = status === "idle" || (isRecord(status) && status["type"] === "idle");
        if (!idle)
            return;
        const session = hashId(props["sessionID"]);
        if (session !== undefined)
            releaseSession(state, session);
        emit(state, {
            hook: "event",
            marker: "session-idle",
            t_start: state.clock(),
            ...(session === undefined ? {} : { session }),
        });
        return;
    }
    // All other event shapes are unfamiliar: ignore without affecting the caller.
}
function safeHook(fn) {
    return (...args) => {
        try {
            const result = fn(...args);
            if (result instanceof Promise)
                return result.catch(() => { });
            return Promise.resolve();
        }
        catch {
            // Malformed hook payloads never override existing capture errors.
            return Promise.resolve();
        }
    };
}
/**
 * Build the plugin hooks around an existing transform. When timing is off,
 * returns only the original transform reference. Never alters outputs, args,
 * or messages; hook bodies observe hashed identifiers and numeric timestamps.
 */
export function withCallerTiming(transform, deps = {}) {
    const state = createCallerTiming(deps);
    if (!state.enabled) {
        return {
            "experimental.chat.messages.transform": transform,
        };
    }
    return {
        "experimental.chat.messages.transform": wrapTransformWithTiming(transform, state),
        "chat.params": safeHook(((input) => {
            handleChatParams(state, input);
        })),
        "tool.execute.before": safeHook(((input) => {
            handleToolBefore(state, input);
        })),
        "tool.execute.after": safeHook(((input) => {
            handleToolAfter(state, input);
        })),
        event: safeHook(((input) => {
            handleEvent(state, input);
        })),
    };
}
