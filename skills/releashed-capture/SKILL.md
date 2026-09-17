---
name: releashed-capture
description: Answer a request for a real, signed-in product screenshot. Check Releashed's retained capture memory first; on a miss, safely prepare and run a directed capture. For saved-evidence-only requests use the releashed-memory skill instead. Use when an owner asks to show a production flow or destination.
---

# Show the product, from memory or by capturing it

The owner asks for a screen. They do not choose a storage mode, assemble an account-preparation
workflow, or need to know a prior run id. Start with evidence already retained for this product.

If the request asks for existing evidence only, use the `releashed-memory`
skill instead and follow only it. The rest of this skill is the fresh-capture
route for other requests.

If the lookup requires an authorized fresh capture, deliver the inspected original images, production preparation,
verified cleanup, local timing and external phase/cost records together. The coordinator owns
preparation and cleanup; the vision caller owns only the browser walk.

Create a private attempt directory and start a `phases.json` record only for that fresh capture, before authentication:

```sh
releashed phases start /private/attempt/phases.json
```

Place attempt and vision records under the host-provided approved temporary-work location when the host
supplies one, after verifying the intended parent; never assume `/tmp` is permitted. A refused path
stays refused: report the denial, do not work around it.

This records machine UTC tracking start, **not** the user request time; do not relabel it or
reconstruct a request timestamp from memory. Use `unknown` for unavailable cost components,
including the current caller's unfinished usage.
A blocked request still returns the linked attempt record and any available timing summary.
The supported client setup below is within the existing request; do not ask the owner to
restart a conversation just because an old client lacks the configured tools.

## 1. Look before you run

For an explicitly fresh request, skip retained-capture lookup and reuse: proceed to preparation.
Consult historical notes only for a concrete customer evidence question, as described below.
For requests eligible for reuse, run this from the product repository, with the deployed product
origin and the user's request:

```sh
releashed memory https://app.example.com --goal "<the user's exact request>" --json
```

This command is read-only: it cannot open a browser, log in, mutate an account, or make a paid
model/grounding call. It searches the Git-shared local store, so another worktree of this product
sees the same sealed candidates.

The default reuse window is seven days. Claimed originals require candidate
`freshness.reusable: true`. Each `matching_observations` image has its own freshness;
inspect reusable matching images for visible-content requests before declaring a scope miss,
even if the original goal is unrelated or not reusable. `policy.config_path`
names the local policy file; the owner can set `{"max_age_days": 7}` there. Per-request CLI overrides
are `RELEASHED_MAX_AGE_DAYS=14` and `RELEASHED_FRESH=1`; MCP `find_capture` accepts
`max_age_days` and `fresh`. If you do consult capture memory during an explicit fresh request,
set `RELEASHED_FRESH=1` (or `fresh: true` in MCP); its images cannot satisfy that fresh request. A zero-day window always requires fresh
capture. Expiry starts no browser, login, scheduled refresh, or paid work. Older evidence stays
available for explicitly historical questions, clearly dated. Selection does not reset its age.

Before accepting reuse, list the request's destination and each required condition, and identify
retained evidence for each one. Read `directed_by`, `stop.detail` and `selection.why` alongside the
selected originals. `freshness.reusable` establishes age eligibility, not fulfillment of the request.
For a condition such as "after every item is complete", a destination image or a count of actions
alone is insufficient: inspect the retained preceding transition and completion evidence. A recorded
remaining item contradicts completion. Do not infer what the retained trace contains or lacks
from a screenshot's `event_id` or from lookup detail alone: report the directly observed
destination mismatch when that alone establishes the gap, or read the relevant retained trace
before claiming what it contains or lacks. A missing requested screen needs no further proof
enumeration. Missing or contradictory proof means a scope miss; preserve
the related evidence. For other requests, proceed to section 2 within the existing authority.
For a saved-only request, stop here and report the exact gap instead; sections 2-4 do not
apply. Do not deliver the
partial match as success with a caveat or ask the owner to request the already-authorized capture again.

Open the eligible `goal_screenshots` sequence (or legacy `screenshot_path`), newest exact match first, with your own native image tool: reading the lookup JSON is not viewing the images. A differently worded request may also carry `matching_observations`: verified intermediate frames to inspect for visible content only, never proof the goal completed, never a change to stop, selection or `evidence_markdown`, and never notebook references. The lookup already carries the verified stop, selection, dates and policy; do not re-list the candidate directory or re-read its map, policy or manifest files. Read the retained trace or preceding images only for a requested condition the opened originals leave unresolved. Judge the visible evidence yourself; never hand saved-image judgment to another model or grounding service (the API-driven `releashed map` alternative below is for fresh coordinate-driven capture only). A matching name, a partial run,
or `goal_claimed` alone is not proof: say what the image actually shows. `exact_goal: false` and the absence of a later selection record are match signals to inspect, not automatic rejection. When selected goal originals support the destination and
all requested conditions, return the supplied `evidence_markdown` unchanged. If matching
observations instead answer the visible-content request, deliver their own original image links,
capture dates and run sources, not the unrelated original goal's markdown or completion claim. It
preserves the verified image/date/run and cost uncertainty; do not relabel UTC or infer zero cost.
Call it an original capture, not a fresh view. A user who explicitly asks for a fresh view skips reuse.
Return the original image references in sequence; showing saved images needs no browser or strip
render. `selection.selected_at` dates a later evidence selection, not a new capture. A
`selection_error` means the selected answer is unavailable; never substitute the stop screenshot.
The selected endpoint is not necessarily the browser's final position. `stop.screenshot_path`
can also name a claimed image; verify stopping claims against the retained trace or omit them.

Consult product notes only for a concrete customer evidence-assessment or
readiness-uncertainty question: run `releashed notes <url> --goal '<specific
customer evidence question>' [--json]` (MCP `find_notes`) once and read its
`product_notes` key, then inspect the supporting originals before relying.
The notes lookup returns active claims only with compact references without
full URLs; full retirement history stays in the memory lookup. When it
returns no relevant active claim, report that gap and proceed. No mandatory
note read without a relevant decision, and no extra historical lookup when
fresh acquisition is already required. Never feed note descriptions, routes,
or answers to the walker, and never write notes at capture end. An honest
useful answer is not proven advantage over answering without notes.

## 2. On a miss, prepare rather than guess

Partial evidence is a useful finding, not an answer. Preserve it. Use `releashed-precondition` and
the product repo's existing supported admin, fixture, and test-account helpers to arrange only the
state needed to begin the flow. Before authentication, write a private, nonsecret preparation record with
authorized identity/environment, verified prerequisites, product-day timezone/expiry, supported
login reference, and confirmation that the destination/final trigger was not seeded.
Verify current entitlement and goal-specific state, including whether a daily destination was
already consumed. Select or prepare an eligible authorized account; a persona label is not proof.
Resolve that identity using the roster in the worktree that will actually authenticate, not another
checkout. After switching accounts, repeat prerequisite and applicable cost checks before login.
When production preparation is complete, stamp it immediately:

```sh
releashed phases preparation /private/attempt/phases.json
```

Read source only for login and preparation. Do not give the walker source-derived routes, database
details, selectors, or a click sequence. If preparation is unsafe or unsupported, report the exact
missing capability and stop.

## 3. Capture and inspect

After reconciling the browser-time allowance, use locator MCP capture. Start it with
the owner's supported authentication, goal, and conduct policy, then use its `observe`, `act`,
`record`, and `finish` loop. The installed server locates your target noun phrase on the observed
bytes through your configured model, so omit coordinates: they are refused, never a fallback. It
retains the same action boundary and evidence package. (Caller-supplied coordinates survive only
as an explicit legacy mode for tests and compatible programmatic callers, never on the installed
server, which refuses to start unconfigured.)

Configure the locator in the MCP server entry's environment (verified 2026-09-10 against the
installed @midscene 1.12.3 with an existing ChatGPT Codex login -- no API key, no new billing):

```sh
export RELEASHED_LOCATOR="midscene"
export MIDSCENE_MODEL_BASE_URL="codex://app-server"
export MIDSCENE_MODEL_NAME="gpt-5.6-sol"
export MIDSCENE_MODEL_FAMILY="gpt-5"
export MIDSCENE_MODEL_REASONING_ENABLED="true"
export MIDSCENE_MODEL_REASONING_EFFORT="low"
export MIDSCENE_MODEL_TIMEOUT="120000"
```

`gpt-5.4` is not offered on a ChatGPT login (use `gpt-5.6-sol` or another vision model from the
server's model list); `gpt-5.6` rejects reasoning effort `minimal`, hence `low`. The timeout pins
the package's server-side call at or below the per-locate budget (default 120 s, further capped by
the remaining acquisition window). Confirm access with `codex login status` before capture;
`releashed doctor --capture` checks these variables are present without making any model call.

Bind a dedicated directed MCP instance after preparation; do not use an inherited discovery server.
Pass the supported login command through `--auth-cmd`; running it as a probe creates a real session.
Inspect its documented contract or source for setup instead. Every already-created session still
needs the customer's exact-session cleanup, even if no capture followed it.
When it is configured through a JSON `mcpServers` entry, run `releashed doctor --capture <url>
--goal "<request>" --mcp-config <file.json> --server <entry> --preparation <attempt-record> --json`
from the actual product worktree before authentication. This checks local configuration and record
presence only; it cannot verify the client's loaded instance, permission or external prerequisites.
Check its tool discovery and the client's permission for those exact tools before the first observe.
Startup and tool discovery do not authenticate; the first observe does. If the coordinator read
source for preparation, give an isolated vision caller only the goal, conduct policy and configured
tools, never source-derived navigation. Authentication failure ends that prepared attempt; another
observe does not retry login. Repair and verify preparation before creating a new attempt.

```sh
releashed explore-mcp https://app.example.com --mine \
  --auth-cmd "<the repo's supported command>" \
  --goal "<the user's request>" --policy "<short conduct policy>" \
  --identity-label "<opaque label>" --precondition "<nonsecret preparation summary>" \
  --steps <bounded steps>
```

Use the current authorized caller's native MCP integration when it already supplies the capture
tools and image viewing. Before authentication, establish this handoff:

- The vision caller can use the same prepared instance's `observe`, `act`, `record` and
  `finish`, and can actually view the returned screenshot or open its original image path.
  Give it the explicit wall rule with the handoff: on a visible paywall, login/auth or bot
  wall it ends the walk with `finish(goal_reached: false)` naming the wall actually seen —
  never opening another exercise, route or surface to keep going. Do not inject navigation.
- Give it the mandatory tool loop with the handoff: `observe` → `act` → keep-and-look with
  `observe({record_previous: true})` for EVERY executed action (waits and no-change results included),
  then choose the next action from that returned image. Do not add another `observe` just to
  repeat the same view. The combined call is an explicit save of the pending transition plus the
  already-cached current view in one step, not a fresh browser observation; standalone `record`
  then `observe` remains a compatible fallback. While `observe` reports `unrecorded_act: true` the current screen is
  cached, not a fresh look: do not issue another `act` or judge the app unresponsive —
  keep it with `observe({record_previous: true})`, or use standalone `record` then `observe`.
  The saved transition references the retained before/after images.
- Its context contains only the request, conduct policy, remaining action/time allowance and
  prepared tool connection. If preparation involved source, use a separate source-free context.
  State whether tool restrictions are enforced or merely instructed and audited; do not claim
  isolation that the client cannot provide.
- It returns the complete `finish` response, preserving `evidence_markdown`,
  `preparation_record`, `diagnostics_dir`, image paths and timestamps. Keep the complete client
  output, errors, usage and terminal status privately, including failed attempts.
- Forward an absolute acquisition cutoff, not an elapsed budget: derive `--acquire-until`
  from the original request deadline minus a finish/seal/cleanup reserve and pass that ISO
  to the capture server. Preparation and authentication count against it and never reset it.
  The cutoff limits NEW INPUT, not client lifetime: the child execution must remain alive
  after the cutoff for `record`, `finish` and seal. After it passes the server refuses new
  `act` (including `wait`) before dispatch but still allows a pending `record`, `observe`
  for necessary current evidence, and `finish`/seal/cleanup. Actions already in flight when
  the cutoff passes may finish so a started gesture is not stranded; only new dispatches
  refuse. An expiry before the first `observe` starts no login, and an expiry after
  authentication starts no browser; end that attempt honestly within the original outer
  deadline without resetting the cutoff or reserve. The outer supervisor deadline still
  applies unchanged.
- If `finish` rejects `goal_screenshots` (unknown, duplicate, or out-of-order), the run is
  retained: retry `finish` on the same instance with corrected recorded ordered unique refs,
  without abandoning the originals. No silent dedupe and no stale-current substitution;
  unrecorded images cannot support a claim.

If client setup is needed, read only the relevant optional adapter:
[Muse Code](references/clients/muse.md), [OpenCode](references/clients/opencode.md)
(including an authorized Muse model), or [Claude CLI](references/clients/claude.md).
These are version-specific setup notes, not a required choice of caller. Other clients can meet
the same contract through their own native capabilities. Do not switch caller, model or provider
implicitly. If a required capability is unavailable, retain and link the actual discovery,
permission or image-opening failure and name what must be configured before authentication.

Start each prepared attempt once. If an execution tool yields a session or cell ID, retain it
and await its terminal result. A partial output, first observation or zero exit alone is not a
complete capture. Read the complete client result and errors; recover the returned finished run
and inspect its selected originals before declaring capture failed. Do not start a replacement,
revoke its session or perform cleanup while it is running. Cancellation must end the caller and
capture server before cleanup begins. A time allowance needs client-side supervision;
`--steps` alone does not enforce elapsed time. Derive the child shell timeout from the
original outer deadline minus an explicit caller inspection/cleanup/final reserve, and compute
the remaining time (child hard stop minus now) at child launch: never a fixed shell timeout,
never reset from preparation. The child hard stop MUST be later than the acquisition cutoff,
never at or before it, so the child is never killed merely for reaching the cutoff. For
example, with a 600s outer deadline: acquisition at 450s, child hard stop at 510s, 90s caller
reserve — 60s child seal plus 90s caller work, 150s protected reserve in total. If too little
time remains before authentication, stop honestly instead of launching. After the cutoff, do
not kill the child: it records any pending act, then calls `finish` (`goal_reached: true`
only for a screen actually observed, otherwise `false`), and the parent supervises it through
its terminal result before cleanup, inspection and the final report.

After the complete capture result names its finished run, stamp capture immediately:

```sh
releashed phases capture /private/attempt/phases.json --run-id <finished-run-id>
```

Use the caller's own authorized coding-agent session and the verified product working directory.
Keep separate capture/grounding API use opt-in. Subscription inference still consumes plan limits;
app-side generation triggered by browsing is a separate expense and needs its own allowance.
Keep source-derived instructions out of the vision context. Instruct it to use only capture tools;
the coordinator keeps preparation, repair, image inspection and cleanup. Retain the complete
client result, including token usage and permission failures, privately. A returned access refusal
comes back to the coordinator for the supported recovery in section 4.

When claiming the goal with `finish`, pass `goal_reached: true` and `goal_screenshots`: the ordered
paths returned by `observe`/`record` that actually show the requested screen or sequence. They may
precede the last screen. Record transitions first; unrecorded images cannot support a claim.

For an older sealed run with a wrong claim image, inspect its retained observations and images,
then use `releashed select <run-id> --screenshots <paths...> --why "<what these images show>"`.
This explicitly writes a separate selection record; it does not alter the run or capture date.
It makes no browser or model call. Selection remains a claim to inspect, not verified coverage.

Inspect the selected screenshots and the observed transition immediately before them. Do not return a
walker's claim, an exercise screen, a fixture preview, or a partial strip as the requested result.
The sealed candidate is automatically retained in the shared store.

After the vision caller completes, **open the selected originals yourself** and verify their visible
scope. Finish exact-session cleanup using the customer's supported helper. Keep preparation and
cleanup as separate original records; a cleanup receipt does not establish production readiness.
After cleanup is verified, stamp it immediately:

```sh
releashed phases cleanup /private/attempt/phases.json
```

The recorder preserves `unknown` cost descriptions. You may add measured cost descriptions later,
but never reinterpret its recorded clock. A report with unknown request time labels only the measured
tracking-start-to-cleanup interval.

Then assemble the final answer with the installed local command:

For a new capture, retain the returned `finish.timing_receipt.summary` as
`<private-attempt>/timing/summary.json` and `finish.timing_receipt.markdown` as the
sibling `summary.md`, preserving both values. This is a new server-generated receipt,
not a copy obtained by opening the diagnostics directory. Pass that private JSON to
`--timing` below. Do not list or open diagnostics to assemble the report: the returned
receipt already supplies the measured timing. A missing receipt is an explicit timing
gap to report, not permission to access a refused directory.

```sh
releashed report <run-id> \
  --preparation /absolute/production-readiness-or-preparation-record \
  --cleanup /absolute/verified-cleanup-receipt \
  --timing /absolute/private-attempt/timing/summary.json \
  --phases /absolute/phases.json \
  --inspection "<what you personally verified in the selected originals>"
```

**Return the complete Markdown output unchanged in your final answer.** It supplies original
image dates and all distinct supporting links. The same command covers sealed blocked runs:
their evidence_markdown names the wall image with NOT-reached and the original timestamp. Do not compress it to image+cleanup, relabel cleanup
as preparation, or substitute `finish.preparation_record` (a code-owned declaration) for independent
production preparation. The command checks sealed images and record completeness; it does not
certify readiness, session revocation or your visual interpretation. Investigate failed cleanup
before claiming success. On a blocked attempt, provide the actual linked attempt records and gap.
The report's assembly time is not actual final-message delivery; keep that distinction and unknown
costs. Retain the final caller usage afterward when the client exposes it.

## 4. Own recovery and cleanup

A blocked browser attempt returns its evidence and unmet prerequisite to the calling agent,
which still owns the request. Retain the attempt before recovery; if packaging fails, retain its
raw evidence and error. Use supported customer helpers to diagnose and repair account setup or
select another authorized eligible account. Verify the changed prerequisite before starting a
new browser attempt with its own identity and preparation declaration. A wall stops the browser;
recovery through supported account preparation is not permission to evade it.

Keep the original request's remaining time, action and spend allowance across attempts. Stop with
the precise unresolved need if repair is unsupported or outside authority, the same blocker recurs
after repair, or allowance is exhausted. Do not make the owner relay preparation messages.
Use `--continues` only for verified persistence on the same account, never for an account switch.

Clean up and verify removal of task-created access on success or failure; preserve genuine learner
progress. Record preparation, capture and delivery time separately, plus cleanup, attempts and
known/unknown costs, appending timestamps to that record as work proceeds. Include its reference
with the inspected images or remaining gap. When repair fails, report the observed blocker and
what remains unknown; do not invent its underlying cause or offer an unchanged retry.
For example, a successful entitlement check followed by an access refusal establishes those two
observations, not why access failed. If no supported check explains the discrepancy, state that
the cause is unknown and identify the unresolved prerequisite; do not propose another unchanged run.

Local server timings are written automatically: finish returns `timing_receipt` after its
tool span closes, plus `diagnostics_dir` as an optional original diagnostic reference.
The report uses the receipt retained in the private attempt. Its wall times cover
authentication, browser tools and packaging; unobserved gaps are not measured model thinking.
Keep the machine tracking start, external preparation, actual image delivery and verified access
cleanup timestamps in the coordinator's record. When actual request time is unknown, keep it
unknown rather than relabelling tracking start. Server timings cannot measure those external phases.
Fresh auth files are attempt-specific and removed on finish/shutdown; this removes local credentials,
not the remote session or access grant. Verify remote cleanup with the customer's supported helper.

The API-driven alternative is `releashed map` with the same capture flags plus `--minutes` and
`--budget`. It needs `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`, calls paid models, and is useful when
the calling agent cannot inspect screenshots and provide coordinates. Keep its API spend separate
from the caller's ordinary inference and any product costs. Use it only when that separate model
route and spend are explicitly authorized; a missing client capability does not authorize a switch.

Never pay, delete, post for another person, evade a wall, or put credentials, raw sessions, or
database output in tracked artifacts.
