// One observation, and one transition event, in the exact shape the packager and renderer consume.
//
// Extracted verbatim from scripts/vision-explorer-run.mjs so the option-D MCP server
// (lib/explore-mcp.mjs) can produce the SAME evidence without copying it. The run script imports
// these and is otherwise unchanged; if the two ever drifted apart, one of the two ways of driving
// a browser would quietly start writing a trace the renderer reads differently.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { isNodeOnScreen } from "./ax-visibility.mjs";
import { formatAxLine } from "./ax-line-format.mjs";
import { sha256Text } from "./scaffold.mjs";
const defaultMeasure = (_name, work) => work();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const pad = (n) => String(n).padStart(4, "0");
// A contact detail or a long digit run on somebody else's page belongs to somebody else. Redact at
// CAPTURE time, before observation_hash is computed over the text: the retained evidence then never
// contains the value at all, and the hash the renderer recomputes still matches. Only for a
// read-only (third-party) target. See the long note at the call site in the run script.
export function redactContactDetails(text) {
    return (String(text)
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>")
        .replace(/(?:\+\d[\d ()-]{7,}\d|\b\d{3}[ -]\d{3}[ -]\d{4}\b)/g, "<phone>")
        // Any 13-to-19-digit run, the shape the packager tests for a card number: about one in ten
        // passes the Luhn check by chance and other people's pages are full of long numeric ids.
        .replace(/(?<![0-9A-Za-z])(?:\d[ -]?){13,19}(?![0-9A-Za-z])/g, "<number>"));
}
// AX roles that mean "this is a control the product itself named". Anything else that matched is a
// piece of visible text, which is a weaker claim about what was pointed at.
export const NAMED_ROLES = new Set([
    "button",
    "link",
    "radio",
    "checkbox",
    "textbox",
    "searchbox",
    "combobox",
    "switch",
    "tab",
    "menuitem",
    "slider",
    "option",
]);
// Same shape the old broker retained: one line per named accessibility node, "eN [role] name".
// The renderer parses exactly this to title screens and to say what was clicked. NO depth limit:
// nodes nest ~15 deep, and { depth: 10 } returned the document root and nothing else.
export async function accessibilitySummary(cdp) {
    const tree = (await cdp.send("Accessibility.getFullAXTree"));
    const refs = [];
    const candidates = [];
    for (const node of tree.nodes ?? []) {
        if (node.ignored || !node.role?.value)
            continue;
        const role = node.role.value;
        const name = String(node.name?.value ?? node.value?.value ?? "")
            .replace(/\s+/g, " ")
            .trim();
        if (!name && !["textbox", "searchbox", "button", "link"].includes(role))
            continue;
        const ref = `e${refs.length + 1}`;
        refs.push({ ref, role, name });
        candidates.push({ ref, role, name, backendDOMNodeId: node.backendDOMNodeId });
        if (candidates.length >= 600)
            break;
    }
    // Real on-screen status per node -- see lib/ax-visibility.mjs. Stale text scrolled off the top
    // and text behind a modal both sit in the very same tree the renderer titles cards from.
    const send = (method, params) => cdp.send(method, params);
    const onScreenFlags = await Promise.all(candidates.map((candidate) => isNodeOnScreen(send, candidate.backendDOMNodeId)));
    const lines = candidates.map((candidate, index) => formatAxLine(candidate.ref, candidate.role, candidate.name, { onScreen: onScreenFlags[index] }).slice(0, 500));
    return { visible_state_summary: lines.join("\n").slice(0, 30_000), refs };
}
// One retained observation: the screenshot the explorer will see, the accessibility state the
// reviewer will read, and the hash the renderer recomputes to prove the two belong together.
export async function observeScreen(page, cdp, runDir, index, readOnly = false, measure = defaultMeasure) {
    const url = page.url();
    const png = await measure("screenshot.capture", () => page.screenshot());
    const summary = await measure("accessibility.collect", () => accessibilitySummary(cdp));
    const refs = summary.refs;
    const visible_state_summary = readOnly
        ? redactContactDetails(summary.visible_state_summary)
        : summary.visible_state_summary;
    const screenshotPath = `screenshots/state-${pad(index)}.png`;
    await measure("screenshot.write", () => writeFile(join(runDir, screenshotPath), png, { mode: 0o600 }));
    return {
        evidence: {
            url,
            origin: new URL(url).origin,
            visible_state_summary,
            observation_hash: sha256Text(JSON.stringify({ url, visible_state_summary })),
            screenshot_path: screenshotPath,
            screenshot_sha256: sha256(png),
        },
        refs,
        png,
    };
}
// The one transition event both drivers append to observations.jsonl. `index` is 1-based and is
// both the event number and the cumulative action count.
export function buildTransitionEvent({ runId, index, before, after, method, identified, mutated, elapsedSeconds, requests, }) {
    // The accessibility hash alone misses transitions made only visually (a word filling an answer
    // box, a scroll repainting the viewport). Either hash differing is a real observed transition --
    // a self-loop needs BOTH hashes to match.
    const changed = before.observation_hash !== after.observation_hash ||
        before.screenshot_sha256 !== after.screenshot_sha256;
    // A scroll only changes what is on screen; it is an observation, not an own-account action, so
    // it carries no effect evidence. A wait is the same and more so: nothing was dispatched at all,
    // so whatever changed cannot be attributed to this run -- the page did it, and the label has to
    // say "waited" rather than "clicked" or the map claims an action caused something time did.
    const observing = method === "scroll" || method === "wait";
    return {
        run_id: runId,
        event_id: `event-${pad(index)}`,
        timestamp: new Date().toISOString(),
        current_url: after.url,
        current_origin: after.origin,
        visible_state_summary: after.visible_state_summary,
        before,
        after,
        intended_action: {
            method,
            // Omitted entirely when the tier is positional, so the map can never name a step whose
            // target we could only locate by where the pointer went.
            ...(identified.ref ? { ref: identified.ref } : {}),
            target_identification: identified.tier,
        },
        effect_evidence: observing ? null : { supervisor_authorized: true, mutation_request_match: mutated },
        action_matrix_class: observing ? "Observe" : "Reversible own-account",
        observed_outcome: changed
            ? { click: "clicked", type: "typed", scroll: "scrolled", wait: "waited" }[method]
            : "no-visible-effect",
        outcome_detail: changed ? null : "The action ran but the visible state did not change.",
        screenshot_path: after.screenshot_path,
        evidence_provenance: "direct-browser-observation",
        transition_kind: changed ? "solid" : "none",
        elapsed_browser_seconds: Number(elapsedSeconds.toFixed(3)),
        cumulative_browser_actions: index,
        cumulative_browser_requests: requests,
        cumulative_app_actual_eur: 0,
        cumulative_model_actual_eur: 0,
        outstanding_cost_reservation_eur: 0,
    };
}
// A typing executor is given an English instruction, not a coordinate. Immediately afterwards the
// field normally still owns focus, which gives us a grounded target without retaining what was
// typed. The value is deliberately not an argument to this function: answers, passwords, and
// contact details belong to the person using the product, not the durable evidence record.
export async function focusedTarget(page, refs) {
    const focused = await page
        .evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body)
            return null;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
            return null;
        // Native inputs have no innerText. Read the accessible NAME sources only; never read value,
        // placeholder, or surrounding form text, any of which could contain a person's answer.
        const labelText = (label) => String(label?.textContent ?? "").replace(/\s+/g, " ").trim();
        const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => labelText(document.getElementById(id)))
            .filter(Boolean);
        const labels = [...(element.labels ?? [])].map(labelText).filter(Boolean);
        const names = [element.getAttribute("aria-label"), labelledBy.join(" "), labels.join(" ")]
            .map((name) => String(name ?? "").replace(/\s+/g, " ").trim())
            .filter(Boolean);
        return { point: [rect.left + rect.width / 2, rect.top + rect.height / 2], names };
    })
        .catch(() => null);
    if (!focused)
        return { tier: "positional", ref: null };
    // A label must identify exactly one retained accessibility control. Selecting the first of two
    // same-named fields would turn an uncertain claim into misleading evidence.
    const names = new Set(focused.names);
    const matches = refs.filter((ref) => NAMED_ROLES.has(ref.role) && names.has(ref.name));
    if (matches.length === 1)
        return { tier: NAMED_ROLES.has(matches[0].role) ? "named" : "described", ref: matches[0].ref };
    if (names.size > 0)
        return { tier: "positional", ref: null };
    return identifyTarget(page, refs, focused.point[0], focused.point[1]);
}
// How confidently can we say WHAT was pointed at? The executor returns a coordinate, never an
// element, so this asks the page what actually sits under that coordinate and tries to match it to
// a named accessibility node.
export async function identifyTarget(page, refs, x, y) {
    const candidates = await page.evaluate(([px, py]) => {
        const out = [];
        let el = document.elementFromPoint(px, py);
        for (let depth = 0; el && depth < 8; depth += 1, el = el.parentElement) {
            const name = (el.getAttribute("aria-label") ?? el.innerText ?? "")
                .replace(/\s+/g, " ")
                .trim();
            out.push({ role: el.getAttribute("role") ?? "", name: name.slice(0, 500) });
        }
        return out;
    }, [x, y]);
    for (const candidate of candidates) {
        if (!candidate.name)
            continue;
        const match = refs.find((ref) => ref.name === candidate.name && ref.role === candidate.role) ??
            refs.find((ref) => ref.name === candidate.name);
        if (match)
            return { tier: NAMED_ROLES.has(match.role) ? "named" : "described", ref: match.ref };
    }
    return { tier: "positional", ref: null };
}
