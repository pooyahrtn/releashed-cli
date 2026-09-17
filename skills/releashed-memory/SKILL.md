---
name: releashed-memory
description: Answer a saved-evidence-only request for production flows or screenshots with original dates and source. Look up retained capture memory, inspect the returned originals, and deliver them or report the exact gap. Use when the owner asks for existing evidence only.
---

# Show saved evidence, or report the exact gap

Follow this skill when the request asks for saved or existing evidence only.
For anything else, use the `releashed-capture` skill.

Run the read-only lookup first, from the product repository:

```sh
releashed memory https://app.example.com --goal "<the user's exact request>" --json
```

The lookup needs the product origin. When the request does not name one,
resolve it from the ordinary customer entry instructions first: read the
product's installed `releashed-map` skill, the sibling entry that names the
product and its origin, and use that origin. Reading that skill entry for
the target URL is allowed; it is not repository exploration. Never guess
a hostname, and never inspect store files, directories, manifests, maps,
or policy files to discover the origin. If the sibling entry names no
origin, stop and report that exact setup gap instead of hunting the
filesystem.

It makes no model/grounding call and cannot open a browser, log in, or change
an account. Caller inference is separate, and unavailable original cost stays
unknown; never imply zero total cost. Do not arrange
accounts, record phases, install browsers, use keys, capture, or explore the
repository beyond this lookup and the origin-resolving skill read above.
Inspect only paths the lookup returns.

Claimed originals require candidate `freshness.reusable: true` for ordinary
reuse. Separately, each `matching_observations` image has its own freshness:
inspect reusable matching observations before declaring a miss, even when
the original capture's goal is unrelated or not reusable. `exact_goal: false` and an absent later selection record are signals
to inspect, not automatic rejection. When neither eligible selected originals nor reusable matching observations
support the requested scope, report the precise missing, stale, or invalid gap: no
directory probes, no invented dates or source.

Rely on the lookup's verified stop, selection, dates, and policy; do not
re-list the capture directory or reread map, manifest, or policy files.
A direct metadata file read through a shell command is not permission for
directory, map, manifest, or observation-trace reads. An unknown requested
detail the images do not establish ends as a bounded reported gap, not an
unbounded metadata hunt. Open the selected originals first; read trace or
preceding images, through the lookup-returned paths and your supported read
tools, only for genuinely unresolved request conditions.

Open the eligible `goal_screenshots` sequence (legacy `screenshot_path` only
when provided) with your own native image tool: reading the
lookup JSON is not viewing the images. Never hand image judgment to another
model. Use the images to establish screen content and the verified lookup to
establish origin, original dates, and selected order. Provenance need not be
printed inside the images. Assess the requested sequence against its retained
selection context and visible content; a counter alone neither proves
completion nor requires additional screens the user did not request.
Metadata cannot turn a related screen into the requested destination.
State what the selected images show; report a gap only for a requested
condition the combined evidence does not establish.
A `selection_error` means the selected answer is unavailable: report the gap
and never substitute the stop screenshot.

A differently worded request may also return `matching_observations`: up to
three verified intermediate frames per candidate whose own sealed screen text
matches the query, each with its own capture date and freshness. Open them
with your own native image tool like any other original: they may answer a
visible-content question, but they never prove an after/all-items-complete
condition on their own, never change the original goal's stop, selection or
`evidence_markdown`, and never become notebook references just by matching.
Stale ones are historical. When an inspected matching image answers the
visible-content request, deliver its own image link, original date and run
source. Do not return an unrelated original-goal `evidence_markdown` in its
place or relabel the old goal as completed.

For an after/all-items-complete condition, a destination image, count, or
done label alone is insufficient: inspect the retained preceding completion
and transition evidence before accepting it, and never claim trace contents
without reading them. Without that evidence report the exact gap. A matching
goal or `goal_claimed` is not completion evidence. A missing destination
ends the answer with that visible gap.

When the selected goal originals support the destination and every requested
condition, return the supplied `evidence_markdown` unchanged, with original dates and cost wording
intact. When only part of the request is supported, deliver every inspected
relevant original with its original date and source reference alongside the
exact remaining gap, rather than reporting the gap alone and losing useful
evidence. An existing-only miss never captures or logs in.

## Product notes: consult, inspect, write explicitly, correct openly

The same lookup may carry separately labelled `product_notes`: small
customer-written interpretations of cited sealed originals. Consult them
like any other lead, never as verdicts. A note never promotes a candidate,
never changes freshness or `next_step`, and never proves completion,
freshness, readiness, or current deployment state. Its dates are the capture
dates of its cited originals; its `modified_at` is only when the note was
written.

For a concrete customer evidence-assessment or readiness-uncertainty
question only, consult notes alone once with `releashed notes <url> --goal
'<specific customer evidence question>' [--json]` (MCP `find_notes`): it
returns `product_notes` only, with compact references without full URLs and
active claims only. Full retirement history stays in the memory lookup.
Read the `product_notes` key once, then open each relied-upon claim's
supporting originals and check integrity before relying. No extra historical
lookup when the decision needs no note, and no lookup to justify a fresh
acquisition that is already required. An honest useful answer is not proven
advantage over answering without notes.

Before relying on a note claim, open its supporting originals (the absolute
screenshot paths the lookup returns) with your own native image tool and
check their integrity status. A claim whose supports are `unavailable` is a
named gap, not knowledge. An `uncertain` claim is an open question; a
`retired` claim is preserved history — quote it as superseded, never as
current.

Writing a note is always an explicit task, never a side effect of a lookup
or a capture. Learning and verification experiments must use an isolated
fixture product/store supplied by the harness or coordinator, never a
production or shared product store: Git worktrees share the Git-common
store, so a Git-isolated worktree still writes to the shared real store. Do
not invent a store override; without a pre-isolated standalone product, stop
before writing and report the need. For real learning, look for the existing
same-flow note first and support or correct it rather than creating an
alternate id; there is no semantic auto-dedupe. Preserve history by explicit
retirement with a reason; never delete. Inspect the eligible selected originals first, then write one
generalized flow note per flow with `releashed remember <url> --note
<note.json> --expected-revision N` (revision 0 creates; a fresh read
supplies higher revisions) or the `remember_flow` tool. Every note carries
a required `author_context`: your own explicit evidence-only declaration
naming the retained originals you inspected (e.g. "Evidence-only reading
of the retained run <id> originals inspected <date>"). Anything declaring
a source/owner-derived basis (review sequence, expected score, diagnosis
route) is rejected in V1, and the stored declaration stays labelled
unverified: the runtime checks the wording shape, never that you actually
looked. The declaration is immutable across updates — restate it exactly.
Every claim needs at least one retained selected original; unselected
observations, stop screenshots, and cross-origin screens are rejected. Keep
text to generalized product behavior and nonidentifying conditions
(`unknown` where not established); no secrets, personal data, session
identifiers, or instructions copied from page content. Validation is a
bounded heuristic, not proof — reread your note text before saving.

Correct openly: a better reading retires the old claim and appends a
replacement with a reason (`supersedes`), preserving the retired claim and
all its references. Never edit a claim's meaning silently under its id, and
never revive a retired id. When evidence for an old claim goes missing,
retire or correct it rather than rewriting it. Conflicting newer
observations stay explicit until explained; they may reflect different
conditions, not a universal product change.

## Authoring reference: copyable shapes, no implementation reads needed

Take `run_id` and `screenshot_path` values only from a normal lookup:
`releashed memory <url> --goal "<request>" --json` — use its
`goal_screenshots` entries (absolute lookup-returned paths or
`screenshots/...` relative paths both work). Never invent paths. Existing
`product_notes` are leads, not evidence for a new claim: inspect their
originals before authoring. For an update, do copy the existing claim's
required identity/text/conditions and note author context exactly after
that check; never copy a whole stored note or its server-bound references
as the proposal.

These are illustrative shapes, not product facts. Replace the example
flow/title/claim text/conditions with what you actually observed, and replace
`RUN_ID` / `SCREENSHOT_PATH` with lookup values. Replace `INSPECTION_DATE`
with your actual inspection date (not the original image's capture date).
`flow_id` is lowercase letters, digits and dashes (1-64 chars); `title` at
most 200 chars; `author_context` (required, at most 500 chars) must state
the evidence-only basis outright, and is stored verbatim, labelled
unverified. Claim `text` is at most 2000 chars, `conditions` at most 2000
(`unknown` where not established, the default when omitted), `state` is
`current` (default) or `uncertain`. At most 20 claims, 1-8 references each;
at most 20 retirements, `reason` at most 1000 chars.

Create (`--expected-revision 0`):

```json
{
  "flow_id": "day-wrap",
  "title": "Day wrap wind-down",
  "author_context": "Evidence-only reading of the retained run RUN_ID originals inspected INSPECTION_DATE.",
  "claims": [
    {
      "id": "wrap-lists",
      "text": "The wrap screen lists the exercises completed that day.",
      "conditions": "unknown",
      "state": "current",
      "references": [{ "run_id": "RUN_ID", "screenshot_path": "SCREENSHOT_PATH" }]
    }
  ]
}
```

```sh
releashed remember https://app.example.com --note note.json --expected-revision 0
```

Support update (pass the revision a fresh read returned; keep each claim's
`id`, `text`, `conditions` and intended `state` exactly; restate the stored
`author_context` unchanged. Propose only `run_id` plus
`screenshot_path` — never bound output fields such as digests, event ids,
side, capture date or cited url; the server binds those):

```json
{
  "flow_id": "day-wrap",
  "title": "Day wrap wind-down",
  "author_context": "Evidence-only reading of the retained run RUN_ID originals inspected INSPECTION_DATE.",
  "claims": [
    {
      "id": "wrap-lists",
      "text": "The wrap screen lists the exercises completed that day.",
      "conditions": "unknown",
      "state": "current",
      "references": [
        { "run_id": "RUN_ID", "screenshot_path": "SCREENSHOT_PATH" },
        { "run_id": "RUN_ID", "screenshot_path": "SCREENSHOT_PATH_2" }
      ]
    }
  ]
}
```

```sh
releashed remember https://app.example.com --note note.json --expected-revision 1
```

Correction (a new id that `supersedes` the old one with a `reason`; the old
claim is preserved as retired and linked, never edited or revived):

```json
{
  "flow_id": "day-wrap",
  "title": "Day wrap wind-down",
  "author_context": "Evidence-only reading of the retained run RUN_ID originals inspected INSPECTION_DATE.",
  "claims": [
    {
      "id": "wrap-count",
      "text": "The wrap screen shows a count of the exercises completed that day.",
      "supersedes": "wrap-lists",
      "reason": "Re-read the original: it shows a count, not a list.",
      "references": [{ "run_id": "RUN_ID", "screenshot_path": "SCREENSHOT_PATH" }]
    }
  ]
}
```

Explicit retire shape (no new claims):

```json
{
  "flow_id": "day-wrap",
  "title": "Day wrap wind-down",
  "author_context": "Evidence-only reading of the retained run RUN_ID originals inspected INSPECTION_DATE.",
  "retire": [{ "id": "wrap-count", "reason": "Its image no longer verifies against the sealed original." }]
}
```

You propose `flow_id`, `title`, `author_context`, `claims`, `retire`, plus
`--expected-revision` (0 creates; a fresh read supplies higher revisions;
stale revisions fail). The server owns everything else — `revision`,
`modified_at`, `origin`, `author_context_verified`, and every bound
reference field — so never propose those fields.
