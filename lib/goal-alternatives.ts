// What else the store already holds, when a directed run did not reach what it was sent for.
//
// On 2026-09-17 a run was asked for "a theory lesson ... a screen inside the lesson that shows body
// prose paragraphs". It spent its whole four-minute budget circling /book/grammar and sealed
// time_budget_exhausted. Six minutes later a different run captured the KNM chapter reading page --
// body prose, exactly what was wanted. The store held the answer to the first question before the
// second run started, and nothing connected them: the team filed a tooling complaint instead of
// learning something about their product.
//
// So: a run that falls short says what it did not reach, and then names what is already on disk
// that the asker may have meant. Three rules hold this honest:
//
//  1. It never says the product LACKS anything. "No theory lesson is reachable from Books" would
//     have been false that morning, and a confident false finding about somebody's product is worse
//     than an honest failure. This reports what was found, never what is absent.
//  2. Every row carries its capture date, because staleness is the caller's judgment to make and
//     not the tool's. Old evidence is offered as dated history, never filtered away.
//  3. It is a candidate to inspect, never proof. A name that matches is not a screen that matches.
//
// The search itself is not reimplemented here. findCaptures() already walks the store, verifies
// every candidate against its manifest, honours the origin filter and dates each one; this module
// only reranks what it returns and names the screen behind each hit. No browser, no model call, no
// key -- asking what we already saw must never start another walk, or cost anything.
import { findCaptures, REQUEST_FRAMING_WORDS } from "./capture-memory.ts";
import type { CaptureMemoryResult } from "./capture-memory.ts";

type Candidate = CaptureMemoryResult["candidates"][number];

/** How many candidates a handoff offers before the list stops helping and starts burying. */
export const DEFAULT_ALTERNATIVE_LIMIT = 5;

const normal = (value: unknown): string =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// The words that carry a request's meaning, with the framing stripped out. Two goals written by
// different people on different days share "the", "screen" and "show" no matter what they are
// about; what tells them apart is "chapter", "prose", "paywall".
const contentTerms = (goal: string): string[] =>
  [...new Set(normal(goal).split(" "))].filter(
    (term) => term.length > 1 && !REQUEST_FRAMING_WORDS.has(term),
  );

export type Alternative = {
  run_id: string;
  title: string | null;
  url: string | null;
  captured_at: string | null;
  screenshot_path: string | null;
  candidate_path: string;
  /** The goal that OTHER run was given -- the sentence this row matched on. */
  directed_by: string;
  matched_terms: number;
  of_terms: number;
  status: Candidate["status"];
  freshness: Candidate["freshness"];
};

export type AlternativesResult = {
  goal: string;
  origin: string | null;
  /** Runs in the store that the goal's words touched at all, before the list was capped. */
  considered: number;
  alternatives: Alternative[];
  /** Set when the store could not be read. The run still succeeded at everything else. */
  lookup_error: string | null;
};

// What to call the screen this run stood on. Three sources, best first, and each is something the
// run itself recorded: the map's own title for the image it claimed; a verified intermediate frame
// that matched the asking words; or nothing, in which case the row still carries a run and a date
// and says so rather than inventing a name.
function nameScreen(candidate: Candidate): {
  title: string | null;
  url: string | null;
  captured_at: string | null;
  screenshot_path: string | null;
} {
  if (candidate.claimed_screen?.title || candidate.claimed_screen?.url)
    return {
      title: candidate.claimed_screen.title,
      url: candidate.claimed_screen.url,
      captured_at:
        candidate.goal_screenshots[0]?.captured_at ?? candidate.captured_at,
      screenshot_path:
        candidate.screenshot_path ??
        candidate.goal_screenshots[0]?.screenshot_path ??
        null,
    };
  const observation = candidate.matching_observations[0];
  if (observation)
    return {
      title: observation.title,
      url: observation.url,
      captured_at: observation.captured_at ?? candidate.captured_at,
      screenshot_path: observation.screenshot_path,
    };
  return {
    title: null,
    url: null,
    captured_at: candidate.captured_at,
    screenshot_path: candidate.screenshot_path,
  };
}

/**
 * Rerank findCaptures() candidates as answers to a goal that was NOT reached. Pure and synchronous.
 *
 * Ranking is on the other run's `directed_by` -- its own plain-English goal -- and not on screen
 * titles, because the two are written in different languages. Measured against the real 2026-09-17
 * store: the KNM chapter screen shares ZERO content terms with "a theory lesson ... body prose
 * paragraphs" (its title says "KNM Chapter 1 reading page"), while the run that captured it was
 * aimed at "the chapter's prose reading content" and shares five. Product nouns are how a product
 * names things; a goal is how a person asks for them, and a goal is what we are matching.
 */
export function rankAlternatives(
  candidates: readonly Candidate[],
  {
    goal,
    excludeRunId = null,
    limit = DEFAULT_ALTERNATIVE_LIMIT,
  }: { goal: string; excludeRunId?: string | null; limit?: number },
): Alternative[] {
  const wanted = contentTerms(goal);
  if (wanted.length === 0) return [];
  const scored = candidates
    // The run that just fell short is not a suggestion for itself. It ranks first on every
    // relevance key there is -- it was given this exact goal -- and offering it back reads as if
    // the tool had not understood the question.
    .filter((candidate) => candidate.run_id !== excludeRunId)
    .map((candidate) => {
      const haystack = normal(candidate.directed_by);
      const matched = wanted.filter((term) => haystack.includes(term)).length;
      return { candidate, matched };
    })
    .filter((row) => row.matched > 0);
  scored.sort(
    (a, b) =>
      b.matched - a.matched ||
      Number(b.candidate.status === "claimed_candidate") -
        Number(a.candidate.status === "claimed_candidate") ||
      String(b.candidate.captured_at ?? "").localeCompare(
        String(a.candidate.captured_at ?? ""),
      ),
  );
  return scored.slice(0, Math.max(0, limit)).map(({ candidate, matched }) => ({
    run_id: candidate.run_id,
    ...nameScreen(candidate),
    candidate_path: candidate.candidate_path,
    directed_by: candidate.directed_by,
    matched_terms: matched,
    of_terms: wanted.length,
    status: candidate.status,
    freshness: candidate.freshness,
  }));
}

/**
 * Search the sealed local store for screens the asker may have meant. Read-only: no browser, no
 * sign-in, no model call, no key. A store that cannot be read is reported, never thrown -- the run
 * it is reporting on already finished, and failing it here would lose that work over a lookup.
 */
export async function alternativesFromStore({
  mapsRoot,
  goal,
  origin = null,
  excludeRunId = null,
  limit = DEFAULT_ALTERNATIVE_LIMIT,
  ...options
}: {
  mapsRoot: string;
  goal: string;
  origin?: string | null;
  excludeRunId?: string | null;
  limit?: number;
}): Promise<AlternativesResult> {
  const empty = {
    goal,
    origin,
    considered: 0,
    alternatives: [],
  };
  try {
    const found = await findCaptures({ mapsRoot, goal, origin, ...options });
    return {
      goal,
      origin: found.origin,
      considered: found.candidates.filter(
        (candidate) => candidate.run_id !== excludeRunId,
      ).length,
      alternatives: rankAlternatives(found.candidates, {
        goal,
        excludeRunId,
        limit,
      }),
      lookup_error: null,
    };
  } catch (error) {
    return {
      ...empty,
      lookup_error: error instanceof Error ? error.message : String(error),
    };
  }
}

const dateOnly = (value: string | null): string =>
  typeof value === "string" && value.length >= 10
    ? value.slice(0, 10)
    : "date unknown";

/**
 * The handoff, in English. Says what was not reached and what is already on disk that might be it.
 * Never says the product lacks anything -- see the rules at the top of this file.
 */
export function formatAlternatives(result: AlternativesResult): string[] {
  const lines = [`I did not reach: "${result.goal}".`];
  if (result.lookup_error) {
    lines.push(
      `I could not search what has already been captured: ${result.lookup_error}. ` +
        `Run "releashed memory <url> --goal "${result.goal}"" to search the store yourself.`,
    );
    return lines;
  }
  if (result.alternatives.length === 0) {
    lines.push(
      "Nothing already in the store matched those words. That is a statement about this search, " +
        "not about the product: a screen can exist under a name these words do not touch.",
    );
    return lines;
  }
  const count = result.alternatives.length;
  lines.push(
    `${count} ${count === 1 ? "screen" : "screens"} already in the store may be what you meant ` +
      `— candidates to inspect, not proof:`,
  );
  for (const item of result.alternatives) {
    lines.push(
      `  • ${item.title ?? "(untitled screen)"} — ${item.url ?? "(url not recorded)"} — captured ${dateOnly(item.captured_at)}`,
    );
    lines.push(`      run ${item.run_id}${item.screenshot_path ? ` — ${item.screenshot_path}` : ""}`);
  }
  lines.push(
    "These matched the goals those earlier runs were given, not this one. Open the images before " +
      "believing any of them, and judge the dates yourself. Nothing here says the screen you asked " +
      "for does not exist.",
  );
  return lines;
}
