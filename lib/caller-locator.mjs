// Server-side target grounding for caller-driven capture (lib/explore-mcp.mjs).
//
// The caller names WHAT in plain English; this module locates WHERE on the exact
// observed screenshot bytes through the installed Midscene package, aiLocate-only:
// the locator never acts. lib/explore-mcp.mjs dispatches only its own controlled
// inputs at a validated point, and never falls back to caller coordinates when
// grounding fails.
//
// Binding: the injected uiContext is built from the observation's own PNG bytes,
// whose sha256 and IHDR dimensions are re-verified here before any model call, so
// a coordinate is by construction bound to that observation -- Midscene never
// re-screenshots. Midscene's prompt-text cache is disabled (cacheable: false) so a
// locate can never return coordinates found on an earlier screen.
import { createHash } from "node:crypto";
export const LOCATOR_ENV_VAR = "RELEASHED_LOCATOR";
export const LOCATOR_MIDSCENE = "midscene";
// Upper bound for one locate call. The caller additionally caps this at the
// remaining acquisition budget; a locate that outlives the window is discarded
// and never dispatched ("no orphan locator actions after deadline").
export const DEFAULT_LOCATOR_TIMEOUT_MS = 120_000;
// Upper bound for agent teardown after a locate settles or times out. Teardown
// must never hold the run past its own deadline: it is raced, and its errors
// are swallowed because report flushing must not fail a grounding result.
export const DESTROY_GRACE_MS = 5_000;
// Explicit supported configuration only. No defaults are guessed and there is no
// Gemini/API-key gate: whatever MIDSCENE_MODEL_* names (for example the verified
// codex://app-server + gpt-5.6-sol + gpt-5 combination) is passed through to the
// installed package, which reports its own auth/model errors.
export function resolveLocatorConfig(env) {
    const raw = (env[LOCATOR_ENV_VAR] ?? "").trim();
    if (!raw)
        return {
            enabled: false,
            reason: `${LOCATOR_ENV_VAR} is unset: the caller supplies coordinates and no locator model is used`,
        };
    if (raw !== LOCATOR_MIDSCENE)
        return {
            enabled: false,
            reason: `unknown ${LOCATOR_ENV_VAR} "${raw}": want "${LOCATOR_MIDSCENE}" or unset`,
        };
    const missing = ["MIDSCENE_MODEL_BASE_URL", "MIDSCENE_MODEL_NAME", "MIDSCENE_MODEL_FAMILY"].find((key) => !(env[key] ?? "").trim());
    if (missing)
        return {
            enabled: false,
            reason: `${LOCATOR_ENV_VAR}=midscene needs ${missing} set; no model or login is guessed`,
        };
    return {
        enabled: true,
        config: {
            baseUrl: (env.MIDSCENE_MODEL_BASE_URL ?? "").trim(),
            modelName: (env.MIDSCENE_MODEL_NAME ?? "").trim(),
            modelFamily: (env.MIDSCENE_MODEL_FAMILY ?? "").trim(),
        },
    };
}
// PNG dimensions straight from the IHDR chunk: the mapping Midscene needs, read
// off the same bytes whose hash the evidence already seals.
export function pngDimensions(png) {
    if (png.length < 24)
        return null;
    if (png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a)
        return null;
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return null;
    return { width, height };
}
// Lazily loaded so coordinate-mode runs never import the Midscene packages.
export async function defaultLocatorFactories() {
    const [{ ScreenshotItem }, { PlaywrightAgent }] = await Promise.all([
        import("@midscene/core"),
        import("@midscene/web/playwright"),
    ]);
    return {
        createAgent: (page) => 
        // No report litter beside the run: grounding evidence stays in our own trace.
        new PlaywrightAgent(page, { generateReport: false }),
        createScreenshotItem: (base64, capturedAt) => ScreenshotItem.create(base64, capturedAt),
    };
}
// Cancellation limit of the installed package (verified against
// @midscene/core 1.12.3): Agent.aiLocate(prompt, opt) forwards only
// opt.uiContext to the task runner and drops opt.abortSignal -- abort is
// plumbed from runPlans down to the codex app-server transport, but the
// aiLocate entry point cannot carry it, so passing a signal would be a false
// promise. Timeout is therefore a bounded race with discard: the late answer
// is never dispatched. Agent creation runs inside the same deadline, and
// teardown is grace-bounded, so no locator phase can hold past the budget.
export class LocateTimeoutError extends Error {
    timeoutMs;
    constructor(timeoutMs) {
        super(`locator timed out after ${timeoutMs}ms`);
        this.timeoutMs = timeoutMs;
    }
}
async function withDeadline(ms, work) {
    let timer;
    try {
        return await Promise.race([
            work(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new LocateTimeoutError(ms)), Math.max(1, ms));
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
async function destroyGracefully(agent) {
    try {
        await Promise.race([agent?.destroy?.(), new Promise((resolve) => setTimeout(resolve, DESTROY_GRACE_MS))]);
    }
    catch {
        // Teardown must not fail or delay the locate outcome past its deadline.
    }
}
// Midscene failures quote internal file paths; the packager refuses retained text
// carrying one, so failure detail is kept short and path-free before it reaches
// any caller-visible message (it never enters the sealed evidence either way).
function sanitizeDetail(error) {
    const raw = error instanceof Error ? error.message : String(error ?? "unknown error");
    return raw
        .replace(/(codex|file|path)[^\s]*(\/[^\s:]+)+/gi, "<path>")
        .replace(/\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+/g, "<path>")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
}
function asPoint(center) {
    const pair = Array.isArray(center)
        ? center
        : center && typeof center === "object"
            ? [center.x, center.y]
            : null;
    if (!pair || pair.length < 2)
        return null;
    const [x, y] = pair;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y))
        return null;
    return { x, y };
}
function asRect(rect) {
    if (!rect || typeof rect !== "object")
        return null;
    const { left, top, width, height } = rect;
    if ([left, top, width, height].some((v) => typeof v !== "number" || !Number.isFinite(v)))
        return null;
    return { left: left, top: top, width: width, height: height };
}
// Locate `target` on the observed bytes and validate the point for dispatch in
// CSS pixels. Every failure kind means "dispatch nothing"; the caller turns it
// into an honest message naming the target, never into a coordinate fallback.
export async function locateOnShot(factories, page, shot, target, opts = {}) {
    const dims = pngDimensions(shot.png);
    if (!dims || dims.width !== shot.width || dims.height !== shot.height)
        return {
            ok: false,
            kind: "stale-shot",
            detail: `observed bytes decode to ${dims ? `${dims.width}x${dims.height}` : "not a PNG"}, not the recorded ${shot.width}x${shot.height}`,
        };
    const digest = createHash("sha256").update(shot.png).digest("hex");
    if (digest !== shot.sha256)
        return { ok: false, kind: "stale-shot", detail: "observed bytes no longer match the recorded screenshot hash" };
    if (!Number.isFinite(shot.cssWidth) || !Number.isFinite(shot.cssHeight) || shot.cssWidth <= 0 || shot.cssHeight <= 0)
        return { ok: false, kind: "error", detail: "viewport size is missing, so screenshot pixels cannot map to input coordinates" };
    // Screenshot pixels to CSS pixels. Both axes must agree: a changed aspect means
    // the bytes are not the observation they claim to be.
    const ratioX = dims.width / shot.cssWidth;
    const ratioY = dims.height / shot.cssHeight;
    if (!Number.isFinite(ratioX) || !Number.isFinite(ratioY) || ratioX <= 0 || Math.abs(ratioX - ratioY) / ratioX > 0.01)
        return { ok: false, kind: "stale-shot", detail: "screenshot aspect does not match the viewport it was observed in" };
    const createScreenshotItem = factories.createScreenshotItem;
    if (!createScreenshotItem)
        return {
            ok: false,
            kind: "error",
            detail: "locator screenshot factory is not configured; cannot bind the observation",
        };
    const uiContext = {
        screenshot: createScreenshotItem(`data:image/png;base64,${shot.png.toString("base64")}`, Date.now()),
        shotSize: { width: dims.width, height: dims.height },
        shrunkShotToLogicalRatio: ratioX,
    };
    const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCATOR_TIMEOUT_MS;
    let agent;
    try {
        const located = await withDeadline(timeoutMs, async () => {
            agent = await factories.createAgent(page);
            return agent.aiLocate(target, { uiContext, cacheable: false });
        });
        const point = asPoint(located?.center);
        if (!point)
            return { ok: false, kind: "miss", detail: "the locator returned no element for the target" };
        if (point.x < 0 || point.y < 0 || point.x >= shot.cssWidth || point.y >= shot.cssHeight)
            return {
                ok: false,
                kind: "out-of-bounds",
                detail: `located (${point.x}, ${point.y}) falls outside the ${shot.cssWidth}x${shot.cssHeight} observed screen`,
            };
        return { ok: true, x: point.x, y: point.y, rect: asRect(located?.rect) };
    }
    catch (error) {
        if (error instanceof LocateTimeoutError)
            return { ok: false, kind: "timeout", detail: `no location within ${error.timeoutMs}ms; nothing was dispatched` };
        return { ok: false, kind: "error", detail: sanitizeDetail(error) };
    }
    finally {
        await destroyGracefully(agent);
    }
}
