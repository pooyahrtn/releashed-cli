import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { capturePolicy, evidenceFreshness } from "./capture-policy.mjs";
import { assertRunId } from "./capture-metadata.mjs";
import { digest, sealedFile, selectionPath, verifySelection, } from "./capture-selection.mjs";
const normal = (value) => String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const terms = (value) => normal(value)
    .split(" ")
    .filter((term) => term.length > 1);
const link = (label, path) => `[${label}](<${path.replaceAll("%", "%25").replaceAll(">", "%3E").replaceAll("<", "%3C").replaceAll("\n", "%0A").replaceAll("\r", "%0D")}>)`;
function captureTime(trace) {
    try {
        const first = JSON.parse(String(trace).split("\n").find(Boolean) ?? "null");
        if (typeof first?.timestamp !== "string" || !first.timestamp.trim())
            return null;
        const time = new Date(first.timestamp);
        return Number.isNaN(time.valueOf()) ? null : time.toISOString();
    }
    catch {
        return null;
    }
}
function matchingScore(map, goal) {
    const wanted = terms(goal);
    if (wanted.length === 0)
        return 0;
    const haystack = [
        map.directed_by,
        ...map.screens.map((screen) => `${screen?.title ?? ""} ${screen?.flow ?? ""} ${screen?.url ?? ""}`),
    ]
        .join(" ")
        .toLowerCase();
    return (wanted.filter((term) => haystack.includes(term)).length / wanted.length);
}
// Request framing is not screen content. Keep product terms (including Today) and
// match whole tokens, so "me" cannot match "timer" or a newer unrelated frame.
const observationRequestWords = new Set("a an the me my we our you your it its this that these those of for from in on at to and or with please show see find give current currently latest flow flows screen screens screenshot screenshots image images".split(" "));
// Verified intermediate frames whose own side text answers a differently worded query.
// Every text source is bound to the SAME before/after image: the sealed map screen with
// that screenshot plus that side's own url and visible_state_summary. The event-level
// summary describes the after state, so it is never used as a before image's text.
// Paths outside screenshots/, unknown to the trace, already claimed as goal originals,
// or outside the requested origin are rejected here; bytes, hash and date are bound
// later through verifySelection, which fails closed on tampered or unbound refs.
function scoredObservations(map, traceBytes, goal, origin, goalPaths) {
    const wanted = [...new Set(terms(goal))].filter((term) => !observationRequestWords.has(term));
    const empty = { scored: [], of_terms: wanted.length };
    if (wanted.length === 0)
        return empty;
    let events;
    try {
        events = String(traceBytes)
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((event) => event && typeof event === "object");
    }
    catch {
        return empty;
    }
    const screensByScreenshot = new Map();
    for (const screen of map.screens ?? []) {
        if (screen &&
            typeof screen.screenshot === "string" &&
            !screensByScreenshot.has(screen.screenshot))
            screensByScreenshot.set(screen.screenshot, screen);
    }
    const seen = new Set();
    const scored = [];
    events.forEach((event, index) => {
        ["before", "after"].forEach((side, sideIndex) => {
            const state = event[side];
            const path = state?.screenshot_path;
            if (typeof path !== "string" ||
                !path.startsWith("screenshots/") ||
                path.split(/[\\/]/).includes(".."))
                return;
            if (seen.has(path) || goalPaths.has(path))
                return;
            // Keep the first occurrence, exactly as recordedSelection/verifySelection do.
            // A later reuse of a path must not supply a new origin/text for an older image.
            seen.add(path);
            const url = state?.url;
            if (typeof url !== "string" || !url)
                return;
            let urlOrigin = null;
            try {
                urlOrigin = new URL(url).origin;
            }
            catch {
                return;
            }
            if (origin && urlOrigin !== origin)
                return;
            const screen = screensByScreenshot.get(path);
            const summary = typeof state?.visible_state_summary === "string"
                ? state.visible_state_summary
                : "";
            const haystack = `${screen?.title ?? ""} ${screen?.flow ?? ""} ${screen?.url ?? ""} ${url} ${summary}`.toLowerCase();
            const observedTerms = new Set(terms(haystack));
            const matched = wanted.filter((term) => observedTerms.has(term)).length;
            if (matched === 0)
                return;
            scored.push({
                path,
                event_id: typeof event.event_id === "string" ? event.event_id : null,
                side,
                url,
                title: typeof screen?.title === "string" ? screen.title.slice(0, 200) : null,
                matched_terms: matched,
                order: index * 2 + sideIndex,
            });
        });
    });
    scored.sort((a, b) => b.matched_terms - a.matched_terms ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { scored: scored.slice(0, 3), of_terms: wanted.length };
}
async function candidate(candidateDir, goal, origin) {
    let manifest, manifestBytes;
    try {
        manifestBytes = await readFile(join(candidateDir, "manifest.json"));
        manifest = JSON.parse(manifestBytes.toString());
    }
    catch {
        return null;
    }
    if (!Array.isArray(manifest.files) || typeof manifest.run_id !== "string")
        return null;
    const [mapBytes, traceBytes] = await Promise.all([
        sealedFile(candidateDir, manifest, "map.json"),
        sealedFile(candidateDir, manifest, "observations.jsonl"),
    ]);
    if (!mapBytes || !traceBytes)
        return null;
    let map;
    try {
        map = JSON.parse(mapBytes.toString());
    }
    catch {
        return null;
    }
    if (map.run_id !== manifest.run_id ||
        typeof map.directed_by !== "string" ||
        !Array.isArray(map.screens))
        return null;
    const urls = map.screens
        ?.map((screen) => screen?.url)
        .filter((url) => typeof url === "string") ?? [];
    if (origin &&
        !urls.some((url) => {
            try {
                return new URL(url).origin === origin;
            }
            catch {
                return false;
            }
        }))
        return null;
    let paths = map.goal_screenshots;
    // A finish-time sequence is already bound to the sealed map and trace. It is not a later
    // selection, so expose its provenance without inventing a selection date or reason.
    let selection = paths === undefined ? null : { source: "capture_finish" };
    let selectionError = null;
    try {
        const saved = JSON.parse(await readFile(selectionPath(dirname(candidateDir), map.run_id), "utf8"));
        if (saved.schema_version !== 1 ||
            saved.run_id !== map.run_id ||
            saved.directed_by !== map.directed_by ||
            saved.manifest_sha256 !== digest(manifestBytes))
            throw new Error("selection does not match this sealed capture");
        paths = saved.goal_screenshots;
        if (!Array.isArray(paths))
            throw new Error("selection has no goal_screenshots");
        selection = {
            selected_at: saved.selected_at,
            why: saved.why,
            source: "post_capture_selection",
        };
    }
    catch (error) {
        if (error.code !== "ENOENT")
            selectionError = error instanceof Error ? error.message : String(error);
    }
    let evidence = null;
    if (paths !== undefined && !selectionError) {
        try {
            if (!Array.isArray(paths) ||
                !paths.every((path) => typeof path === "string"))
                throw new Error("Invalid selected paths");
            evidence = await verifySelection(candidateDir, manifest, traceBytes, paths);
        }
        catch (error) {
            selectionError = error instanceof Error ? error.message : String(error);
        }
    }
    const screenshot = evidence?.[0]?.screenshot_path ?? map.stop?.screenshot_path;
    const claimBytes = screenshot
        ? await sealedFile(candidateDir, manifest, screenshot)
        : null;
    const exact = normal(map.directed_by) === normal(goal);
    const score = matchingScore(map, goal);
    const goalPaths = new Set([
        ...(Array.isArray(paths) ? paths : []),
        ...(Array.isArray(map.goal_screenshots) ? map.goal_screenshots : []),
        map.stop?.screenshot_path,
    ].filter((path) => typeof path === "string"));
    // Intermediate frames are verified, never inferred: each relevance pick goes back
    // through verifySelection for sealed bytes, hash and trace date binding. A tampered,
    // unbound or escaped ref fails closed on its own frame, never as a substitute.
    const { scored, of_terms } = scoredObservations(map, traceBytes, goal, origin, goalPaths);
    const matching_observations = [];
    if (scored.length > 0) {
        // Each frame verifies alone: one tampered ref fails closed on its own frame
        // without discarding the other verified frames.
        for (const item of scored) {
            let bound;
            try {
                [bound] = await verifySelection(candidateDir, manifest, traceBytes, [
                    item.path,
                ]);
            }
            catch {
                continue;
            }
            if (!bound)
                continue;
            matching_observations.push({
                role: "matching_observation",
                screenshot_path: resolve(candidateDir, bound.screenshot_path),
                screenshot_sha256: bound.screenshot_sha256,
                captured_at: typeof bound.captured_at === "string" ? bound.captured_at : null,
                event_id: bound.event_id,
                side: item.side,
                title: item.title,
                url: item.url.slice(0, 500),
                matched_terms: item.matched_terms,
                of_terms,
            });
        }
    }
    const observation_matched_terms = matching_observations.length > 0
        ? Math.max(...matching_observations.map((item) => item.matched_terms))
        : 0;
    if (!exact && score === 0 && observation_matched_terms === 0)
        return null;
    const claimReason = ["goal_claimed", "goal_reached"].includes(map.stop?.reason ?? "");
    // A purported claim whose named image no longer verifies is not partial evidence: it is a
    // broken reference, and returning it would invite an agent to trust an unsealed substitute.
    if (claimReason && !claimBytes && !selectionError)
        return null;
    const claimed = !selectionError &&
        (Boolean(evidence) || claimReason) &&
        Boolean(claimBytes);
    const goalScreenshots = claimed
        ? (evidence ?? [
            {
                screenshot_path: screenshot,
                screenshot_sha256: digest(claimBytes),
                captured_at: captureTime(traceBytes),
                event_id: null,
            },
        ]).map((item) => ({
            ...item,
            screenshot_path: resolve(candidateDir, item.screenshot_path),
        }))
        : [];
    const evidenceMarkdown = claimed
        ? [
            ...goalScreenshots.map((shot, index) => `${link(`Original image ${index + 1}`, shot.screenshot_path)} — captured ${shot.captured_at ?? "date unknown"}.`),
            `Run: ${map.run_id}. ${link("Sealed capture", resolve(candidateDir))}.`,
            "Original capture costs were not measured by this lookup; caller inference is separate.",
        ].join("\n\n")
        : null;
    return {
        run_id: map.run_id,
        candidate_path: resolve(candidateDir),
        candidate_sha256: manifest.candidate_sha256 ?? null,
        captured_at: captureTime(traceBytes),
        directed_by: map.directed_by,
        exact_goal: exact,
        matched_terms: Math.round(score * terms(goal).length),
        of_terms: terms(goal).length,
        status: claimed ? "claimed_candidate" : "partial_evidence",
        screenshot_path: claimed ? resolve(candidateDir, screenshot) : null,
        goal_screenshots: goalScreenshots,
        matching_observations,
        observation_matched_terms,
        observation_of_terms: of_terms,
        evidence_markdown: evidenceMarkdown,
        selection,
        ...(selectionError ? { selection_error: selectionError } : {}),
        stop: map.stop ?? null,
        identity_label: Object.hasOwn(map, "identity_label")
            ? map.identity_label
            : null,
        auth_mode: Object.hasOwn(map, "auth_mode") ? map.auth_mode : null,
        precondition: map.precondition ?? null,
        continues: map.continues ?? null,
    };
}
/** Scan a local capture store. Results are claims to inspect, never verified coverage. */
export async function findCaptures({ mapsRoot, goal, origin = null, ...options }) {
    const exactOrigin = origin ? new URL(origin).origin : null;
    const policy = await capturePolicy(mapsRoot, options);
    let entries;
    try {
        entries = await readdir(mapsRoot, { withFileTypes: true });
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        entries = [];
    }
    const found = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => candidate(join(mapsRoot, entry.name), goal, exactOrigin)));
    const candidates = found
        .filter((item) => item !== null)
        .map((item) => {
        const freshness = evidenceFreshness(item.goal_screenshots.length
            ? item.goal_screenshots.map((shot) => shot.captured_at)
            : [item.captured_at], policy);
        // Each intermediate frame carries its own capture date and age eligibility under the
        // same policy. A stale or undated observation is historical, never ordinarily reusable.
        const matching_observations = item.matching_observations.map((observation) => ({
            ...observation,
            freshness: evidenceFreshness([observation.captured_at], policy),
        }));
        return {
            ...item,
            matching_observations,
            freshness: {
                ...freshness,
                reusable: item.status === "claimed_candidate" && freshness.reusable,
            },
        };
    });
    // The existing exact/freshness/claimed/relevance order is unchanged; observation
    // relevance only breaks ties the old keys left equal, so old rankings never move.
    candidates.sort((a, b) => Number(b.exact_goal) - Number(a.exact_goal) ||
        Number(b.freshness.reusable) - Number(a.freshness.reusable) ||
        Number(b.status === "claimed_candidate") -
            Number(a.status === "claimed_candidate") ||
        b.matched_terms - a.matched_terms ||
        String(b.captured_at ?? "").localeCompare(String(a.captured_at ?? "")) ||
        b.observation_matched_terms - a.observation_matched_terms);
    const hasReusableClaim = candidates.some((item) => item.freshness.reusable);
    const hasReusableObservation = candidates.some((item) => item.matching_observations.some((observation) => observation.freshness.reusable));
    return {
        goal,
        origin: exactOrigin,
        policy,
        candidates,
        next_step: hasReusableClaim || hasReusableObservation
            ? "inspect_reusable_candidates"
            : "fresh_capture_needed",
        guidance: "Inspect eligible images and retained transitions for the requested scope before rejecting a candidate. After that check accepts a candidate, return its evidence_markdown unchanged: do not reinterpret its UTC timestamps or infer costs from raw counters. A later selection is optional when capture_finish evidence is present, and exact_goal false is a match signal to inspect, not a rejection. Age is not proof of a match or an unchanged deployment. Stale evidence remains historical; lookup never captures, logs in or spends." +
            (hasReusableObservation && !hasReusableClaim
                ? " No reusable claimed original exists, but reusable matching_observation frames do: inspect those verified intermediate images for visible content only. They do not prove the goal was reached, do not change stop, selection or eligibility of the old claim, and cannot support a notebook note."
                : ""),
    };
}
/** Verify one retained run without applying lookup freshness or reading store policy. */
export async function findCapture({ mapsRoot, runId, }) {
    assertRunId(runId);
    const dir = join(mapsRoot, runId);
    const map = JSON.parse(await readFile(join(dir, "map.json"), "utf8"));
    if (!map ||
        typeof map !== "object" ||
        !("directed_by" in map) ||
        typeof map.directed_by !== "string")
        return null;
    return candidate(dir, map.directed_by, null);
}
