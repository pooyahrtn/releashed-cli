import { randomUUID } from "node:crypto";
import {
  CLERK_PAGE_AUTH_FAILURE_CODES,
  CLERK_TICKET_TTL_SECONDS,
  isSafeClerkAuthFailureCode,
  safeClerkBoundedRouteFailure
} from "../lib/clerk-auth.mjs";

export const CLERK_SIGN_IN_TOKEN_ENDPOINT = "https://api.clerk.com/v1/sign_in_tokens";
export const CLERK_DOMAINS_ENDPOINT = "https://api.clerk.com/v1/domains";
export const CLERK_MINT_OUTCOME_UNKNOWN_CODE = "clerk_sign_in_token_mint_outcome_unknown";

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

async function deleteDisposableUser({ secretKey, userId, fetchImpl }) {
  await boundedFetchJson({
    fetchImpl,
    secretKey,
    url: new URL(`/v1/users/${encodeURIComponent(userId)}`, CLERK_API_ORIGIN).href,
    init: { method: "DELETE" },
    deadlineAt: operationDeadline(),
    failure: "Clerk disposable identity cleanup did not complete"
  });
}

function exactHttpsOrigin(value) {
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

async function verifyClerkFrontendOrigin({ secretKey, expectedFrontendOrigin, fetchImpl, deadlineAt }) {
  const expectedOrigin = exactHttpsOrigin(expectedFrontendOrigin);
  if (expectedOrigin === null) throw new Error("Clerk authentication policy mismatch");
  const body = await boundedFetchJson({
    fetchImpl,
    secretKey,
    url: CLERK_DOMAINS_ENDPOINT,
    init: { method: "GET" },
    deadlineAt,
    failure: "Clerk authentication policy check did not complete"
  });
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Array.isArray(body.data) ||
    !Number.isSafeInteger(body.total_count) ||
    body.total_count < 0 ||
    body.total_count !== body.data.length
  ) throw new Error("Clerk authentication policy mismatch");
  let matched = false;
  for (const row of body.data) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Clerk authentication policy mismatch");
    }
    const returnedOrigin = exactHttpsOrigin(row.frontend_api_url);
    if (returnedOrigin === null) throw new Error("Clerk authentication policy mismatch");
    if (returnedOrigin === expectedOrigin) matched = true;
  }
  if (!matched) throw new Error("Clerk authentication policy mismatch");
}

function clerkPolicyMismatch(cleanup) {
  const error = new Error("Clerk authentication policy mismatch");
  error.cleanup = cleanup;
  Object.defineProperty(error, "calibration_failure_code", { value: "clerk_auth_policy_mismatch" });
  return error;
}

function disposableUsername(marker) {
  const username = `flowmap_${marker.slice("flowmap_cal_".length)}`;
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
}) {
  let secretKey = environment.CLERK_SECRET_KEY;
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

  let before;
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

  let created;
  let userId;
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
    userId = boundedOpaqueId(created?.id, "disposable user identifier");
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

  if (created?.external_id !== marker || created?.username !== username) {
    const cleanupHandle = exactDisposableUserCleanupHandle({ secretKey, userId, fetchImpl });
    const cleanup = await cleanupHandle();
    secretKey = null;
    throw disposableProvisionFailure(cleanup, cleanup.cleanup_complete ? null : cleanupHandle);
  }

  let auth = null;
  let attachedCleanup = null;
  let attachedFailureCode = null;
  let cleanupPromise = null;
  return {
    userId,
    async authenticate({ browser }) {
      try {
        auth = await bootstrapClerkAuthentication({
          browser,
          expectedUserId: userId,
          expectedFrontendOrigin,
          workingDayDeadline,
          environment: { CLERK_SECRET_KEY: secretKey },
          fetchImpl,
          deferFailureCleanup: true
        });
        return { authenticated: auth.authenticated === true };
      } catch (error) {
        attachedCleanup = error?.cleanup ?? null;
        attachedFailureCode = error?.code ?? null;
        throw error;
      }
    },
    cleanup({ browserStopped = false } = {}) {
      cleanupPromise ??= (async () => {
        if (!browserStopped) {
          return {
            cleanup_complete: false,
            sessions_revoked_or_absent: false,
            sign_in_token_unusable: false,
            synthetic_identity_deleted: false
          };
        }
        let deleted = false;
        let authCleanup = null;
        if (
          attachedFailureCode === CLERK_MINT_OUTCOME_UNKNOWN_CODE &&
          attachedCleanup?.settlesByIdentityDeletion === true
        ) {
          try {
            await deleteDisposableUser({ secretKey, userId, fetchImpl });
            deleted = true;
          } catch {}
          try {
            if (typeof attachedCleanup === "function") {
              authCleanup = await attachedCleanup({ browserStopped: true, identityDeleted: deleted });
            }
          } catch {}
        } else {
          try {
            if (auth?.cleanup) authCleanup = await auth.cleanup();
            else if (typeof attachedCleanup === "function") authCleanup = await attachedCleanup({ browserStopped: true });
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
}) {
  let secretKey = environment.CLERK_SECRET_KEY;
  delete environment.CLERK_SECRET_KEY;
  try {
    if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
      throw new Error("invalid secret");
    }
    if (
      !recovery ||
      !["creation-pending", "identity-bound"].includes(recovery.state) ||
      typeof recovery.external_id !== "string" ||
      !/^flowmap_cal_[0-9a-f]{32}$/.test(recovery.external_id) ||
      (recovery.state === "creation-pending" && recovery.user_id !== null) ||
      (recovery.state === "identity-bound" && typeof recovery.user_id !== "string")
    ) throw new Error("invalid recovery");

    const userId = recovery.state === "identity-bound"
      ? boundedOpaqueId(recovery.user_id, "disposable user identifier")
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
        if (exact.id !== userId || exact.external_id !== recovery.external_id) throw new Error("mismatched recovery");
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
        marker: recovery.external_id,
        fetchImpl,
        deadlineAt: operationDeadline(workingDayDeadline)
      });
      if (users.length > 1) throw new Error("ambiguous recovery");
      if (users.length === 1) {
        await deleteDisposableUser({ secretKey, userId: users[0], fetchImpl });
      }
      const remaining = await listDisposableUsersByMarker({
        secretKey,
        marker: recovery.external_id,
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
}) {
  let secretKey = environment.CLERK_SECRET_KEY;
  delete environment.CLERK_SECRET_KEY;
  try {
    if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
      throw new Error("invalid secret");
    }
    const userId = boundedOpaqueId(identity?.user_id, "disposable user identifier");
    const username = boundedUsername(identity?.username);
    const marker = identity?.external_id;
    if (!/^flowmap_cal_[0-9a-f]{32}$/.test(marker ?? "") || username !== disposableUsername(marker)) {
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
}) {
  let secretKey = environment.CLERK_SECRET_KEY;
  delete environment.CLERK_SECRET_KEY;
  try {
    if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
      throw new Error("invalid secret");
    }
    const userId = boundedOpaqueId(identity?.user_id, "disposable user identifier");
    const username = boundedUsername(identity?.username);
    const marker = identity?.external_id;
    if (!/^flowmap_cal_[0-9a-f]{32}$/.test(marker ?? "") || username !== disposableUsername(marker)) {
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

function disposableCleanup(complete, deleted) {
  return {
    cleanup_complete: complete,
    sessions_revoked_or_absent: complete,
    sign_in_token_unusable: complete,
    synthetic_identity_deleted: deleted
  };
}

function disposableProvisionFailure(cleanup, cleanupHandle = null, recoveryMaterial = null) {
  const error = new Error("Clerk disposable identity provisioning did not complete");
  error.cleanup = cleanup;
  if (typeof cleanupHandle === "function") {
    Object.defineProperty(error, "cleanup_handle", { value: cleanupHandle });
  }
  if (recoveryMaterial !== null) {
    Object.defineProperty(error, "recovery_material", { value: recoveryMaterial });
  }
  return error;
}

function exactDisposableUserCleanupHandle({ secretKey: initialSecretKey, userId: initialUserId, fetchImpl }) {
  let secretKey = initialSecretKey;
  let userId = initialUserId;
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

async function listDisposableUsersByMarker({ secretKey, marker, fetchImpl, deadlineAt }) {
  const url = new URL("/v1/users", CLERK_API_ORIGIN);
  url.searchParams.append("external_id", marker);
  url.searchParams.set("limit", "2");
  url.searchParams.set("offset", "0");
  const body = await boundedFetchJson({
    fetchImpl,
    secretKey,
    url: url.href,
    init: { method: "GET" },
    deadlineAt,
    failure: "Clerk disposable identity lookup did not complete"
  });
  const rows = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(rows) || rows.length > 2) throw new Error("Clerk disposable identity lookup was invalid");
  if (Number.isSafeInteger(body?.total_count) && body.total_count !== rows.length) {
    throw new Error("Clerk disposable identity lookup was incomplete");
  }
  return rows.map((row) => {
    if (row?.external_id !== marker) throw new Error("Clerk returned a mismatched disposable identity marker");
    return boundedOpaqueId(row?.id, "disposable user identifier");
  });
}

async function getDisposableUserById({ secretKey, userId, fetchImpl, deadlineAt }) {
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
  if (!result.body || typeof result.body !== "object" || Array.isArray(result.body)) {
    throw new Error("Clerk disposable identity lookup was invalid");
  }
  return {
    id: boundedOpaqueId(result.body.id, "disposable user identifier"),
    external_id: result.body.external_id,
    username: result.body.username
  };
}

async function recoverAmbiguousDisposableCreate({ secretKey, marker, fetchImpl }) {
  let users;
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

function boundedOpaqueId(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) throw new Error(`Clerk returned an invalid ${label}`);
  return value;
}

function boundedUserId(userId) {
  try {
    return boundedOpaqueId(userId, "approved identity");
  } catch {
    throw new Error("The preflight did not provide one approved Clerk identity");
  }
}

function boundedUsername(username) {
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
}) {
  const body = await boundedFetchJson({
    fetchImpl,
    secretKey,
    url: new URL(`/v1/users/${encodeURIComponent(expectedUserId)}`, CLERK_API_ORIGIN).href,
    init: { method: "GET" },
    deadlineAt,
    failure: "Clerk approved identity check did not complete"
  });
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.id !== expectedUserId ||
    body.username !== expectedUsername
  ) throw new Error("Clerk approved identity did not match");
}

function operationDeadline(workingDayDeadline = null) {
  const now = Date.now();
  const ownerDeadline = workingDayDeadline === null
    ? now + MAX_OPERATION_MS
    : typeof workingDayDeadline === "number"
      ? workingDayDeadline
      : Date.parse(workingDayDeadline);
  if (!Number.isFinite(ownerDeadline) || ownerDeadline <= now) throw new Error("The original working-day deadline has expired");
  return Math.min(ownerDeadline, now + MAX_OPERATION_MS);
}

async function boundedFetchJson({ fetchImpl, secretKey, url, init, deadlineAt, failure, onDispatch = null }) {
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
}) {
  const controller = new AbortController();
  const beforeDeadline = async (operation) => {
    const remaining = Math.min(MAX_REQUEST_MS, deadlineAt - Date.now());
    if (remaining <= 0) throw new Error(failure);
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, rejectTimeout) => {
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
    const body = await beforeDeadline(() => response.json());
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

function sessionRows(body) {
  if (Array.isArray(body)) return { rows: body, totalCount: null };
  if (Array.isArray(body?.data)) {
    return {
      rows: body.data,
      totalCount: Number.isSafeInteger(body.total_count) && body.total_count >= 0 ? body.total_count : null
    };
  }
  throw new Error("Clerk session list response was invalid");
}

async function listSessionIds({ secretKey, expectedUserId, fetchImpl, deadlineAt }) {
  const found = new Set();
  let expectedTotalCount = null;
  for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
    const offset = page * SESSION_PAGE_SIZE;
    const url = new URL("/v1/sessions", CLERK_API_ORIGIN);
    url.searchParams.set("user_id", expectedUserId);
    url.searchParams.set("limit", String(SESSION_PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    const body = await boundedFetchJson({
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
      const id = boundedOpaqueId(row?.id, "session identifier");
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
}) {
  let secretKey = environment.CLERK_SECRET_KEY;
  let sessionIds = null;
  try {
    if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
      throw new Error("invalid credential");
    }
    const deadlineAt = operationDeadline(workingDayDeadline);
    const expectedUserId = boundedUserId(preflightUserId);
    if (
      !approvedDisposableIdentity ||
      approvedDisposableIdentity.providerUserId !== expectedUserId
    ) throw new Error("identity mismatch");
    const expectedUsername = boundedUsername(approvedDisposableIdentity.username);
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

function mintOutcomeUnknown({ tokenId = null, ambiguityObservedAt }) {
  const error = new Error("Clerk sign-in ticket mint outcome is unknown");
  error.code = CLERK_MINT_OUTCOME_UNKNOWN_CODE;
  Object.defineProperties(error, {
    tokenId: { value: tokenId },
    ambiguityObservedAt: { value: ambiguityObservedAt }
  });
  return error;
}

async function mintTicket({ secretKey, expectedUserId, fetchImpl, deadlineAt, timing }) {
  let dispatched = false;
  let body;
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

  let id = null;
  try {
    id = boundedOpaqueId(body?.id, "sign-in token identifier");
  } catch {}
  const validTicket = typeof body?.token === "string" && body.token.length >= 8 && body.token.length <= 4_096 && !/[\r\n]/.test(body.token);
  if (id === null || !validTicket) {
    throw mintOutcomeUnknown({
      tokenId: id,
      ambiguityObservedAt: { monotonic: timing.monotonicNow(), wall: timing.wallNow() }
    });
  }
  return { id, ticket: body.token };
}

async function revokeExact({ secretKey, fetchImpl, path, deadlineAt, failure }) {
  await boundedFetchJson({
    fetchImpl,
    secretKey,
    url: new URL(path, CLERK_API_ORIGIN).href,
    init: { method: "POST", headers: { "Content-Type": "application/json" } },
    deadlineAt,
    failure
  });
}

function safeCleanupResult({ complete, sessionReconciled, sessionRevoked, unusedTokenRevoked }) {
  return {
    cleanup_complete: complete,
    session_reconciled: sessionReconciled,
    run_session_revoked: sessionRevoked,
    unused_sign_in_token_revoked: unusedTokenRevoked
  };
}

async function cleanupFailedAuthentication({ secretKey, expectedUserId, beforeSessionIds, signInTokenId, fetchImpl, outcomeUnknown, browserStopped, cleanupDeadlineAt = null }) {
  const deadlineAt = operationDeadline(cleanupDeadlineAt);
  let afterSessionIds = null;
  let sessionRevoked = false;
  let unusedTokenRevoked = false;
  if (browserStopped) {
    try {
      afterSessionIds = await listSessionIds({ secretKey, expectedUserId, fetchImpl, deadlineAt });
    } catch {}
  }

  const newSessions = afterSessionIds === null
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

async function stopBrowserBeforeReconciliation(browser) {
  if (typeof browser.stop !== "function") return false;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => browser.stop()).then(() => true),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), MAX_OPERATION_MS);
      })
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function bootstrapFailure(message, cleanup, diagnosticCode = "clerk_auth_failed", failureCode = null) {
  const error = new Error(message);
  error.cleanup = cleanup;
  Object.defineProperty(error, "calibration_failure_code", {
    value: isSafeClerkAuthFailureCode(diagnosticCode) || diagnosticCode === CLERK_MINT_OUTCOME_UNKNOWN_CODE
      ? diagnosticCode
      : "clerk_auth_failed"
  });
  if (failureCode !== null) Object.defineProperty(error, "code", { value: failureCode });
  return error;
}

function boundedRouteBootstrapFailure(cleanup, route) {
  const error = bootstrapFailure(
    "The browser could not confirm Clerk authentication",
    cleanup,
    "clerk_auth_landing_unconfirmed"
  );
  const diagnostic = safeClerkBoundedRouteFailure(route?.failure_stage, route?.failure_code, route?.failure_point ?? null);
  if (diagnostic) {
    Object.defineProperty(error, "calibration_failure_substage", { value: diagnostic.stage });
    Object.defineProperty(error, "calibration_failure_subcode", { value: diagnostic.code });
    Object.defineProperty(error, "calibration_failure_point", { value: diagnostic.point });
  }
  return error;
}

function authPreparationFailure(cleanup = null) {
  const error = new Error("Clerk authentication preparation failed");
  Object.defineProperty(error, "calibration_failure_code", { value: "clerk_auth_preparation_failed" });
  if (cleanup !== null) error.cleanup = cleanup;
  return error;
}

function rejectedBeforeMintCleanup(sessionReconciled) {
  return safeCleanupResult({
    complete: true,
    sessionReconciled,
    sessionRevoked: false,
    unusedTokenRevoked: false
  });
}

function mintTiming(dependencies = {}) {
  return {
    monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
    wallNow: dependencies.wallNow ?? (() => Date.now()),
    wait: dependencies.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  };
}

function unknownMintCleanupResult({ complete = false, sessionReconciled = false, reason = null } = {}) {
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
}) {
  const lifetimeMs = (CLERK_TICKET_TTL_SECONDS * 1_000) + SIGN_IN_TOKEN_EXPIRY_MARGIN_MS;
  let secretKey = initialSecretKey;
  let expectedUserId = initialUserId;
  let beforeSessionIds = new Set(initialSessionIds);
  let completed = null;
  let inFlight = null;
  const clearRetained = () => {
    secretKey = null;
    expectedUserId = null;
    beforeSessionIds?.clear();
    beforeSessionIds = null;
  };
  const finish = (result) => {
    if (completed !== null) return completed;
    if (result.cleanup_complete) {
      completed = result;
      if (inFlight === null) clearRetained();
    }
    return result;
  };
  const cleanup = function cleanup({ identityDeleted = false, cleanupDeadlineAt = null } = {}) {
    if (completed !== null) return Promise.resolve(completed);
    if (identityDeleted) {
      return Promise.resolve(finish(unknownMintCleanupResult({
        complete: true,
        sessionReconciled: true,
        reason: "identity-deleted"
      })));
    }
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      const monotonicRemaining = lifetimeMs - (timing.monotonicNow() - ambiguityObservedAt.monotonic);
      const wallRemaining = lifetimeMs - (timing.wallNow() - ambiguityObservedAt.wall);
      const remaining = Math.max(0, monotonicRemaining, wallRemaining);
      if (
        cleanupDeadlineAt !== null &&
        (!Number.isFinite(cleanupDeadlineAt) || remaining > cleanupDeadlineAt - timing.wallNow())
      ) return unknownMintCleanupResult();
      if (remaining > 0) await timing.wait(remaining);
      if (completed !== null) return completed;
      const expired = timing.monotonicNow() - ambiguityObservedAt.monotonic >= lifetimeMs &&
        timing.wallNow() - ambiguityObservedAt.wall >= lifetimeMs;
      if (!expired) return unknownMintCleanupResult();

      let afterSessionIds;
      try {
        afterSessionIds = await listSessionIds({
          secretKey,
          expectedUserId,
          fetchImpl,
          deadlineAt: operationDeadline(cleanupDeadlineAt)
        });
      } catch {
        return unknownMintCleanupResult({ reason: "expired" });
      }
      if (completed !== null) return completed;
      const newSessions = [...afterSessionIds].filter((id) => !beforeSessionIds.has(id));
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

function deferFailedAuthenticationCleanup({ secretKey, expectedUserId, beforeSessionIds, signInTokenId, fetchImpl, outcomeUnknown }) {
  let retainedSecretKey = secretKey;
  let retainedUserId = expectedUserId;
  let retainedSessionIds = new Set(beforeSessionIds);
  let retainedTokenId = signInTokenId;
  let completed = null;
  let inFlight = null;
  return function cleanup({ browserStopped = false, cleanupDeadlineAt = null } = {}) {
    if (completed !== null) return Promise.resolve(completed);
    if (inFlight !== null) return inFlight;
    inFlight = cleanupFailedAuthentication({
      secretKey: retainedSecretKey,
      expectedUserId: retainedUserId,
      beforeSessionIds: retainedSessionIds,
      signInTokenId: retainedTokenId,
      fetchImpl,
      outcomeUnknown,
      browserStopped,
      cleanupDeadlineAt
    }).then((result) => {
      if (result.cleanup_complete) {
        completed = result;
        retainedSecretKey = null;
        retainedUserId = null;
        retainedSessionIds.clear();
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

function deferKnownUnusedTokenCleanup({ secretKey, fetchImpl, signInTokenId }) {
  let retainedSecretKey = secretKey;
  let retainedTokenId = signInTokenId;
  let completed = null;
  let inFlight = null;
  return function cleanup({ cleanupDeadlineAt = null } = {}) {
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

async function cleanupKnownUnusedToken({ secretKey, fetchImpl, signInTokenId, cleanupDeadlineAt = null }) {
  let unusedTokenRevoked = false;
  try {
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

function successCleanup({ secretKey: initialSecretKey, fetchImpl, activeSessionId: initialSessionId }) {
  let secretKey = initialSecretKey;
  let activeSessionId = initialSessionId;
  let completed = null;
  let inFlight = null;
  return function cleanup({ cleanupDeadlineAt = null } = {}) {
    if (completed !== null) return Promise.resolve(completed);
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
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
}) {
  let secretKey = environment.CLERK_SECRET_KEY;
  delete environment.CLERK_SECRET_KEY;
  if (typeof secretKey !== "string" || secretKey.length < 8 || secretKey.length > 4_096 || /[\r\n]/.test(secretKey)) {
    secretKey = null;
    throw new Error("CLERK_SECRET_KEY is required by the supervisor");
  }

  let deadlineAt;
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
    let expectedUsername;
    try {
      if (
        !approvedDisposableIdentity ||
        approvedDisposableIdentity.providerUserId !== expectedUserId
      ) throw new Error("identity mismatch");
      expectedUsername = boundedUsername(approvedDisposableIdentity.username);
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
  let beforeSessionIds;
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
    const cleanBrowserPreAuth = (preAuth) =>
      preAuth?.ok === true &&
      preAuth.clerk_ready === true &&
      preAuth.signed_out === true &&
      preAuth.session_absent === true &&
      preAuth.sign_in_clean === true &&
      preAuth.caps_valid === true;
    let preAuth;
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
    let finalPreAuth;
    try {
      finalPreAuth = await browser.call({ method: "inspect_clerk_pre_auth" }, "supervisor");
    } catch {}
    if (!cleanBrowserPreAuth(finalPreAuth)) {
      secretKey = null;
      beforeSessionIds.clear();
      throw authPreparationFailure(rejectedBeforeMintCleanup(true));
    }

    let finalSessionIds;
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

  let signInToken;
  try {
    signInToken = await mintTicket({ secretKey, expectedUserId, fetchImpl, deadlineAt, timing });
  } catch (error) {
    if (error?.code !== CLERK_MINT_OUTCOME_UNKNOWN_CODE) {
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

  let response;
  try {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("expired");
    let timer;
    try {
      response = await Promise.race([
        browser.call(
          { method: "authenticate_clerk_ticket", ticket: signInToken.ticket, expected_user_id: expectedUserId },
          "supervisor"
        ),
        new Promise((_, rejectTimeout) => {
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

  const confirmed = response?.ok === true &&
    response.authenticated === true &&
    response.current_context_auth_methods_locked === true &&
    response.persistent_clerk_network_filter === true;
  let activeSessionId = null;
  try {
    activeSessionId = boundedOpaqueId(response?.active_session_id, "active session identifier");
  } catch {}
  if (!confirmed || activeSessionId === null || beforeSessionIds.has(activeSessionId)) {
    const outcomeUnknown = confirmed || AMBIGUOUS_AUTH_FAILURE_CODES.has(response?.refusal?.code);
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
    const message = response?.refusal?.code === "clerk_auth_outcome_unknown"
      ? "Clerk authentication outcome is unknown"
      : "Clerk authentication was refused";
    throw bootstrapFailure(message, cleanup, response?.refusal?.code);
  }

  if (requireFreshAuth) {
    let route;
    try {
      route = await browser.call({ method: "bind_bounded_post_auth_route" }, "supervisor");
    } catch {}
    if (route?.ok !== true || route.route_bound !== true) {
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
    outcome_confirmed_after_timeout: response.outcome_confirmed_after_timeout === true,
    cleanup: successCleanup({ secretKey, fetchImpl, activeSessionId })
  };
}
