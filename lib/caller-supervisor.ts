// Owned-caller supervision: hard deadline, external-signal forwarding,
// parent-early-exit detection and verified process-group cleanup.
//
// Exactly one owned process group is ever signalled (the spawned child's
// group id); no global kills. Every exit path resolves a durable result.
// Whether partial output may count as an answer is left to the entrypoint:
// this module only reports how the child ended.
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';

export type SuperviseOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Already-open file descriptors the child writes to; owned by the caller. */
  stdoutFd: number;
  stderrFd: number;
  deadlineMs: number;
  /** SIGTERM grace before SIGKILL escalation. Default 1500. */
  termGraceMs?: number;
  /** Wait after SIGKILL before declaring the group unkillable. Default 1500. */
  killGraceMs?: number;
  /** Parent-liveness poll interval. Default 500. */
  parentPollMs?: number;
  label?: string;
  /** Called synchronously with the owned group id right after spawn. */
  onSpawn?: (pid: number) => void;
  /**
   * Trusted process-table source for controlled no-browser tests. Native
   * listProcessTable by default; never supplied via CLI or environment.
   */
  source?: ProcessTableSource;
};

export type SupervisionResult = {
  pid: number | null;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  cancelled: 'SIGTERM' | 'SIGINT' | null;
  parent_gone: boolean;
  group_clean: boolean;
  /** Machine-readable failure cause; null only on a clean child exit. */
  error: string | null;
  /**
   * Bounded typed custody evidence: total failed process-table reads plus
   * the first and last failure. No raw tables, argv, env or payloads.
   */
  custody: CustodyEvidence;
  /**
   * Raw enforcement outcome (null when nothing was enforced). Retained
   * separately because sticky custody uncertainty can dominate it: this is
   * an enforcement result, NOT proof of complete custody, and an
   * uncertain/missing snapshot is evidence of neither a survivor nor a
   * clean tree. Only group_clean is authoritative.
   */
  enforcement: { clean: boolean; escalated: boolean } | null;
};

function fail(message: string): never {
  throw new Error(message);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveOnPath(command: string): string | null {
  const search = (process.env.PATH ?? '/usr/bin:/bin').split(':');
  for (const dir of search) {
    if (!dir) continue;
    const candidate = `${dir}/${command}`;
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Throws before any spawn when the request cannot run. No side effects. */
export function validateCallerRequest(options: Pick<SuperviseOptions, 'command' | 'args' | 'cwd' | 'deadlineMs'>): void {
  const { command, args, cwd, deadlineMs } = options;
  if (!command || typeof command !== 'string') fail('caller command is required');
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) fail('caller args must be strings');
  try {
    if (!statSync(cwd).isDirectory()) fail(`workspace is not a directory: ${cwd}`);
  } catch {
    fail(`workspace is not a directory: ${cwd}`);
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) fail('deadline must be a positive integer of milliseconds');
  const resolved = command.includes('/') ? (isExecutableFile(command) ? command : null) : resolveOnPath(command);
  if (!resolved) fail(`caller binary not found or not executable: ${command}`);
}

export function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException)?.code === 'EPERM') return true;
    throw error;
  }
}

function signalOwnedGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    // ESRCH: group already gone. EPERM: nothing left signallable — on
    // Darwin a group whose sole member is an unreaped zombie answers EPERM,
    // and a group with an unkillable member could not be touched anyway.
    // Either way there is nothing more this signal can do; liveness stays
    // with the verified wait below, which fails closed.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH' || code === 'EPERM') return;
    throw error;
  }
}

async function waitForGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!processGroupAlive(pgid)) return true;
    if (Date.now() >= deadline) return !processGroupAlive(pgid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Owned-descendant custody.
//
// The owned caller is typically a shell (the OpenCode bash tool) that forks
// children into a *detached* process group: signalling only the spawned
// child's group id leaves that subtree running past the deadline (observed
// C2: group_clean reported while a second vision run kept acting for four
// more minutes).
//
// The tracker records owned descendants by ancestry *while the tree is
// alive*: ppid links from the owned root (the only way to reach detached
// children) plus a same-group sweep (pgid === root pid, which also catches
// reparented same-group orphans). Discovery starts synchronously after
// spawn, but the first snapshot is async: a child that forks, detaches and
// orphans before the first observation is a stated limitation. Long-lived
// shells — the observed shape — are reliably tracked.
//
// Identity is pinned by process start stamp (ps lstart). A pid is adopted
// only when its parent's pinned stamp matches the live table, and a tracked
// pid is signalled only when its own stamp matches: a reused pid is never
// adopted, never signalled, and never blocks a clean verdict. Without
// validated identity the code fails closed — no individual signal — and
// marks custody uncertain, which never reports clean. Table reads are
// bounded and serialized. Nothing is matched by command name, so parallel
// owner sessions are untouched.
// ---------------------------------------------------------------------------

export type ProcessEntry = { pid: number; ppid: number; pgid: number; start: string };
export type ProcessTableSource = () => Promise<Map<number, ProcessEntry>>;
export type DescendantCustody = { owned: Map<number, string | null>; uncertain: boolean; ledger?: CustodyLedger };

/** Controlled custody-failure kind: never a raw dump. */
export type CustodyFailureKind = 'timeout' | 'spawn' | 'exit' | 'parse' | 'source';
/** Where the failed read happened: background tracking or terminal cleanup. */
export type CustodyFailurePhase = 'tracking' | 'cleanup';
export type CustodyFailure = {
  kind: CustodyFailureKind;
  phase: CustodyFailurePhase;
  /** ISO timestamp of the failed read. */
  at: string;
  /** Elapsed milliseconds for the failed read. */
  read_ms: number;
  /** Native spawn errno (spawn kind only). */
  code?: string;
  /** Native ps exit code (exit kind only). */
  exit?: number | null;
  /** Native ps termination signal (exit kind only). */
  signal?: string | null;
  /** Bounded safe detail; never raw rows, argv, env or payloads. */
  detail?: string;
};
/** Bounded ledger: total count plus first/last failure only. */
export type CustodyLedger = { count: number; first: CustodyFailure | null; last: CustodyFailure | null };
export type CustodyEvidence = CustodyLedger;

/** Cap for safe diagnostic strings kept in custody evidence. */
export const CUSTODY_DETAIL_LIMIT = 160;

export function boundCustodyDetail(value: unknown): string {
  const text = String(value ?? '');
  return text.length > CUSTODY_DETAIL_LIMIT ? text.slice(0, CUSTODY_DETAIL_LIMIT) : text;
}

/**
 * Record one failed custody read: sticky uncertain, bounded ledger (count
 * plus first/last). Never throws. No retries, no clearing of uncertainty.
 * Every diagnostic field is validated and bounded here at the recording
 * boundary: native codes/signals must match their safe shapes, exit must
 * be a small integer, and detail text is capped. First and last are stored
 * as detached copies so they never share mutable state.
 */
export function recordCustodyFailure(
  custody: DescendantCustody,
  phase: CustodyFailurePhase,
  kind: CustodyFailureKind,
  readMs: number,
  extra?: Pick<CustodyFailure, 'code' | 'exit' | 'signal' | 'detail'>,
): CustodyFailure {
  const failure: CustodyFailure = { kind, phase, at: new Date().toISOString(), read_ms: Math.max(0, Math.round(readMs)) };
  const code = boundNativeCode(extra?.code);
  if (code !== undefined) failure.code = code;
  const exit = boundNativeExit(extra?.exit);
  if (exit !== undefined) failure.exit = exit;
  const signal = boundNativeSignal(extra?.signal);
  if (signal !== undefined) failure.signal = signal;
  if (extra?.detail !== undefined) failure.detail = boundCustodyDetail(extra.detail);
  const ledger = (custody.ledger ??= { count: 0, first: null, last: null });
  ledger.count += 1;
  if (ledger.first === null) ledger.first = { ...failure };
  ledger.last = { ...failure };
  custody.uncertain = true;
  return { ...failure };
}

/** Detached snapshot of the ledger for results and receipts: copies, never shared mutable state. */
export function custodyEvidence(custody: DescendantCustody): CustodyEvidence {
  const ledger = custody.ledger;
  return {
    count: ledger?.count ?? 0,
    first: ledger?.first ? { ...ledger.first } : null,
    last: ledger?.last ? { ...ledger.last } : null,
  };
}

/** Native spawn errno shape (e.g. ENOENT); anything else is dropped, never recorded. */
function boundNativeCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const text = value.length > 32 ? value.slice(0, 32) : value;
  return /^[A-Z][A-Z0-9_]*$/.test(text) ? text : undefined;
}

/** Native exit status: a small safe integer (or null); anything else is dropped. */
function boundNativeExit(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined;
  if (value < 0 || value > 255) return undefined;
  return value;
}

/** Native termination signal name (e.g. SIGKILL, or null); anything else is dropped. */
function boundNativeSignal(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const text = value.length > 16 ? value.slice(0, 16) : value;
  return /^[A-Za-z][A-Za-z0-9]*$/.test(text) ? text : undefined;
}

type TaggedTableError = Error & {
  custodyKind?: CustodyFailureKind;
  code?: string;
  exit?: number | null;
  signal?: string | null;
};

function taggedTableError(kind: CustodyFailureKind, message: string, extra?: { code?: string; exit?: number | null; signal?: string | null; detail?: string }): TaggedTableError {
  const error = new Error(message) as TaggedTableError;
  error.custodyKind = kind;
  if (extra?.code !== undefined) error.code = extra.code;
  if (extra?.exit !== undefined) error.exit = extra.exit;
  if (extra?.signal !== undefined) error.signal = extra.signal;
  if (extra?.detail !== undefined) (error as TaggedTableError & { detail?: string }).detail = extra.detail;
  return error;
}

/** Bound for one process-table read, so a hung ps cannot stall deadline cleanup. */
export const PROCESS_TABLE_TIMEOUT_MS = 500;

/**
 * Parse native `ps -eo pid,ppid,pgid,lstart` stdout. Fail-fast and
 * fail-closed: the header must match one supported column order exactly,
 * every row must carry exactly three decimal ids plus a five-token start
 * stamp, and a duplicate pid or an empty body rejects instead of resolving
 * a partial or empty table that could masquerade as complete evidence.
 * Error detail names the row number and reason only, never raw content.
 * No row is ever truncated or dropped: extra columns reject like any
 * other malformed row. Start-stamp names stay alphabetic-loose so a
 * native locale variant is never rejected for its day/month words; the
 * numeric fields must be well-formed.
 */
export function parseProcessTableOutput(stdout: string): Map<number, ProcessEntry> {
  const lines = stdout.split('\n');
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index += 1;
  const header = (lines[index] ?? '').trim().split(/\s+/).map((token) => token.toUpperCase());
  // Darwin prints STARTED for lstart; Linux prints LSTART. Either order is
  // accepted, but exactly: a reordered or extended header is evidence of an
  // unexpected table shape, not a supported one.
  const headerOk =
    header.length === 4 &&
    header[0] === 'PID' &&
    header[1] === 'PPID' &&
    header[2] === 'PGID' &&
    (header[3] === 'LSTART' || header[3] === 'STARTED');
  if (!headerOk) {
    throw taggedTableError('parse', 'process table malformed: missing header');
  }
  const table = new Map<number, ProcessEntry>();
  let rows = 0;
  for (let lineNo = index + 1; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
    if (!line.trim()) continue;
    // pid ppid pgid + 5-token start stamp (Day Mon DD HH:MM:SS YYYY):
    // exactly eight tokens, never silently truncated.
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 8) {
      throw taggedTableError('parse', `process table malformed: row ${rows + 1} is not pid ppid pgid start`);
    }
    const [pidRaw, ppidRaw, pgidRaw] = parts;
    if (!isDecimalId(pidRaw) || !isDecimalId(ppidRaw) || !isDecimalId(pgidRaw)) {
      throw taggedTableError('parse', `process table malformed: row ${rows + 1} has non-numeric ids`);
    }
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const pgid = Number(pgidRaw);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) {
      throw taggedTableError('parse', `process table malformed: row ${rows + 1} has non-numeric ids`);
    }
    // Decimal positive pid; ppid/pgid are never negative.
    if (!(pid > 0) || ppid < 0 || pgid < 0) {
      throw taggedTableError('parse', `process table malformed: row ${rows + 1} has out-of-range ids`);
    }
    if (!isValidStartStamp(parts.slice(3, 8))) {
      throw taggedTableError('parse', `process table malformed: row ${rows + 1} has malformed start`);
    }
    if (table.has(pid)) {
      throw taggedTableError('parse', 'process table malformed: duplicate pid');
    }
    table.set(pid, { pid, ppid, pgid, start: parts.slice(3, 8).join(' ') });
    rows += 1;
  }
  if (rows === 0) throw taggedTableError('parse', 'process table malformed: empty table');
  return table;
}

/** Plain decimal digits only: no sign, hex, exponent or whitespace. */
function isDecimalId(token: string): boolean {
  return /^[0-9]+$/.test(token);
}

/** Five-token start stamp with well-formed numeric fields; day/month words stay loose. */
function isValidStartStamp(tokens: string[]): boolean {
  if (tokens.length !== 5) return false;
  const [dow, mon, day, time, year] = tokens;
  if (!/^[A-Za-z]+$/.test(dow) || !/^[A-Za-z]+$/.test(mon)) return false;
  if (!/^[0-9]{1,2}$/.test(day) || Number(day) < 1 || Number(day) > 31) return false;
  const clock = /^([0-9]{1,2}):([0-9]{2}):([0-9]{2})$/.exec(time);
  if (!clock) return false;
  if (Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3]) > 60) return false;
  if (!/^[0-9]{4}$/.test(year)) return false;
  return true;
}

/**
 * Native process table (pid/ppid/pgid/start only). Rejects with a tagged
 * custodyKind (timeout/spawn/exit/parse) on spawn failure, timeout,
 * nonzero exit or malformed output. ps stderr is drained so the pipe
 * cannot block; only a bounded snippet is kept for exit diagnostics.
 */
export function listProcessTable(): Promise<Map<number, ProcessEntry>> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('ps', ['-eo', 'pid,ppid,pgid,lstart'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Normalize only this collector's output; never alter the caller locale.
        env: { ...process.env, LC_ALL: 'C' },
      });
    } catch (error) {
      reject(taggedTableError('spawn', `process table spawn failed: ${boundCustodyDetail((error as Error)?.message)}`, { code: (error as NodeJS.ErrnoException)?.code }));
      return;
    }
    let stdout = '';
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      reject(taggedTableError('timeout', 'process table timed out'));
    }, PROCESS_TABLE_TIMEOUT_MS);
    // stdio pipe guarantees both streams; the assertions keep the drain total.
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    // Drained and counted past a bounded prefix, so ps stderr can never
    // block the pipe. Evidence keeps only size/status, never raw payload.
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderrBytes += chunk.length;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(taggedTableError('spawn', `process table spawn failed: ${boundCustodyDetail((error as Error)?.message)}`, { code: (error as NodeJS.ErrnoException)?.code }));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(taggedTableError('exit', `ps exited ${code}`, { exit: code, signal: signal as string | null, detail: `ps exit ${code} signal ${signal ?? 'none'} stderr ${stderrBytes}b` }));
        return;
      }
      try {
        resolve(parseProcessTableOutput(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

/** One snapshot with an outer bound, so an injected or hung source also fails closed. */
async function snapshotTable(source: ProcessTableSource): Promise<Map<number, ProcessEntry>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(taggedTableError('timeout', 'process table timed out')), PROCESS_TABLE_TIMEOUT_MS);
    });
    return await Promise.race([source(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * snapshotTable that records the bounded typed failure (kind, phase,
 * timestamp, read elapsed, native code/exit/signal where applicable)
 * instead of discarding the cause. Returns null on failure; the caller
 * fails closed via sticky uncertainty. Injected-source failures keep only
 * a controlled kind and a fixed detail: arbitrary injected message, code,
 * exit, signal or detail payloads never reach the receipt. Native failures
 * keep their tagged kind (an untagged native error is `source`, never a
 * claimed `exit`); native fields are validated safe-typed at recording.
 */
async function snapshotWithCustody(
  source: ProcessTableSource,
  custody: DescendantCustody,
  phase: CustodyFailurePhase,
): Promise<Map<number, ProcessEntry> | null> {
  const started = Date.now();
  const isNative = source === listProcessTable;
  try {
    return await snapshotTable(source);
  } catch (error) {
    const readMs = Date.now() - started;
    const tagged = error as TaggedTableError & { detail?: string };
    if (!isNative) {
      const kind: CustodyFailureKind = tagged?.custodyKind === 'timeout' ? 'timeout' : 'source';
      recordCustodyFailure(custody, phase, kind, readMs, { detail: 'controlled source read failed' });
      return null;
    }
    const rawKind = tagged?.custodyKind;
    const kind: CustodyFailureKind =
      rawKind === 'timeout' || rawKind === 'spawn' || rawKind === 'exit' || rawKind === 'parse' ? rawKind : 'source';
    const message = (error as Error)?.message ?? String(error);
    recordCustodyFailure(custody, phase, kind, readMs, {
      code: tagged?.code,
      exit: tagged?.exit,
      signal: tagged?.signal,
      detail: tagged?.detail ?? boundCustodyDetail(message),
    });
    return null;
  }
}

/**
 * Grow `custody.owned` (pid -> start stamp) from one table snapshot. A pid
 * is adopted only when its parent is owned AND the parent's pinned stamp
 * matches the live table — a child of a reused parent pid is never
 * adopted. The root stamp is captured on first sight (never an eternal
 * null); while the root is unobserved, nothing is adopted through it. A
 * failed snapshot marks custody uncertain and adopts nothing.
 */
export async function refreshOwnedDescendants(
  rootPid: number,
  custody: DescendantCustody,
  source: ProcessTableSource = listProcessTable,
  phase: CustodyFailurePhase = 'tracking',
): Promise<void> {
  const table = await snapshotWithCustody(source, custody, phase);
  if (!table) return;
  const { owned } = custody;
  const seenRoot = table.get(rootPid);
  if (seenRoot && owned.get(rootPid) == null) owned.set(rootPid, seenRoot.start);
  const rootStamp = owned.get(rootPid);
  const rootOurs = rootStamp != null && table.get(rootPid)?.start === rootStamp;
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of table.values()) {
      if (owned.has(entry.pid)) continue;
      const parentStamp = owned.get(entry.ppid);
      if (parentStamp == null) continue;
      const parentNow = table.get(entry.ppid);
      if (parentNow?.start === parentStamp) {
        owned.set(entry.pid, entry.start);
        grew = true;
      } else if (rootOurs && entry.pgid === rootPid) {
        owned.set(entry.pid, entry.start);
        grew = true;
      }
    }
  }
}

/**
 * Owned-descendant tracker with a drained stop. stop() halts new ticks and
 * then awaits the bounded in-flight refresh directly, so a delayed
 * failure is recorded BEFORE enforcement and the receipt — never mutating
 * custody after the result resolved. The in-flight refresh is already
 * bounded by PROCESS_TABLE_TIMEOUT_MS, so no fallback timer is kept: a
 * stray race timer held the event loop ~750ms past a stopped process and
 * is what made stop() take ~799ms with an immediate source.
 */
export type DescendantTracker = { stop(): Promise<void> };

export function startDescendantTracker(
  rootPid: number,
  custody: DescendantCustody,
  pollMs = 100,
  source: ProcessTableSource = listProcessTable,
): DescendantTracker {
  let stopped = false;
  let busy = false;
  let active: Promise<void> | null = null;
  const tick = (): void => {
    if (stopped || busy) return;
    busy = true;
    active = refreshOwnedDescendants(rootPid, custody, source, 'tracking')
      .catch((error) => {
        // refreshOwnedDescendants records read failures itself; this guards
        // only against an unexpected adoption-loop throw, same phase/kind
        // discipline, bounded detail.
        recordCustodyFailure(custody, 'tracking', 'source', 0, { detail: boundCustodyDetail((error as Error)?.message) });
      })
      .finally(() => {
        busy = false;
      });
    void active;
  };
  tick();
  const timer = setInterval(tick, Math.max(50, pollMs));
  timer.unref?.();
  return {
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      // Await the already-bounded in-flight refresh directly. No fallback
      // timer is created, so nothing is left keeping the loop alive and
      // nothing can mutate custody after stop() returns.
      const pending = active;
      if (pending) await pending;
    },
  };
}

/**
 * Tri-state ownership liveness. True: alive with confirmed identity. False:
 * ours is gone (dead, or the slot now names another process). Null:
 * unknown — no validated identity — which fails closed: never signalled,
 * never counted as cleaned.
 */
function ownedState(
  pid: number,
  wantStart: string | null | undefined,
  table: Map<number, ProcessEntry> | null,
): boolean | null {
  if (wantStart == null) return null;
  if (!processAlive(pid)) return false;
  if (table === null) return null;
  const current = table.get(pid);
  if (!current) return null;
  return current.start === wantStart;
}

function signalOwnedPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH' || code === 'EPERM') return;
    throw error;
  }
}

async function waitForOwnedTreeExit(
  rootPid: number,
  custody: DescendantCustody,
  rootDead: boolean,
  snapshot: () => Promise<Map<number, ProcessEntry> | null>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const table = await snapshot();
    let outstanding = 0;
    for (const [pid, wantStart] of custody.owned) {
      if (ownedState(pid, wantStart, table) !== false) outstanding += 1;
    }
    const rootGone = rootDead || ownedState(rootPid, custody.owned.get(rootPid), table) === false;
    if (outstanding === 0 && rootGone && !processGroupAlive(rootPid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * SIGTERM the owned root (via its handle when held, else by
 * identity-checked pid) plus every confirmed descendant individually, and
 * the root group while anything of ours may live in it; escalate survivors
 * to SIGKILL on grace expiry and verify the whole tree is gone. The group
 * id is never signalled once everything owned is provably dead, so a
 * possibly-reused pgid is left alone. Detached subtrees die through the
 * per-pid signals; unrelated pids are never touched.
 */
export type TreeEnforcement = Enforcement & { uncertain: boolean };
export type EnforceTreeOptions = {
  source?: ProcessTableSource;
  /** Identity-safe root signal via the supervisor's child handle. */
  signalRoot?: (signal: NodeJS.Signals) => void;
  /** True when the supervisor already reaped the root (close event): authoritative death. */
  rootDead?: boolean;
};

export async function enforceOwnedTree(
  rootPid: number,
  custody: DescendantCustody,
  termGraceMs: number,
  killGraceMs: number,
  options: EnforceTreeOptions = {},
): Promise<TreeEnforcement> {
  const { source = listProcessTable, signalRoot, rootDead = false } = options;
  await refreshOwnedDescendants(rootPid, custody, source, 'cleanup');
  const snapshot = async (): Promise<Map<number, ProcessEntry> | null> => snapshotWithCustody(source, custody, 'cleanup');
  let table = await snapshot();
  const confirmedAlive = (): number[] => {
    const out: number[] = [];
    for (const [pid, wantStart] of custody.owned) {
      if (ownedState(pid, wantStart, table) === true) out.push(pid);
    }
    return out;
  };
  const signalTree = (signal: NodeJS.Signals): void => {
    for (const pid of confirmedAlive()) signalOwnedPid(pid, signal);
    if (signalRoot && !rootDead) signalRoot(signal);
  };
  const groupMayLive = (): boolean => !rootDead || confirmedAlive().length > 0 || processGroupAlive(rootPid);
  if (rootDead && confirmedAlive().length === 0 && !processGroupAlive(rootPid)) {
    return { clean: true, escalated: false, uncertain: custody.uncertain };
  }
  signalTree('SIGTERM');
  if (groupMayLive()) signalOwnedGroup(rootPid, 'SIGTERM');
  const wait = (graceMs: number): Promise<boolean> =>
    waitForOwnedTreeExit(rootPid, custody, rootDead, snapshot, graceMs);
  if (await wait(termGraceMs)) return { clean: true, escalated: false, uncertain: custody.uncertain };
  table = await snapshot();
  signalTree('SIGKILL');
  if (groupMayLive()) signalOwnedGroup(rootPid, 'SIGKILL');
  if (await wait(killGraceMs)) return { clean: true, escalated: true, uncertain: custody.uncertain };
  return { clean: false, escalated: true, uncertain: custody.uncertain };
}

export type Enforcement = { clean: boolean; escalated: boolean };

/** SIGTERM the owned group, escalate to SIGKILL on grace expiry, verify death. */
export async function enforceGroupExit(pgid: number, termGraceMs: number, killGraceMs: number): Promise<Enforcement> {
  if (!processGroupAlive(pgid)) return { clean: true, escalated: false };
  signalOwnedGroup(pgid, 'SIGTERM');
  if (await waitForGroupExit(pgid, termGraceMs)) return { clean: true, escalated: false };
  signalOwnedGroup(pgid, 'SIGKILL');
  if (await waitForGroupExit(pgid, killGraceMs)) return { clean: true, escalated: true };
  return { clean: false, escalated: true };
}

/** True when pid names a living process. Used for parent and PID-absence checks. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException)?.code === 'EPERM') return true;
    throw error;
  }
}

/** True when the supervisor's parent changed (orphaned) or is no longer alive. */
export function isParentGone(startedPpid: number): boolean {
  if (process.ppid !== startedPpid) return true;
  return !processAlive(startedPpid);
}

function parentWatcher(startedPpid: number, pollMs: number, onGone: () => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      if (isParentGone(startedPpid)) onGone();
    } catch {
      onGone();
    }
  }, Math.max(50, pollMs));
  timer.unref?.();
  return timer;
}

/**
 * Spawn the caller as an owned detached group and enforce the deadline.
 * Resolves exactly once on every path: clean exit, deadline, external
 * SIGTERM/SIGINT, or the parent exiting first. Never throws after spawn.
 */
export async function superviseOwnedCaller(options: SuperviseOptions): Promise<SupervisionResult> {
  validateCallerRequest(options);
  const label = options.label ?? 'caller';
  const termGraceMs = options.termGraceMs ?? 1500;
  const killGraceMs = options.killGraceMs ?? 1500;
  const child: ChildProcess = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', options.stdoutFd, options.stderrFd],
    detached: true,
  });

  return await new Promise<SupervisionResult>((resolve) => {
    const startedPpid = process.ppid;
    let done = false;
    let exit_code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let timed_out = false;
    let cancelled: SupervisionResult['cancelled'] = null;
    let parent_gone = false;
    let spawnNote: string | null = null;
    // The close event reaps the root through the supervisor's own child
    // handle: authoritative death, immune to pid reuse.
    let rootReaped = false;
    // Owned-descendant custody starts at spawn: the tracker records ppid
    // ancestry while the tree is alive. The first snapshot is async, so a
    // child that forks, detaches and orphans before it is a stated
    // limitation; long-lived shells — the observed OpenCode shape — are
    // reliably tracked.
    const custody: DescendantCustody = { owned: new Map<number, string | null>(), uncertain: false };
    const tableSource = options.source ?? listProcessTable;
    const tracker = child.pid === undefined ? null : startDescendantTracker(child.pid, custody, 100, tableSource);

    const deadlineTimer = setTimeout(() => {
      timed_out = true;
      void settle(`${label} deadline reached`);
    }, options.deadlineMs);
    const watcher = parentWatcher(startedPpid, options.parentPollMs ?? 500, () => {
      parent_gone = true;
      void settle(`${label} parent exited first; owned group terminated`);
    });
    const onTerm = (): void => {
      cancelled ??= 'SIGTERM';
      void settle(null);
    };
    const onInt = (): void => {
      cancelled ??= 'SIGINT';
      void settle(null);
    };
    // `on`, not `once`: `once` unregisters after the first delivery, so a
    // repeated SIGTERM/SIGINT during grace would fall through to default
    // termination. Repeat deliveries are idempotent via the done guard.
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);

    async function settle(error: string | null): Promise<void> {
      if (done) return;
      done = true;
      clearTimeout(deadlineTimer);
      clearInterval(watcher);
      // Signal handlers stay installed through group cleanup: a repeated
      // SIGTERM/SIGINT during the grace period is idempotent (done guard
      // plus `cancelled ??=`), while removing them early would restore
      // default termination and orphan a resistant group with no receipt.
      const pgid = child.pid;
      let group_clean = false;
      let enforcement: SupervisionResult['enforcement'] = null;
      try {
        if (pgid === undefined) {
          error ??= `${label} never started`;
        } else {
          // Forced settlement (deadline, cancel, parent loss) signals the
          // owned root via the supervisor's own child handle FIRST: an
          // identity-safe kill that never waits on a pending (up to 500ms)
          // custody read. The drained tracker and verified enforcement
          // follow, so termination is prompt and still fully verified.
          const forced = timed_out || cancelled !== null || parent_gone;
          if (forced && !rootReaped) {
            try {
              child.kill('SIGTERM');
            } catch {
              // Already gone; verification below stays authoritative.
            }
          }
          // Drained stop: no new ticks, and the bounded in-flight refresh
          // settles (recording any failure) BEFORE enforcement and receipt.
          await tracker?.stop();
          const tree = await enforceOwnedTree(pgid, custody, termGraceMs, killGraceMs, {
            source: tableSource,
            signalRoot: (sig) => {
              child.kill(sig);
            },
            rootDead: rootReaped,
          });
          // Retained separately: an enforcement result is NOT proof of
          // complete custody, and uncertain/missing snapshots are evidence
          // of neither a survivor nor a clean tree.
          enforcement = { clean: tree.clean, escalated: tree.escalated };
          // Custody uncertainty never reports clean: without validated
          // process-table evidence the receipt must not claim the tree died.
          group_clean = tree.clean && !custody.uncertain;
          if (spawnNote) error ??= spawnNote;
          if (custody.uncertain) error ??= `${label} descendant custody uncertain: process-table evidence failed`;
          else if (!tree.clean) error ??= `${label} process group survived SIGKILL`;
        }
      } catch (cleanupError) {
        // Settle is durable: an enforcement throw becomes an honest failure
        // result, never a rejected promise with no receipt.
        error ??= `${label} cleanup failed: ${(cleanupError as Error)?.message ?? String(cleanupError)}`;
        group_clean = false;
      }
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
      resolve({ pid: pgid ?? null, exit_code, signal, timed_out, cancelled, parent_gone, group_clean, error, custody: custodyEvidence(custody), enforcement });
    }

    child.once('error', (spawnError) => {
      void settle(`${label} spawn failed: ${(spawnError as Error)?.message ?? String(spawnError)}`);
    });
    child.once('close', (code, childSignal) => {
      rootReaped = true;
      exit_code = code;
      signal = childSignal;
      const killed = childSignal !== null && !timed_out && cancelled === null && !parent_gone;
      void settle(killed ? `${label} terminated by ${childSignal}` : null);
    });

    // The spawn notice runs after the deadline timer, parent watcher, signal
    // handlers and child handlers are registered, so an observer can act from
    // the first millisecond of the child's life. A throwing notice triggers
    // immediate cleanup instead of leaving the child to the full deadline.
    try {
      if (child.pid !== undefined) options.onSpawn?.(child.pid);
    } catch (error) {
      spawnNote = `spawn notice failed: ${(error as Error)?.message ?? String(error)}`;
      void settle(spawnNote);
    }
  });
}
