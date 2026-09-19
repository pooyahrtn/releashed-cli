export const BROWSER_STARTUP_BUDGET_MS = 30_000;
export const BROWSER_READY_GRACE_MS = 1_000;
export const CDP_COMMAND_TIMEOUT_MS = 5_000;
export const INITIAL_TOP_FRAME_LOAD_TIMEOUT_MS = 15_000;
export const INITIAL_NAVIGATION_FAILURE_POINTS = Object.freeze({
    navigate_dispatch: "navigate_dispatch",
    load_wait: "load_wait",
    bootstrap_admission: "bootstrap_admission"
});
const SAFE_INITIAL_NAVIGATION_FAILURE_POINTS = new Set(Object.values(INITIAL_NAVIGATION_FAILURE_POINTS));
export function safeInitialNavigationFailurePoint(value) {
    return typeof value === "string" && SAFE_INITIAL_NAVIGATION_FAILURE_POINTS.has(value)
        ? value
        : null;
}
