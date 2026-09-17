import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const DAY_MS = 86_400_000;
function ageLimit(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 36500)
        throw new Error('max_age_days must be a finite number from 0 to 36500 (0 always requires a new capture).');
    return value;
}
/** Lookup only reads policy. Expiry never deletes evidence or starts any paid work. */
export async function capturePolicy(mapsRoot, options = {}) {
    const env = options.env ?? process.env;
    const path = join(dirname(mapsRoot), 'memory-policy.json');
    let stored;
    try {
        const raw = JSON.parse(await readFile(path, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => k !== 'max_age_days'))
            throw new Error('Expected {"max_age_days": 7}.');
        stored = ageLimit(raw.max_age_days);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw new Error(`Invalid capture policy at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const rawEnv = env.RELEASHED_MAX_AGE_DAYS;
    const envAge = rawEnv === undefined ? undefined : ageLimit(rawEnv.trim() === '' ? NaN : Number(rawEnv));
    const rawFresh = env.RELEASHED_FRESH;
    if (rawFresh !== undefined && !['0', '1'].includes(rawFresh))
        throw new Error('RELEASHED_FRESH must be 0 or 1.');
    if (options.fresh !== undefined && typeof options.fresh !== 'boolean')
        throw new Error('fresh must be boolean.');
    const now = options.now ?? new Date();
    if (!Number.isFinite(now.valueOf()))
        throw new Error('Invalid freshness clock.');
    return {
        max_age_days: ageLimit(options.maxAgeDays ?? envAge ?? stored ?? 7),
        fresh_requested: options.fresh ?? rawFresh === '1',
        checked_at: now.toISOString(), config_path: path,
        source: options.maxAgeDays !== undefined ? 'request' : envAge !== undefined ? 'environment' : stored !== undefined ? 'store' : 'default',
    };
}
export function evidenceFreshness(dates, policy) {
    const now = Date.parse(policy.checked_at);
    const times = dates.map(date => date === null ? NaN : Date.parse(date));
    const known = times.length > 0 && times.every(time => Number.isFinite(time) && time <= now);
    const oldest = known ? Math.min(...times) : null;
    const status = oldest === null ? 'unknown' : policy.max_age_days > 0 && now - oldest < policy.max_age_days * DAY_MS ? 'within_window' : 'stale';
    return {
        status, age_days: oldest === null ? null : (now - oldest) / DAY_MS,
        expires_at: oldest === null ? null : new Date(oldest + policy.max_age_days * DAY_MS).toISOString(),
        reusable: !policy.fresh_requested && status === 'within_window',
        reason: policy.fresh_requested ? 'explicit_fresh_request' : status,
    };
}
