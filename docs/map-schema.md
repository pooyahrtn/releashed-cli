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
| `stop` | Why the run ended, or `null`. `reason` is a stable code (`step_budget_exhausted`, `explicit_done`, `time_budget_exhausted`, `cost_budget_exhausted`, `bot-wall`, `login-wall`, `explorer_error`, …); `detail` is one sentence of English. |
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

## What is deliberately absent

- **Layout.** No coordinates, no lanes, no colours. Draw your own.
- **Intent.** No "expected" flow, no route names, no assertion about what should exist. Everything
  here was observed; nothing was inferred from source.
- **Anything unobserved.** A screen missing from `screens` was not seen. That is a statement about
  the run, not about the product.
