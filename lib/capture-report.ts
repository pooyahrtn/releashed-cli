// Assemble delivery from verified local evidence and separately supplied customer records.
// This does not authenticate, inspect images, or certify the truth of customer receipts.
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { assertRunId } from './capture-metadata.mjs';
import { findCapture } from './capture-memory.ts';
import { digest, sealedFile } from './capture-selection.mjs';

export type ReportOptions = {
  mapsRoot: string; runId: string; preparation: string; cleanup: string;
  timing: string; phases: string; inspection: string;
};
const link = (label: string, path: string) => `[${label}](<${path.replaceAll('%', '%25').replaceAll('>', '%3E').replaceAll('<', '%3C').replaceAll('\n', '%0A').replaceAll('\r', '%0D')}>)`;

async function record(path: string, name: string) {
  if (!isAbsolute(path)) throw new Error(`${name} needs an absolute file path.`);
  const resolved = await realpath(path);
  const text = await readFile(resolved, 'utf8');
  if (!text.trim()) throw new Error(`${name} record is empty: ${resolved}`);
  return { path: resolved, text };
}
function object(text: string, name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a JSON object.`);
  return value as Record<string, unknown>;
}
function timestamp(value: unknown, key: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error(`phases.${key} needs a recorded ISO timestamp.`);
  return Date.parse(value);
}

export async function captureReport(options: ReportOptions) {
  const { mapsRoot, runId, inspection } = options;
  assertRunId(runId);
  if (!inspection?.trim()) throw new Error('Inspect the selected original images, then supply --inspection describing what they show.');
  const [preparation, cleanup, timing, phases] = await Promise.all([
    record(options.preparation, 'preparation'), record(options.cleanup, 'cleanup'),
    record(options.timing, 'timing'), record(options.phases, 'phases'),
  ]);
  if (new Set([preparation.path, cleanup.path, timing.path, phases.path]).size !== 4)
    throw new Error('Supply distinct preparation, cleanup, timing and phases records; a cleanup receipt alone is not preparation evidence.');
  const timingMarkdown = await record(join(dirname(timing.path), 'summary.md'), 'readable timing');
  const clock = object(timing.text, 'timing');
  if (clock.run_id !== runId || typeof clock.wall_ms !== 'number' || !Number.isFinite(clock.wall_ms) || clock.wall_ms < 0)
    throw new Error(`Timing summary must name run ${runId} and its nonnegative wall_ms.`);
  const external = object(phases.text, 'phases');
  if (external.run_id !== runId) throw new Error(`phases.run_id must be ${runId}.`);
  const tracked = external.request_started_at === null && external.tracking_started_at !== undefined;
  const trackedKeys = ['tracking_started_at', 'preparation_finished_at', 'capture_finished_at', 'cleanup_finished_at'];
  const legacyKeys = ['request_started_at', 'preparation_finished_at', 'capture_finished_at', 'cleanup_finished_at'];
  const keys = tracked ? trackedKeys : legacyKeys;
  const times = keys.map(key => timestamp(external[key], key));
  if (times.some((time, index) => index > 0 && time < times[index - 1])) throw new Error('Recorded phase timestamps must be chronological.');
  const costs = external.costs;
  if (!costs || typeof costs !== 'object' || Array.isArray(costs)) throw new Error('phases.costs needs caller, capture, grounding and product descriptions; write unknown when unmeasured.');
  const entries = costs as Record<string, unknown>;
  for (const key of ['caller', 'capture', 'grounding', 'product']) {
    if (typeof entries[key] !== 'string' || !(entries[key] as string).trim()) throw new Error(`phases.costs.${key} needs an amount/basis or explicit unknown.`);
  }
  // The existing memory verifier binds images, trace and selections to their sealed manifest.
  const candidate = await findCapture({ mapsRoot, runId });
  const tail = [
    `Image inspection (caller): ${inspection.trim()}`,
    `Run: ${runId}. ${link('Sealed capture', candidate?.candidate_path ?? join(mapsRoot, runId))}.`,
    link('Production preparation record', preparation.path),
    link('Cleanup record', cleanup.path),
    `${link('Capture timing', timingMarkdown.path)} — ${(clock.wall_ms / 1000).toFixed(3)} s inside the capture server.`,
    `${link('External phases and costs', phases.path)} — ${((times[3] - times[0]) / 1000).toFixed(3)} s from recorded ${tracked ? 'tracking start' : 'request start'} through cleanup.${tracked ? ' The actual user request time is unknown and is not inferred from tracking start.' : ''} Actual final-message delivery occurs afterward and is not measured here.`,
    `Costs: caller ${entries.caller}; capture ${entries.capture}; grounding ${entries.grounding}; product ${entries.product}.`,
    'Preparation, cleanup, image inspection and external times/costs are supplied by the caller. File presence and image integrity do not independently verify their claims.',
  ];
  if (candidate && candidate.status === 'claimed_candidate' && candidate.goal_screenshots.length) {
    const markdown = [
      ...candidate.goal_screenshots.map((shot, index) => `${link(`Original image ${index + 1}`, shot.screenshot_path)} — captured ${shot.captured_at ?? 'date unknown'}.`),
      ...tail,
    ].join('\n\n');
    return { run_id: runId, markdown, goal_screenshots: candidate.goal_screenshots,
      records: { preparation: preparation.path, cleanup: cleanup.path, timing: timing.path, phases: phases.path } };
  }
  // Honest blocked path: a sealed observation-only run names its wall screenshot in the sealed
  // explorer-result marker. The original bytes, sealed date and source return exactly like a
  // claim, with an explicit NOT-reached statement and no success language. Anything else keeps
  // the original refusal below.
  const blocked = candidate ? await blockedEvidence(candidate.candidate_path) : null;
  if (!blocked)
    throw new Error(`Run ${runId} has no intact selected image claim. Inspect/select retained evidence before reporting.`);
  const markdown = [
    `${link('Original image 1 (blocked wall)', blocked.screenshot_path)} — captured ${blocked.observed_at}.`,
    `Goal NOT reached: ${blocked.reason}${blocked.url ? ` — observed at ${blocked.url}` : ''}`,
    ...tail,
  ].join('\n\n');
  return { run_id: runId, markdown, goal_screenshots: [],
    records: { preparation: preparation.path, cleanup: cleanup.path, timing: timing.path, phases: phases.path } };
}

type SealedManifest = { run_id: string; candidate_sha256?: string; files: Array<{ path: string; sha256: string }> };

/** Sealed blocked marker plus its manifest-verified original, or null. Corrupt/missing originals fail. */
async function blockedEvidence(candidateDir: string) {
  let manifest: SealedManifest;
  try {
    manifest = JSON.parse(await readFile(join(candidateDir, 'manifest.json'), 'utf8')) as SealedManifest;
    if (!Array.isArray(manifest.files)) return null;
  } catch { return null; }
  const resultBytes = await sealedFile(candidateDir, manifest, 'explorer-result.json');
  if (!resultBytes) return null;
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(resultBytes.toString('utf8')) as Record<string, unknown>;
  } catch { return null; }
  const blocked = result.blocked as Record<string, unknown> | undefined;
  if (!blocked || typeof blocked !== 'object') return null;
  if (typeof blocked.reason !== 'string' || !blocked.reason.trim()) return null;
  if (typeof blocked.screenshot_path !== 'string' || !blocked.screenshot_path) return null;
  if (typeof blocked.screenshot_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(blocked.screenshot_sha256)) return null;
  if (typeof blocked.observed_at !== 'string' || !Number.isFinite(Date.parse(blocked.observed_at))) return null;
  const entry = manifest.files.find((file) => file.path === blocked.screenshot_path);
  if (!entry || entry.sha256 !== blocked.screenshot_sha256) return null;
  const bytes = await sealedFile(candidateDir, manifest, blocked.screenshot_path);
  if (!bytes || !bytes.length || digest(bytes) !== blocked.screenshot_sha256) return null;
  return {
    reason: blocked.reason.trim(),
    screenshot_path: join(candidateDir, blocked.screenshot_path),
    screenshot_sha256: blocked.screenshot_sha256,
    observed_at: new Date(blocked.observed_at).toISOString(),
    url: typeof blocked.url === 'string' && blocked.url ? blocked.url : null,
  };
}
