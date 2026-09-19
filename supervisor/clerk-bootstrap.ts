import { randomUUID } from "node:crypto";
import {
  CLERK_PAGE_AUTH_FAILURE_CODES,
  CLERK_TICKET_TTL_SECONDS,
  isSafeClerkAuthFailureCode,
  safeClerkBoundedRouteFailure
} from "../lib/clerk-auth.ts";

export const CLERK_SIGN_IN_TOKEN_ENDPOINT = "https://api.clerk.com/v1/sign_in_tokens";
export const CLERK_DOMAINS_ENDPOINT = "https://api.clerk.com/v1/domains";
export const CLERK_MINT_OUTCOME_UNKNOWN_CODE = "clerk_sign_in_token_mint_outcome_unknown";

/**
 * A working-day deadline as carried through the supervisor: epoch milliseconds
 * or a date-parseable string, or null when the caller leaves the cap to the
 * operation bound. Public entry points accept `unknown` for this value (a
 * downstream owner-bundle flow holds it opaquely) and `operationDeadline`
 * below enforces this domain at runtime, so no importer ever needs a cast.
 */
export type WorkingDayDeadline = number | string | null;

export type ClerkEnvironment = NodeJS.ProcessEnv;

export type ClerkRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type ClerkFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type ClerkFetch = (
  url: string,
  init: ClerkRequestInit & { redirect: "error"; signal: AbortSignal }
) => Promise<ClerkFetchResponse>;

export type SupervisorBrowser = {
  call: (message: Record<string, unknown>, origin: string) => Promise<unknown>;
  stop?: () => unknown;
};

/**
 * Every cleanup result in this module carries `cleanup_complete` plus the
 * subset of reconciliation booleans its path can establish. Readers compare
 * individual flags with `=== true`, so absent flags read as unproven.
 */
export type ClerkCleanupResult = {
  cleanup_complete: boolean;
  session_reconciled?: boolean;
  run_session_revoked?: boolean;
  unused_sign_in_token_revoked?: boolean;
  sessions_revoked_or_absent?: boolean;
  sign_in_token_unusable?: boolean;
  synthetic_identity_deleted?: boolean;
  sign_in_token_expired?: boolean;
  sign_in_token_unusable_by_identity_deletion?: boolean;
};

export type ClerkProvisionCleanupResult = {
  cleanup_complete: boolean;
  sessions_revoked_or_absent: boolean;
  sign_in_token_unusable: boolean;
  synthetic_identity_deleted: boolean;
};

export type DeferredCleanupOptions = {
  browserStopped?: boolean;
  identityDeleted?: boolean;
  cleanupDeadlineAt?: WorkingDayDeadline;
};

export type DeferredCleanup = (
  options?: DeferredCleanupOptions
) => Promise<ClerkCleanupResult>;

export type ClerkAuthentication = {
  authenticated: boolean;
  current_context_auth_methods_locked: boolean;
  persistent_clerk_network_filter: boolean;
  outcome_confirmed_after_timeout: boolean;
  cleanup: DeferredCleanup;
};

export type DisposableClerkIdentity = {
  userId: string;
  authenticate: (args: { browser: SupervisorBrowser }) => Promise<{ authenticated: boolean }>;
  cleanup: (options?: { browserStopped?: boolean }) => Promise<ClerkProvisionCleanupResult>;
};

export type ClerkRecoveryMaterial = {
  state: string;
  external_id: string;
  user_id: string | null;
};

export type MintTiming = {
  monotonicNow: () => number;
  wallNow: () => number;
  wait: (milliseconds: number) => Promise<unknown>;
};

export type MintTimingOverrides = {
  monotonicNow?: () => number;
  wallNow?: () => number;
  wait?: (milliseconds: number) => Promise<unknown>;
};

export type MintAmbiguityObservedAt = {
  monotonic: number;
  wall: number;
};

type ClerkFailure = Error & {
  cleanup?: unknown;
  cleanup_handle?: unknown;
  recovery_material?: unknown;
  code?: unknown;
  calibration_failure_code?: unknown;
  calibration_failure_substage?: unknown;
  calibration_failure_subcode?: unknown;
  calibration_failure_point?: unknown;
};

type MintOutcomeUnknownError = Error & {
  code?: unknown;
  tokenId?: unknown;
  ambiguityObservedAt?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDeferredCleanup(value: unknown): value is DeferredCleanup {
  return typeof value === "function";
}

function isSettlingCleanup(value: unknown): value is DeferredCleanup {
  return (
    typeof value === "function" &&
    "settlesByIdentityDeletion" in value &&
    value.settlesByIdentityDeletion === true
  );
}

function isAmbiguityObservedAt(value: unknown): value is MintAmbiguityObservedAt {
  return (
    typeof value === "object" &&
    value !== null &&
    "monotonic" in value &&
    typeof value.monotonic === "number" &&
    "wall" in value &&
    typeof value.wall === "number"
  );
}

function isMintOutcomeUnknown(
  error: unknown
): error is Error & { tokenId: string | null; ambiguityObservedAt: MintAmbiguityObservedAt } {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === CLERK_MINT_OUTCOME_UNKNOWN_CODE &&
    "tokenId" in error &&
    (error.tokenId === null || typeof error.tokenId === "string") &&
    "ambiguityObservedAt" in error &&
    isAmbiguityObservedAt(error.ambiguityObservedAt)
  );
}

const AMBIGUOUS_AUTH_FAILURE_CODES = new Set([
  "clerk_auth_failed",
  "clerk_auth_landing_unconfirmed",
  "clerk_auth_outcome_unknown",
  ...Object.entries(CLERK_PAGE_AUTH_FAILURE_CODES)
    .filter(([stage]) => stage.startsWith("ticket_exchange_"))
    .map(([, code]) => code),
  CLERK_PAGE_AUTH_FAILURE_CODES.session_missing,
  CLERK_PAGE_AUTH_FAILURE_CODES.activation_failed,
  CLERK_PAGE_AUTH_FAILURE_CODES.token_confirmation_failed
]);

const CLERK_API_ORIGIN = "https://api.clerk.com";
const SESSION_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 10;
const MAX_OPERATION_MS = 10_000;
const MAX_REQUEST_MS = 3_000;
const SIGN_IN_TOKEN_EXPIRY_MARGIN_MS = 2_000;

async function deleteDisposableUser({ secretKey, userId, fetchImpl }: {
  secretKey: string;
  userId: string;
  fetchImpl: ClerkFetch;
}): Promise<void> {
  await boundedFetchJson({
    fetchImpl,
    secretKey,
    url: new URL(`/v1/users/${encodeURIComponent(userId)}`, CLERK_API_ORIGIN).href,
    init: { method: "DELETE" },
    deadlineAt: operationDeadline(),
    failure: "Clerk disposable identity cleanup did not complete"
  });
}

function exactHttpsOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function verifyClerkFrontendOrigin({ secretKey, expectedFrontendOrigin, fetchImpl, deadlineAt }: {
  secretKey: string;
  expectedFrontendOrigin: unknown;
  fetchImpl: ClerkFetch;
  deadlineAt: number;
}): Promise<void> {
  const expectedOrigin = exactHttpsOrigin(expectedFrontendOrigin);
  if (expectedOrigin === null) throw new Error("Clerk authentication policy mismatch");
  const body: unknown = await boundedFetchJson({
    fetchImpl,
    secretKey,
    url: CLERK_DOMAINS_ENDPOINT,
    init: { method: "GET" },
    deadlineAt,
    failure: "Clerk authentication policy check did not complete"
  });
  const domains = isRecord(body) && !Array.isArray(body) ? body : null;
  if (domains === null) throw new Error("Clerk authentication policy mismatch");
  const rows: unknown = domains.data;
  const totalCount: unknown = domains.total_count;
  if (
    !Array.isArray(rows) ||
    typeof totalCount !== "number" ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 0 ||
    totalCount !== rows.length
  ) throw new Error("Clerk authentication policy mismatch");
  const data: unknown[] = rows;
  let matched = false;
  for (const row of data) {
    const fields = isRecord(row) && !Array.isArray(row) ? row : null;
    if (fields === null) {
      throw new Error("Clerk authentication policy mismatch");
    }
    const returnedOrigin = exactHttpsOrigin(fields.frontend_api_url);
    if (returnedOrigin === null) throw new Error("Clerk authentication policy mismatch");
    if (returnedOrigin === expectedOrigin) matched = true;
  }
  if (!matched) throw new Error("Clerk authentication policy mismatch");
}

function clerkPolicyMismatch(cleanup: ClerkCleanupResult): ClerkFailure {
  const error: ClerkFailure = new Error("Clerk authentication policy mismatch");
  error.cleanup = cleanup;
  Object.defineProperty(error, "calibration_failure_code", { value: "clerk_auth_policy_mismatch" });
  return error;
}

function disposableUsername(marker: unknown): string {
  const username = `flowmap_${typeof marker === "string" ? marker.slice("flowmap_cal_".length) : ""}`;
  if (!/^flowmap_[0-9a-f]{32}$/.test(username)) {
    throw new Error("The disposable identity username is invalid");
  }
  return username;
}

export async function provisionDisposableClerkIdentity({
  environment = process.env,
  fetchImpl = fetch,
  expectedFrontendOrigin,
  workingDayDeadline = null,
  onRecoveryMaterial = async () => {},
  markerFactory = () => `flowmap_cal_${randomUUID().replaceAll("-", "")}`
}: {
  environment?: ClerkEnvironment;
  fetchImpl?: ClerkFetch;
  expectedFrontendOrigin: unknown;
  workingDayDeadline?: unknown;
  onRecoveryMaterial?: (material: ClerkRecoveryMaterial) => Promise<unknown>;
  markerFactory?: () => string;
}): Promise<DisposableClerkIdentity> {
  let secretKey: string | null = environment.CLERK_SECRET_KEY ?? null;
  delete environment.CLERK_SECRET_KEY;
  if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
    secretKey = null;
    throw new Error("CLERK_SECRET_KEY is required by the supervisor");
  }
  const noIdentityCleanup = disposableCleanup(true, true);
  try {
    await verifyClerkFrontendOrigin({
      secretKey,
      expectedFrontendOrigin,
      fetchImpl,
      deadlineAt: operationDeadline(workingDayDeadline)
    });
  } catch {
    secretKey = null;
    throw clerkPolicyMismatch(noIdentityCleanup);
  }
  const marker = markerFactory();
  if (typeof marker !== "string" || !/^flowmap_cal_[0-9a-f]{32}$/.test(marker)) {
    secretKey = null;
    throw new Error("The disposable identity correlation marker is invalid");
  }
  const username = disposableUsername(marker);
  try {
    await onRecoveryMaterial({ state: "creation-pending", external_id: marker, user_id: null });
  } catch {
    secretKey = null;
    throw disposableProvisionFailure(noIdentityCleanup);
  }

  let before: string[];
  try {
    before = await listDisposableUsersByMarker({ secretKey, marker, fetchImpl, deadlineAt: operationDeadline(workingDayDeadline) });
  } catch {
    secretKey = null;
    throw disposableProvisionFailure(noIdentityCleanup);
  }
  if (before.length !== 0) {
    secretKey = null;
    throw disposableProvisionFailure(disposableCleanup(false, false));
  }

  let created: unknown;
  let userId: string;
  try {
    created = await boundedFetchJson({
      fetchImpl,
      secretKey,
      url: new URL("/v1/users", CLERK_API_ORIGIN).href,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: "Flow Map",
          last_name: "Calibration",
          username,
          external_id: marker,
          skip_password_requirement: true
        })
      },
      deadlineAt: operationDeadline(workingDayDeadline),
      failure: "Clerk disposable identity creation did not complete"
    });
    userId = boundedOpaqueId(isRecord(created) ? created.id : undefined, "disposable user identifier");
  } catch {
    const cleanup = await recoverAmbiguousDisposableCreate({ secretKey, marker, fetchImpl });
    secretKey = null;
    throw disposableProvisionFailure(cleanup);
  }

  try {
    await onRecoveryMaterial({ state: "identity-bound", external_id: marker, user_id: userId });
  } catch {
    const cleanupHandle = exactDisposableUserCleanupHandle({ secretKey, userId, fetchImpl });
    const cleanup = await cleanupHandle();
    if (cleanup.synthetic_identity_deleted) {
      secretKey = null;
      throw disposableProvisionFailure(cleanup);
    }
    secretKey = null;
    throw disposableProvisionFailure(cleanup, cleanupHandle, { state: "identity-bound", external_id: marker, user_id: userId });
  }

  const createdFields = isRecord(created) ? created : null;
  if (createdFields?.external_id !== marker || createdFields?.username !== username) {
    const cleanupHandle = exactDisposableUserCleanupHandle({ secretKey, userId, fetchImpl });
    const cleanup = await cleanupHandle();
    secretKey = null;
    throw disposableProvisionFailure(cleanup, cleanup.cleanup_complete ? null : cleanupHandle);
  }

  let auth: ClerkAuthentication | null = null;
  let attachedCleanup: unknown = null;
  let attachedFailureCode: unknown = null;
  let cleanupPromise: Promise<ClerkProvisionCleanupResult> | null = null;
  return {
    userId,
    async authenticate({ browser }: { browser: SupervisorBrowser }) {
      // The secret reads live so a handle used after terminal cleanup fails
      // closed here with the same message the bootstrap would throw.
      const liveSecretKey = secretKey;
      if (liveSecretKey === null) throw new Error("CLERK_SECRET_KEY is required by the supervisor");
      try {
        auth = await bootstrapClerkAuthentication({
          browser,
          expectedUserId: userId,
          expectedFrontendOrigin,
          workingDayDeadline,
          environment: { CLERK_SECRET_KEY: liveSecretKey },
          fetchImpl,
          deferFailureCleanup: true
        });
        return { authenticated: auth.authenticated === true };
      } catch (error) {
        const failure = isRecord(error) ? error : null;
        attachedCleanup = failure?.cleanup ?? null;
        attachedFailureCode = failure?.code ?? null;
        throw error;
      }
    },
    cleanup({ browserStopped = false }: { browserStopped?: boolean } = {}) {
      cleanupPromise ??= (async (): Promise<ClerkProvisionCleanupResult> => {
        // Retained credentials clear only alongside the stored completed
        // result, which returns before reaching this point, so a null secret
        // here is unreachable. Report it as incomplete either way.
        if (secretKey === null || !browserStopped) {
          return {
            cleanup_complete: false,
            sessions_revoked_or_absent: false,
            sign_in_token_unusable: false,
            synthetic_identity_deleted: false
          };
        }
        let deleted = false;
        let authCleanup: ClerkCleanupResult | null = null;
        if (
          attachedFailureCode === CLERK_MINT_OUTCOME_UNKNOWN_CODE &&
          isSettlingCleanup(attachedCleanup)
        ) {
          try {
            await deleteDisposableUser({ secretKey, userId, fetchImpl });
            deleted = true;
          } catch {}
          try {
            authCleanup = await attachedCleanup({ browserStopped: true, identityDeleted: deleted });
          } catch {}
        } else {
          try {
            if (auth?.cleanup) authCleanup = await auth.cleanup();
            else if (isDeferredCleanup(attachedCleanup)) authCleanup = await attachedCleanup({ browserStopped: true });
          } catch {}
          try {
            await deleteDisposableUser({ secretKey, userId, fetchImpl });
            deleted = true;
          } catch {}
        }
        secretKey = null;
        auth = null;
        attachedCleanup = null;
        attachedFailureCode = null;
        return {
          // Deleting the disposable Clerk user is the terminal cleanup proof:
          // Clerk can no longer retain a live session or usable sign-in token for it.
          // The detailed booleans below already use that same proof, so the aggregate
          // must not contradict them when an earlier auth reconciliation was ambiguous.
          cleanup_complete: deleted,
          sessions_revoked_or_absent: deleted || authCleanup?.session_reconciled === true,
          sign_in_token_unusable: deleted || authCleanup?.unused_sign_in_token_revoked === true || authCleanup?.run_session_revoked === true,
          synthetic_identity_deleted: deleted
        };
      })();
      return cleanupPromise;
    }
  };
}

export async function reconcileDisposableClerkRecovery({
  recovery,
  expectedFrontendOrigin,
  workingDayDeadline = null,
  environment = process.env,
  fetchImpl = fetch
}: {
  recovery: unknown;
  expectedFrontendOrigin: unknown;
  workingDayDeadline?: unknown;
  environment?: ClerkEnvironment;
  fetchImpl?: ClerkFetch;
}): Promise<{ cleanup_complete: boolean }> {
  let secretKey: string | null = environment.CLERK_SECRET_KEY ?? null;
  delete environment.CLERK_SECRET_KEY;
  try {
    if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
      throw new Error("invalid secret");
    }
    const record = isRecord(recovery) ? recovery : null;
    const state = record?.state;
    const externalId = record?.external_id;
    const recoveryUserId = record?.user_id;
    if (
      record === null ||
      (state !== "creation-pending" && state !== "identity-bound") ||
      typeof externalId !== "string" ||
      !/^flowmap_cal_[0-9a-f]{32}$/.test(externalId) ||
      (state === "creation-pending" && recoveryUserId !== null) ||
      (state === "identity-bound" && typeof recoveryUserId !== "string")
    ) throw new Error("invalid recovery");

    const userId = state === "identity-bound"
      ? boundedOpaqueId(recoveryUserId, "disposable user identifier")
      : null;
    await verifyClerkFrontendOrigin({
      secretKey,
      expectedFrontendOrigin,
      fetchImpl,
      deadlineAt: operationDeadline(workingDayDeadline)
    });
    if (userId !== null) {
      const exact = await getDisposableUserById({
        secretKey,
        userId,
        fetchImpl,
        deadlineAt: operationDeadline(workingDayDeadline)
      });
      if (exact !== null) {
        if (exact.id !== userId || exact.external_id !== externalId) throw new Error("mismatched recovery");
        await deleteDisposableUser({ secretKey, userId, fetchImpl });
        const remaining = await getDisposableUserById({
          secretKey,
          userId,
          fetchImpl,
          deadlineAt: operationDeadline(workingDayDeadline)
        });
        if (remaining !== null) throw new Error("unconfirmed recovery");
      }
    } else {
      const users = await listDisposableUsersByMarker({
        secretKey,
        marker: externalId,
        fetchImpl,
        deadlineAt: operationDeadline(workingDayDeadline)
      });
      if (users.length > 1) throw new Error("ambiguous recovery");
      if (users.length === 1) {
        await deleteDisposableUser({ secretKey, userId: users[0], fetchImpl });
      }
      const remaining = await listDisposableUsersByMarker({
        secretKey,
        marker: externalId,
        fetchImpl,
        deadlineAt: operationDeadline(workingDayDeadline)
      });
      if (remaining.length !== 0) throw new Error("unconfirmed recovery");
    }
    return { cleanup_complete: true };
  } catch {
    throw new Error("Clerk disposable recovery reconciliation did not complete");
  } finally {
    secretKey = null;
  }
}

export async function verifyDisposableClerkIdentity({
  identity,
  expectedFrontendOrigin,
  workingDayDeadline = null,
  environment = process.env,
  fetchImpl = fetch
}: {
  identity: unknown;
  expectedFrontendOrigin: unknown;
  workingDayDeadline?: unknown;
  environment?: ClerkEnvironment;
  fetchImpl?: ClerkFetch;
}): Promise<{ identity_exact: boolean }> {
  let secretKey: string | null = environment.CLERK_SECRET_KEY ?? null;
  delete environment.CLERK_SECRET_KEY;
  try {
    if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
      throw new Error("invalid secret");
    }
    const fields = isRecord(identity) ? identity : null;
    const userId = boundedOpaqueId(fields?.user_id, "disposable user identifier");
    const username = boundedUsername(fields?.username);
    const marker = fields?.external_id;
    if (typeof marker !== "string" || !/^flowmap_cal_[0-9a-f]{32}$/.test(marker) || username !== disposableUsername(marker)) {
      throw new Error("invalid identity");
    }
    const deadlineAt = operationDeadline(workingDayDeadline);
    await verifyClerkFrontendOrigin({ secretKey, expectedFrontendOrigin, fetchImpl, deadlineAt });
    const exact = await getDisposableUserById({ secretKey, userId, fetchImpl, deadlineAt });
    if (exact?.id !== userId || exact.external_id !== marker || exact.username !== username) {
      throw new Error("identity mismatch");
    }
    const markerMatches = await listDisposableUsersByMarker({ secretKey, marker, fetchImpl, deadlineAt });
    if (markerMatches.length !== 1 || markerMatches[0] !== userId) throw new Error("identity mismatch");
    return { identity_exact: true };
  } catch {
    throw new Error("Clerk disposable identity verification did not complete");
  } finally {
    secretKey = null;
  }
}

/**
 * Retire one certificate-bound disposable identity. The exact identity and the
 * marker index must agree before deletion. An absent exact id is accepted only
 * when the marker index is also empty, which makes a confirmed retry safe.
 */
export async function retireDisposableClerkIdentity({
  identity,
  expectedFrontendOrigin,
  workingDayDeadline = null,
  environment = process.env,
  fetchImpl = fetch,
  beforeDelete = async () => {},
  beforeConfirmation = async () => {}
}: {
  identity: unknown;
  expectedFrontendOrigin: unknown;
  workingDayDeadline?: unknown;
  environment?: ClerkEnvironment;
  fetchImpl?: ClerkFetch;
  beforeDelete?: () => Promise<void>;
  beforeConfirmation?: () => Promise<void>;
}): Promise<{ retirement_confirmed: boolean; deletion_dispatched: boolean }> {
  let secretKey: string | null = environment.CLERK_SECRET_KEY ?? null;
  delete environment.CLERK_SECRET_KEY;
  try {
    if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
      throw new Error("invalid secret");
    }
    const fields = isRecord(identity) ? identity : null;
    const userId = boundedOpaqueId(fields?.user_id, "disposable user identifier");
    const username = boundedUsername(fields?.username);
    const marker = fields?.external_id;
    if (typeof marker !== "string" || !/^flowmap_cal_[0-9a-f]{32}$/.test(marker) || username !== disposableUsername(marker)) {
      throw new Error("invalid identity");
    }
    const deadlineAt = operationDeadline(workingDayDeadline);
    await verifyClerkFrontendOrigin({ secretKey, expectedFrontendOrigin, fetchImpl, deadlineAt });
    const exact = await getDisposableUserById({ secretKey, userId, fetchImpl, deadlineAt });
    const markerMatches = await listDisposableUsersByMarker({ secretKey, marker, fetchImpl, deadlineAt });

    if (exact === null) {
      if (markerMatches.length !== 0) throw new Error("identity mismatch");
    } else {
      if (
        exact.id !== userId ||
        exact.external_id !== marker ||
        exact.username !== username ||
        markerMatches.length !== 1 ||
        markerMatches[0] !== userId
      ) throw new Error("identity mismatch");
      await beforeDelete();
      await deleteDisposableUser({ secretKey, userId, fetchImpl });
    }

    await beforeConfirmation();
    const [remainingExact, remainingMarkerMatches] = await Promise.all([
      getDisposableUserById({ secretKey, userId, fetchImpl, deadlineAt }),
      listDisposableUsersByMarker({ secretKey, marker, fetchImpl, deadlineAt })
    ]);
    if (remainingExact !== null || remainingMarkerMatches.length !== 0) {
      throw new Error("unconfirmed retirement");
    }
    return { retirement_confirmed: true, deletion_dispatched: exact !== null };
  } catch {
    throw new Error("Clerk disposable identity retirement did not complete");
  } finally {
    secretKey = null;
  }
}

function disposableCleanup(complete: boolean, deleted: boolean): ClerkProvisionCleanupResult {
  return {
    cleanup_complete: complete,
    sessions_revoked_or_absent: complete,
    sign_in_token_unusable: complete,
    synthetic_identity_deleted: deleted
  };
}

function disposableProvisionFailure(
  cleanup: ClerkProvisionCleanupResult,
  cleanupHandle: (() => Promise<ClerkProvisionCleanupResult>) | null = null,
  recoveryMaterial: ClerkRecoveryMaterial | null = null
): ClerkFailure {
  const error: ClerkFailure = new Error("Clerk disposable identity provisioning did not complete");
  error.cleanup = cleanup;
  if (typeof cleanupHandle === "function") {
    Object.defineProperty(error, "cleanup_handle", { value: cleanupHandle });
  }
  if (recoveryMaterial !== null) {
    Object.defineProperty(error, "recovery_material", { value: recoveryMaterial });
  }
  return error;
}

function exactDisposableUserCleanupHandle({ secretKey: initialSecretKey, userId: initialUserId, fetchImpl }: {
  secretKey: string;
  userId: string;
  fetchImpl: ClerkFetch;
}): () => Promise<ClerkProvisionCleanupResult> {
  let secretKey: string | null = initialSecretKey;
  let userId: string | null = initialUserId;
  return async function cleanupKnownDisposableUser() {
    if (secretKey === null || userId === null) return disposableCleanup(true, true);
    try {
      await deleteDisposableUser({ secretKey, userId, fetchImpl });
      secretKey = null;
      userId = null;
      return disposableCleanup(true, true);
    } catch {
      return disposableCleanup(false, false);
    }
  };
}

async function listDisposableUsersByMarker({ secretKey, marker, fetchImpl, deadlineAt }: {
  secretKey: string;
  marker: string;
  fetchImpl: ClerkFetch;
  deadlineAt: number;
}): Promise<string[]> {
  const url = new URL("/v1/users", CLERK_API_ORIGIN);
  url.searchParams.append("external_id", marker);
  url.searchParams.set("limit", "2");
  url.searchParams.set("offset", "0");
  const body: unknown = await boundedFetchJson({
    fetchImpl,
    secretKey,
    url: url.href,
    init: { method: "GET" },
    deadlineAt,
    failure: "Clerk disposable identity lookup did not complete"
  });
  const rawRows: unknown = Array.isArray(body) ? body : isRecord(body) ? body.data : undefined;
  if (!Array.isArray(rawRows) || rawRows.length > 2) throw new Error("Clerk disposable identity lookup was invalid");
  const rows: unknown[] = rawRows;
  const totalCount: unknown = isRecord(body) && !Array.isArray(body) ? body.total_count : undefined;
  if (typeof totalCount === "number" && Number.isSafeInteger(totalCount) && totalCount !== rows.length) {
    throw new Error("Clerk disposable identity lookup was incomplete");
  }
  return rows.map((row) => {
    const fields = isRecord(row) ? row : null;
    if (fields?.external_id !== marker) throw new Error("Clerk returned a mismatched disposable identity marker");
    return boundedOpaqueId(fields?.id, "disposable user identifier");
  });
}

async function getDisposableUserById({ secretKey, userId, fetchImpl, deadlineAt }: {
  secretKey: string;
  userId: string;
  fetchImpl: ClerkFetch;
  deadlineAt: number;
}): Promise<{ id: string; external_id: unknown; username: unknown } | null> {
  const result = await boundedFetchJsonResult({
    fetchImpl,
    secretKey,
    url: new URL(`/v1/users/${encodeURIComponent(userId)}`, CLERK_API_ORIGIN).href,
    init: { method: "GET" },
    deadlineAt,
    acceptedStatuses: [404],
    failure: "Clerk disposable identity lookup did not complete"
  });
  if (result.status === 404) return null;
  const record = isRecord(result.body) && !Array.isArray(result.body) ? result.body : null;
  if (record === null) {
    throw new Error("Clerk disposable identity lookup was invalid");
  }
  return {
    id: boundedOpaqueId(record.id, "disposable user identifier"),
    external_id: record.external_id,
    username: record.username
  };
}

async function recoverAmbiguousDisposableCreate({ secretKey, marker, fetchImpl }: {
  secretKey: string;
  marker: string;
  fetchImpl: ClerkFetch;
}): Promise<ClerkProvisionCleanupResult> {
  let users: string[];
  try {
    users = await listDisposableUsersByMarker({ secretKey, marker, fetchImpl, deadlineAt: operationDeadline() });
  } catch {
    return disposableCleanup(false, false);
  }
  if (users.length !== 1) return disposableCleanup(false, false);
  try {
    await deleteDisposableUser({ secretKey, userId: users[0], fetchImpl });
    return disposableCleanup(true, true);
  } catch {
    return disposableCleanup(false, false);
  }
}

function boundedOpaqueId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) throw new Error(`Clerk returned an invalid ${label}`);
  return value;
}

function boundedUserId(userId: unknown): string {
  try {
    return boundedOpaqueId(userId, "approved identity");
  } catch {
    throw new Error("The preflight did not provide one approved Clerk identity");
  }
}

function boundedUsername(username: unknown): string {
  if (
    typeof username !== "string" ||
    username.length < 4 ||
    username.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(username)
  ) throw new Error("The preflight did not provide one approved Clerk identity");
  return username;
}

async function verifyExactDisposableIdentity({
  secretKey,
  expectedUserId,
  expectedUsername,
  fetchImpl,
  deadlineAt
}: {
  secretKey: string;
  expectedUserId: string;
  expectedUsername: string;
  fetchImpl: ClerkFetch;
  deadlineAt: number;
}): Promise<void> {
  const body: unknown = await boundedFetchJson({
    fetchImpl,
    secretKey,
    url: new URL(`/v1/users/${encodeURIComponent(expectedUserId)}`, CLERK_API_ORIGIN).href,
    init: { method: "GET" },
    deadlineAt,
    failure: "Clerk approved identity check did not complete"
  });
  const record = isRecord(body) && !Array.isArray(body) ? body : null;
  if (
    record === null ||
    record.id !== expectedUserId ||
    record.username !== expectedUsername
  ) throw new Error("Clerk approved identity did not match");
}

function operationDeadline(workingDayDeadline: unknown = null): number {
  const now = Date.now();
  const ownerDeadline = workingDayDeadline === null
    ? now + MAX_OPERATION_MS
    : typeof workingDayDeadline === "number"
      ? workingDayDeadline
      : typeof workingDayDeadline === "string"
        ? Date.parse(workingDayDeadline)
        : NaN;
  if (!Number.isFinite(ownerDeadline) || ownerDeadline <= now) throw new Error("The original working-day deadline has expired");
  return Math.min(ownerDeadline, now + MAX_OPERATION_MS);
}

async function boundedFetchJson({ fetchImpl, secretKey, url, init, deadlineAt, failure, onDispatch = null }: {
  fetchImpl: ClerkFetch;
  secretKey: string;
  url: string;
  init: ClerkRequestInit;
  deadlineAt: number;
  failure: string;
  onDispatch?: (() => void) | null;
}): Promise<unknown> {
  return (await boundedFetchJsonResult({ fetchImpl, secretKey, url, init, deadlineAt, failure, onDispatch })).body;
}

async function boundedFetchJsonResult({
  fetchImpl,
  secretKey,
  url,
  init,
  deadlineAt,
  failure,
  onDispatch = null,
  acceptedStatuses = []
}: {
  fetchImpl: ClerkFetch;
  secretKey: string;
  url: string;
  init: ClerkRequestInit;
  deadlineAt: number;
  failure: string;
  onDispatch?: (() => void) | null;
  acceptedStatuses?: number[];
}): Promise<{ body: unknown; status: number }> {
  const controller = new AbortController();
  const beforeDeadline = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = Math.min(MAX_REQUEST_MS, deadlineAt - Date.now());
    if (remaining <= 0) throw new Error(failure);
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<T>((_, rejectTimeout) => {
          timer = setTimeout(() => {
            controller.abort();
            rejectTimeout(new Error(failure));
          }, remaining);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const response = await beforeDeadline(() => {
      onDispatch?.();
      return fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          ...(init.headers ?? {})
        },
        redirect: "error",
        signal: controller.signal
      });
    });
    const body: unknown = await beforeDeadline(() => response.json());
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      throw new Error(`${failure} (HTTP ${Number.isInteger(response.status) ? response.status : "unknown"})`);
    }
    return { body, status: response.status };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(failure)) throw error;
    throw new Error(failure);
  } finally {
    controller.abort();
  }
}

function sessionRows(body: unknown): { rows: unknown[]; totalCount: number | null } {
  if (Array.isArray(body)) return { rows: body, totalCount: null };
  if (isRecord(body) && Array.isArray(body.data)) {
    const data: unknown[] = body.data;
    const total = body.total_count;
    return {
      rows: data,
      totalCount: typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null
    };
  }
  throw new Error("Clerk session list response was invalid");
}

async function listSessionIds({ secretKey, expectedUserId, fetchImpl, deadlineAt }: {
  secretKey: string;
  expectedUserId: string;
  fetchImpl: ClerkFetch;
  deadlineAt: number;
}): Promise<Set<string>> {
  const found = new Set<string>();
  let expectedTotalCount: number | null = null;
  for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
    const offset = page * SESSION_PAGE_SIZE;
    const url = new URL("/v1/sessions", CLERK_API_ORIGIN);
    url.searchParams.set("user_id", expectedUserId);
    url.searchParams.set("limit", String(SESSION_PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    const body: unknown = await boundedFetchJson({
      fetchImpl,
      secretKey,
      url: url.href,
      init: { method: "GET" },
      deadlineAt,
      failure: "Clerk session inventory did not complete"
    });
    const { rows, totalCount } = sessionRows(body);
    if (totalCount !== null) {
      if (expectedTotalCount === null) expectedTotalCount = totalCount;
      if (
        totalCount !== expectedTotalCount ||
        offset + rows.length > totalCount ||
        (offset < totalCount && rows.length === 0)
      ) throw new Error("Clerk session inventory was incomplete");
    } else if (expectedTotalCount !== null) {
      throw new Error("Clerk session inventory was incomplete");
    }
    for (const row of rows) {
      const id = boundedOpaqueId(isRecord(row) ? row.id : undefined, "session identifier");
      if (found.has(id)) throw new Error("Clerk session inventory was ambiguous");
      found.add(id);
    }
    if (totalCount !== null) {
      if (offset + rows.length === totalCount) return found;
    } else if (rows.length < SESSION_PAGE_SIZE) {
      return found;
    }
  }
  throw new Error("Clerk session inventory exceeded its pagination bound");
}

/**
 * Read-only admission before a fresh run starts either broker. This deliberately
 * returns no provider data and leaves the credential available for the later,
 * just-before-mint authentication checks and terminal identity retirement.
 */
export async function preflightFreshClerkAuthentication({
  expectedUserId: preflightUserId,
  expectedFrontendOrigin,
  workingDayDeadline,
  environment = process.env,
  fetchImpl = fetch,
  approvedDisposableIdentity
}: {
  expectedUserId: unknown;
  expectedFrontendOrigin: unknown;
  workingDayDeadline: unknown;
  environment?: ClerkEnvironment;
  fetchImpl?: ClerkFetch;
  approvedDisposableIdentity: unknown;
}): Promise<void> {
  let secretKey: string | null = environment.CLERK_SECRET_KEY ?? null;
  let sessionIds: Set<string> | null = null;
  try {
    if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
      throw new Error("invalid credential");
    }
    const deadlineAt = operationDeadline(workingDayDeadline);
    const expectedUserId = boundedUserId(preflightUserId);
    const approval = isRecord(approvedDisposableIdentity) ? approvedDisposableIdentity : null;
    if (
      approval === null ||
      approval.providerUserId !== expectedUserId
    ) throw new Error("identity mismatch");
    const expectedUsername = boundedUsername(approval.username);
    await verifyClerkFrontendOrigin({ secretKey, expectedFrontendOrigin, fetchImpl, deadlineAt });
    await verifyExactDisposableIdentity({
      secretKey,
      expectedUserId,
      expectedUsername,
      fetchImpl,
      deadlineAt
    });
    sessionIds = await listSessionIds({ secretKey, expectedUserId, fetchImpl, deadlineAt });
    if (sessionIds.size !== 0) throw new Error("existing session");
  } catch {
    throw new Error("Clerk authentication preflight failed");
  } finally {
    sessionIds?.clear();
    secretKey = null;
  }
}

function mintOutcomeUnknown({ tokenId = null, ambiguityObservedAt }: {
  tokenId?: string | null;
  ambiguityObservedAt: MintAmbiguityObservedAt;
}): MintOutcomeUnknownError {
  const error: MintOutcomeUnknownError = new Error("Clerk sign-in ticket mint outcome is unknown");
  error.code = CLERK_MINT_OUTCOME_UNKNOWN_CODE;
  Object.defineProperties(error, {
    tokenId: { value: tokenId },
    ambiguityObservedAt: { value: ambiguityObservedAt }
  });
  return error;
}

async function mintTicket({ secretKey, expectedUserId, fetchImpl, deadlineAt, timing }: {
  secretKey: string;
  expectedUserId: string;
  fetchImpl: ClerkFetch;
  deadlineAt: number;
  timing: MintTiming;
}): Promise<{ id: string; ticket: string }> {
  let dispatched = false;
  let body: unknown;
  try {
    body = await boundedFetchJson({
      fetchImpl,
      secretKey,
      url: CLERK_SIGN_IN_TOKEN_ENDPOINT,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: expectedUserId, expires_in_seconds: CLERK_TICKET_TTL_SECONDS })
      },
      deadlineAt,
      failure: "Clerk sign-in ticket request did not complete",
      onDispatch: () => {
        dispatched = true;
      }
    });
  } catch {
    if (dispatched) {
      throw mintOutcomeUnknown({
        ambiguityObservedAt: { monotonic: timing.monotonicNow(), wall: timing.wallNow() }
      });
    }
    throw new Error("Clerk sign-in ticket request did not start");
  }

  const fields = isRecord(body) ? body : null;
  let id: string | null = null;
  try {
    id = boundedOpaqueId(fields?.id, "sign-in token identifier");
  } catch {}
  const token = fields?.token;
  const validTicket = typeof token === "string" && token.length >= 8 && token.length <= 4_096 && !/[\r\n]/.test(token);
  if (id === null || !validTicket) {
    throw mintOutcomeUnknown({
      tokenId: id,
      ambiguityObservedAt: { monotonic: timing.monotonicNow(), wall: timing.wallNow() }
    });
  }
  return { id, ticket: token };
}

async function revokeExact({ secretKey, fetchImpl, path, deadlineAt, failure }: {
  secretKey: string;
  fetchImpl: ClerkFetch;
  path: string;
  deadlineAt: number;
  failure: string;
}): Promise<void> {
  await boundedFetchJson({
    fetchImpl,
    secretKey,
    url: new URL(path, CLERK_API_ORIGIN).href,
    init: { method: "POST", headers: { "Content-Type": "application/json" } },
    deadlineAt,
    failure
  });
}

function safeCleanupResult({ complete, sessionReconciled, sessionRevoked, unusedTokenRevoked }: {
  complete: boolean;
  sessionReconciled: boolean;
  sessionRevoked: boolean;
  unusedTokenRevoked: boolean;
}): ClerkCleanupResult {
  return {
    cleanup_complete: complete,
    session_reconciled: sessionReconciled,
    run_session_revoked: sessionRevoked,
    unused_sign_in_token_revoked: unusedTokenRevoked
  };
}

async function cleanupFailedAuthentication({ secretKey, expectedUserId, beforeSessionIds, signInTokenId, fetchImpl, outcomeUnknown, browserStopped, cleanupDeadlineAt = null }: {
  secretKey: string;
  expectedUserId: string;
  beforeSessionIds: Set<string>;
  signInTokenId: string;
  fetchImpl: ClerkFetch;
  outcomeUnknown: boolean;
  browserStopped: boolean;
  cleanupDeadlineAt?: WorkingDayDeadline;
}): Promise<ClerkCleanupResult> {
  const deadlineAt = operationDeadline(cleanupDeadlineAt);
  let afterSessionIds: Set<string> | null = null;
  let sessionRevoked = false;
  let unusedTokenRevoked = false;
  if (browserStopped) {
    try {
      afterSessionIds = await listSessionIds({ secretKey, expectedUserId, fetchImpl, deadlineAt });
    } catch {}
  }

  const newSessions: string[] = afterSessionIds === null
    ? []
    : [...afterSessionIds].filter((id) => !beforeSessionIds.has(id));
  if (newSessions.length === 1) {
    try {
      await revokeExact({
        secretKey,
        fetchImpl,
        path: `/v1/sessions/${encodeURIComponent(newSessions[0])}/revoke`,
        deadlineAt,
        failure: "Clerk run-session cleanup did not complete"
      });
      sessionRevoked = true;
    } catch {}
  }
  try {
    await revokeExact({
      secretKey,
      fetchImpl,
      path: `/v1/sign_in_tokens/${encodeURIComponent(signInTokenId)}/revoke`,
      deadlineAt,
      failure: "Clerk unused sign-in token cleanup did not complete"
    });
    unusedTokenRevoked = true;
  } catch {}

  const oneNewSessionCleaned = newSessions.length === 1 && sessionRevoked;
  const confirmedNoSessionAndUnusedToken = !outcomeUnknown && newSessions.length === 0 && unusedTokenRevoked;
  const sessionReconciled = afterSessionIds !== null && newSessions.length <= 1 && (!outcomeUnknown || newSessions.length === 1);
  return safeCleanupResult({
    complete: sessionReconciled && (oneNewSessionCleaned || confirmedNoSessionAndUnusedToken),
    sessionReconciled,
    sessionRevoked,
    unusedTokenRevoked
  });
}

async function stopBrowserBeforeReconciliation(browser: SupervisorBrowser): Promise<boolean> {
  const stopBrowser = browser.stop;
  if (typeof stopBrowser !== "function") return false;
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => stopBrowser()).then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), MAX_OPERATION_MS);
      })
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function bootstrapFailure(
  message: string,
  cleanup: ClerkCleanupResult | DeferredCleanup,
  diagnosticCode: unknown = "clerk_auth_failed",
  failureCode: unknown = null
): ClerkFailure {
  const error: ClerkFailure = new Error(message);
  error.cleanup = cleanup;
  Object.defineProperty(error, "calibration_failure_code", {
    value: isSafeClerkAuthFailureCode(diagnosticCode) || diagnosticCode === CLERK_MINT_OUTCOME_UNKNOWN_CODE
      ? diagnosticCode
      : "clerk_auth_failed"
  });
  if (failureCode !== null) Object.defineProperty(error, "code", { value: failureCode });
  return error;
}

function boundedRouteBootstrapFailure(cleanup: ClerkCleanupResult | DeferredCleanup, route: unknown): ClerkFailure {
  const error = bootstrapFailure(
    "The browser could not confirm Clerk authentication",
    cleanup,
    "clerk_auth_landing_unconfirmed"
  );
  const fields = isRecord(route) ? route : null;
  const stage = fields?.failure_stage;
  const code = fields?.failure_code;
  const point = fields?.failure_point;
  const diagnostic = typeof stage === "string" && typeof code === "string"
    ? safeClerkBoundedRouteFailure(stage, code, typeof point === "string" ? point : null)
    : null;
  if (diagnostic) {
    Object.defineProperty(error, "calibration_failure_substage", { value: diagnostic.stage });
    Object.defineProperty(error, "calibration_failure_subcode", { value: diagnostic.code });
    Object.defineProperty(error, "calibration_failure_point", { value: diagnostic.point });
  }
  return error;
}

function authPreparationFailure(cleanup: ClerkCleanupResult | null = null): ClerkFailure {
  const error: ClerkFailure = new Error("Clerk authentication preparation failed");
  Object.defineProperty(error, "calibration_failure_code", { value: "clerk_auth_preparation_failed" });
  if (cleanup !== null) error.cleanup = cleanup;
  return error;
}

function rejectedBeforeMintCleanup(sessionReconciled: boolean): ClerkCleanupResult {
  return safeCleanupResult({
    complete: true,
    sessionReconciled,
    sessionRevoked: false,
    unusedTokenRevoked: false
  });
}

function mintTiming(dependencies: MintTimingOverrides = {}): MintTiming {
  return {
    monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
    wallNow: dependencies.wallNow ?? (() => Date.now()),
    wait: dependencies.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  };
}

function unknownMintCleanupResult({ complete = false, sessionReconciled = false, reason = null }: {
  complete?: boolean;
  sessionReconciled?: boolean;
  reason?: string | null;
} = {}): ClerkCleanupResult {
  return {
    ...safeCleanupResult({
      complete,
      sessionReconciled,
      sessionRevoked: false,
      unusedTokenRevoked: false
    }),
    sign_in_token_expired: reason === "expired",
    sign_in_token_unusable_by_identity_deletion: reason === "identity-deleted"
  };
}

function deferUnknownMintCleanup({
  ambiguityObservedAt,
  timing,
  secretKey: initialSecretKey,
  expectedUserId: initialUserId,
  beforeSessionIds: initialSessionIds,
  fetchImpl
}: {
  ambiguityObservedAt: MintAmbiguityObservedAt;
  timing: MintTiming;
  secretKey: string;
  expectedUserId: string;
  beforeSessionIds: Set<string>;
  fetchImpl: ClerkFetch;
}): DeferredCleanup {
  const lifetimeMs = (CLERK_TICKET_TTL_SECONDS * 1_000) + SIGN_IN_TOKEN_EXPIRY_MARGIN_MS;
  let secretKey: string | null = initialSecretKey;
  let expectedUserId: string | null = initialUserId;
  let beforeSessionIds: Set<string> | null = new Set(initialSessionIds);
  let completed: ClerkCleanupResult | null = null;
  let inFlight: Promise<ClerkCleanupResult> | null = null;
  const clearRetained = () => {
    secretKey = null;
    expectedUserId = null;
    beforeSessionIds?.clear();
    beforeSessionIds = null;
  };
  const finish = (result: ClerkCleanupResult): ClerkCleanupResult => {
    if (completed !== null) return completed;
    if (result.cleanup_complete) {
      completed = result;
      if (inFlight === null) clearRetained();
    }
    return result;
  };
  const cleanup = function cleanup({ identityDeleted = false, cleanupDeadlineAt = null }: DeferredCleanupOptions = {}): Promise<ClerkCleanupResult> {
    if (completed !== null) return Promise.resolve(completed);
    if (identityDeleted) {
      return Promise.resolve(finish(unknownMintCleanupResult({
        complete: true,
        sessionReconciled: true,
        reason: "identity-deleted"
      })));
    }
    if (inFlight !== null) return inFlight;
    inFlight = (async (): Promise<ClerkCleanupResult> => {
      const monotonicRemaining = lifetimeMs - (timing.monotonicNow() - ambiguityObservedAt.monotonic);
      const wallRemaining = lifetimeMs - (timing.wallNow() - ambiguityObservedAt.wall);
      const remaining = Math.max(0, monotonicRemaining, wallRemaining);
      if (cleanupDeadlineAt !== null && cleanupDeadlineAt !== undefined) {
        if (typeof cleanupDeadlineAt !== "number" || !Number.isFinite(cleanupDeadlineAt)) {
          return unknownMintCleanupResult();
        }
        if (remaining > cleanupDeadlineAt - timing.wallNow()) {
          return unknownMintCleanupResult();
        }
      }
      if (remaining > 0) await timing.wait(remaining);
      if (completed !== null) return completed;
      const expired = timing.monotonicNow() - ambiguityObservedAt.monotonic >= lifetimeMs &&
        timing.wallNow() - ambiguityObservedAt.wall >= lifetimeMs;
      if (!expired) return unknownMintCleanupResult();

      // Retained credentials clear only alongside the stored completed
      // result, which returns before reaching this point, so nulls here are
      // unreachable. Report the inventory as expired either way.
      const activeSecretKey = secretKey;
      const activeUserId = expectedUserId;
      const activeSessionIds = beforeSessionIds;
      if (activeSecretKey === null || activeUserId === null || activeSessionIds === null) {
        return unknownMintCleanupResult({ reason: "expired" });
      }
      let afterSessionIds: Set<string>;
      try {
        afterSessionIds = await listSessionIds({
          secretKey: activeSecretKey,
          expectedUserId: activeUserId,
          fetchImpl,
          deadlineAt: operationDeadline(cleanupDeadlineAt)
        });
      } catch {
        return unknownMintCleanupResult({ reason: "expired" });
      }
      if (completed !== null) return completed;
      const newSessions = [...afterSessionIds].filter((id) => !activeSessionIds.has(id));
      if (newSessions.length === 0) {
        return finish(unknownMintCleanupResult({
          complete: true,
          sessionReconciled: true,
          reason: "expired"
        }));
      }
      return unknownMintCleanupResult({ reason: "expired" });
    })().finally(() => {
      inFlight = null;
      if (completed !== null) clearRetained();
    });
    return inFlight;
  };
  Object.defineProperty(cleanup, "settlesByIdentityDeletion", { value: true });
  return cleanup;
}

function deferFailedAuthenticationCleanup({ secretKey, expectedUserId, beforeSessionIds, signInTokenId, fetchImpl, outcomeUnknown }: {
  secretKey: string;
  expectedUserId: string;
  beforeSessionIds: Set<string>;
  signInTokenId: string;
  fetchImpl: ClerkFetch;
  outcomeUnknown: boolean;
}): DeferredCleanup {
  let retainedSecretKey: string | null = secretKey;
  let retainedUserId: string | null = expectedUserId;
  let retainedSessionIds: Set<string> | null = new Set(beforeSessionIds);
  let retainedTokenId: string | null = signInTokenId;
  let completed: ClerkCleanupResult | null = null;
  let inFlight: Promise<ClerkCleanupResult> | null = null;
  return function cleanup({ browserStopped = false, cleanupDeadlineAt = null }: DeferredCleanupOptions = {}): Promise<ClerkCleanupResult> {
    if (completed !== null) return Promise.resolve(completed);
    if (inFlight !== null) return inFlight;
    // Retained credentials clear only alongside the stored completed result,
    // which returns before reaching this point, so nulls here are unreachable.
    // Report the reconciliation as missed either way.
    const activeSecretKey = retainedSecretKey;
    const activeUserId = retainedUserId;
    const activeSessionIds = retainedSessionIds;
    const activeTokenId = retainedTokenId;
    if (
      activeSecretKey === null ||
      activeUserId === null ||
      activeSessionIds === null ||
      activeTokenId === null
    ) {
      return Promise.resolve(
        safeCleanupResult({
          complete: false,
          sessionReconciled: false,
          sessionRevoked: false,
          unusedTokenRevoked: false
        })
      );
    }
    inFlight = cleanupFailedAuthentication({
      secretKey: activeSecretKey,
      expectedUserId: activeUserId,
      beforeSessionIds: activeSessionIds,
      signInTokenId: activeTokenId,
      fetchImpl,
      outcomeUnknown,
      browserStopped,
      cleanupDeadlineAt
    }).then((result) => {
      if (result.cleanup_complete) {
        completed = result;
        retainedSecretKey = null;
        retainedUserId = null;
        retainedSessionIds?.clear();
        retainedSessionIds = null;
        retainedTokenId = null;
      }
      return result;
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

function deferKnownUnusedTokenCleanup({ secretKey, fetchImpl, signInTokenId }: {
  secretKey: string;
  fetchImpl: ClerkFetch;
  signInTokenId: string;
}): DeferredCleanup {
  let retainedSecretKey: string | null = secretKey;
  let retainedTokenId: string | null = signInTokenId;
  let completed: ClerkCleanupResult | null = null;
  let inFlight: Promise<ClerkCleanupResult> | null = null;
  return function cleanup({ cleanupDeadlineAt = null }: DeferredCleanupOptions = {}): Promise<ClerkCleanupResult> {
    if (completed !== null) return Promise.resolve(completed);
    if (inFlight !== null) return inFlight;
    inFlight = cleanupKnownUnusedToken({
      secretKey: retainedSecretKey,
      fetchImpl,
      signInTokenId: retainedTokenId,
      cleanupDeadlineAt
    }).then((result) => {
      if (result.cleanup_complete) {
        completed = result;
        retainedSecretKey = null;
        retainedTokenId = null;
      }
      return result;
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

async function cleanupKnownUnusedToken({ secretKey, fetchImpl, signInTokenId, cleanupDeadlineAt = null }: {
  secretKey: string | null;
  fetchImpl: ClerkFetch;
  signInTokenId: string | null;
  cleanupDeadlineAt?: WorkingDayDeadline;
}): Promise<ClerkCleanupResult> {
  let unusedTokenRevoked = false;
  try {
    if (secretKey === null || signInTokenId === null) throw new Error("Clerk unused sign-in token cleanup did not complete");
    await revokeExact({
      secretKey,
      fetchImpl,
      path: `/v1/sign_in_tokens/${encodeURIComponent(signInTokenId)}/revoke`,
      deadlineAt: operationDeadline(cleanupDeadlineAt),
      failure: "Clerk unused sign-in token cleanup did not complete"
    });
    unusedTokenRevoked = true;
  } catch {}
  return safeCleanupResult({
    complete: unusedTokenRevoked,
    sessionReconciled: true,
    sessionRevoked: false,
    unusedTokenRevoked
  });
}

function successCleanup({ secretKey: initialSecretKey, fetchImpl, activeSessionId: initialSessionId }: {
  secretKey: string;
  fetchImpl: ClerkFetch;
  activeSessionId: string;
}): DeferredCleanup {
  let secretKey: string | null = initialSecretKey;
  let activeSessionId: string | null = initialSessionId;
  let completed: ClerkCleanupResult | null = null;
  let inFlight: Promise<ClerkCleanupResult> | null = null;
  return function cleanup({ cleanupDeadlineAt = null }: DeferredCleanupOptions = {}): Promise<ClerkCleanupResult> {
    if (completed !== null) return Promise.resolve(completed);
    if (inFlight !== null) return inFlight;
    inFlight = (async (): Promise<ClerkCleanupResult> => {
      // Retained credentials clear only alongside the stored completed
      // result, which returns before reaching this point, so nulls here are
      // unreachable. Report the revocation as missed either way.
      if (secretKey === null || activeSessionId === null) {
        return safeCleanupResult({
          complete: false,
          sessionReconciled: true,
          sessionRevoked: false,
          unusedTokenRevoked: false
        });
      }
      let sessionRevoked = false;
      try {
        await revokeExact({
          secretKey,
          fetchImpl,
          path: `/v1/sessions/${encodeURIComponent(activeSessionId)}/revoke`,
          deadlineAt: operationDeadline(cleanupDeadlineAt),
          failure: "Clerk run-session cleanup did not complete"
        });
        sessionRevoked = true;
      } catch {}
      const result = safeCleanupResult({
        complete: sessionRevoked,
        sessionReconciled: true,
        sessionRevoked,
        unusedTokenRevoked: false
      });
      if (result.cleanup_complete) {
        completed = result;
        secretKey = null;
        activeSessionId = null;
      }
      return result;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/**
 * The dedicated supervisor is the only process that reads the Clerk key and the
 * private account. Auth identifiers stay in this closure and are never retained.
 */
export async function bootstrapClerkAuthentication({
  browser,
  expectedUserId: preflightUserId,
  expectedFrontendOrigin,
  workingDayDeadline,
  environment = process.env,
  fetchImpl = fetch,
  deferFailureCleanup = false,
  requireFreshAuth = false,
  approvedDisposableIdentity = null,
  timing: timingDependencies = {}
}: {
  browser: SupervisorBrowser;
  expectedUserId: unknown;
  expectedFrontendOrigin: unknown;
  workingDayDeadline: unknown;
  environment?: ClerkEnvironment;
  fetchImpl?: ClerkFetch;
  deferFailureCleanup?: boolean;
  requireFreshAuth?: boolean;
  approvedDisposableIdentity?: unknown;
  timing?: MintTimingOverrides;
}): Promise<ClerkAuthentication> {
  let secretKey: string | null = environment.CLERK_SECRET_KEY ?? null;
  delete environment.CLERK_SECRET_KEY;
  if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
    secretKey = null;
    throw new Error("CLERK_SECRET_KEY is required by the supervisor");
  }

  let deadlineAt: number;
  try {
    deadlineAt = operationDeadline(workingDayDeadline);
    await verifyClerkFrontendOrigin({ secretKey, expectedFrontendOrigin, fetchImpl, deadlineAt });
  } catch {
    secretKey = null;
    throw clerkPolicyMismatch(safeCleanupResult({
      complete: true,
      sessionReconciled: !requireFreshAuth,
      sessionRevoked: false,
      unusedTokenRevoked: false
    }));
  }
  const expectedUserId = boundedUserId(preflightUserId);
  const timing = mintTiming(timingDependencies);
  if (requireFreshAuth) {
    let expectedUsername: string;
    try {
      const approval = isRecord(approvedDisposableIdentity) ? approvedDisposableIdentity : null;
      if (
        approval === null ||
        approval.providerUserId !== expectedUserId
      ) throw new Error("identity mismatch");
      expectedUsername = boundedUsername(approval.username);
      await verifyExactDisposableIdentity({
        secretKey,
        expectedUserId,
        expectedUsername,
        fetchImpl,
        deadlineAt
      });
    } catch {
      secretKey = null;
      throw authPreparationFailure(rejectedBeforeMintCleanup(false));
    }
  }
  let beforeSessionIds: Set<string>;
  try {
    beforeSessionIds = await listSessionIds({ secretKey, expectedUserId, fetchImpl, deadlineAt });
  } catch {
    secretKey = null;
    throw requireFreshAuth
      ? authPreparationFailure(rejectedBeforeMintCleanup(false))
      : authPreparationFailure();
  }
  if (requireFreshAuth && beforeSessionIds.size !== 0) {
    secretKey = null;
    beforeSessionIds.clear();
    throw authPreparationFailure(rejectedBeforeMintCleanup(true));
  }
  if (requireFreshAuth) {
    const cleanBrowserPreAuth = (preAuth: unknown): boolean =>
      isRecord(preAuth) &&
      preAuth.ok === true &&
      preAuth.clerk_ready === true &&
      preAuth.signed_out === true &&
      preAuth.session_absent === true &&
      preAuth.sign_in_clean === true &&
      preAuth.caps_valid === true;
    let preAuth: unknown;
    try {
      preAuth = await browser.call({ method: "inspect_clerk_pre_auth" }, "supervisor");
    } catch {}
    if (!cleanBrowserPreAuth(preAuth)) {
      secretKey = null;
      beforeSessionIds.clear();
      throw authPreparationFailure(rejectedBeforeMintCleanup(true));
    }

    // Finish browser-state, deadline, and cap admission before the final
    // provider inventory, which must be the last awaited precondition to mint.
    let finalPreAuth: unknown;
    try {
      finalPreAuth = await browser.call({ method: "inspect_clerk_pre_auth" }, "supervisor");
    } catch {}
    if (!cleanBrowserPreAuth(finalPreAuth)) {
      secretKey = null;
      beforeSessionIds.clear();
      throw authPreparationFailure(rejectedBeforeMintCleanup(true));
    }

    let finalSessionIds: Set<string>;
    try {
      finalSessionIds = await listSessionIds({ secretKey, expectedUserId, fetchImpl, deadlineAt });
    } catch {
      secretKey = null;
      beforeSessionIds.clear();
      throw authPreparationFailure(rejectedBeforeMintCleanup(false));
    }
    beforeSessionIds.clear();
    beforeSessionIds = finalSessionIds;
    if (beforeSessionIds.size !== 0) {
      secretKey = null;
      beforeSessionIds.clear();
      throw authPreparationFailure(rejectedBeforeMintCleanup(true));
    }
  }

  let signInToken: { id: string; ticket: string } | null;
  try {
    signInToken = await mintTicket({ secretKey, expectedUserId, fetchImpl, deadlineAt, timing });
  } catch (error) {
    if (!isMintOutcomeUnknown(error)) {
      secretKey = null;
      beforeSessionIds.clear();
      throw new Error("Clerk authentication preparation failed");
    }
    const cleanup = error.tokenId === null
      ? deferUnknownMintCleanup({
          ambiguityObservedAt: error.ambiguityObservedAt,
          timing,
          secretKey,
          expectedUserId,
          beforeSessionIds,
          fetchImpl
        })
      : deferFailureCleanup
        ? deferKnownUnusedTokenCleanup({ secretKey, fetchImpl, signInTokenId: error.tokenId })
        : await cleanupKnownUnusedToken({ secretKey, fetchImpl, signInTokenId: error.tokenId });
    secretKey = null;
    beforeSessionIds.clear();
    throw bootstrapFailure(
      "Clerk authentication preparation failed",
      cleanup,
      CLERK_MINT_OUTCOME_UNKNOWN_CODE,
      CLERK_MINT_OUTCOME_UNKNOWN_CODE
    );
  }

  let response: unknown;
  try {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("expired");
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    try {
      response = await Promise.race([
        browser.call(
          { method: "authenticate_clerk_ticket", ticket: signInToken.ticket, expected_user_id: expectedUserId },
          "supervisor"
        ),
        new Promise<never>((_, rejectTimeout) => {
          timer = setTimeout(() => rejectTimeout(new Error("timeout")), remaining);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    const cleanup = deferFailureCleanup
      ? deferFailedAuthenticationCleanup({ secretKey, expectedUserId, beforeSessionIds, signInTokenId: signInToken.id, fetchImpl, outcomeUnknown: true })
      : await cleanupFailedAuthentication({
          secretKey,
          expectedUserId,
          beforeSessionIds,
          signInTokenId: signInToken.id,
          fetchImpl,
          outcomeUnknown: true,
          browserStopped: await stopBrowserBeforeReconciliation(browser)
        });
    secretKey = null;
    signInToken = null;
    beforeSessionIds.clear();
    throw bootstrapFailure("The browser could not confirm Clerk authentication", cleanup, "clerk_auth_outcome_unknown");
  }

  const payload = isRecord(response) ? response : null;
  const confirmed = payload !== null &&
    payload.ok === true &&
    payload.authenticated === true &&
    payload.current_context_auth_methods_locked === true &&
    payload.persistent_clerk_network_filter === true;
  let activeSessionId: string | null = null;
  try {
    activeSessionId = boundedOpaqueId(payload?.active_session_id, "active session identifier");
  } catch {}
  if (!confirmed || activeSessionId === null || beforeSessionIds.has(activeSessionId)) {
    const refusal = payload !== null && isRecord(payload.refusal) ? payload.refusal : null;
    const refusalCode: unknown = refusal?.code;
    const outcomeUnknown = confirmed || (typeof refusalCode === "string" && AMBIGUOUS_AUTH_FAILURE_CODES.has(refusalCode));
    const cleanup = deferFailureCleanup
      ? deferFailedAuthenticationCleanup({ secretKey, expectedUserId, beforeSessionIds, signInTokenId: signInToken.id, fetchImpl, outcomeUnknown })
      : await cleanupFailedAuthentication({
          secretKey,
          expectedUserId,
          beforeSessionIds,
          signInTokenId: signInToken.id,
          fetchImpl,
          outcomeUnknown,
          browserStopped: await stopBrowserBeforeReconciliation(browser)
        });
    secretKey = null;
    signInToken = null;
    beforeSessionIds.clear();
    const message = refusalCode === "clerk_auth_outcome_unknown"
      ? "Clerk authentication outcome is unknown"
      : "Clerk authentication was refused";
    throw bootstrapFailure(message, cleanup, refusalCode);
  }

  if (requireFreshAuth) {
    let route: unknown;
    try {
      route = await browser.call({ method: "bind_bounded_post_auth_route" }, "supervisor");
    } catch {}
    const routeFields = isRecord(route) ? route : null;
    if (routeFields?.ok !== true || routeFields?.route_bound !== true) {
      const cleanup = deferFailureCleanup
        ? deferFailedAuthenticationCleanup({ secretKey, expectedUserId, beforeSessionIds, signInTokenId: signInToken.id, fetchImpl, outcomeUnknown: true })
        : await cleanupFailedAuthentication({
            secretKey,
            expectedUserId,
            beforeSessionIds,
            signInTokenId: signInToken.id,
            fetchImpl,
            outcomeUnknown: true,
            browserStopped: await stopBrowserBeforeReconciliation(browser)
          });
      secretKey = null;
      signInToken = null;
      beforeSessionIds.clear();
      throw boundedRouteBootstrapFailure(cleanup, route);
    }
  }

  signInToken = null;
  beforeSessionIds.clear();
  return {
    authenticated: true,
    current_context_auth_methods_locked: true,
    persistent_clerk_network_filter: true,
    outcome_confirmed_after_timeout: payload?.outcome_confirmed_after_timeout === true,
    cleanup: successCleanup({ secretKey, fetchImpl, activeSessionId })
  };
}
