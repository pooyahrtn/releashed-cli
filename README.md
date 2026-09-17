# releashed

Point it at a deployed web product and it comes back with a map of that product's user flows —
every screen it saw, every transition it actually observed, each one backed by a screenshot.

No source code, no database, no test ids, no list of journeys. It looks at the screen the way a
person would, decides the next thing to try in plain English, clicks it, and looks again.

**See one first:** https://releashed.io/m/e78f288edb489316/flow-map.html — a real product, mapped
this way, nothing hand-written.

## Install

Needs Node 22 or newer. From a release checkout, create the archive (this does not publish it):

```sh
npm pack
```

Install that archive and its matching agent skills in the product environment:

```sh
mkdir -p /tmp/releashed-install
cp /path/to/releashed-0.1.0.tgz /tmp/releashed-install/
npm install -g /tmp/releashed-install/releashed-0.1.0.tgz
releashed install-skills
```

This installs the archive's own dependencies. It does not use a developer checkout or another
project's `node_modules`. Run `releashed install-skills` from the product repository: by default
skills go to its `.claude/skills`. Choose another location with `--destination <directory>`.
Installed skills include `releashed-memory` for saved-evidence-only requests alongside the
fresh-capture route. Existing skill folders are protected. Use `--replace` only when you intend to replace one with the
packaged version. Muse Code 1.0.3 recognizes the default `.claude/skills` location as
supported project skills; check with
`muse skills list --source project --workspace <product-repo> --trust-workspace`.
Suspect trust only when that output carries a `project-skills-untrusted` diagnostic.

### Saved lookup needs no browser

Saved lookup (searching sealed local captures) works straight after the archive install above.
It needs no `install-browser`, no `doctor` mode, and no model keys:

```sh
releashed memory --help      # or: releashed memory -h
releashed mcp --help         # or: releashed mcp -h
releashed install-skills --help
releashed memory https://app.example.com --goal "show me the session wrap" --json
```

Each `... --help` entry is side-effect-free: it prints usage, exits 0, and creates no store,
performs no authentication and makes no paid checks. The lookup itself is read-only against
the product's shared Git store (see below); open each returned original PNG directly and
inspect it before relying on it.

Fresh capture is separate: `releashed install-browser`, the API keys under Keys below, and
`releashed doctor` / `releashed doctor --capture ...` belong to making new maps, not to
reading saved evidence. Keep that setup for capture work.

Plain `releashed doctor` is only for the API-driven `map` command: it makes paid key checks.
For local checks before a signed-in caller-coordinate capture, use:

```sh
releashed doctor --capture https://app.example.com --goal "<request>" \
  --mcp-config /path/to/private-mcp.json --server directed-capture \
  --preparation /path/to/private-attempt.md --json
```

Run it from the product worktree that will authenticate. It checks the selected JSON `mcpServers`
entry, exact package/goal/URL, owner mode, identity/precondition declarations, local run references,
sign-in configuration, Chromium presence and preparation-record presence without launching anything
or making a model call. The preparation record remains caller-authored prose or JSON; this check
does not validate its contents. Client permission, account eligibility and cost prerequisites remain
explicitly unverified. [Details and contributor tooling](docs/developer-tooling.md).
Memory lookup needs neither doctor mode.

## Keys

Export both before you run API-driven `map`:

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # decides what to try next, from the screenshot
export GEMINI_API_KEY=...             # points at the control you named
```

`releashed doctor` checks both keys and Chromium before you spend on an API-driven map. The
shared-memory commands make no model call. `explore-mcp` uses the coding agent's screenshot
coordinates and needs neither API key.

**Two keys is one too many and we know it.** Anthropic's own model can point at a control accurately
(measured on a small probe: 8 of 8 controls, every one inside the real element), so the second key goes away when that swap
lands. Until then the browser-automation library we use has no Anthropic grounding family, and we
would rather ask you for a second key than pretend one model is doing both jobs. A 60-step map costs
roughly EUR 0.50 on Sonnet or EUR 1.00 on Opus, on your key, plus a fraction of a cent for the
pointing. `--budget` caps it.

## The commands

```
releashed doctor
releashed map <url> [options]
releashed login <url>
releashed mcp [candidate-dir]
releashed memory <url> --goal "<English>"
releashed install-skills [--destination <directory>] [--replace]
releashed diff <old-map-dir> <new-map-dir>
releashed explore-mcp [<url>] [--steps N]
```

### `releashed map <url>` — make a map

```sh
releashed map https://play.grafana.org --steps 40 --exclude "/blog/**,/docs/**"
```

It reads the product's own landing page (plain code, no model call), explores within the limits you
set, writes a short description of every screen, and seals the result into a candidate directory
holding `map.html` (one standalone file, screenshots embedded) and `map.json` (the same graph as
data — schema in [docs/map-schema.md](docs/map-schema.md)). It prints both paths, and offers your
project's `AGENTS.md` / `CLAUDE.md` a block telling your coding agent to ask the map first.

| Option | What it does |
|---|---|
| `--model sonnet\|opus` | Sonnet (default) is half the price; **`--model opus` gives a fuller first map** — it reaches about a third more distinct pages. Sonnet for re-runs. |
| `--steps N` | Actions the run may take, 1–250, default 40. |
| `--minutes N` | Wall-clock budget. The run stops when it is spent. |
| `--budget EUR` | Model-spend budget. The run stops when it is spent. |
| `--include <globs>` | Only these paths are the product: `"/tools/**,/app/**"`. |
| `--exclude <globs>` | Never these paths: `"/blog/**,/docs/**"`. |
| `--allow <origins>` | More origins of the same product: `"https://app.example.com"`. Everything else is off-limits. |
| `--seed <file.json>` | Values *you* supply for its fields: `{ "email": "you@example.com", "postcode": "1011AB" }`. The run may type these; it may never invent one. |
| `--upload <file>` | The one file the run may hand to a file picker. |
| `--viewports desktop,phone` | One desktop pass and one phone pass in a single run. Default: desktop. |
| `--login` | Explore as you: uses the session you saved with `releashed login`. |
| `--auth-cmd "<cmd>"` | Your own product: a command of yours prints the sign-in, so no human is needed. |
| `--mine` | You own this product: the run may use it like a user (send, post, submit, reply). It still never pays, deletes, or touches billing/checkout/subscriptions/account deletion. |
| `--goal "<objective>"` | Aim a capture at a screen or flow in your own product. Its evidence is labelled as directed. |
| `--policy "<conduct>"` | How the walk should behave while pursuing `--goal`. |
| `--continues <run-id>` | Capture only: record that this run continues an existing run. It does not restore the browser, replay actions or check account persistence. |
| `--precondition "<setup>"` | Capture only: declare arranged starting state. Use `run <run-id>` to reference earlier evidence under the same output root. Setup is recorded, never sent to the walker. |
| `--identity-label <label>` | Capture only: a nonsecret account label for the record. Omit it if unknown; never use a token or password. |

For a deep capture, authenticate the same account on each run, keep the goal and policy consistent,
and check that its progress survives a fresh sign-in before relying on continuation. The capture
metadata flags also work with `explore-mcp`. Each run has its own sealed evidence; the continuation
pointer is supplied before packaging, never patched into a finished candidate.

A walker saying it arrived produces `goal_claimed`, with its reason and the screenshot it was
looking at. This is a claim to inspect, not independent verification. `get_flow` returns the
directed run's provenance and claim evidence alongside its screens. A wall, error or exhausted
budget keeps its own stop reason.

For a flow requiring yesterday's activity or another backend condition, use
[releashed-precondition](skills/releashed-precondition/SKILL.md) in the customer's repo to arrange,
verify and declare the starting state. The walk still has to reach the destination through the
product.

Everything lands in the product's shared Git store (`.git/releashed`), so every worktree can find
the same sealed captures. Outside Git it falls back to `./releashed`; `RELEASHED_OUT` always
overrides either location. Nothing is uploaded, and nothing phones home: **no telemetry, at all.**

### Capture memory — answer before running

When an owner asks for a production screen, first search sealed local evidence:

```sh
releashed memory https://app.example.com --goal "show me the session wrap" --json
```

This is read-only: it never launches a browser, signs in, or makes a model call. It returns dated
candidate screenshots and their provenance for an agent to inspect; a matching name or walker claim
is not proof by itself. `releashed mcp` with no candidate path exposes the same lookup as the
read-only `find_capture` MCP tool.

Saved captures are reusable for **seven days** by default. Lookup returns `freshness.reusable`
and the policy path; images still need inspection for the requested account and destination.
To change the window for this product, write `{"max_age_days": 7}` to the returned
`policy.config_path` (`memory-policy.json` beside `maps/`). Request overrides:

```sh
RELEASHED_MAX_AGE_DAYS=14 releashed memory https://app.example.com --goal "show the wrap" --json
RELEASHED_FRESH=1 releashed memory https://app.example.com --goal "show a fresh wrap" --json
```

MCP accepts `max_age_days` and `fresh` directly. Zero days always requires a fresh capture.
Age is measured from the oldest selected original image; selecting an image later does not
renew it. Expired evidence remains available as dated history. Expiry never schedules a refresh,
logs in, deletes a map, or spends money. A fresh request goes through the normal preparation and
capture allowance. Caller-coordinate capture uses the agent's authorized subscription by default;
separate model APIs are opt-in, and any app-side generation remains a separate expense.

### Complete capture reports

After inspecting the selected originals and verifying cleanup, assemble the final response locally:

```sh
releashed report <run-id> --preparation /absolute/preparation-record \
  --cleanup /absolute/cleanup-receipt --timing /absolute/diagnostics/summary.json \
  --phases /absolute/phases.json --inspection "What the selected images actually show"
```

The command emits Markdown with every original image/date, distinct preparation and cleanup
links, readable local timing, and external phases/costs. `--json` returns the same Markdown and
structured references. It makes no browser, authentication or model call, and reporting a retained
run does not depend on its current reuse age. Broken selected images, missing/distinct-record
violations and wrong-run timing records are errors. Record presence does not certify their claims.

`phases.json` names `run_id` and the recorded ISO timestamps `request_started_at`,
`preparation_finished_at`, `capture_finished_at`, `cleanup_finished_at`. Its `costs` object has
nonempty `caller`, `capture`, `grounding`, `product` descriptions: an amount and basis when known,
otherwise explicit `unknown`. Record times as they happen. Report assembly precedes final-message
delivery, so it never invents that delivery timestamp or the unfinished caller's final bill.
The packaged capture skill describes the complete sequence.

### `releashed login <url>` — map what only a signed-in user sees

Opens a visible browser so **you** log in by hand. The cookies are saved on your machine, mode 600.
We never see a password, and the tool never signs in by itself. Then:
`releashed map <url> --login`.

**`--auth-cmd "<command>"` — for your own product, with no human at all.** If your backend can mint
a one-shot sign-in link for a test account you own (a Clerk ticket, a magic link, a signed
redirect), point us at the command that prints one and the run signs itself in:

```sh
releashed map https://app.example.com/home --mine \
  --auth-cmd "bun scripts/mint-sign-in.ts qa-persona"
```

The command runs with your environment and working directory, and must print **either** a sign-in
URL (we open it in a throwaway headless browser, wait until the page has left the sign-in flow, and
keep the cookies) **or** a session file of the same shape `releashed login` writes
(`{"schema_version": 1, ...}` on stdout). Anything else is an error. The session lands in
`./releashed/sessions/<host>.json`, mode 600, and the run proceeds exactly as `--login` does — it
still refuses to explore if the landing page is a sign-in page. `--auth-cmd` and `--login` are two
ways to do one thing: pick one. Use this only for a product you own; never for someone else's
credentials. `releashed explore-mcp <url> --auth-cmd "<command>"` takes the same flag.

### `releashed mcp <candidate-dir>` — give the map to your coding agent

```sh
claude mcp add flow-map -- releashed mcp ./releashed/maps/vision-prod-20260906T101500Z
```

Five read-only tools: `list_screens`, `find_screen` (search by what a user would call it, not by
id), `get_screen` (returns the screenshot as an image), `screen_edges` (every observed way into a
screen and out of it), `list_transitions`. Your agent can then answer "what does the user see after
they click Save" from evidence rather than from your codebase.

### `releashed diff <old-map-dir> <new-map-dir>` — did anything break overnight

```sh
releashed map https://app.example.com --mine   # tonight
releashed map https://app.example.com --mine   # tomorrow night
releashed diff releashed/maps/<tonight-id> releashed/maps/<tomorrow-id>
echo $?
```

```
3 screens gone, 1 new, 2 changed

Not reached this run (may be broken, or the walk simply did not visit them):
  - Checkout confirmation  https://app.example.com/checkout/done
  ...

Reached in both runs, evidence changed:
  - Pricing  https://app.example.com/pricing
  ...
```

Compares two `map.json` files (schema in `docs/map-schema.md`) and reports what changed: screens
gone, screens new, transitions gone, transitions new, and screens that were reached both times but
now look different. **The exit code is the interface**: `0` means nothing that existed before is
missing now (new screens or transitions appearing is not a failure — a walk that goes somewhere new
this time is doing its job); `1` means a screen or a transition that existed before is gone now. That
is the whole contract a nightly job needs. `--json` prints the same comparison as data.

A screen missing from the new map is not necessarily broken — two walks of the same product take
different paths, so it may simply not have been visited this time. The wording says so: a screen or
transition that disappeared is reported as "not reached this run", never as "broken", and only a
screen that both runs actually reached and that now looks different is reported as "changed".

Screens are matched across runs by address and title, not by id (an id is a per-run hash of what the
screen looked like, so it changes the moment the content does — useless as an identity). That gets
one thing wrong on its own: a title that legitimately varies night to night (a count, a name) reads
as one screen disappearing and an unrelated one appearing, rather than as a change to the same
screen. A product with day-to-day dynamic content (today's task list, a randomised exercise, a
rotating paywall message) will diff noisily for exactly this reason — see `docs/DECISIONS.md`.

### `releashed explore-mcp [<url>]` — let your agent be the explorer

```sh
claude mcp add releashed-explore -- releashed explore-mcp https://play.grafana.org
```

Same browser, same boundary, same evidence — but your agent supplies the eyes and the pixel
coordinate it sees, so it makes no separate model or grounding call. The coding agent's ordinary
inference and any product costs still apply. Four tools: `observe`, `act`,
`record`, `finish`. `releashed install-skills` installs the matching skills, including
`releashed-capture`, which checks retained evidence before starting a directed capture. Add `--mine` if you own the product, exactly as `releashed map --mine`
does: ordinary product use is allowed, pay/delete and billing/checkout/subscription/account-deletion
stay refused.

## What it will not do

- **It will not get past a wall.** A bot check ends the run and is written into the map as a
  finding; a login wall at the front door does the same, and tells you to use `releashed login`.
  There is no user-agent trick, no proxy, no back door.
- **It will not sign up or log in for you**, and it will not invent a value to get past a form. It
  types only what `--seed` gave it; anything else that looks like an email address, a phone number
  or a password is refused. `--login` exists so that a human does that part.
- **It will not send, post, pay or delete a stranger's product.** Those verbs are refused before the
  click, and the request boundary underneath refuses every mutating request to the product's own
  origin anyway. It cannot buy, book, message or destroy anything.
  **With `--mine`** (you own this product), ordinary product use is allowed — submitting an answer,
  posting a reply — because the request boundary now allows same-origin mutating requests too. It
  still never pays or deletes, and it still refuses anything billing-, checkout-, subscription- or
  account-deletion-shaped, however the instruction words it.
- **It will not leave the product.** One origin (plus any you `--allow`), inside your path globs.
  Off-site links are noted as doors not taken.
- **It will not keep your data.** Contact details are redacted out of the retained text **at capture
  time**, before anything is hashed, and the packager refuses to seal a candidate carrying anything
  credential- or PII-shaped. Screenshots still show whatever the page showed — pixel blurring is not
  in this version, so look before you share a map of a product with real data on screen.
- **It is not deterministic and it is not a test suite.** Two runs explore differently. A map is
  what was seen this time, and the evidence contract refuses to draw a transition nothing observed —
  so a bad run gives you a thin map, never a false one.
- **It does not promise complete coverage.** Nothing that walks a product from the outside can. What
  it did not reach is absent, and `map.json`'s findings say why.

## What comes out

A candidate directory, every file hashed into `manifest.json`:

```
map.html                     the map, standalone, screenshots embedded
map.json                     the same graph as data -- docs/map-schema.md
observations.jsonl           one line per observed transition: before, after, what was clicked
screenshots/                 every retained screen, at most 1280px wide
public-pack.json             what the product's own landing page says about itself, quoted
metrics.json                 tokens, cost in EUR, every request the boundary saw
production-run-report.json   how the run ended
```

## Licence and status

MIT. Early: the CLI and the two MCP servers work; the grounder swap, flow diffing against a previous
run, and anything hosted do not exist yet. Issues and pull requests welcome.

---

This repository is also the lab the tool was built in, so it carries more than the tool: see
[AGENTS.md](AGENTS.md) for how the lab works, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how
the pieces fit, [docs/CONTROL-SURFACE.md](docs/CONTROL-SURFACE.md) for what ships when, and
[docs/DECISIONS.md](docs/DECISIONS.md) for why each call was made.
