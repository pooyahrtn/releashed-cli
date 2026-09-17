// What a run may touch, and when it must stop. Pure functions, shared by both drivers (the CLI loop
// in scripts/vision-explorer-run.mjs and the option-D server in lib/explore-mcp.mjs) so "out of
// scope", "forbidden", "a wall" and "out of budget" mean exactly one thing.
//
// Every control here is a REFUSAL, never an evasion: a door we do not walk through is recorded as a
// finding and the run carries on (or, for a wall, stops and says so). See docs/ARCHITECTURE.md.
import { matchesGlob } from "node:path";

// Named verbs a run never performs on a product it does not own. Matched against the plain-English
// instruction and the noun phrase it points at -- the model's own words for what it is about to do.
// Deliberately over-refusing: a wrongly refused control costs one step and is recorded as a door not
// taken, while a wrongly allowed one sends somebody a message or spends their money.
export const FORBIDDEN_VERBS = ["send", "post", "pay", "delete"];

// Owner mode (--mine): the run may USE the product like a user -- submit a form, send a reply --
// because it is the owner's own product. Only money-and-destruction verbs stay forbidden.
export const OWNER_FORBIDDEN_VERBS = ["pay", "delete"];

// Not a verb, a DESTINATION: however an instruction words it ("go to billing", "the checkout
// page", "upgrade to paid", "cancel my account", "delete account"), owner mode still never walks
// in. Checked only when limits.mine is set (see checkActionAuthorized), so a stranger run is
// untouched -- its own FORBIDDEN_VERBS list is stricter anyway.
const OWNER_BLOCKED_DESTINATION =
  /\b(billing|checkout|subscri(?:be|ption)|upgrade[- ]?to[- ]?paid|cancel[- ]?account|delete[- ]?account)\b/i;

// A URL is in scope when it is on one of the product's own origins AND its path is inside the
// include globs (if any were given) and outside the exclude globs. Chrome's own error page and
// about:blank parse to no real origin, so they answer false rather than throwing.
export function inScope(currentUrl, allowedOrigins, { include = [], exclude = [] } = {}) {
  let url;
  try {
    url = new URL(currentUrl);
  } catch {
    return false;
  }
  if (!allowedOrigins.has(url.origin)) return false;
  if (exclude.some((pattern) => matchesGlob(url.pathname, pattern))) return false;
  if (include.length > 0 && !include.some((pattern) => matchesGlob(url.pathname, pattern))) return false;
  return true;
}

// A leading politeness or confirmation word in front of the actual verb: "Yes, delete", "Confirm
// send". Stripped before the starts-with check below so the word after it is what gets judged.
const CONFIRM_PREFIX = /^(?:yes|ok(?:ay)?|confirm)\b[,:]?\s*/i;

// Does a forbidden verb refuse THIS step -- is it the action the control performs, not a word the
// product's own content happens to contain? Two real dogfood refusals got this wrong by matching
// the verb anywhere in the instruction-plus-target text: a grammar lesson literally named "Split &
// Send" refused `Tap the 'Split & Send' lesson item`, and a health-insurance quiz answer that read
// "You pay it yourself" refused `Select an answer option`. Both were the product's own words, not
// an action about to be performed, and both permanently killed a branch of the walk.
// A verb counts as the action when, word-boundary matched throughout (so "Password" is never "pay"
// and "Postcode" is never "post"):
//  - the control's label (after an optional "Yes,"/"Confirm" prefix) STARTS with the verb --
//    "Send", "Send message", "Pay now", "Delete account", "Yes, delete"; or
//  - the label is short (three words or fewer) and contains the verb anywhere in it -- "Pay €9"; or
//  - the instruction says the RUN ITSELF will do it, outside of any quoted span -- "submit the form
//    and send it". A quoted span ('...' or "...") is the product's own words, not the run's
//    intended action, and is stripped out before this check.
// A verb sitting inside a longer quoted label, or inside a sentence of ordinary product content,
// does not refuse -- that is exactly the distinction the two refusals above got wrong.
export function verbIsTheAction(verb, { instruction = "", target = "" } = {}) {
  const wholeWord = new RegExp(`\\b${verb}(s|ed|ing)?\\b`, "i");
  const label = String(target ?? "").trim();
  if (label) {
    const afterConfirm = label.replace(CONFIRM_PREFIX, "");
    if (new RegExp(`^${verb}(s|ed|ing)?\\b`, "i").test(afterConfirm)) return true;
    if (label.split(/\s+/).filter(Boolean).length <= 3 && wholeWord.test(label)) return true;
  }
  const unquoted = String(instruction ?? "").replace(/'[^']*'|"[^"]*"/g, " ");
  return wholeWord.test(unquoted);
}

// The verb this instruction would perform, if it is one we never perform on a product we do not
// own. See verbIsTheAction for what counts as "would perform".
export function forbiddenAction(decision, verbs = FORBIDDEN_VERBS) {
  if (verbs.length === 0) return null;
  const found = verbs.find((verb) => verbIsTheAction(verb, decision));
  return found ?? null;
}

// A typed value must be one the USER seeded. Anything else contact-shaped is invented, and inventing
// an e-mail address to get past a form is exactly what W1-2 had to forbid (a whole OpenStreetMap
// candidate was unpackageable because of one). Ordinary text -- a search term, a city name -- is
// still free: only the contact-and-secret shapes need a seed behind them.
export const CONTACT_OR_SECRET_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|passw|\+\d[\d ()-]{7,}\d/i;

export function typedValueAllowed(text, seedValues = []) {
  const value = String(text ?? "");
  if (seedValues.includes(value)) return true;
  return !CONTACT_OR_SECRET_TEXT.test(value);
}

// A wall is a finding, never an obstacle. Two kinds, and they are treated differently:
//   * a BOT wall (captcha, "unusual traffic", "access denied") means the product will not talk to a
//     browser it does not like, and there is nothing honest left to do -- the run ends;
//   * a LOGIN wall is only terminal at the FRONT DOOR. Mid-run it is an ordinary screen: exploring
//     the logged-out surface, sign-up and sign-in included, is most of what a public map is.
const BOT_WALL =
  /\b(captcha|are you a (human|robot)|unusual traffic|verify you are human|access denied|请完成安全验证|checking your browser|enable javascript and cookies)\b/i;
const LOGIN_WALL = /\b(sign in|log in|login|sign up)\b/i;

export function detectWall(url, visibleText, { entry = false } = {}) {
  const text = String(visibleText ?? "");
  if (BOT_WALL.test(text))
    return { kind: "bot-wall", reason: `The product answered with a bot check at ${url}; the run does not try to get around one.` };
  if (entry) {
    let authPath = false;
    try {
      authPath = /\/(auth|oauth|sso|sign-?in|sign-?up|login)(\/|$)/i.test(new URL(url).pathname);
    } catch {
      /* an unparseable entry url is somebody else's problem, not a wall */
    }
    if (authPath && LOGIN_WALL.test(text))
      return {
        kind: "login-wall",
        reason: `The front door at ${url} is a login wall, so a signed-out visitor sees nothing else. Capture a session with "releashed login" and run it again.`,
      };
  }
  return null;
}

// Steps are counted by the loop itself. These are the other two budgets: wall-clock minutes and
// euros of model spend, both hard aborts rather than warnings.
export function budgetExhausted({ elapsedSeconds, minutes, costEur, maxEur }) {
  if (minutes && elapsedSeconds >= minutes * 60)
    return { reason: "time_budget_exhausted", detail: `The run reached its ${minutes}-minute budget.` };
  if (maxEur && costEur !== null && costEur >= maxEur)
    return {
      reason: "cost_budget_exhausted",
      detail: `The run reached its EUR ${maxEur} budget (spent EUR ${costEur.toFixed(4)}).`,
    };
  return null;
}

// Nothing used to read the loudest signal a walk produces. A directed run on 2026-09-06 met a
// screen that advances on a recording timer and spent 36 of its 40 steps re-issuing one
// instruction, each answered "no visible effect"; earlier free walks died hitting one wall
// nineteen ways. Three in a row is where rephrasing has stopped being worth a step, so from there
// on the walk is told plainly, in the turn it actually sees, how many times in a row this has
// happened and that a reword will not help. Not gated on capture mode: discovery gets stuck the
// same way.
// The most actions any one run may take. Sized for a roaming survey at 60 until 2026-09-06, when a
// capture aimed at a screen that only exists once a day's work is finished ran out mid-exercise: an
// aimed run is a different shape from a survey. --minutes and --budget are the bounds that actually
// cost money; this one only stops a runaway loop. Defined once, because it is checked in the CLI and
// again in the walk, and those two disagreeing is a run that dies after paying for its sign-in.
export const MAX_STEPS = 250;

export const NO_EFFECT_STREAK_LIMIT = 3;

export function noEffectNote(streak) {
  if (!(streak >= NO_EFFECT_STREAK_LIMIT)) return null;
  return `(that changed nothing on the screen, and neither did the ${streak - 1} things you tried before it -- ${streak} in a row now. What you are trying does not work on this screen. Saying it again in different words will not help: try something materially different, somewhere else on the screen, or leave this screen.)`;
}

// Waiting is the walk's one non-action: it dispatches nothing and lets the page move on its own.
// Ten seconds is one beat of a countdown, a recording or a spinner, and short enough that a wasted
// wait costs about what a wasted click does. The run's TOTAL is capped separately so a 60-step run
// cannot sleep for an hour. Five minutes, not ninety seconds, because the first product we aimed
// this at answers a directed goal only through a sixteen-question exam that advances on a recording
// timer (2026-09-06): ninety seconds of patience cannot cross content like that, and a walk that
// gives up there reports a budget it ran out of rather than the screen it was sent for. `--minutes`
// is the real wall-clock bound on a run; this is only the share of it that may be spent asleep.
export const SINGLE_WAIT_MS = 10_000;
export const RUN_WAIT_BUDGET_MS = 300_000;

// How long the next wait may last: never more than one wait's cap, never more than the run has
// left, and 0 once the run's patience is spent -- which the caller must say out loud.
export function waitAllowance(waitedMs) {
  return Math.max(0, Math.min(SINGLE_WAIT_MS, RUN_WAIT_BUDGET_MS - waitedMs));
}

// Is the browser still standing on one of the target's own origins? Chrome's own error page
// (chrome-error://chromewebdata/, what a failed navigation commits) and about:blank are not, and
// neither parses to a real origin -- so this answers false for them rather than throwing. The one
// place both the pre-dispatch guard below and the post-action off-site recovery in main() ask the
// question, so the two can never disagree about what "off the bound origin" means.
// `pathScope` ({ include, exclude } globs) is optional and empty by default, so a run that names no
// globs behaves exactly as it always did: origin membership and nothing else.
export function onBoundOrigin(currentUrl, allowedOrigins, pathScope = undefined) {
  return inScope(currentUrl, allowedOrigins, pathScope);
}

// `limits` is optional and empty by default, so an existing caller gets exactly today's behavior:
//   pathScope    { include, exclude } path globs, on top of the origin allow-list
//   forbidden    named verbs this run never performs (send, post, pay, delete) -- read-only only
//   seedValues   the exact values the USER supplied; a contact-shaped value the user did not
//                supply is invented, and inventing one is the thing W1-2 had to forbid
//   mine         owner mode: forbidden should already be OWNER_FORBIDDEN_VERBS, and this also
//                turns on the money-or-destruction DESTINATION check below
export function checkActionAuthorized(decision, allowedOrigins, currentUrl, readOnly = false, limits = {}) {
  const reversibleInput = ["tap", "type", "scroll", "drag"].includes(decision.action);
  if (!reversibleInput)
    return { authorized: false, reason: `Refused "${decision.instruction}": unsupported action ${decision.action}.` };
  if (!onBoundOrigin(currentUrl, allowedOrigins, limits.pathScope))
    return { authorized: false, reason: `Refused "${decision.instruction}": the page had left the bound origin.` };
  // Named verbs this run never performs on somebody else's product. The network boundary already
  // refuses the request such a control would make; this refuses the click itself, so the run never
  // even looks like it tried to send, post, pay or delete.
  const forbidden = readOnly ? forbiddenAction(decision, limits.forbidden ?? FORBIDDEN_VERBS) : null;
  if (forbidden)
    return {
      authorized: false,
      reason: `Refused "${decision.instruction}": this run never performs "${forbidden}" on a product it does not own.`,
    };
  // Owner mode's shrunk verb list is worded around by naming a destination instead of a verb --
  // "the billing page", "checkout" -- so that stays refused regardless of which verb got it there.
  if (limits.mine) {
    const words = `${decision?.instruction ?? ""} ${decision?.target ?? ""}`;
    const match = OWNER_BLOCKED_DESTINATION.exec(words);
    if (match)
      return {
        authorized: false,
        reason: `Refused "${decision.instruction}": this run never touches "${match[0]}", even on a product it owns.`,
      };
  }
  // On a read-only target the run will never sign in or submit anything, so typing an email
  // address, phone number or password into it buys nothing and costs twice: it is a push against a
  // login wall we have promised to treat as a finding rather than an obstacle, and the typed value
  // lands in retained evidence, where the packager refuses the entire candidate as PII. A whole
  // OpenStreetMap candidate was unpackageable because the explorer invented
  // "testmapper2024@example.com" and typed it into the login form. Refuse it here, like any other
  // closed door: the step is spent, the explorer is told, the run carries on.
  if (readOnly && decision.action === "type" && !typedValueAllowed(decision.text, limits.seedValues ?? []))
    return {
      authorized: false,
      reason: `Refused "${decision.instruction}": this run is read-only and never signs in, so it does not type contact details or passwords into the product.`,
    };
  return { authorized: true, reason: null };
}
