import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { sha256File, sha256Text } from "../lib/scaffold.mjs";
import { validatePublicPack } from "../lib/public-pack-schema.mjs";
import { parseAxLine } from "../lib/ax-line-format.mjs";

export const BOUNDED_MUTATION_DISCLOSURE =
  "Bound-route mutation attribution is temporal only: CDP cannot establish click causality, and an unrelated background mutation inside the input-dispatch-through-after-evidence window may be counted.";
const BOUNDED_ROUTE_ACTION_CLASS = "Bounded own-account bound-route progress";

function args() {
  const values = {};
  if ((process.argv.length - 2) % 2 !== 0)
    throw new Error(
      "Usage: render-map.mjs --trace observations.jsonl --output map.html",
    );
  for (let index = 2; index < process.argv.length; index += 2) {
    if (
      ![
        "--trace",
        "--output",
        "--public-pack",
        "--public-pack-sha256",
      ].includes(process.argv[index]) ||
      values[process.argv[index]]
    )
      throw new Error(
        "Usage: render-map.mjs --trace observations.jsonl --output map.html [--public-pack pack.json --public-pack-sha256 digest]",
      );
    values[process.argv[index]] = process.argv[index + 1];
  }
  if (!values["--trace"] || !values["--output"])
    throw new Error(
      "Usage: render-map.mjs --trace observations.jsonl --output map.html",
    );
  return values;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function boundedText(value, name, maximumBytes) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  )
    throw new Error(`${name} must be bounded non-empty text`);
  return value.trim();
}

function citationFor(event) {
  const citation = event.citation ?? event.source_evidence;
  if (!citation || typeof citation !== "object" || Array.isArray(citation))
    throw new Error(
      `Dashed transition ${event.event_id} lacks explicit source evidence`,
    );
  const sourceId = boundedText(
    citation.source_id,
    `Citation source for ${event.event_id}`,
    128,
  );
  const excerpt = boundedText(
    citation.excerpt ?? citation.quote ?? citation.text,
    `Citation excerpt for ${event.event_id}`,
    800,
  );
  const sourceUrl = citation.source_url ?? citation.url;
  if (sourceUrl !== undefined) {
    boundedText(sourceUrl, `Citation URL for ${event.event_id}`, 2_048);
    try {
      const url = new URL(sourceUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw new Error();
    } catch {
      throw new Error(
        `Citation URL for ${event.event_id} is not a safe HTTPS URL`,
      );
    }
  }
  return { sourceId, excerpt, sourceUrl };
}

function imageMime(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  throw new Error(`Unsupported screenshot format: ${basename(path)}`);
}

async function embeddedImage(path, label) {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024)
    throw new Error(`Screenshot ${label} is outside the bounded image size`);
  return `<figure class="shot"><img alt="${escapeHtml(label)}" src="data:${imageMime(path)};base64,${bytes.toString("base64")}"><figcaption>${escapeHtml(label)}</figcaption></figure>`;
}

function validateRedactedEffect(event) {
  const classes = [
    "Reversible own-account",
    "Listed own-account progress",
    BOUNDED_ROUTE_ACTION_CLASS,
  ];
  if (
    event.intended_action?.method !== "click" ||
    !classes.includes(event.action_matrix_class)
  )
    return;
  const evidence = event.effect_evidence;
  if (event.action_matrix_class === BOUNDED_ROUTE_ACTION_CLASS) {
    if (
      !evidence ||
      Object.keys(evidence).sort().join("\n") !==
        [
          "supervisor_authorized",
          "authorization_consumed_once",
          "mutation_window",
          "mutation_association",
          "same_origin_mutation_requests_dispatched",
          "outside_window_mutation_policy",
        ]
          .sort()
          .join("\n") ||
      evidence.supervisor_authorized !== true ||
      evidence.authorization_consumed_once !== true ||
      evidence.mutation_window !== "input-dispatch-through-after-evidence" ||
      evidence.mutation_association !== "temporal-only" ||
      ![0, 1].includes(evidence.same_origin_mutation_requests_dispatched) ||
      evidence.outside_window_mutation_policy !== "block-and-abort"
    )
      throw new Error(`Bound-route evidence is invalid for ${event.event_id}`);
    return;
  }
  if (evidence?.effect_id && evidence?.effect_class_id) {
    if (
      event.action_matrix_class === "Listed own-account progress" &&
      (!evidence.matched_request?.method || !evidence.matched_request?.url)
    )
      throw new Error(
        `Missing listed-action request evidence for ${event.event_id}`,
      );
    return;
  }
  if (evidence?.supervisor_authorized !== true)
    throw new Error(
      `Production-redacted click lacks supervisor authorization for ${event.event_id}`,
    );
  if (
    event.action_matrix_class === "Listed own-account progress" &&
    evidence.mutation_request_match !== true
  )
    throw new Error(
      `Production-redacted listed click lacks a matching mutation request for ${event.event_id}`,
    );
}

export async function validateTrace({ tracePath }) {
  const body = await readFile(tracePath, "utf8");
  const lines = body.split("\n").filter(Boolean);
  const events = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Trace line ${index + 1} is not JSON`);
    }
  });
  const ids = new Set();
  let previous = null;
  for (const [index, event] of events.entries()) {
    if (!event.event_id || ids.has(event.event_id))
      throw new Error("Trace contains a missing or duplicate event ID");
    ids.add(event.event_id);
    if (
      !/^event-\d{4}$/.test(event.event_id) ||
      event.event_id !== `event-${String(index + 1).padStart(4, "0")}`
    )
      throw new Error(
        `Trace event order is not contiguous at ${event.event_id}`,
      );
    if (typeof event.run_id !== "string" || !event.run_id)
      throw new Error(`Trace run ID is invalid for ${event.event_id}`);
    if (previous?.transition_kind === "unknown-terminal")
      throw new Error(
        `Unknown terminal ${previous.event_id} must be the final event`,
      );
    if (
      Number.isNaN(Date.parse(event.timestamp)) ||
      (previous && Date.parse(event.timestamp) < Date.parse(previous.timestamp))
    )
      throw new Error(`Trace timestamps are out of order at ${event.event_id}`);
    if (
      previous?.after?.observation_hash &&
      event.before?.observation_hash !== previous.after.observation_hash
    )
      throw new Error(
        `Trace evidence continuity is broken at ${event.event_id}`,
      );
    if (
      !["solid", "dashed", "unknown-terminal", "none"].includes(
        event.transition_kind,
      )
    )
      throw new Error(`Invalid transition kind for ${event.event_id}`);
    if (
      ![
        "Observe",
        "Reversible own-account",
        "Listed own-account progress",
        BOUNDED_ROUTE_ACTION_CLASS,
      ].includes(event.action_matrix_class)
    )
      throw new Error(`Invalid action class for ${event.event_id}`);
    if (
      event.observed_outcome === "route-scope-exit" &&
      (index !== events.length - 1 ||
        event.transition_kind !== "solid" ||
        event.action_matrix_class !== BOUNDED_ROUTE_ACTION_CLASS ||
        event.intended_action?.method !== "click" ||
        !event.before ||
        !event.after ||
        event.before.url === event.after.url ||
        event.current_url !== event.after.url ||
        event.current_origin !== event.after.origin ||
        event.before.origin !== event.after.origin)
    )
      throw new Error(`Invalid bound-route exit ${event.event_id}`);
    if (event.transition_kind === "solid") {
      if (
        !event.before?.observation_hash ||
        !event.after?.observation_hash ||
        !event.before?.screenshot_path ||
        !event.after?.screenshot_path ||
        // "Solid" means something observably changed -- either the accessibility tree or the
        // pixels. Requiring only the tree hash to differ missed transitions this app makes purely
        // visually (a word filling the answer box, a scroll repainting the viewport).
        (event.before.observation_hash === event.after.observation_hash &&
          event.before.screenshot_sha256 === event.after.screenshot_sha256) ||
        !["navigate", "click", "type", "scroll"].includes(
          event.intended_action?.method,
        ) ||
        event.observed_outcome === "unknown-terminal" ||
        event.evidence_provenance !== "direct-browser-observation"
      )
        throw new Error(`Invalid solid transition ${event.event_id}`);
      validateRedactedEffect(event);
    }
    // A click or type can legitimately turn out to be a no-op (e.g. a control that does nothing
    // observable in this run), exactly like a scroll that hits the bottom of the page -- both are
    // a genuine "nothing changed" outcome, not a broken trace.
    if (
      event.transition_kind === "none" &&
      (!event.before?.observation_hash ||
        !event.after?.observation_hash ||
        // Genuinely no effect requires BOTH the tree AND the pixels to be unchanged -- either one
        // differing is a real observed transition, not a self-loop.
        event.before.observation_hash !== event.after.observation_hash ||
        event.before.screenshot_sha256 !== event.after.screenshot_sha256 ||
        !["observe", "scroll", "click", "type"].includes(
          event.intended_action?.method,
        ))
    )
      throw new Error(`Invalid no-transition evidence for ${event.event_id}`);
    for (const evidence of [event.before, event.after].filter(Boolean)) {
      if (
        !/^[0-9a-f]{64}$/.test(evidence.observation_hash ?? "") ||
        !evidence.screenshot_path ||
        !/^[0-9a-f]{64}$/.test(evidence.screenshot_sha256 ?? "")
      )
        throw new Error(`Incomplete retained evidence for ${event.event_id}`);
      if (
        typeof evidence.url !== "string" ||
        typeof evidence.visible_state_summary !== "string" ||
        sha256Text(
          JSON.stringify({
            url: evidence.url,
            visible_state_summary: evidence.visible_state_summary,
          }),
        ) !== evidence.observation_hash
      )
        throw new Error(`Observation hash mismatch for ${event.event_id}`);
      const base = resolve(dirname(tracePath));
      const screenshot = resolve(base, evidence.screenshot_path);
      if (
        !screenshot.startsWith(`${base}/screenshots/`) ||
        screenshot === `${base}/screenshots/`
      )
        throw new Error(`Invalid screenshot path for ${event.event_id}`);
      if ((await sha256File(screenshot)) !== evidence.screenshot_sha256)
        throw new Error(`Screenshot hash mismatch for ${event.event_id}`);
    }
    if (event.transition_kind === "dashed") {
      if (!["public-claim", "inference"].includes(event.evidence_provenance))
        throw new Error(`Invalid dashed provenance for ${event.event_id}`);
      citationFor(event);
    }
    previous = event;
  }
  return { body, events };
}

export async function validatePublicPackBinding({
  events,
  publicPackPath,
  publicPackSha256,
}) {
  if (!events.some((event) => event.transition_kind === "dashed")) return null;
  if (
    typeof publicPackPath !== "string" ||
    !/^[0-9a-f]{64}$/.test(publicPackSha256 ?? "")
  )
    throw new Error(
      "Dashed evidence requires a public-pack file and SHA-256 binding",
    );
  const bytes = await readFile(publicPackPath);
  if (sha256Text(bytes) !== publicPackSha256)
    throw new Error("Public-pack hash does not match the supplied binding");
  let pack;
  try {
    pack = JSON.parse(bytes.toString("utf8"));
    validatePublicPack(pack);
  } catch {
    throw new Error("Public-pack binding is not a valid public pack");
  }
  for (const event of events.filter(
    (item) => item.transition_kind === "dashed",
  )) {
    const citation = event.citation ?? event.source_evidence;
    const source = pack.sources.find(
      (item) => item.source_id === citation.source_id,
    );
    if (!source || source.final_url !== (citation.source_url ?? citation.url))
      throw new Error(
        `Dashed citation does not match the public pack for ${event.event_id}`,
      );
  }
  return { path: publicPackPath, sha256: publicPackSha256 };
}

// Screen-graph layout constants (shared between the Node-side layout math below and the
// literal pixel values baked into the generated page's CSS/client-JS).
const NODE_WIDTH = 280;
const SHOT_HEIGHT = 150;
const NODE_HEIGHT = 272;
// A lane lays its cards out as a GRID, not as one long row. One row per flow put 31 screens on a
// 17,000px-wide canvas: every card was a thumbnail at fit-zoom and every arrow was a full-width
// wire. Cards now run left-to-right and then wrap boustrophedon (the next row runs right-to-left),
// so the step from the end of one row to the start of the next is a short drop rather than a
// full-width return line.
const COL_GAP = 130; // card-free vertical corridor between two card columns, in every lane
const BAND_MIN = 96; // card-free horizontal band between two card rows
const LANE_HEADER = 44;
const LANE_PADDING = 20;
const LANE_GAP = 30;
const CANVAS_PADDING = 26;
// A routed (cross-row, cross-lane or backward) arrow runs its horizontal leg inside a band between
// two card rows, where there is never a card. Each such arrow gets its own horizontal channel in
// that band, and the band grows to fit however many arrows it has to carry -- so two arrows
// crossing the same band can never sit on top of each other, and neither can their labels.
const CHANNEL_SPACING = 26;
const CHANNEL_MARGIN = 14;
// Two arrows sharing one vertical corridor (the card-free column between two card columns -- the
// same x-range in every lane, because every lane uses the same column pitch) are nudged apart by
// this much so their vertical legs stay separate.
const CORRIDOR_SLOT = 26;
const CORRIDOR_SLOTS = 5;
// Roughly the shape of a laptop viewport: each lane's grid aims for this width-to-height ratio, so
// "fit" genuinely fits instead of scaling a single row down to nothing.
const GRID_ASPECT = 1.7;
// A wire longer than this is not drawn on the resting map at all. At 30+ screens the long wires
// crossed every lane and no reader could follow one by eye; the source card carries a stub chip
// naming its target instead, and the wire itself is drawn only while one of its two cards is
// focused. Nothing about what the map asserts changes -- every transition is still on the page, in
// the card's stubs, in its drawer, and in map.json.
const LONG_EDGE = 1100;

// Ref ids (e12, e25, ...) are scoped to one accessibility snapshot, so a plain-language label for
// "what did clicking e12 do" has to look up e12's own text inside THAT event's before-state -- not
// guess from the id. Generic parsing of the mapper's own AX-dump format, no product knowledge.
function findRefText(summary, ref) {
  if (!ref || typeof summary !== "string") return null;
  for (const line of summary.split("\n")) {
    const parsed = parseAxLine(line);
    if (parsed && parsed.ref === ref)
      return { role: parsed.role, text: parsed.text };
  }
  return null;
}

function describeAction(event) {
  const method = event.intended_action?.method;
  const ref = event.intended_action?.ref;
  const found = ref
    ? findRefText(event.before?.visible_state_summary, ref)
    : null;
  const target = found?.text
    ? `"${found.text}"`
    : ref
      ? `an element (${ref})`
      : "the page";
  if (method === "click") return `Clicked ${target}`;
  if (method === "type") return `Typed into ${target}`;
  if (method === "scroll") return "Scrolled the page";
  if (method === "navigate") {
    try {
      return `Navigated to ${new URL(event.after?.url ?? event.current_url ?? "").pathname || "/"}`;
    } catch {
      return "Navigated";
    }
  }
  if (method === "observe") return "Observed the page";
  return typeof event.observed_outcome === "string"
    ? event.observed_outcome
    : "Action";
}

// A flow group is derived purely from where the browser was (origin + path), never from a
// catalog of known product routes -- this keeps the renderer usable on a target it has never
// seen. A run confined to one URL yields exactly one group, which is the honest outcome.
function urlGroupKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return typeof url === "string" && url ? url : "unknown-origin";
  }
}

function groupTitle(key, fallbackScreenTitle) {
  try {
    const parsed = new URL(key);
    const segments = parsed.pathname.split("/").filter(Boolean);
    // The root path has no route segment to name a lane after ("localhost" told a reader nothing
    // about what's actually there) -- name it from the screen itself instead, exactly the way a
    // card title is derived: real, already-extracted evidence, never a guessed or hardcoded name.
    if (!segments.length)
      return fallbackScreenTitle || parsed.hostname || "Home";
    return segments
      .map((segment) =>
        segment
          .replace(/[-_]+/g, " ")
          .replace(/\b\w/g, (letter) => letter.toUpperCase()),
      )
      .join(" › ");
  } catch {
    return key;
  }
}

const PROMPT_ROLES = new Set(["radiogroup", "heading"]);
// A form or modal is often defined by its input's placeholder more than by any paragraph near it
// (a vocabulary pop-up's own content here IS its "Type a Dutch or English word..." field) -- this
// treats a named input like a StaticText candidate, same length bar, just a different
// accessible-name source. But a native control's accessible name is computed from its placeholder
// attribute REGARDLESS of whether the field currently holds real content, so once the field has a
// value the placeholder name is simply stale -- see PLACEHOLDER_SHAPE and undisplayedPlaceholders
// below, which detect and skip exactly that case.
const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox"]);
// A placeholder reads as an instruction to an EMPTY field ("Write your message in Dutch…", "Type a
// Dutch or English word…") and near-universally ends in an ellipsis -- a generic UI convention,
// not product knowledge.
const PLACEHOLDER_SHAPE = /(?:…|\.\.\.)\s*$/;

function parseAxLines(summary) {
  return (summary ?? "")
    .split("\n")
    .map((line) => parseAxLine(line))
    .filter(Boolean)
    .slice(1); // drop the RootWebArea line -- its name is the browser tab title, never a title candidate
}

// A chat-style surface appends new content as it goes AND keeps old turns mounted, so a plain
// scan for "the last heading/radiogroup on the page" keeps re-finding an old, already-answered
// question instead of the screen's own new content. Compare against the immediately-preceding
// state as a MULTISET (not a positional prefix -- one early differing line, e.g. an active nav
// tab label, would otherwise push every later UNCHANGED line into the "new" bucket too) so only
// genuinely new lines count as this screen's own content.
function newAxLines(current, previous) {
  const pool = new Map();
  for (const { role, text } of previous) {
    const key = `${role}|${text}`;
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  const fresh = [];
  for (const line of current) {
    const key = `${line.role}|${line.text}`;
    const count = pool.get(key) ?? 0;
    if (count > 0) pool.set(key, count - 1);
    else fresh.push(line);
  }
  return fresh;
}

// Every heading/radiogroup cue (the question or instruction itself) ahead of every long static
// caption, each group in document order -- so a caller can walk past an already-used title
// instead of settling for a lone repeat. `stalePlaceholders` names input names that read as a
// placeholder but are known (see freshRealContent below) to no longer be what the field shows.
function axCues(lines, stalePlaceholders) {
  const roleCues = [];
  const textCues = [];
  for (const { role, text, onScreen } of lines) {
    if (!onScreen) continue; // scrolled off, or sitting behind a modal -- not what's on screen now
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (PROMPT_ROLES.has(role)) roleCues.push(trimmed);
    else if (
      (role === "StaticText" || INPUT_ROLES.has(role)) &&
      trimmed.length >= 24 &&
      !stalePlaceholders.has(trimmed)
    )
      textCues.push(trimmed);
  }
  return [...roleCues, ...textCues];
}

// Same "what's new since the previous screen" comparison newAxLines already runs, but not
// restricted to on-screen lines: an input's own typed value, or a modal's own content, can be
// marked off-screen by the same click-through-overlay hit-test quirk that misclassifies other
// elements (see lib/ax-visibility.mjs isNodeOnScreen), yet still be genuinely what is drawn right
// now. Only non-placeholder-shaped text counts as "real" here, so an unrelated still-empty field's
// placeholder can never itself "confirm" that some other field has a value. The 20-character floor
// is higher than a normal candidate needs (see axCues) on purpose: a modal opening also brings in
// its own short, generic chrome ("Save word", "Clear word") that is new text too but never a
// field's typed content, and this only has to tell those two apart, not title anything itself.
function freshRealContent(lines, previousLines) {
  return newAxLines(lines, previousLines).filter(
    ({ role, text }) =>
      (role === "StaticText" ||
        role === "InlineTextBox" ||
        INPUT_ROLES.has(role)) &&
      text.trim().length >= 20 &&
      !PLACEHOLDER_SHAPE.test(text.trim()),
  );
}

// A CAPTION is the renderer's own plain-English description of what a screenshot shows, written by
// a small image model and handed in as a sidecar (see scripts/caption-screens.mjs) -- never part of
// the evidence, and never an observation. It says what the screen IS, so a reader can recognise the
// picture; it must never say what an action did or what happens next, which is the arrow's job and
// the only thing the trace actually witnessed. A caption is therefore carried on the node next to
// the observed on-screen text it replaces on the card, labelled as a description everywhere it
// appears, and it has to clear the same guards a derived title does: never the browser tab title,
// never a URL or a percent-encoded path, never a repeat of a title another card in the same lane
// already carries -- a same-lane collision is disambiguated with a trailing " (2)", " (3)" ... on
// the SAME caption rather than dropped, because the alternative is worse: dropping it hands the
// card to deriveNodeTitle below, which reads whatever real text is on the page with no idea that a
// promotional banner isn't a description (see the vision prompt's own note on ad banners) -- that is
// exactly how a slogan ended up titling a card before. Only once every numbered variant is also
// taken does the screen fall back to its extracted-text title.
const CAPTION_MAX = 90;
const CAPTION_DEDUPE_ATTEMPTS = 8;
// Behaviour-claiming shapes: a caption asserting an effect ("opens the...", "after tapping...")
// would read as an observation the trace never made. Descriptions of the picture only.
const CAPTION_CLAIM =
  /\b(?:opens|opened|leads to|leading to|navigates?|navigated|after|afterwards|then|results? in|takes you|will|goes to|brings up|submits|saves|confirms)\b/i;

export function usableCaption(caption, summary, usedTitles) {
  if (typeof caption !== "string") return null;
  const text = caption
    .trim()
    .replace(/[\s.]+$/, "")
    .replace(/\s+/g, " ");
  if (!text || text.length > CAPTION_MAX) return null;
  if (
    /%[0-9a-f]{2}/i.test(text) ||
    /https?:\/\//i.test(text) ||
    text.startsWith("/")
  )
    return null;
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text)) return null;
  if (CAPTION_CLAIM.test(text)) return null;
  const root = (summary ?? "")
    .split("\n")
    .map((line) => parseAxLine(line))
    .find((line) => line && line.role === "RootWebArea");
  if (root && text.toLowerCase() === root.text.trim().toLowerCase())
    return null;
  if (!usedTitles.has(text)) return text;
  // A same-lane collision: still an honest description of THIS screen, just worded the same as one
  // already used. Number it rather than discard it -- see the file-level note above on why the
  // fallback below this function (raw on-screen text) is the worse failure mode.
  for (let n = 2; n <= CAPTION_DEDUPE_ATTEMPTS; n++) {
    const numbered = `${text} (${n})`;
    if (numbered.length <= CAPTION_MAX && !usedTitles.has(numbered))
      return numbered;
  }
  return null;
}

// Title a screen from its OWN evidence: prefer content that is new since the previous screen
// (this screen's real question/instruction), falling back to the whole page only when nothing
// changed there (e.g. an instruction that disappeared rather than one that appeared). Never the
// tab title -- a single-page app keeps one document title across every screen, so it names
// nothing. `usedTitles` lets a later, still-honest candidate win over a repeat of an earlier
// card's title; two screens reading identically is worse than a slightly-generic title, since it
// hides that the flow moved at all.
function deriveNodeTitle(
  summary,
  previousSummary,
  url,
  usedTitles,
  verifiedOnScreenText = null,
) {
  // Two situations leave the automated pass with no honest on-screen candidate: a trace captured
  // before this file could record a real per-element on-screen flag at all (see
  // lib/ax-line-format.mjs), and a flag that IS present but is a known false positive -- a tall or
  // overlapping element whose bounding-box center still hit-tests as on screen after the app has
  // scrolled its text away (see lib/ax-visibility.mjs isNodeOnScreen). Both leave a reviewer's own
  // verified reading of this exact state's retained screenshot standing in for the flag. It is
  // never invented text: every entry must already be one of this state's own retained lines,
  // checked below, so the title still traces back to real captured evidence.
  if (verifiedOnScreenText) {
    const realTexts = new Set(parseAxLines(summary).map((line) => line.text));
    for (const text of verifiedOnScreenText)
      if (!realTexts.has(text))
        throw new Error(
          `Verified on-screen title text is not part of this state's own retained summary: "${text}"`,
        );
    return verifiedOnScreenText.join(" ").slice(0, 160);
  }
  const lines = parseAxLines(summary);
  const previousLines =
    previousSummary != null ? parseAxLines(previousSummary) : [];
  const fresh = freshRealContent(lines, previousLines);
  // An input whose name reads as a placeholder is stale the moment ANY other fresh, non-placeholder
  // content appears alongside it -- the screen just gained real content, so an instruction addressed
  // to an empty field is no longer true of it. (A page with one still-empty field and one freshly
  // filled one loses nothing: the empty field's own placeholder was never going to be this screen's
  // most on-topic title candidate anyway, and the filled field's real content below is.)
  const stalePlaceholders = new Set(
    fresh.length
      ? lines
          .filter(
            ({ role, text }) =>
              INPUT_ROLES.has(role) && PLACEHOLDER_SHAPE.test(text.trim()),
          )
          .map(({ text }) => text.trim())
      : [],
  );
  const candidates = [
    ...axCues(newAxLines(lines, previousLines), stalePlaceholders),
    ...axCues(lines, stalePlaceholders),
    // Reached only once nothing on screen qualifies -- a field's own real content, possibly
    // misclassified off-screen by the hit-test quirk above, still beats a stale placeholder or a
    // bare URL.
    ...fresh
      .filter(({ text }) => text.trim().length >= 24)
      .map(({ text }) => text.trim()),
  ].map((value) => value.slice(0, 90));
  // No candidate may repeat a title another card already carries (see the file-level note above) --
  // when every candidate here is already spoken for, fall through to the URL below rather than
  // silently reusing one.
  const label = candidates.find((candidate) => !usedTitles.has(candidate));
  if (label) return label;
  try {
    const parsed = new URL(url);
    const bare = parsed.pathname || url; // query strings are drawer detail, not card-title material
    if (!usedTitles.has(bare)) return bare;
    // ...unless the bare path is ALSO already spoken for (several query-distinguished screens with
    // no other title candidate at all): a duplicate title is worse than one still-honest query
    // string, so keep the one piece of real distinguishing evidence available rather than collide --
    // decoded, so this still never puts a raw percent-encoded query on a card.
    try {
      return bare + decodeURIComponent(parsed.search || "");
    } catch {
      return bare + (parsed.search || "");
    }
  } catch {
    return typeof url === "string" && url ? url : "Screen";
  }
}

// The one place that decides WHICH retained screenshot stands for a screen: a state can be captured
// many times, and the first capture of it is the one the card shows. Both the map and the captioner
// (scripts/caption-screens.mjs) read it from here, so a caption can never end up describing a
// different picture than the card displays.
export function retainedScreenshots(events) {
  const shots = new Map();
  for (const event of events)
    for (const evidence of [event.before, event.after].filter(Boolean))
      if (!shots.has(evidence.observation_hash) && evidence.screenshot_path)
        shots.set(evidence.observation_hash, {
          path: evidence.screenshot_path,
          sha256: evidence.screenshot_sha256,
        });
  return shots;
}

// Turns the validated event list into a screen graph: one node per distinct observed state
// (deduped by observation_hash, so a re-visited screen is one card, not a duplicate), plus the
// edges between them. A pure "observe, nothing changed" checkpoint is folded into the node it
// reconfirms rather than drawn as its own arrow -- it is bookkeeping, not a user action. A real
// click/type/scroll that changed nothing IS drawn, as a self-loop, because that is a finding.
async function buildGraph(events, titleOverrides = {}, captions = {}) {
  const nodes = new Map();
  const order = [];
  // Every title assigned so far WITHIN THE SAME LANE, so deriveNodeTitle can skip a candidate some
  // other card in its own lane already carries rather than only checking the immediately preceding
  // one. Scoped per lane (not global) because the same accurate, generic title can honestly belong
  // to two unrelated screens in different lanes (an empty vocabulary look-up box reads the same
  // whether it was opened from the writing flow or the speaking flow) -- a reader comparing cards
  // side by side only ever does so within one lane, so that is the scope duplication actually has
  // to be avoided in.
  const usedTitlesByGroup = new Map();
  const ensureNode = (hash, url, summary, previousSummary) => {
    if (!nodes.has(hash)) {
      const groupKey = urlGroupKey(url);
      let usedTitles = usedTitlesByGroup.get(groupKey);
      if (!usedTitles)
        usedTitlesByGroup.set(groupKey, (usedTitles = new Set()));
      const observedTitle = deriveNodeTitle(
        summary,
        previousSummary,
        url,
        usedTitles,
        titleOverrides[hash] ?? null,
      );
      // The card reads better as a description of its own picture than as a line of text lifted off
      // it, so a usable caption wins -- but the extracted on-screen text is kept alongside it and
      // shown in the drawer, and it is still what titles the card whenever no caption survives.
      const caption = usableCaption(captions[hash], summary, usedTitles);
      const title = caption ?? observedTitle;
      usedTitles.add(title);
      nodes.set(hash, {
        id: hash,
        url,
        groupKey,
        title,
        caption,
        observedTitle,
        summary: summary ?? "",
        screenshotPath: null,
        terminal: false,
        confirmations: [],
        selfLoops: [],
        selfChanges: [],
      });
      order.push(hash);
    }
    return nodes.get(hash);
  };

  const edges = [];
  let lastTouchedId = null;
  for (const event of events) {
    const before = event.before;
    const after = event.after;
    // The before-state has no recorded predecessor of its own here (only the very first event's
    // before ever reaches this path fresh); the after-state's predecessor is this same event's
    // before-state, which IS on hand.
    const beforeNode = before
      ? ensureNode(
          before.observation_hash,
          before.url,
          before.visible_state_summary,
          null,
        )
      : null;

    let afterNode = null;
    if (after) {
      afterNode = ensureNode(
        after.observation_hash,
        after.url,
        after.visible_state_summary,
        before?.visible_state_summary ?? null,
      );
      if (event.transition_kind === "unknown-terminal")
        afterNode.terminal = true;
    } else if (event.transition_kind === "unknown-terminal") {
      const id = `terminal-${event.event_id}`;
      afterNode = {
        id,
        url: null,
        groupKey: beforeNode?.groupKey ?? "unknown-outcome",
        title: "Outcome unknown",
        caption: null,
        observedTitle: "Outcome unknown",
        summary: "",
        screenshotPath: null,
        terminal: true,
        confirmations: [],
        selfLoops: [],
        selfChanges: [],
      };
      nodes.set(id, afterNode);
      order.push(id);
    }

    lastTouchedId = afterNode?.id ?? beforeNode?.id ?? lastTouchedId;

    const isPureReobservation =
      event.transition_kind === "none" &&
      event.intended_action?.method === "observe";
    if (isPureReobservation) {
      beforeNode?.confirmations.push(event.event_id);
      continue;
    }
    if (!beforeNode && !afterNode) continue;

    const fromId = beforeNode?.id ?? afterNode.id;
    const toId = afterNode?.id ?? beforeNode.id;
    const edgeRecord = {
      event_id: event.event_id,
      from: fromId,
      to: toId,
      label: describeAction(event),
      kind: event.transition_kind,
      citation: event.transition_kind === "dashed" ? citationFor(event) : null,
      boundedNote: event.action_matrix_class === BOUNDED_ROUTE_ACTION_CLASS,
    };
    if (fromId === toId) {
      const loopNode = nodes.get(fromId);
      if (edgeRecord.kind === "none") loopNode.selfLoops.push(edgeRecord);
      else loopNode.selfChanges.push(edgeRecord);
    } else edges.push(edgeRecord);
  }

  const shots = retainedScreenshots(events);
  for (const [hash, shot] of shots)
    if (nodes.has(hash)) nodes.get(hash).screenshotPath = shot.path;

  // A screen is identified by its observation hash, which bakes the URL in -- so the same picture
  // reached at two different addresses (e.g. a bookmarked home route vs. its trailing-slash
  // variant) still gets two hashes. But it is the same screen: what a reader sees never changed.
  // Wherever two nodes' retained screenshots are byte-identical, fold the later one into the
  // first-seen card -- same identity, same title -- and repoint every transition that named the
  // discarded id at the survivor, so nothing is left dangling.
  const survivorForSha = new Map();
  const mergeInto = new Map();
  for (const id of order) {
    const sha = shots.get(id)?.sha256;
    if (!sha) continue;
    const survivor = survivorForSha.get(sha);
    if (survivor === undefined) survivorForSha.set(sha, id);
    else mergeInto.set(id, survivor);
  }
  const resolveNode = (id) => (mergeInto.has(id) ? mergeInto.get(id) : id);
  if (mergeInto.size) {
    for (const [discardedId, survivorId] of mergeInto) {
      const survivor = nodes.get(survivorId);
      const discarded = nodes.get(discardedId);
      survivor.confirmations.push(...discarded.confirmations);
      survivor.selfLoops.push(...discarded.selfLoops);
      survivor.selfChanges.push(...discarded.selfChanges);
      if (discarded.terminal) survivor.terminal = true;
      nodes.delete(discardedId);
    }
    for (let index = order.length - 1; index >= 0; index -= 1)
      if (mergeInto.has(order[index])) order.splice(index, 1);
    const survivingEdges = [];
    for (const edge of edges) {
      edge.from = resolveNode(edge.from);
      edge.to = resolveNode(edge.to);
      // A transition that used to run between two now-merged cards is a self-reference: file it
      // exactly like a genuine self-loop above, rather than leaving a zero-length arrow in the graph.
      if (edge.from === edge.to) {
        const node = nodes.get(edge.from);
        if (edge.kind === "none") node.selfLoops.push(edge);
        else node.selfChanges.push(edge);
      } else survivingEdges.push(edge);
    }
    edges.length = 0;
    edges.push(...survivingEdges);
    lastTouchedId = resolveNode(lastTouchedId);
  }

  return { nodes, order, edges, lastTouchedId };
}

// Which lane each screen belongs to. A lane is a flow group (origin + path) -- but two groups a
// reader cannot tell apart (a trailing-slash variant of the same route, say) become ONE lane on the
// canvas: the same lane title drawn twice implied two different places when the walk only ever saw
// one. Groups from different hosts keep their own lanes and say which host they are, so joining
// lanes never merges two genuinely different places.
function assignLanes(graph) {
  const groupKeys = [];
  for (const id of graph.order) {
    const key = graph.nodes.get(id).groupKey;
    if (!groupKeys.includes(key)) groupKeys.push(key);
  }
  const partOf = (key, part) => {
    try {
      return new URL(key)[part];
    } catch {
      return key;
    }
  };
  const titleOf = new Map();
  for (const key of groupKeys) {
    const first = graph.order.find(
      (id) => graph.nodes.get(id).groupKey === key,
    );
    titleOf.set(key, groupTitle(key, graph.nodes.get(first)?.title));
  }
  const hostsPerTitle = new Map();
  for (const key of groupKeys) {
    const hosts = hostsPerTitle.get(titleOf.get(key)) ?? new Set();
    hosts.add(partOf(key, "hostname"));
    hostsPerTitle.set(titleOf.get(key), hosts);
  }
  const laneOrder = [];
  const laneTitles = new Map();
  const laneOfGroup = new Map();
  for (const key of groupKeys) {
    const base = titleOf.get(key);
    const title =
      hostsPerTitle.get(base).size > 1
        ? `${base} · ${partOf(key, "hostname")}`
        : base;
    const laneKey = `${partOf(key, "origin")} | ${title}`;
    if (!laneTitles.has(laneKey)) {
      laneOrder.push(laneKey);
      laneTitles.set(laneKey, title);
    }
    laneOfGroup.set(key, laneKey);
  }
  return {
    laneOrder,
    laneTitles,
    laneOfNode: (id) => laneOfGroup.get(graph.nodes.get(id)?.groupKey),
  };
}

// How many columns a lane's grid gets: the shape closest to GRID_ASPECT, so a lane is about as
// wide as it is tall rather than a mile-long row.
function gridColumns(count) {
  if (count <= 1) return 1;
  const ideal = Math.sqrt(
    (count * (NODE_HEIGHT + BAND_MIN) * GRID_ASPECT) / (NODE_WIDTH + COL_GAP),
  );
  return Math.max(1, Math.min(count, Math.round(ideal)));
}

// Lays screens out in stacked lanes, one lane per flow, each lane a boustrophedon grid of cards,
// and routes every arrow so it never crosses a card or another arrow's label.
//
// Two facts about this layout make honest routing cheap, with no graph-layout library:
//   * every lane uses the SAME column pitch, so the gap between column N and column N+1 is a
//     card-free vertical CORRIDOR running the full height of the canvas; and
//   * the band between two card rows (and the padding above the first row and below the last) is a
//     card-free horizontal BAND running the full width of its lane.
// So an arrow that is not a step to the neighbouring card leaves its card sideways into the
// corridor beside it, runs vertically down (or up) that corridor, turns along a channel in the band
// next to the row it is heading for, and drops into the top (or bottom) of its target. Every leg is
// in space no card occupies. Bands grow to fit the arrows crossing them, and arrows sharing a
// corridor are nudged onto separate slots, so arrows do not overlap each other either.
function layoutGraph(graph, lanes) {
  const { laneOrder, laneTitles, laneOfNode } = lanes;
  const placement = new Map(); // node id -> { lane, row, col }
  const laneCols = [];
  const laneRows = [];
  laneOrder.forEach((laneKey, lane) => {
    const ids = graph.order.filter((id) => laneOfNode(id) === laneKey);
    const cols = gridColumns(ids.length);
    laneCols.push(cols);
    laneRows.push(Math.max(1, Math.ceil(ids.length / cols)));
    ids.forEach((id, index) => {
      const row = Math.floor(index / cols);
      // Odd rows run right-to-left, so consecutive screens are always neighbours.
      const col = row % 2 === 0 ? index % cols : cols - 1 - (index % cols);
      placement.set(id, { lane, row, col });
    });
  });

  // Which arrows are a step to the neighbouring card (drawn straight, in the reading direction of
  // their row, or straight down at a row wrap), and which have to be routed. A backward step is
  // routed too: drawn straight it would lie exactly on top of the forward arrow it retraces.
  const plans = graph.edges.map((edge) => {
    const from = placement.get(edge.from);
    const to = placement.get(edge.to);
    if (!from || !to) return null;
    const sameLane = from.lane === to.lane;
    if (sameLane && from.row === to.row) {
      const forward =
        from.row % 2 === 0 ? to.col === from.col + 1 : to.col === from.col - 1;
      if (forward) return { kind: "row", from, to };
    }
    if (sameLane && from.col === to.col && to.row === from.row + 1)
      return { kind: "wrap", from, to };
    // The band to use: the one immediately next to the TARGET's row, on the side the arrow arrives
    // from, so the final vertical leg only ever crosses card-free space.
    const band =
      to.lane > from.lane
        ? 0
        : to.lane < from.lane
          ? laneRows[to.lane]
          : to.row > from.row
            ? to.row
            : to.row + 1;
    return { kind: "routed", from, to, band, cross: !sameLane };
  });

  const bandLoad = new Map();
  for (const plan of plans)
    if (plan?.kind === "routed") {
      const key = `${plan.to.lane}:${plan.band}`;
      bandLoad.set(key, (bandLoad.get(key) ?? 0) + 1);
    }
  const bandHeight = (lane, band) => {
    const load = bandLoad.get(`${lane}:${band}`) ?? 0;
    if (load)
      return Math.max(BAND_MIN, CHANNEL_MARGIN * 2 + load * CHANNEL_SPACING);
    // An empty band above the first row or below the last is just the lane's own padding; an empty
    // band between two rows still has to carry the wrap arrow and its label.
    return band === 0 || band === laneRows[lane] ? LANE_PADDING : BAND_MIN;
  };

  const laneY = [];
  const laneHeight = [];
  const laneWidth = [];
  laneOrder.forEach((laneKey, lane) => {
    let height = LANE_HEADER + laneRows[lane] * NODE_HEIGHT;
    for (let band = 0; band <= laneRows[lane]; band += 1)
      height += bandHeight(lane, band);
    laneHeight.push(height);
    laneWidth.push(
      LANE_PADDING * 2 +
        laneCols[lane] * NODE_WIDTH +
        (laneCols[lane] - 1) * COL_GAP,
    );
    laneY.push(
      lane === 0
        ? CANVAS_PADDING
        : laneY[lane - 1] + laneHeight[lane - 1] + LANE_GAP,
    );
  });
  const bandTop = (lane, band) => {
    let y = laneY[lane] + LANE_HEADER + band * NODE_HEIGHT;
    for (let index = 0; index < band; index += 1) y += bandHeight(lane, index);
    return y;
  };

  const positioned = new Map();
  for (const [id, place] of placement)
    positioned.set(id, {
      x: CANVAS_PADDING + LANE_PADDING + place.col * (NODE_WIDTH + COL_GAP),
      y: bandTop(place.lane, place.row) + bandHeight(place.lane, place.row),
    });

  const regions = laneOrder.map((laneKey, lane) => ({
    title: laneTitles.get(laneKey),
    x: CANVAS_PADDING,
    y: laneY[lane],
    width: laneWidth[lane],
    height: laneHeight[lane],
  }));

  const channelsUsed = new Map();
  const corridorsUsed = new Map();
  const entriesUsed = new Map();
  const nextSlot = (map, key) => {
    const slot = map.get(key) ?? 0;
    map.set(key, slot + 1);
    return slot;
  };

  const routes = plans.map((plan, index) => {
    const edge = graph.edges[index];
    if (!plan) return null;
    const source = positioned.get(edge.from);
    const target = positioned.get(edge.to);
    // Several arrows can join the same pair of neighbouring cards (two different actions with the
    // same outcome); each one is lifted clear of the last so they read as separate arrows.
    if (plan.kind === "row") {
      const stack = nextSlot(corridorsUsed, `pair:${edge.from}:${edge.to}`);
      const y = source.y + NODE_HEIGHT / 2 + stack * 20;
      const rightward = target.x > source.x;
      const startX = rightward ? source.x + NODE_WIDTH : source.x;
      const endX = rightward ? target.x - 7 : target.x + NODE_WIDTH + 7;
      return {
        path: `M ${startX} ${y} L ${endX} ${y}`,
        labelX: (startX + endX) / 2,
        labelY: y - 14,
        labelWidth: COL_GAP - 16,
        resting: true,
        cross: false,
        long: false,
      };
    }
    if (plan.kind === "wrap") {
      const stack = nextSlot(corridorsUsed, `pair:${edge.from}:${edge.to}`);
      const x = source.x + NODE_WIDTH / 2 + stack * 20;
      const startY = source.y + NODE_HEIGHT;
      const endY = target.y - 7;
      return {
        path: `M ${x} ${startY} L ${x} ${endY}`,
        labelX: x,
        labelY: (startY + endY) / 2,
        labelWidth: NODE_WIDTH,
        resting: true,
        cross: false,
        long: false,
      };
    }
    const exitRight = plan.from.col < laneCols[plan.from.lane] - 1;
    const midY = source.y + NODE_HEIGHT / 2;
    const corridorCentre = exitRight
      ? source.x + NODE_WIDTH + COL_GAP / 2
      : source.x - COL_GAP / 2;
    const corridorX =
      corridorCentre +
      (nextSlot(corridorsUsed, corridorCentre) % CORRIDOR_SLOTS) *
        CORRIDOR_SLOT -
      ((CORRIDOR_SLOTS - 1) / 2) * CORRIDOR_SLOT;
    const channelY =
      bandTop(plan.to.lane, plan.band) +
      CHANNEL_MARGIN +
      nextSlot(channelsUsed, `${plan.to.lane}:${plan.band}`) * CHANNEL_SPACING;
    // Arrows landing on the same card come in on separate points along its top (or bottom) edge.
    const entryX =
      target.x +
      NODE_WIDTH / 2 +
      ((nextSlot(entriesUsed, edge.to) % 3) - 1) * (NODE_WIDTH / 4);
    const enterFromAbove = channelY < target.y;
    const entryY = enterFromAbove ? target.y - 6 : target.y + NODE_HEIGHT + 6;
    const startX = exitRight ? source.x + NODE_WIDTH : source.x;
    const length =
      Math.abs(corridorX - startX) +
      Math.abs(channelY - midY) +
      Math.abs(entryX - corridorX) +
      Math.abs(entryY - channelY);
    return {
      path: `M ${startX} ${midY} L ${corridorX} ${midY} L ${corridorX} ${channelY} L ${entryX} ${channelY} L ${entryX} ${entryY}`,
      labelX: (corridorX + entryX) / 2,
      labelY: channelY,
      labelWidth: 420,
      // A routed arrow's label is shown only while one of its cards is focused: eight of them once
      // landed in the same band, stacked on top of each other and unreadable.
      resting: false,
      cross: plan.cross,
      long: length > LONG_EDGE,
      laneTitle: plan.cross ? laneTitles.get(laneOrder[plan.to.lane]) : null,
    };
  });

  const canvasWidth = Math.max(
    720,
    // One corridor's worth of room past the widest lane, so an arrow leaving the last card in a row
    // still has card-free space to turn in.
    ...regions.map(
      (region) => region.x + region.width + COL_GAP + CANVAS_PADDING,
    ),
  );
  const canvasHeight = Math.max(
    400,
    ...regions.map((region) => region.y + region.height + CANVAS_PADDING),
  );
  return { regions, positioned, routes, canvasWidth, canvasHeight };
}

// A flow is a lane the explorer actually moved AROUND in, not just arrived at once -- one lone
// transition (e.g. a single scroll) is still honest evidence of how far the explorer reached (the
// canvas keeps showing the lane), but counting it as a "flow" the same as a multi-step journey
// overstates how much of the product was actually walked. Two or more of the lane's own
// transitions is the bar for "walked," not just "visited."
function countFlows(graph, laneOfNode) {
  const transitionsPerLane = new Map();
  for (const edge of graph.edges) {
    const fromLane = laneOfNode(edge.from);
    const toLane = laneOfNode(edge.to);
    if (fromLane && fromLane === toLane)
      transitionsPerLane.set(
        fromLane,
        (transitionsPerLane.get(fromLane) ?? 0) + 1,
      );
  }
  return [...transitionsPerLane.values()].filter((count) => count >= 2).length;
}

async function nodeImageDataUri(node, tracePath) {
  if (!node.screenshotPath) return null;
  const path = resolve(dirname(tracePath), node.screenshotPath);
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024)
    throw new Error(
      `Screenshot for ${node.id} is outside the bounded image size`,
    );
  return `data:${imageMime(path)};base64,${bytes.toString("base64")}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// The page has to say what it mapped and when -- "Evidence flow map" named neither. Both come
// straight out of the trace: the first address the browser was at, and the first event's own
// timestamp. No product knowledge, no guessing, nothing the run did not record.
function runIdentity(events) {
  const url =
    events.find((event) => event.before?.url)?.before?.url ??
    events[0]?.after?.url ??
    "";
  let productName = "Flow map";
  try {
    productName = new URL(url).hostname.replace(/^www\./, "") || productName;
  } catch {
    // Not a URL the run could parse -- the page just carries the generic name.
  }
  const stamp = new Date(events[0]?.timestamp ?? NaN);
  const runDate = Number.isNaN(stamp.valueOf())
    ? ""
    : `${stamp.getUTCDate()} ${MONTHS[stamp.getUTCMonth()]} ${stamp.getUTCFullYear()}`;
  return { productName, productUrl: url, runDate };
}

// A refused mutating request (see readBlockedActions below) has no per-event timestamp or ref in
// the retained evidence, so it cannot be honestly pinned to the one state where it happened -- it
// is surfaced here, once, inside the "How to read this" panel next to the legend entry that already
// promises it, rather than dropped (the legend must keep advertising it either way: the block
// genuinely happened). The header keeps a count chip that opens the panel, so a reader never has to
// find it by accident.
function blockedActionsNote(blockedActions) {
  if (!blockedActions?.length) return "";
  const count = blockedActions.length;
  const items = blockedActions
    .map(
      (action) =>
        `<code>${escapeHtml(action.method)} ${escapeHtml(action.path)}</code>`,
    )
    .join(", ");
  // The full list stays collapsed: a run's refusal count can run into the hundreds. The one-line
  // summary alone carries the fact that the safety boundary did its job.
  return `<div class="alert" role="note"><div class="alert-title">${count} request${count === 1 ? "" : "s"} refused by the run's own safety boundary</div><p class="alert-body">Not attempted against the product.</p><details class="alert-list"><summary>Show the refused requests</summary><p>${items}</p></details></div>`;
}

// Renders the interactive atlas: an absolutely-positioned pan/zoom canvas of screenshot cards
// (model.nodes), SVG arrows labelled in plain language (model.edges), grouped into named lanes
// (model.regions), with the raw accessibility dump and full evidence detail tucked behind a
// click-to-open drawer instead of sitting in the main view. Client-side code below is built with
// string concatenation, not template literals -- it lives inside this file's own template
// literal, and a literal backtick in the generated script would terminate that early.
function documentHtml(model, meta) {
  const data = JSON.stringify(model)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  const pageTitle = `${meta.productName} flow map · ${meta.runDate}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<style>
/* shadcn/ui's design language, written by hand in plain CSS: its neutral palette as custom
   properties, its radius and type scale, and its card/badge/button/input/tooltip shapes. Both
   themes live in these variables -- the system preference by default, a root stamp when the reader
   overrides it. No framework, no build step, no external font: the page opens from disk. */
:root{
  color-scheme:light;
  --background:0 0% 100%;
  --foreground:240 10% 3.9%;
  --card:0 0% 100%;
  --card-foreground:240 10% 3.9%;
  --popover:0 0% 100%;
  --popover-foreground:240 10% 3.9%;
  --primary:240 5.9% 10%;
  --primary-foreground:0 0% 98%;
  --secondary:240 4.8% 95.9%;
  --secondary-foreground:240 5.9% 10%;
  --muted:240 4.8% 95.9%;
  --muted-foreground:240 3.8% 46.1%;
  --accent:240 4.8% 95.9%;
  --accent-foreground:240 5.9% 10%;
  --destructive:0 72% 45%;
  --destructive-foreground:0 0% 98%;
  --border:240 5.9% 90%;
  --input:240 5.9% 90%;
  --ring:240 5.9% 10%;
  --observed:161 84% 26%;
  --claimed:25 90% 42%;
  --unknown:0 72% 45%;
  --surface:240 5% 97%;
  --grid:240 6% 88%;
  --radius:0.5rem;
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --shadow-sm:0 1px 2px 0 hsl(240 6% 10% / .06);
  --shadow-md:0 4px 12px -2px hsl(240 6% 10% / .12),0 2px 4px -2px hsl(240 6% 10% / .06);
  --shadow-lg:0 16px 40px -12px hsl(240 6% 10% / .28);
  --header-h:56px;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    color-scheme:dark;
    --background:240 10% 4%;
    --foreground:0 0% 98%;
    --card:240 6% 10%;
    --card-foreground:0 0% 98%;
    --popover:240 6% 10%;
    --popover-foreground:0 0% 98%;
    --primary:0 0% 98%;
    --primary-foreground:240 6% 10%;
    --secondary:240 4% 16%;
    --secondary-foreground:0 0% 98%;
    --muted:240 4% 16%;
    --muted-foreground:240 5% 65%;
    --accent:240 4% 16%;
    --accent-foreground:0 0% 98%;
    --destructive:0 72% 51%;
    --border:240 4% 18%;
    --input:240 4% 18%;
    --ring:240 5% 65%;
    --observed:160 62% 45%;
    --claimed:35 92% 58%;
    --unknown:0 75% 62%;
    --surface:240 6% 8%;
    --grid:240 5% 18%;
    --shadow-sm:0 1px 2px 0 hsl(0 0% 0% / .4);
    --shadow-md:0 4px 12px -2px hsl(0 0% 0% / .5);
    --shadow-lg:0 16px 40px -12px hsl(0 0% 0% / .7);
  }
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --background:240 10% 4%;
  --foreground:0 0% 98%;
  --card:240 6% 10%;
  --card-foreground:0 0% 98%;
  --popover:240 6% 10%;
  --popover-foreground:0 0% 98%;
  --primary:0 0% 98%;
  --primary-foreground:240 6% 10%;
  --secondary:240 4% 16%;
  --secondary-foreground:0 0% 98%;
  --muted:240 4% 16%;
  --muted-foreground:240 5% 65%;
  --accent:240 4% 16%;
  --accent-foreground:0 0% 98%;
  --destructive:0 72% 51%;
  --border:240 4% 18%;
  --input:240 4% 18%;
  --ring:240 5% 65%;
  --observed:160 62% 45%;
  --claimed:35 92% 58%;
  --unknown:0 75% 62%;
  --surface:240 6% 8%;
  --grid:240 5% 18%;
  --shadow-sm:0 1px 2px 0 hsl(0 0% 0% / .4);
  --shadow-md:0 4px 12px -2px hsl(0 0% 0% / .5);
  --shadow-lg:0 16px 40px -12px hsl(0 0% 0% / .7);
}
*{box-sizing:border-box}
html,body{height:100%;margin:0;overflow:hidden}
body{background:hsl(var(--background));color:hsl(var(--foreground));font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}
:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important}}

/* Header: one line -- who was mapped and when, what was found, search, and the controls. */
.topbar{position:fixed;z-index:40;inset:0 0 auto;display:flex;align-items:center;gap:14px;height:56px;padding:0 16px;background:hsl(var(--background) / .82);backdrop-filter:blur(12px);border-bottom:1px solid hsl(var(--border))}
.brand{display:flex;align-items:baseline;gap:8px;min-width:0}
.brand-name{font-weight:650;letter-spacing:-.01em;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brand-date{color:hsl(var(--muted-foreground));font-size:12.5px;white-space:nowrap}
.counts{color:hsl(var(--muted-foreground));font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.controls{display:flex;align-items:center;gap:8px;margin-left:auto}
.input{height:32px;width:min(220px,26vw);padding:0 10px;border:1px solid hsl(var(--input));border-radius:calc(var(--radius) - 2px);background:hsl(var(--background));box-shadow:var(--shadow-sm)}
.input::placeholder{color:hsl(var(--muted-foreground))}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 11px;border:1px solid hsl(var(--border));border-radius:calc(var(--radius) - 2px);background:hsl(var(--background));box-shadow:var(--shadow-sm);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .15s,border-color .15s}
.btn:hover{background:hsl(var(--accent));color:hsl(var(--accent-foreground))}
.btn[aria-expanded="true"]{background:hsl(var(--accent))}
.btn.icon{width:32px;padding:0;font-size:15px}
.btn.warn{border-color:hsl(var(--destructive) / .45);color:hsl(var(--destructive))}
.btn.warn:hover{background:hsl(var(--destructive) / .1);color:hsl(var(--destructive))}
.group{display:inline-flex}
.group .btn{border-radius:0;margin-left:-1px}
.group .btn:first-child{border-radius:calc(var(--radius) - 2px) 0 0 calc(var(--radius) - 2px);margin-left:0}
.group .btn:last-child{border-radius:0 calc(var(--radius) - 2px) calc(var(--radius) - 2px) 0}

/* "How to read this": a popover, not a wall of text above the map. */
.panel{position:fixed;z-index:50;top:calc(var(--header-h) + 8px);right:12px;width:min(430px,92vw);max-height:calc(100vh - var(--header-h) - 24px);overflow:auto;padding:18px;background:hsl(var(--popover));color:hsl(var(--popover-foreground));border:1px solid hsl(var(--border));border-radius:var(--radius);box-shadow:var(--shadow-lg)}
.panel h2{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.panel p{margin:10px 0;color:hsl(var(--muted-foreground));font-size:12.5px;line-height:1.6}
.panel details{margin:10px 0;font-size:12.5px}
.panel summary{cursor:pointer;font-weight:550;color:hsl(var(--foreground))}
.panel code{font:11.5px var(--mono)}
.legend{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:7px}
.legend li{display:flex;align-items:center;gap:9px;font-size:12.5px;color:hsl(var(--muted-foreground))}
.legend .key{flex:0 0 34px;height:14px;display:inline-flex;align-items:center;justify-content:center}
.legend .key i{display:block;width:100%;height:0;border-top:2.5px solid hsl(var(--observed))}
.legend .key i.dashed{border-top-style:dashed;border-color:hsl(var(--claimed))}
.legend .key i.unknown{border-color:hsl(var(--unknown))}
.legend .key i.thick{border-top-width:4.5px}
.badge{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:10.5px;font-weight:600;line-height:1.7;border:1px solid transparent;white-space:nowrap}
.badge-terminal{background:hsl(var(--unknown) / .14);color:hsl(var(--unknown));border-color:hsl(var(--unknown) / .3)}
.badge-loop{background:hsl(var(--muted));color:hsl(var(--muted-foreground));border-color:hsl(var(--border))}
.badge-solid-loop{background:hsl(var(--observed) / .13);color:hsl(var(--observed));border-color:hsl(var(--observed) / .3)}
.alert{margin:14px 0 0;padding:11px 12px;border:1px solid hsl(var(--destructive) / .35);background:hsl(var(--destructive) / .08);border-radius:calc(var(--radius) - 2px)}
.alert-title{font-size:12.5px;font-weight:600;color:hsl(var(--destructive))}
.alert-body{margin:3px 0 0!important;font-size:12px}
.alert-list{margin:8px 0 0}
.alert-list summary{font-size:12px;color:hsl(var(--destructive))}
.alert-list p{max-height:120px;overflow:auto;margin:6px 0 0}

/* The map is the page: it fills everything under the header and pans inside its own surface. */
.viewport{position:fixed;top:var(--header-h);left:0;right:0;bottom:0;overflow:hidden;cursor:grab;touch-action:none;background:hsl(var(--surface))}
.viewport.dragging{cursor:grabbing}
.canvas{position:absolute;transform-origin:0 0;background-image:radial-gradient(hsl(var(--grid)) 1px,transparent 1px);background-size:26px 26px}
.region{position:absolute;border:1px solid hsl(var(--border));border-radius:calc(var(--radius) + 4px);background:hsl(var(--background) / .55)}
.region-header{position:absolute;z-index:3;top:0;left:0;right:0;height:${LANE_HEADER}px;display:flex;align-items:center;padding:0 16px}
.region-header span{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));border:1px solid hsl(var(--border));border-radius:999px;padding:3px 11px;font-size:12px;font-weight:600;letter-spacing:-.005em;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.edges{position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:1}
.edges path{fill:none;stroke:hsl(var(--observed));stroke-width:2.25;stroke-linejoin:round;stroke-linecap:round}
.edges path.dashed{stroke:hsl(var(--claimed));stroke-dasharray:7 6}
.edges path.unknown-terminal{stroke:hsl(var(--unknown))}
.edges g.cross path{stroke-width:4}
.edges path.halo,.edges g.cross path.halo{stroke:hsl(var(--surface));stroke-width:10;stroke-dasharray:none;opacity:.95}
.edges g.dim{opacity:.1}
.edges marker polygon{fill:hsl(var(--observed))}
.edges marker.dashed polygon{fill:hsl(var(--claimed))}
.edges marker.unknown polygon{fill:hsl(var(--unknown))}
.edge-label{fill:hsl(var(--foreground));font:600 11px var(--font);text-anchor:middle;dominant-baseline:middle}
.edge-label-bg{fill:hsl(var(--popover));stroke:hsl(var(--border));stroke-width:1}
.edge-label-bg.cross{stroke:hsl(var(--foreground) / .45);stroke-width:1.5}

/* A screen card: the screenshot, its plain-English title, its flow, and where it leads. */
.node{position:absolute;z-index:2;display:flex;flex-direction:column;width:${NODE_WIDTH}px;height:${NODE_HEIGHT}px;background:hsl(var(--card));color:hsl(var(--card-foreground));border:1px solid hsl(var(--border));border-radius:var(--radius);box-shadow:var(--shadow-sm);overflow:hidden;transition:box-shadow .15s,border-color .15s,transform .15s}
.node:hover{box-shadow:var(--shadow-md);border-color:hsl(var(--foreground) / .28);transform:translateY(-1px)}
.node.dim{opacity:.16}
.node.selected{border-color:hsl(var(--ring));box-shadow:0 0 0 2px hsl(var(--ring) / .55),var(--shadow-md)}
.node.terminal{border-color:hsl(var(--unknown) / .55)}
.shot{position:relative;display:block;width:100%;height:${SHOT_HEIGHT}px;padding:0;border:0;border-bottom:1px solid hsl(var(--border));background:hsl(var(--muted));cursor:zoom-in;overflow:hidden}
.shot img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;object-position:top center}
.empty-shot{position:absolute;inset:0;display:grid;place-items:center;color:hsl(var(--muted-foreground));font-size:12px;padding:10px;text-align:center}
.body{flex:1;display:flex;flex-direction:column;gap:5px;padding:9px 11px 10px;min-height:0;overflow:hidden}
.meta{display:block;width:100%;padding:0;border:0;background:none;text-align:left;cursor:pointer;min-height:0}
.meta .title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12.5px;font-weight:600;line-height:1.3;letter-spacing:-.005em}
.meta .url{display:block;margin-top:3px;color:hsl(var(--muted-foreground));font:11px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badges,.stubs{display:flex;flex-wrap:wrap;gap:4px;overflow:hidden}
.stubs{margin-top:auto}
.stub{max-width:100%;border:1px dashed hsl(var(--border));background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));border-radius:999px;padding:1px 8px;font-size:10.5px;font-weight:600;line-height:1.7;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stub:hover{border-style:solid;background:hsl(var(--accent))}
.stop-reason{font-size:11px;line-height:1.35;color:hsl(var(--unknown));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.empty-atlas{padding:60px;text-align:center;color:hsl(var(--muted-foreground))}

/* Evidence drawer and full-size screenshot lightbox. */
.drawer{position:fixed;z-index:45;top:var(--header-h);right:0;bottom:0;width:min(440px,94vw);padding:20px;overflow:auto;background:hsl(var(--card));border-left:1px solid hsl(var(--border));box-shadow:var(--shadow-lg);transform:translateX(105%);transition:transform .2s ease}
.drawer.open{transform:translateX(0)}
.drawer h2{margin:0 34px 0 0;font-size:16px;font-weight:650;letter-spacing:-.01em}
.drawer h3{margin:16px 0 6px;font-size:13px;font-weight:650}
.close-drawer{position:absolute;right:12px;top:12px;width:30px;height:30px;border:1px solid hsl(var(--border));border-radius:calc(var(--radius) - 2px);background:hsl(var(--background));font-size:16px;line-height:1;cursor:pointer}
.close-drawer:hover{background:hsl(var(--accent))}
.drawer-shot{margin:14px 0;background:hsl(var(--muted));border:1px solid hsl(var(--border));border-radius:calc(var(--radius) - 2px);overflow:hidden;cursor:zoom-in;padding:0;width:100%;display:block}
.drawer-shot img{display:block;width:100%;max-height:52vh;object-fit:contain}
.drawer .url{color:hsl(var(--muted-foreground));font:11.5px var(--mono);word-break:break-all}
.drawer .provenance{color:hsl(var(--muted-foreground));font-size:12px;margin:8px 0 0}
.drawer dl{margin:14px 0}
.drawer dt{color:hsl(var(--muted-foreground));font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-top:12px}
.drawer dd{margin:3px 0;word-break:break-word;font-size:13px}
.drawer pre,.drawer code{font:11.5px var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.drawer details{margin:12px 0}
.drawer details summary{cursor:pointer;font-weight:550;font-size:12.5px}
.drawer details pre{padding:10px;background:hsl(var(--muted));border-radius:calc(var(--radius) - 2px);margin-top:8px;max-height:340px;overflow:auto}
.drawer ul{padding-left:18px;margin:6px 0}
.drawer li{margin:7px 0;font-size:12.5px}
.notice{margin:12px 0;padding:10px 12px;border:1px solid hsl(var(--unknown) / .35);background:hsl(var(--unknown) / .08);border-radius:calc(var(--radius) - 2px);font-size:12.5px}
.bounded-note{margin:5px 0;font-size:11.5px;color:hsl(var(--muted-foreground))}
.citation{margin:6px 0;padding:8px 10px;border-left:3px solid hsl(var(--claimed));background:hsl(var(--claimed) / .09);border-radius:0 calc(var(--radius) - 2px) calc(var(--radius) - 2px) 0;font-size:12px}
.lightbox{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:32px;background:hsl(240 10% 4% / .82);cursor:zoom-out}
.lightbox img{max-width:100%;max-height:100%;object-fit:contain;border-radius:calc(var(--radius) - 2px);box-shadow:var(--shadow-lg);background:hsl(var(--background))}
.lightbox-close{position:absolute;top:16px;right:16px;width:34px;height:34px;border:1px solid hsl(0 0% 100% / .3);border-radius:calc(var(--radius) - 2px);background:hsl(0 0% 0% / .4);color:#fff;font-size:18px;line-height:1;cursor:pointer}
[hidden]{display:none!important}
@media (max-width:900px){.counts{display:none}}
</style></head>
<body>
<header class="topbar">
<div class="brand"><span class="brand-name" title="${escapeHtml(meta.productUrl)}">${escapeHtml(meta.productName)}</span><span class="brand-date">${escapeHtml(meta.runDate)}</span></div>
<div class="counts" id="summary"></div>
<div class="controls">
<input class="input" id="search" type="search" placeholder="Search screens" aria-label="Search screens">
<button class="btn" id="info-toggle" type="button" aria-expanded="false" aria-controls="info-panel">How to read this</button>
${meta.blockedActions?.length ? `<button class="btn warn" id="refused-toggle" type="button" aria-controls="info-panel">${meta.blockedActions.length} refused</button>` : ""}
<div class="group">
<button class="btn icon" id="zoom-out" type="button" aria-label="Zoom out">&minus;</button>
<button class="btn icon" id="zoom-in" type="button" aria-label="Zoom in">+</button>
<button class="btn" id="fit" type="button" aria-label="Fit the map to the screen">Fit</button>
</div>
<button class="btn icon" id="theme" type="button" aria-label="Switch between light and dark">&#9681;</button>
</div>
</header>
<div class="panel" id="info-panel" role="dialog" aria-labelledby="info-title" hidden>
<div class="panel-head"><h2 id="info-title">How to read this map</h2><button class="close-drawer" id="info-close" type="button" aria-label="Close" style="position:static">&times;</button></div>
<p>Screenshots are the screens the browser actually showed, and each card is titled with a short description of its own picture, written from that screenshot so you can recognise the screen. Arrows are the actions that changed what was on screen, in plain language &mdash; only the arrows report what actually happened.</p>
<p>An arrow shows which action came right before a change; the tool only observes timing, so in rare cases an unrelated background update could be attributed to a click.</p>
<p>Click a card to follow one journey: everything else dims, and that screen's own steps &mdash; including the long ones the resting map leaves out &mdash; are drawn and labelled. Click a screenshot to see it full size.</p>
<ul class="legend">
<li><span class="key"><i></i></span>Solid line &middot; observed</li>
<li><span class="key"><i class="dashed"></i></span>Dashed line &middot; claim or inference</li>
<li><span class="key"><i class="unknown"></i></span>Red line &middot; unknown outcome, exploration stopped</li>
<li><span class="key"><i class="thick"></i></span>Thick line &middot; one flow leading into another</li>
<li><span class="key"><span class="badge badge-loop">&#8635;</span></span>Grey badge &middot; action with no visible effect</li>
<li><span class="key"><span class="badge badge-solid-loop">&#8635;</span></span>Green badge &middot; the screen visibly changed, but stayed the same screen underneath</li>
<li><span class="key"><span class="stub">&rarr;</span></span>Stub chip &middot; a step to a distant screen; click it to go there</li>
</ul>
${blockedActionsNote(meta.blockedActions)}
<details><summary>How this map reads timing (technical detail)</summary><p>${escapeHtml(BOUNDED_MUTATION_DISCLOSURE)}</p><p>Trace: <code>${escapeHtml(meta.traceName)}</code></p></details>
</div>
<main class="viewport" id="viewport" tabindex="-1" aria-label="Flow map">
<section class="canvas" id="canvas"></section>
</main>
<aside class="drawer" id="drawer" role="dialog" aria-modal="false" aria-labelledby="drawer-title" aria-hidden="true">
<button class="close-drawer" id="close-drawer" type="button" aria-label="Close details">&times;</button>
<div id="drawer-content"></div>
</aside>
<div class="lightbox" id="lightbox" hidden>
<button class="lightbox-close" id="lightbox-close" type="button" aria-label="Close full-size screenshot">&times;</button>
<img id="lightbox-img" alt="">
</div>
<script>
const model = ${data};
const canvas = document.querySelector('#canvas');
const viewport = document.querySelector('#viewport');
const drawer = document.querySelector('#drawer');
const drawerContent = document.querySelector('#drawer-content');
const closeDrawerButton = document.querySelector('#close-drawer');
const search = document.querySelector('#search');
const summary = document.querySelector('#summary');
const panel = document.querySelector('#info-panel');
const infoToggle = document.querySelector('#info-toggle');
const lightbox = document.querySelector('#lightbox');
const lightboxImage = document.querySelector('#lightbox-img');
const root = document.documentElement;
// The header is one fixed-height line, but a narrow window can still wrap it -- measure the real
// rendered box so the pan/zoom viewport below it (and the initial Fit) starts from the actual
// available space, not a guess.
const measureHeader = () => root.style.setProperty('--header-h', document.querySelector('.topbar').getBoundingClientRect().height + 'px');
measureHeader();
const NODE_WIDTH = ${NODE_WIDTH}, NODE_HEIGHT = ${NODE_HEIGHT}, FIT_MIN = 0.45;
let selectedId = null, scale = 1, tx = 30, ty = 20, drag = null;
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
// Short, plain-language form of a stop reason for the main map view (the drawer keeps the full text).
const shortStopReason = (info) => {
  if (!info) return '';
  const full = (info.reason || info.stopReason || '').trim();
  if (!full) return '';
  const firstSentence = full.split(/(?<=[.!?])\\s/)[0];
  return firstSentence.length <= 140 ? firstSentence : full.slice(0, 137) + '\\u2026';
};
// Short, readable form of a screen's URL for the main map view -- the path only, no query string
// (the drawer keeps the full URL for anyone who needs it).
const shortUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.pathname + ((parsed.search || parsed.hash) ? '…' : '');
  } catch {
    return url;
  }
};
// A long opaque path segment (a hash, an id) used to run off the edge of its card. Cut the middle
// out instead of the end, so both what it starts with and what it ends with stay visible; the full
// value is on the element's tooltip and in the drawer.
const middleTruncate = (value, max) => value.length <= max ? value : value.slice(0, Math.ceil(max / 2) - 1) + '…' + value.slice(1 - Math.floor(max / 2));
const apply = () => { canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; };
const nodeFor = (id) => model.nodes.find((node) => node.id === id) || null;
const matchesNode = (node, term) => !term || [node.title, node.observedTitle || '', node.url || '', node.groupTitle, node.summary || ''].join(' ').toLowerCase().includes(term);
// An arrow that leaves its lane says so on its own label -- the destination lane's name after the
// action -- because those joins are what show the product's flows connect at all.
const edgeLabelText = (edge) => edge.cross && edge.laneTitle ? edge.label + ' → ' + edge.laneTitle : edge.label;
const neighboursOf = (id) => {
  const set = new Set([id]);
  model.edges.forEach((edge) => { if (edge.from === id) set.add(edge.to); if (edge.to === id) set.add(edge.from); });
  return set;
};
const render = () => {
  const term = search.value.trim().toLowerCase();
  // Focus mode: one screen selected dims everything that is not that screen's own step, so a reader
  // can follow a single journey instead of a field of wires.
  const focus = selectedId ? neighboursOf(selectedId) : null;
  const visible = (node) => matchesNode(node, term);
  const lit = (node) => visible(node) && (!focus || focus.has(node.id));
  const arrows = model.edges.map((edge) => {
    const incident = focus && (edge.from === selectedId || edge.to === selectedId);
    // A long wire is not drawn on the resting map at all -- it is the card's stub chip instead.
    if (!edge.path || (edge.long && !incident)) return null;
    const source = nodeFor(edge.from), target = nodeFor(edge.to);
    if (!source || !target) return null;
    const dim = !(visible(source) && visible(target)) || (focus && !incident);
    const kindClass = edge.kind === 'dashed' ? 'dashed' : edge.kind === 'unknown-terminal' ? 'unknown-terminal' : '';
    const marker = edge.kind === 'dashed' ? 'arrow-dashed' : edge.kind === 'unknown-terminal' ? 'arrow-unknown' : 'arrow';
    // A cross-lane arrow is drawn on a surface-coloured halo so that where it does have to pass a
    // lane boundary it still reads as one continuous line rather than merging with what is behind.
    const halo = edge.cross ? '<path class="halo" d="' + edge.path + '"></path>' : '';
    const line = '<g class="edge' + (dim ? ' dim' : '') + (edge.cross ? ' cross' : '') + '">' + halo + '<path class="' + kindClass + '" d="' + edge.path + '" marker-end="url(#' + marker + ')"></path></g>';
    // Labels are shown for the short local steps, which each own their own gap, and for whatever is
    // in focus. Everything else would stack in the same band and be unreadable.
    if (!(focus ? incident : edge.resting) || dim) return { line: line, label: '' };
    const text = edgeLabelText(edge);
    const naturalWidth = text.length * 6.4 + 16;
    const labelWidth = Math.max(60, Math.min(edge.labelWidth, naturalWidth));
    const shrinkAttr = naturalWidth > edge.labelWidth ? ' textLength="' + (labelWidth - 12) + '" lengthAdjust="spacingAndGlyphs"' : '';
    return {
      line: line,
      label: '<g class="edge"><rect class="edge-label-bg' + (edge.cross ? ' cross' : '') + '" x="' + (edge.labelX - labelWidth / 2) + '" y="' + (edge.labelY - 10) + '" width="' + labelWidth + '" height="20" rx="4"></rect><text class="edge-label"' + shrinkAttr + ' x="' + edge.labelX + '" y="' + edge.labelY + '">' + esc(text) + '</text></g>',
    };
  }).filter(Boolean);
  const regions = model.regions.map((region) => '<section class="region" style="left:' + region.x + 'px;top:' + region.y + 'px;width:' + region.width + 'px;height:' + region.height + 'px"><div class="region-header"><span>' + esc(region.title) + '</span></div></section>').join('');
  const nodes = model.nodes.map((node) => {
    const image = node.imageData ? '<img src="' + node.imageData + '" alt="Screenshot of ' + esc(node.title) + '">' : '<div class="empty-shot">No screenshot retained</div>';
    const stopped = node.terminal || !!node.stopInfo;
    const badges = (stopped ? '<span class="badge badge-terminal">Exploration stopped here</span>' : '') + (node.selfLoops.length ? '<span class="badge badge-loop">' + node.selfLoops.length + ' action' + (node.selfLoops.length === 1 ? '' : 's') + ' with no effect</span>' : '') + (node.selfChanges.length ? '<span class="badge badge-solid-loop">' + node.selfChanges.length + ' change' + (node.selfChanges.length === 1 ? '' : 's') + ' on this screen</span>' : '');
    const stopReason = node.stopInfo ? '<div class="stop-reason">' + esc(shortStopReason(node.stopInfo)) + '</div>' : '';
    const stubs = node.stubs.length ? '<div class="stubs">' + node.stubs.slice(0, 2).map((stub) => '<button class="stub" type="button" data-jump="' + esc(stub.id) + '" title="' + esc(stub.title) + '">→ ' + esc(middleTruncate(stub.title, 26)) + '</button>').join('') + (node.stubs.length > 2 ? '<button class="stub" type="button" data-node="' + esc(node.id) + '">+' + (node.stubs.length - 2) + '</button>' : '') + '</div>' : '';
    return '<div class="node' + (lit(node) ? '' : ' dim') + (node.id === selectedId ? ' selected' : '') + (stopped ? ' terminal' : '') + '" style="left:' + node.x + 'px;top:' + node.y + 'px">'
      + '<button class="shot" type="button" data-shot="' + esc(node.id) + '" aria-label="Open the full-size screenshot of ' + esc(node.title) + '">' + image + '</button>'
      + '<div class="body"><button class="meta" type="button" data-node="' + esc(node.id) + '" aria-label="Details for ' + esc(node.title) + '"><span class="title">' + esc(node.title) + '</span>'
      + (node.url ? '<span class="url" title="' + esc(node.url) + '">' + esc(middleTruncate(shortUrl(node.url), 34)) + '</span>' : '') + '</button>'
      + (badges ? '<div class="badges">' + badges + '</div>' : '') + stopReason + stubs + '</div></div>';
  }).join('');
  canvas.style.width = model.canvasWidth + 'px';
  canvas.style.height = model.canvasHeight + 'px';
  const markers = ['arrow', 'arrow-dashed', 'arrow-unknown'].map((id, index) => '<marker id="' + id + '" class="' + ['', 'dashed', 'unknown'][index] + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><polygon points="0,0 10,5 0,10"></polygon></marker>').join('');
  canvas.innerHTML = '<svg class="edges" width="' + model.canvasWidth + '" height="' + model.canvasHeight + '"><defs>' + markers + '</defs>' + arrows.map((arrow) => arrow.line).join('') + arrows.map((arrow) => arrow.label).join('') + '</svg>' + regions + (nodes || '<p class="empty-atlas">No screens were observed. This is an honest empty map.</p>');
  const shownCount = model.nodes.filter(visible).length;
  summary.textContent = shownCount + ' screen' + (shownCount === 1 ? '' : 's') + ' \\u00b7 ' + model.edges.length + ' step' + (model.edges.length === 1 ? '' : 's') + ' \\u00b7 ' + model.flowCount + ' lane' + (model.flowCount === 1 ? '' : 's') + ' with repeat interaction';
};
const connectionsFor = (id) => model.edges.map((edge) => {
  if (edge.from !== id && edge.to !== id) return null;
  const incoming = edge.to === id;
  const other = nodeFor(incoming ? edge.from : edge.to);
  return other ? { edge, incoming, other } : null;
}).filter(Boolean);
const openLightbox = (node) => {
  if (!node || !node.imageData) return;
  lightboxImage.src = node.imageData;
  lightboxImage.alt = 'Full-size screenshot of ' + node.title;
  lightbox.hidden = false;
  document.querySelector('#lightbox-close').focus({ preventScroll: true });
};
const closeLightbox = () => { lightbox.hidden = true; lightboxImage.removeAttribute('src'); };
const centreOn = (node) => {
  tx = viewport.clientWidth / 2 - (node.x + NODE_WIDTH / 2) * scale;
  ty = viewport.clientHeight / 2 - (node.y + NODE_HEIGHT / 2) * scale;
  apply();
};
const select = (id) => {
  const node = nodeFor(id);
  if (!node) return;
  selectedId = id;
  render();
  const shot = node.imageData ? '<button class="drawer-shot" type="button" id="drawer-shot" aria-label="Open the full-size screenshot"><img src="' + node.imageData + '" alt="Screenshot of ' + esc(node.title) + '"></button>' : '';
  const stop = node.stopInfo ? '<div class="notice"><strong>Exploration stopped here.</strong> ' + esc(node.stopInfo.reason || node.stopInfo.stopReason) + '</div>' : (node.terminal ? '<div class="notice"><strong>Outcome unknown.</strong> Exploration stopped without observing what this leads to.</div>' : '');
  const loops = node.selfLoops.length ? '<dt>No-effect actions here</dt><dd>' + node.selfLoops.map((loop) => esc(loop.label)).join('; ') + '</dd>' : '';
  const solidLoops = node.selfChanges.length ? '<dt>Screen changes here (without changing the page structure)</dt><dd>' + node.selfChanges.map((loop) => esc(loop.label)).join('; ') + '</dd>' : '';
  const confirmations = node.confirmations.length ? '<dt>Reconfirmed</dt><dd>Observed again with no change (' + node.confirmations.length + ' time' + (node.confirmations.length === 1 ? '' : 's') + ')</dd>' : '';
  const connections = connectionsFor(id).map((connection) => {
    const citation = connection.edge.citation ? '<div class="citation"><strong>' + esc(connection.edge.citation.sourceId) + '</strong>' + (connection.edge.citation.sourceUrl ? ' \\u00b7 ' + esc(connection.edge.citation.sourceUrl) : '') + '<br>&quot;' + esc(connection.edge.citation.excerpt) + '&quot;</div>' : '';
    const bounded = connection.edge.boundedNote ? '<div class="bounded-note">Mutation association: temporal-only (input dispatch through after-evidence)</div>' : '';
    return '<li>' + (connection.incoming ? 'From ' : 'To ') + '<button class="stub" type="button" data-jump="' + esc(connection.other.id) + '">' + esc(connection.other.title) + '</button> \\u2014 ' + esc(connection.edge.label) + (connection.edge.cross ? ' (a different flow: ' + esc(connection.edge.laneTitle || connection.other.groupTitle) + ')' : '') + citation + bounded + '</li>';
  }).join('');
  const described = node.caption ? '<p class="provenance">This heading is a description of the screenshot below, written from it to help you recognise the screen — not something the run observed happening.</p>' : '';
  const onScreenText = node.observedTitle && node.observedTitle !== node.title ? '<dt>Text read off this screen</dt><dd>' + esc(node.observedTitle) + '</dd>' : '';
  drawerContent.innerHTML = '<h2 id="drawer-title">' + esc(node.title) + '</h2>' + described + (node.url ? '<p class="url">' + esc(node.url) + '</p>' : '') + shot + stop + '<dl><dt>Flow</dt><dd>' + esc(node.groupTitle) + '</dd>' + onScreenText + solidLoops + loops + confirmations + '</dl>' + (connections ? '<h3>Connections</h3><ul>' + connections + '</ul>' : '') + '<details><summary>Raw accessibility snapshot</summary><pre>' + esc(node.summary || 'No raw snapshot retained.') + '</pre></details>';
  const drawerShot = document.querySelector('#drawer-shot');
  if (drawerShot) drawerShot.addEventListener('click', () => openLightbox(node));
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  closeDrawerButton.focus({ preventScroll: true });
};
const closeDrawer = () => {
  selectedId = null;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  render();
};
const setPanel = (open) => {
  panel.hidden = !open;
  infoToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) document.querySelector('#info-close').focus({ preventScroll: true });
};
canvas.addEventListener('click', (event) => {
  const jump = event.target.closest('[data-jump]');
  if (jump) {
    const node = nodeFor(jump.dataset.jump);
    if (node) { select(node.id); centreOn(node); }
    return;
  }
  const shot = event.target.closest('[data-shot]');
  if (shot) { openLightbox(nodeFor(shot.dataset.shot)); return; }
  const meta = event.target.closest('[data-node]');
  if (meta) select(meta.dataset.node);
});
drawerContent.addEventListener('click', (event) => {
  const jump = event.target.closest('[data-jump]');
  if (!jump) return;
  const node = nodeFor(jump.dataset.jump);
  if (node) { select(node.id); centreOn(node); }
});
closeDrawerButton.addEventListener('click', closeDrawer);
infoToggle.addEventListener('click', () => setPanel(panel.hidden));
document.querySelector('#info-close').addEventListener('click', () => { setPanel(false); infoToggle.focus({ preventScroll: true }); });
const refusedToggle = document.querySelector('#refused-toggle');
if (refusedToggle) refusedToggle.addEventListener('click', () => setPanel(true));
lightbox.addEventListener('click', closeLightbox);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!lightbox.hidden) closeLightbox();
  else if (!panel.hidden) { setPanel(false); infoToggle.focus({ preventScroll: true }); }
  else if (drawer.classList.contains('open')) closeDrawer();
});
document.addEventListener('pointerdown', (event) => {
  if (panel.hidden || panel.contains(event.target) || event.target.closest('#info-toggle,#refused-toggle')) return;
  setPanel(false);
});
search.addEventListener('input', render);
// Theme: the system preference decides unless the reader overrides it here, and the override is
// remembered per browser where storage is available (a file:// page may refuse it -- that is fine,
// the toggle still works for the session).
const stored = (() => { try { return localStorage.getItem('flow-map-theme'); } catch { return null; } })();
if (stored === 'dark' || stored === 'light') root.dataset.theme = stored;
document.querySelector('#theme').addEventListener('click', () => {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('flow-map-theme', root.dataset.theme); } catch { /* storage unavailable */ }
});
// Lanes stack top-to-bottom like a page, and each lane's cards are a grid rather than one endless
// row, so "fit" can genuinely fit: it scales to the width, never crops a card sideways, and stops
// shrinking at FIT_MIN -- below that nothing on a card is legible anyway, and panning down a tall
// map beats squinting at the whole of it.
const fitAll = () => {
  const width = viewport.clientWidth, height = viewport.clientHeight;
  const fitWidth = (width - 48) / model.canvasWidth, fitHeight = (height - 48) / model.canvasHeight;
  scale = Math.max(0.15, Math.min(1, fitWidth, Math.max(FIT_MIN, Math.min(fitWidth, fitHeight))));
  tx = Math.max(0, (width - model.canvasWidth * scale) / 2);
  ty = 24;
  apply();
};
document.querySelector('#zoom-in').addEventListener('click', () => { scale = Math.min(2.5, scale * 1.2); apply(); });
document.querySelector('#zoom-out').addEventListener('click', () => { scale = Math.max(0.15, scale / 1.2); apply(); });
document.querySelector('#fit').addEventListener('click', fitAll);
window.addEventListener('resize', measureHeader);
viewport.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = viewport.getBoundingClientRect(), mx = event.clientX - rect.left, my = event.clientY - rect.top;
  const next = Math.max(0.15, Math.min(2.5, scale * Math.exp(-event.deltaY * 0.0015)));
  tx = mx - (mx - tx) * (next / scale);
  ty = my - (my - ty) * (next / scale);
  scale = next;
  apply();
}, { passive: false });
viewport.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.node')) return;
  drag = { x: event.clientX - tx, y: event.clientY - ty, moved: false };
  viewport.classList.add('dragging');
  viewport.setPointerCapture(event.pointerId);
});
viewport.addEventListener('pointermove', (event) => { if (!drag) return; drag.moved = true; tx = event.clientX - drag.x; ty = event.clientY - drag.y; apply(); });
// A click on empty canvas clears the focus, which is how a reader gets the whole map back.
viewport.addEventListener('pointerup', () => { if (drag && !drag.moved && selectedId) closeDrawer(); drag = null; viewport.classList.remove('dragging'); });
viewport.addEventListener('pointercancel', () => { drag = null; viewport.classList.remove('dragging'); });
render();
fitAll();
</script>
</body></html>`;
}

export async function renderMap({
  tracePath,
  outputPath,
  publicPackPath = null,
  publicPackSha256 = null,
  // Verified-on-screen overrides for a state whose automated on-screen evidence can't honestly
  // title it -- missing entirely, or a known false positive (see deriveNodeTitle above):
  // { [observation_hash]: string[] }. Empty for every ordinary render -- default behavior, and
  // every existing caller, is unchanged.
  titleOverrides = {},
  // Plain-English descriptions of what each retained screenshot shows, keyed by observation hash
  // (see scripts/caption-screens.mjs). A sidecar, never part of the trace: the evidence file stays
  // exactly what the browser reported. Empty for every render that has no caption sidecar, which
  // behaves exactly as before.
  captions = {},
}) {
  const { events } = await validateTrace({ tracePath });
  await validatePublicPackBinding({ events, publicPackPath, publicPackSha256 });
  const graph = await buildGraph(events, titleOverrides, captions);

  // Optional generic pipeline artifact (every run's candidate-packager stage carries it, see
  // TEXT_FILES in lib/candidate-packager.mjs) -- reading it is source-blind, its shape is a
  // standard explorer-result schema, not something invented per target. Its absence just means
  // no stop-reason annotation on the final screen.
  let stopInfo = null;
  let findings = [];
  try {
    const raw = await readFile(
      resolve(dirname(tracePath), "explorer-result.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    if (typeof parsed.stop_reason === "string")
      stopInfo = {
        stopReason: parsed.stop_reason,
        reason: typeof parsed.reason === "string" ? parsed.reason : null,
      };
    // Doors the run chose not to walk through -- an off-site link, a refused action, a wall. They
    // are findings, and map.json carries them so a reader knows what was NOT explored and why.
    if (Array.isArray(parsed.blocked_actions))
      findings = parsed.blocked_actions;
  } catch {
    // No sibling explorer-result.json (or it doesn't parse) -- render without a stop annotation.
  }
  if (stopInfo && graph.lastTouchedId && graph.nodes.has(graph.lastTouchedId))
    graph.nodes.get(graph.lastTouchedId).stopInfo = stopInfo;

  // Same optional-sibling-artifact pattern as explorer-result.json above: every run's
  // action-boundary log (also carried by candidate-packager, see TEXT_FILES) records a refused
  // mutating request as {method, path, verdict}, with no event_id or timestamp -- so it cannot be
  // pinned to the one state where it happened. Read here and surfaced once near the legend
  // (blockedActionsNote) instead of only being visible to someone who opens the JSON.
  let blockedActions = [];
  try {
    const raw = await readFile(
      resolve(dirname(tracePath), "request-events.jsonl"),
      "utf8",
    );
    blockedActions = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (entry) =>
          entry.verdict &&
          entry.verdict !== "allow" &&
          entry.method &&
          entry.path,
      )
      .map((entry) => ({ method: entry.method, path: entry.path }));
  } catch {
    // No sibling request-events.jsonl (or it doesn't parse) -- render without a blocked-action note.
  }

  const lanes = assignLanes(graph);
  const layout = layoutGraph(graph, lanes);
  const nodeModels = [];
  for (const id of graph.order) {
    const node = graph.nodes.get(id);
    const position = layout.positioned.get(id) ?? {
      x: CANVAS_PADDING,
      y: CANVAS_PADDING,
    };
    nodeModels.push({
      id: node.id,
      title: node.title,
      // What the card title came from: a description of the picture, or text read off the screen.
      caption: node.caption ?? null,
      observedTitle: node.observedTitle ?? null,
      url: node.url,
      groupTitle: lanes.laneTitles.get(lanes.laneOfNode(id)) ?? node.groupKey,
      x: position.x,
      y: position.y,
      imageData: await nodeImageDataUri(node, tracePath),
      terminal: node.terminal,
      summary: node.summary,
      confirmations: node.confirmations,
      selfLoops: node.selfLoops.map((loop) => ({
        label: loop.label,
        kind: loop.kind,
      })),
      selfChanges: node.selfChanges.map((loop) => ({
        label: loop.label,
        kind: loop.kind,
      })),
      stopInfo: node.stopInfo ?? null,
      // Filled in below: the steps from this screen whose wire is too long to draw on the resting
      // map. The card names them instead, so no transition ever goes unmentioned.
      stubs: [],
    });
  }
  const edgeModels = graph.edges.map((edge, index) => {
    const route = layout.routes[index];
    return {
      from: edge.from,
      to: edge.to,
      label: edge.label,
      kind: edge.kind,
      citation: edge.citation,
      boundedNote: edge.boundedNote,
      // Precomputed orthogonal route (see layoutGraph): the client only draws it.
      path: route?.path ?? null,
      labelX: route?.labelX ?? 0,
      labelY: route?.labelY ?? 0,
      labelWidth: route?.labelWidth ?? 200,
      // Whether this arrow carries its label on the resting map, or only while it is in focus.
      resting: route?.resting ?? false,
      long: route?.long ?? false,
      cross: route?.cross ?? false,
      laneTitle: route?.laneTitle ?? null,
    };
  });
  const nodeById = new Map(nodeModels.map((node) => [node.id, node]));
  for (const edge of edgeModels) {
    if (!edge.long) continue;
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (source && target && !source.stubs.some((stub) => stub.id === target.id))
      source.stubs.push({ id: target.id, title: target.title });
  }
  const regionModels = layout.regions.map((region) => ({
    title: region.title,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  }));

  const model = {
    nodes: nodeModels,
    edges: edgeModels,
    regions: regionModels,
    flowCount: countFlows(graph, lanes.laneOfNode),
    canvasWidth: layout.canvasWidth,
    canvasHeight: layout.canvasHeight,
  };
  // map.json: the same graph without the drawing. Documented in docs/map-schema.md, and the only
  // thing anyone should have to parse -- map.html is for people, map.json is for programs. It cites
  // screenshots by path rather than embedding them, so it stays small enough to read.
  const outDegree = new Map();
  for (const edge of edgeModels)
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
  const screens = nodeModels.map((node) => ({
    id: node.id,
    title: node.caption ?? node.title,
    caption: node.caption,
    observed_title: node.observedTitle,
    url: node.url ?? null,
    flow: node.groupTitle,
    screenshot: graph.nodes.get(node.id)?.screenshotPath ?? null,
    terminal: Boolean(node.terminal),
    out_degree: outDegree.get(node.id) ?? 0,
  }));
  const transitions = edgeModels.map((edge) => ({
    from: edge.from,
    to: edge.to,
    action: edge.label,
    kind: edge.kind,
  }));
  const mapJson = {
    schema_version: 1,
    run_id: events[0]?.run_id ?? null,
    stop: stopInfo
      ? { reason: stopInfo.stopReason, detail: stopInfo.reason }
      : null,
    screens,
    transitions,
    findings: findings.map((finding) => ({
      kind: finding.transition_kind ?? "unknown-terminal",
      instruction: finding.instruction ?? null,
      reason: finding.reason ?? null,
    })),
    refused_requests: blockedActions,
    // Recomputed from the arrays right above, every time -- so this summary can never drift from
    // the map it is summarising (see the 2026-09-05 dogfood run, where it did).
    counts: {
      screens: screens.length,
      transitions: transitions.length,
      flows: new Set(screens.map((screen) => screen.flow)).size,
    },
  };
  const html = documentHtml(model, {
    traceName: basename(tracePath),
    blockedActions,
    ...runIdentity(events),
  });
  await writeFile(outputPath, html, { encoding: "utf8", mode: 0o600 });
  return { outputPath, html, map: mapJson };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  const options = args();
  const tracePath = resolve(options["--trace"]);
  const outputPath = resolve(options["--output"]);
  const publicPackPath = options["--public-pack"]
    ? resolve(options["--public-pack"])
    : null;
  const publicPackSha256 = options["--public-pack-sha256"] ?? null;
  if (
    (publicPackPath && !publicPackSha256) ||
    (!publicPackPath && publicPackSha256)
  )
    throw new Error(
      "--public-pack and --public-pack-sha256 must be supplied together",
    );
  renderMap({ tracePath, outputPath, publicPackPath, publicPackSha256 })
    .then(() => process.stdout.write(`${outputPath}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Map rendering failed"}\n`,
      );
      process.exitCode = 1;
    });
}
