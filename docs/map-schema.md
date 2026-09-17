# `map.json` — the map as data

Every candidate a run produces carries two views of the same graph: `map.html` for a person and
**`map.json`** for a program. This is the file to parse. `map.html` embeds a rendering model with
layout coordinates and base64 screenshots; nothing outside the renderer should read it.

`map.json` is written by `renderer/render-map.mjs` and sealed into the candidate by
`lib/candidate-packager.mjs`, so its bytes are hashed in `manifest.json` like every other file.
Producing the same run twice produces the same `map.json`, byte for byte.

## Shape

```json
{
  "schema_version": 1,
  "run_id": "vision-prod-20260906T101500Z",
  "stop": { "reason": "step_budget_exhausted", "detail": "The step budget ran out ..." },
  "screens": [
    {
      "id": "f469a002e6c1...",
      "title": "Dashboards list with folders and search",
      "caption": "Dashboards list with folders and search",
      "observed_title": "Dashboards",
      "url": "https://play.grafana.org/dashboards",
      "flow": "Dashboards",
      "screenshot": "screenshots/state-0007.png",
      "terminal": false,
      "out_degree": 3
    }
  ],
  "transitions": [
    { "from": "f469a002e6c1...", "to": "7cbab16e9a02...", "action": "Clicked \"START\"", "kind": "solid" }
  ],
  "findings": [
    { "kind": "unknown-terminal", "instruction": "Click Donate", "reason": "\"Click Donate\" led off the product's own site; the run did not follow it." }
  ],
  "refused_requests": [{ "method": "POST", "path": "/api/billing/checkout" }],
  "counts": { "screens": 51, "transitions": 53, "flows": 6 }
}
```

## Fields

| Field | Meaning |
|---|---|
| `schema_version` | `1`. Bumped only for a breaking change; new optional fields do not bump it. |
| `run_id` | The run this map came from. Matches `production-run-report.json` and every trace event. |
| `directed_by` | **Present only on a directed map**, and then it is the plain-English goal the owner aimed the run at (`releashed map --goal "..."`, capture mode). Its ABSENCE is what says a walk was free. A directed map is what one aimed walk found on its way somewhere — it is never evidence that anything is discoverable, and `releashed diff` refuses to compare a directed map with a free one. |
| `policy` | The directed run's short plain-English behaviour policy, when the producer recorded one. |
| `continues` | Optional earlier run id this run continues. It is a pointer, not replayed history or proof that the earlier route still works. |
| `precondition` | Optional plain-English declaration of state arranged before this directed run. It was not supplied to the walk as a destination. |
| `auth_mode` / `identity_label` | How the run authenticated and its non-secret account label. `identity_label` may explicitly be `null`; absent fields mean the historical record did not say. |
| `stop` | Why the run ended, or `null`. `reason` is a stable code (`step_budget_exhausted`, `explicit_done`, `time_budget_exhausted`, `cost_budget_exhausted`, `bot-wall`, `login-wall`, `explorer_error`, and on a directed run `goal_claimed`, …); `detail` is one sentence of English. `step`, present on `goal_claimed`, is the claimed step. `screenshot_path`, present only when the declared retained image is safely available, names the actual screenshot the walker claimed — it can differ from the screenshot selected for a deduplicated screen card. Historical `goal_reached` records remain readable as historical claims; this schema does not upgrade them to verification. |
| `screens[].id` | The observation hash of that screen. Stable across runs for a screen that looks identical. The MCP server shortens it to the first 8 characters; a prefix is enough to address it. |
| `screens[].title` | What to call the screen: the caption if one was written, otherwise text read off the screen. |
| `screens[].caption` | The description written from the screenshot, or `null`. A reading aid — never evidence, and never a claim about what a control does. |
| `screens[].observed_title` | Text actually read off the screen, or `null`. |
| `screens[].url` | The address the browser was on, or `null`. |
| `screens[].flow` | The group the renderer put the screen in. A grouping, not a claim about the product's own navigation. |
| `screens[].screenshot` | Path, relative to the candidate directory, of the retained PNG. At most 1280px wide. `null` if none was retained. |
| `screens[].terminal` | Nothing observed leaving this screen. |
| `screens[].out_degree` | How many transitions leave it. |
| `transitions[].from` / `.to` | Full screen ids. |
| `transitions[].action` | What was done, in the product's own words for the control (`Clicked "START"`). |
| `transitions[].kind` | `solid` = observed directly, before and after. `dashed` = supported only by a cited public-pack claim, never by an observation. |
| `findings[]` | Doors the run refused to walk through: off-site links, forbidden actions, a bot or login wall. `kind` is `unknown-terminal`. **A finding is not a defect claim about the product** — it is a statement about what this run did not do. |
| `refused_requests[]` | Mutating requests the boundary blocked, method and masked path only. |
| `counts` | Convenience totals, recomputed from the arrays above so they can never drift from them: `screens`/`transitions` are those arrays' lengths, `flows` is the number of distinct `screens[].flow` values. |

**Goal selection (2026-09-07; S-15):** directed MCP `finish` accepts an optional ordered
`goal_screenshots` array of recorded screenshot paths with `goal_reached: true`. The array is
retained in `map.json` separately from the stopping step; `stop.screenshot_path` retains its
compatibility role as the first claimed image. Omission keeps the legacy current-image behavior.
All selected paths must be recorded, unique, in observation order and hash-verified.

For old sealed runs, `releashed select <run-id> --screenshots <paths...> --why "<reason>"`
writes `<output-root>/selections/<run-id>.json`, never edits the candidate. This version-1 record
binds run ID, directed goal and manifest SHA256 to the selected relative paths, reason and
`selected_at`. Explicit reselection replaces that derived record atomically. Memory revalidates
it and returns `goal_screenshots` objects with absolute image paths, hashes, source event IDs
and observation timestamps. `captured_at` still dates the original run; `selection.selected_at`
dates the later selection. A bad explicit selection returns partial evidence with
`selection_error` and no answer images, never falls back to the final frame. Memory results
remain candidates for visual inspection, not verified coverage.

The retained session-review run is the regression: its old stop points at `state-0045.png`,
while a separate selection can name `state-0039.png` through `state-0043.png` without changing
any sealed bytes. Full record: [capture acceptance](capture-acceptance-2026-09.md#ordinary-developer-variant--2026-09-07).

## What is deliberately absent

- **Layout.** No coordinates, no lanes, no colours. Draw your own.
- **Intent.** No "expected" flow, no route names, no assertion about what should exist. Everything
  here was observed; nothing was inferred from source.
- **Anything unobserved.** A screen missing from `screens` was not seen. That is a statement about
  the run, not about the product.
