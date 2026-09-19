// What a first run needs before `releashed map` may spend anything, and the exact words the tool
// says when one of those things is missing.
//
// One module, because on 2026-09-17 a walk through the four gates a new reader hits found each gate
// answering the same question differently, or not at all:
//   Node      the package declares engines >=22, npm downgrades that to one EBADENGINE warning in a
//             300-line install log, and nothing at run time mentioned it again.
//   Chromium  `releashed doctor` said "npx playwright install chromium", which fetches whatever
//             Playwright the registry serves today rather than the one this package is pinned to,
//             and `map` let Playwright's own "npx playwright install" banner answer instead. The
//             command that is actually correct, `releashed install-browser`, was in neither place.
//   Keys      the explorer said "ANTHROPIC_API_KEY is required" with nowhere to get one, while the
//             grounding refusal beside it named a URL, an alternative and a way to need no key. The
//             two were also reported one at a time, so a reader fixed one key, re-ran, and only
//             then learned about the second.
//   Money     nothing said what a run costs until it was over.
//
// Every string here names the exact next command, key or URL. The reader is as likely to be a
// coding agent as a person, and an agent cannot puzzle one out.

/** The Node major this package's dependencies and syntax require; mirrors package.json engines. */
export const MIN_NODE_MAJOR = 22;

/**
 * The version refusal, or null when this Node is new enough.
 *
 * Best effort by design: it runs only once the entry module has linked. On Node 18 the link itself
 * fails first (node:path has no matchesGlob before Node 22), so that reader still sees a
 * SyntaxError. Node 20 is the version a reader is realistically one step behind on, and there the
 * whole CLI loads and runs, which is exactly why a run-time check has to exist at all.
 *
 * @param version process.versions.node, or any "major.minor.patch".
 */
export function nodeRefusal(version: string = process.versions.node): string | null {
  const major = Number(String(version).split(".")[0]);
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return null;
  return (
    `releashed needs Node ${MIN_NODE_MAJOR} or newer, and this is Node ${version}. Install it, then re-check:\n` +
    `  1. https://nodejs.org/en/download, or "nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}".\n` +
    "  2. Run `releashed doctor` to confirm the version, the keys and Chromium in one go."
  );
}

/**
 * Chromium is installed separately from the package, and only one command installs the build this
 * package is pinned to.
 */
export const BROWSER_REFUSAL =
  "Chromium is not installed. Run: releashed install-browser\n" +
  "That installs the Chromium build this package's own Playwright expects. `npx playwright install` " +
  "fetches whatever Playwright version the registry serves today, whose browser revision may not be " +
  "the one this package looks for. Then confirm with `releashed doctor`.";

// ANTHROPIC_API_KEY drives the explorer: it is the model that looks at each screenshot and says, in
// plain English, what to try next. SPIKE_EXPLORER_BASE_URL routes that same job at any
// OpenAI-compatible host instead (lib/explorer-client.mjs).
export const EXPLORER_KEY_REFUSAL =
  "No explorer key. `releashed map` needs a model to look at each screenshot and decide what to try " +
  "next, and neither ANTHROPIC_API_KEY nor SPIKE_EXPLORER_BASE_URL is set. Three ways on:\n" +
  "  1. Get a key at https://console.anthropic.com/settings/keys and export ANTHROPIC_API_KEY. This " +
  "is the default (claude-sonnet-5, or claude-opus-5 with --model opus).\n" +
  "  2. Already have an OpenAI-compatible host: export SPIKE_EXPLORER_BASE_URL together with " +
  "SPIKE_EXPLORER_API_KEY (Together, OpenRouter, DashScope, ...). Set both or neither.\n" +
  "  3. No key of ours at all: run `releashed explore-mcp` instead, and your own coding agent is the " +
  "explorer.\n" +
  "GEMINI_API_KEY cannot stand in for this one: it only points at the control this model names.";

// Moved here from scripts/vision-explorer-run.mjs so the CLI can say it before the walk starts
// without importing the explorer (and Playwright, and Midscene) to do it. That file still exports
// it, and resolveGroundingEnv still throws it.
//
// No "until the Claude grounder lands". Claude points accurately enough (8 of 8 controls inside the
// real element, artifacts/grounding-probe-claude-20260905), but it did so through a direct
// Anthropic call; the browser-automation library we ground through accepts only its own listed
// model families and none of them is Anthropic's. Naming the real blocker beats implying a swap is
// imminent.
export const GROUNDING_KEY_REFUSAL =
  "No grounding key. `releashed map` needs a second model that can point at a control on a " +
  "screenshot, and neither GEMINI_API_KEY nor MIDSCENE_MODEL_API_KEY is set. Three ways on:\n" +
  "  1. Free, about a minute: get a key at https://aistudio.google.com/apikey and export " +
  "GEMINI_API_KEY. This is the measured default (gemini-3.6-flash).\n" +
  "  2. Already have another vision key: export MIDSCENE_MODEL_API_KEY together with " +
  "MIDSCENE_MODEL_NAME, MIDSCENE_MODEL_FAMILY and MIDSCENE_MODEL_BASE_URL. The family must be one " +
  "the installed Midscene package accepts; besides Gemini, the only other grounder we have " +
  "measured is zai-org/GLM-5.3-Flash on Together (family glm-v).\n" +
  "  3. No key of ours at all: run `releashed explore-mcp` instead -- your own coding agent is the " +
  "explorer and its own eyes.\n" +
  "ANTHROPIC_API_KEY cannot stand in for this one: it drives the explorer, but the installed " +
  "Midscene package has no Anthropic grounding family, so there is nothing to point it at.";

/**
 * Both key refusals a `map` run would hit, in the order the run hits them, so one reading of one
 * message is enough to finish the setup.
 */
export function missingModelKeys(env: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = [];
  if (!env.SPIKE_EXPLORER_BASE_URL && !env.ANTHROPIC_API_KEY)
    problems.push(EXPLORER_KEY_REFUSAL);
  if (!env.MIDSCENE_MODEL_API_KEY && !env.GEMINI_API_KEY)
    problems.push(GROUNDING_KEY_REFUSAL);
  return problems;
}

// Euros per action, derived from the one real run the README quotes: 60 steps, 8 minutes of browser
// time, EUR 0.53 on Opus, and about half that on Sonnet. An order of magnitude, not a quote, which
// is why every sentence built from it says "roughly" and says what it was measured on.
export const EUR_PER_STEP: Record<string, number> = { sonnet: 0.5 / 60, opus: 1 / 60 };

/**
 * @param steps
 * @param model "sonnet" or "opus"; anything else is priced as sonnet.
 * @returns euros, rounded to a cent
 */
export function estimateEur(steps: number, model: string): number {
  return Math.round(steps * (EUR_PER_STEP[model] ?? EUR_PER_STEP.sonnet) * 100) / 100;
}

/**
 * The one line a first run reads before anything is spent: what this run costs, on whose key, and
 * the flag that caps it. Printed whether or not --budget was given, because a reader who has not
 * met --budget yet is exactly the reader who needs to.
 *
 * @param steps
 * @param model "sonnet" or "opus".
 * @param budgetEur
 * @param subject what is being priced; "this run" inside a run, "a map" before one.
 */
export function spendNotice(steps: number, model: string, budgetEur: number | null = null, subject = "this run"): string {
  const estimate = estimateEur(steps, model).toFixed(2);
  const basis =
    `${subject} spends your own model key: roughly EUR ${estimate} for ${steps} steps on ${model}, ` +
    "scaled from one real 60-step run that cost EUR 0.53, so treat it as an order of magnitude and " +
    "not a quote";
  return budgetEur
    ? `${basis}. --budget ${budgetEur} stops it once EUR ${budgetEur} of model spend is gone.`
    : `${basis}. Cap it with --budget <eur> and the run stops the moment that much model spend is gone.`;
}
