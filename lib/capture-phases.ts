import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { assertRunId } from './capture-metadata.mjs';

export const PHASE_COSTS = {
  caller: 'unknown until caller ends',
  capture: 'unknown',
  grounding: 'unknown',
  product: 'unknown',
};

export type PhaseBoundary = 'preparation' | 'capture' | 'cleanup';
type TimestampKey = 'preparation_finished_at' | 'capture_finished_at' | 'cleanup_finished_at';
export type PhaseRecord = {
  schema_version: 1;
  tracking_started_at: string;
  request_started_at: null;
  preparation_finished_at: string | null;
  capture_finished_at: string | null;
  cleanup_finished_at: string | null;
  run_id?: string;
  costs: Record<keyof typeof PHASE_COSTS, string>;
};

const keyFor: Record<PhaseBoundary, TimestampKey> = {
  preparation: 'preparation_finished_at',
  capture: 'capture_finished_at',
  cleanup: 'cleanup_finished_at',
};

function absolute(path: string) {
  if (!isAbsolute(path)) throw new Error('phases needs an absolute record path.');
  return resolve(path);
}
function iso(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error(`phases.${name} needs a recorded ISO timestamp.`);
  return value;
}
function record(value: unknown): PhaseRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('phases record must be a JSON object.');
  const entry = value as Record<string, unknown>;
  if (entry.schema_version !== 1) throw new Error('phases record needs schema_version 1.');
  iso(entry.tracking_started_at, 'tracking_started_at');
  if (entry.request_started_at !== null) throw new Error('tracked phases must keep request_started_at null; tracking time is not request time.');
  for (const key of ['preparation_finished_at', 'capture_finished_at', 'cleanup_finished_at'])
    if (entry[key] !== null) iso(entry[key], key);
  if (entry.run_id !== undefined) assertRunId(String(entry.run_id), 'phases run_id');
  const costs = entry.costs;
  if (!costs || typeof costs !== 'object' || Array.isArray(costs)) throw new Error('phases record needs cost descriptions.');
  for (const key of Object.keys(PHASE_COSTS)) if (typeof (costs as Record<string, unknown>)[key] !== 'string') throw new Error(`phases.costs.${key} needs a description.`);
  return entry as unknown as PhaseRecord;
}
function verifyOrder(entry: PhaseRecord, boundary: PhaseBoundary) {
  const required: Record<PhaseBoundary, TimestampKey[]> = {
    preparation: [], capture: ['preparation_finished_at'], cleanup: ['preparation_finished_at', 'capture_finished_at'],
  };
  for (const key of required[boundary]) if (!entry[key]) throw new Error(`phases ${boundary} needs ${key} first.`);
  const previous = boundary === 'preparation' ? entry.tracking_started_at
    : boundary === 'capture' ? entry.preparation_finished_at! : entry.capture_finished_at!;
  return Date.parse(previous);
}

export async function startPhases(path: string, now = new Date()) {
  const target = absolute(path);
  const entry: PhaseRecord = {
    schema_version: 1,
    tracking_started_at: now.toISOString(),
    request_started_at: null,
    preparation_finished_at: null,
    capture_finished_at: null,
    cleanup_finished_at: null,
    costs: { ...PHASE_COSTS },
  };
  try { await writeFile(target, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`phases record already exists: ${target}`);
    throw error;
  }
  return entry;
}

export async function stampPhase(path: string, boundary: PhaseBoundary, options: { runId?: string; now?: Date } = {}) {
  const target = absolute(path);
  const entry = record(JSON.parse(await readFile(target, 'utf8')));
  const key = keyFor[boundary];
  if (entry[key]) throw new Error(`phases.${key} is already recorded and cannot be overwritten.`);
  if (boundary === 'capture') {
    if (!options.runId) throw new Error('phases capture needs --run-id.');
    if (entry.run_id) throw new Error('phases.run_id is already recorded and cannot be overwritten.');
    entry.run_id = assertRunId(options.runId, 'phases run_id');
  } else if (options.runId) throw new Error('--run-id is only supported with phases capture.');
  const time = (options.now ?? new Date()).toISOString();
  if (Date.parse(time) < verifyOrder(entry, boundary)) throw new Error(`phases.${key} cannot precede its prior boundary.`);
  entry[key] = time;
  await writeFile(target, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 });
  return entry;
}
