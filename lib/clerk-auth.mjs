export const CLERK_TICKET_TTL_SECONDS = 60;
export const CLERK_TICKET_EXCHANGE_FAILURE_STAGES = Object.freeze({
    clean: Object.freeze({
        unauthorized: "ticket_exchange_unauthorized_clean",
        conflict: "ticket_exchange_conflict_clean",
        rejected: "ticket_exchange_rejected_clean",
        rate_limited: "ticket_exchange_rate_limited_clean",
        provider_5xx: "ticket_exchange_provider_5xx_clean",
        transport_or_runtime: "ticket_exchange_transport_or_runtime_clean",
    }),
    existing: Object.freeze({
        unauthorized: "ticket_exchange_unauthorized_existing",
        conflict: "ticket_exchange_conflict_existing",
        rejected: "ticket_exchange_rejected_existing",
        rate_limited: "ticket_exchange_rate_limited_existing",
        provider_5xx: "ticket_exchange_provider_5xx_existing",
        transport_or_runtime: "ticket_exchange_transport_or_runtime_existing",
    }),
});
const CLERK_TICKET_EXCHANGE_FAILURE_CODES = Object.fromEntries(Object.values(CLERK_TICKET_EXCHANGE_FAILURE_STAGES)
    .flatMap((stages) => Object.values(stages))
    .map((stage) => [stage, `clerk_auth_${stage}`]));
export const CLERK_PAGE_AUTH_FAILURE_CODES = Object.freeze({
    sdk_unavailable: "clerk_auth_sdk_unavailable",
    precondition_failed: "clerk_auth_precondition_failed",
    ticket_exchange_failed: "clerk_auth_ticket_exchange_failed",
    ...CLERK_TICKET_EXCHANGE_FAILURE_CODES,
    session_missing: "clerk_auth_session_missing",
    session_mismatch: "clerk_auth_session_mismatch",
    activation_failed: "clerk_auth_activation_failed",
    token_confirmation_failed: "clerk_auth_token_confirmation_failed",
});
const SAFE_CLERK_AUTH_FAILURE_CODES = new Set([
    "clerk_auth_failed",
    "clerk_auth_input_invalid",
    "clerk_auth_locked",
    "clerk_auth_landing_unconfirmed",
    "clerk_auth_post_auth_readiness_unconfirmed",
    "clerk_auth_outcome_unknown",
    "clerk_auth_policy_mismatch",
    "clerk_auth_preparation_failed",
    "clerk_auth_state_invalid",
    ...Object.values(CLERK_PAGE_AUTH_FAILURE_CODES),
]);
export function isSafeClerkAuthFailureCode(value) {
    return typeof value === "string" && SAFE_CLERK_AUTH_FAILURE_CODES.has(value);
}
export const CLERK_BOUNDED_ROUTE_FAILURE_CODES = Object.freeze({
    candidate_wait: "clerk_auth_route_candidate_unconfirmed",
    exact_clerk_inspection: "clerk_auth_exact_inspection_unconfirmed",
    post_inspection_reseal: "clerk_auth_post_inspection_reseal_unconfirmed",
});
export const CLERK_BOUNDED_ROUTE_FAILURE_POINTS = Object.freeze({
    initial_route_admission: "initial_route_admission",
    initial_route_snapshot: "initial_route_snapshot",
    auth_transit_lineage: "auth_transit_lineage",
    auth_transit_recheck: "auth_transit_recheck",
    resume_target: "resume_target",
    resume_navigation: "resume_navigation",
    route_admission: "route_admission",
    route_off_origin: "route_off_origin",
    route_returned_to_auth: "route_returned_to_auth",
    route_lineage: "route_lineage",
    route_hop_limit: "route_hop_limit",
    route_stability_timeout: "route_stability_timeout",
    clerk_initial_inspection: "clerk_initial_inspection",
    clerk_readiness: "clerk_readiness",
    clerk_final_inspection: "clerk_final_inspection",
    clerk_context_relock: "clerk_context_relock",
    clerk_final_reseal: "clerk_final_reseal",
});
const SAFE_CLERK_BOUNDED_ROUTE_FAILURE_POINTS = new Set(Object.values(CLERK_BOUNDED_ROUTE_FAILURE_POINTS));
export function safeClerkBoundedRouteFailure(stage, code, point = null) {
    if (!Object.hasOwn(CLERK_BOUNDED_ROUTE_FAILURE_CODES, stage))
        return null;
    if (CLERK_BOUNDED_ROUTE_FAILURE_CODES[stage] !== code)
        return null;
    return {
        stage,
        code,
        point: typeof point === "string" &&
            SAFE_CLERK_BOUNDED_ROUTE_FAILURE_POINTS.has(point)
            ? point
            : null,
    };
}
function refusal(code, message) {
    return { ok: false, refusal: { code, message } };
}
function validAuthState(state, expectedUserId) {
    return Boolean(state &&
        state.user_id === expectedUserId &&
        typeof state.session_id === "string" &&
        /^[A-Za-z0-9_-]{4,256}$/.test(state.session_id) &&
        state.token_present === true);
}
/**
 * A one-shot boundary around Clerk's browser SDK. The browser implementation owns
 * the ticket; callers receive only a safe success/refusal result.
 */
export class OneShotClerkPageAuthenticator {
    start;
    inspect;
    lock;
    timeoutMs;
    attempted = false;
    locked = false;
    lockSucceeded = false;
    constructor({ start, inspect, lock, timeoutMs = 8_000, }) {
        this.start = start;
        this.inspect = inspect;
        this.lock = lock;
        this.timeoutMs = timeoutMs;
        this.attempted = false;
        this.locked = false;
    }
    async authenticate({ ticket, expectedUserId, expectedCurrentHref, }) {
        if (this.attempted)
            return refusal("clerk_auth_locked", "Clerk authentication is already locked");
        this.attempted = true;
        if (typeof ticket !== "string" ||
            ticket.length < 8 ||
            ticket.length > 4_096 ||
            /[\r\n]/.test(ticket) ||
            typeof expectedUserId !== "string" ||
            expectedUserId.length < 4 ||
            expectedUserId.length > 256 ||
            /[\r\n]/.test(expectedUserId)) {
            if (!(await this.lockMethods()))
                return refusal("clerk_auth_failed", "Clerk authentication failed");
            return refusal("clerk_auth_input_invalid", "Clerk authentication input is invalid");
        }
        let timer;
        let outcome;
        try {
            outcome = await Promise.race([
                Promise.resolve().then(() => this.start({ ticket, expectedUserId, expectedCurrentHref })),
                new Promise((resolveTimeout) => {
                    timer = setTimeout(() => resolveTimeout({ timed_out: true }), this.timeoutMs);
                }),
            ]);
        }
        catch {
            await this.lockMethods();
            return refusal("clerk_auth_failed", "Clerk authentication failed");
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
        let state = outcome;
        let ambiguous = false;
        if (outcome?.timed_out === true) {
            ambiguous = true;
            try {
                state = await this.inspect();
            }
            catch {
                state = null;
            }
        }
        if (!ambiguous) {
            let failureCode = null;
            let hasFailureStage = false;
            try {
                hasFailureStage = Object.hasOwn(outcome ?? {}, "failure_stage");
                const failureStage = outcome?.failure_stage;
                if (typeof failureStage === "string" &&
                    Object.hasOwn(CLERK_PAGE_AUTH_FAILURE_CODES, failureStage)) {
                    failureCode = CLERK_PAGE_AUTH_FAILURE_CODES[failureStage];
                }
            }
            catch {
                hasFailureStage = true;
            }
            if (hasFailureStage) {
                if (!(await this.lockMethods()))
                    return refusal("clerk_auth_failed", "Clerk authentication failed");
                return refusal(failureCode ?? "clerk_auth_failed", "Clerk authentication failed");
            }
        }
        if (!(await this.lockMethods()))
            return refusal("clerk_auth_failed", "Clerk authentication failed");
        if (!state || !validAuthState(state, expectedUserId)) {
            return refusal(ambiguous ? "clerk_auth_outcome_unknown" : "clerk_auth_failed", ambiguous
                ? "Clerk authentication timed out and could not be confirmed"
                : "Clerk authentication failed");
        }
        return {
            ok: true,
            authenticated: true,
            current_context_auth_methods_locked: true,
            outcome_confirmed_after_timeout: ambiguous,
            active_session_id: state.session_id,
        };
    }
    async lockMethods() {
        if (this.locked)
            return this.lockSucceeded;
        this.locked = true;
        try {
            await this.lock();
            this.lockSucceeded = true;
        }
        catch {
            this.lockSucceeded = false;
        }
        return this.lockSucceeded;
    }
}
export function isPermittedClerkMutation({ rawUrl, method, frontendApiOrigin, phase, activeSessionId = null, }) {
    if (String(method).toUpperCase() !== "POST")
        return false;
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return false;
    }
    if (url.origin !== frontendApiOrigin || url.username || url.password || url.hash)
        return false;
    // A Clerk DEV instance has no custom domain sharing the app's site, so clerk-js cannot rely on
    // a first-party cookie to recognize the browser across requests. It mints a "dev browser" JWT
    // via this fixed, well-known endpoint instead -- Clerk's own replacement for that cookie. The
    // call carries no account or session identifier, cannot mutate any user's state, and fires
    // automatically on page load before any auth phase begins (often before "bootstrap"), so it is
    // admitted regardless of phase. A production Clerk instance (a real custom domain) never calls
    // this endpoint at all -- it is exercised only by this lab's local, dev-Clerk target.
    if (url.pathname === "/v1/dev_browser")
        return true;
    // Once a dev instance has minted its dev-browser JWT (see above), clerk-js tunnels a PATCH
    // through POST (Clerk's own "_method=PATCH" convention) to sync the environment snapshot for
    // that browser identity -- again purely infrastructural: the Frontend API is publishable-key
    // scoped and cannot mutate real instance configuration (that requires the separate,
    // secret-key-authenticated Backend API on a different origin, already gated independently).
    // A production instance, having no dev-browser JWT to sync, never sends this tunneled call.
    if (url.pathname === "/v1/environment" &&
        url.searchParams.get("_method") === "PATCH" &&
        url.searchParams.has("__clerk_db_jwt"))
        return true;
    if (phase === "bootstrap") {
        return url.pathname === "/v1/client/sign_ins";
    }
    const sessionId = activeSessionId ?? "";
    if (["activating", "active"].includes(phase ?? "") &&
        /^[A-Za-z0-9_-]{4,256}$/.test(sessionId)) {
        const encoded = encodeURIComponent(sessionId);
        const tokenPath = `/v1/client/sessions/${encoded}/tokens`;
        return (url.pathname === `/v1/client/sessions/${encoded}/touch` ||
            url.pathname === tokenPath ||
            new RegExp(`^${tokenPath}/[A-Za-z0-9_-]+$`).test(url.pathname));
    }
    return false;
}
export function provisionalClerkBootstrapTouchSessionId({ rawUrl, method, frontendApiOrigin, phase, }) {
    if (phase !== "bootstrap" || String(method).toUpperCase() !== "POST")
        return null;
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return null;
    }
    if (url.origin !== frontendApiOrigin || url.username || url.password || url.hash)
        return null;
    return (/^\/v1\/client\/sessions\/([A-Za-z0-9_-]{4,256})\/touch$/.exec(url.pathname)?.[1] ??
        null);
}
