# releashed

Point it at a deployed web product and it comes back with a map of that product's user flows —
every screen it saw, every transition it actually observed, each one backed by a screenshot.

No source code, no database, no test ids, no list of journeys. It looks at the screen the way a
person would, decides the next thing to try in plain English, clicks it, and looks again.

**See one first:** https://releashed.io/m/e78f288edb489316/flow-map.html — a real product, mapped
this way, nothing hand-written.

## Install

Needs Node 22 or newer. Not on npm yet, so install it from a clone of this repository:

```sh
cd releashed            # wherever you cloned it
npm install
npx playwright install chromium
npm link                # puts `releashed` on your PATH
releashed doctor        # do this first
```

`doctor` makes one one-token model call and tells you whether your keys work, whether the balance is
actually positive, and whether Chromium is installed — the two-minute check that saves an evening.

Everything below also works without `npm link`, as `node bin/releashed.mjs <command>`.

## Keys

Export both, before you run `map`:

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # decides what to try next, from the screenshot
export GEMINI_API_KEY=...             # points at the control you named
```

Both keys stay in your own shell environment. Nothing here reads them for any purpose but the two
calls above, nothing logs them, and nothing sends them anywhere but Anthropic's and Google's own
APIs.

`npx releashed doctor` (or `releashed doctor` after `npm link`) checks both are set and actually
work, plus that Chromium is installed, before you spend anything on a real run.

**Two keys is one too many and we know it.** Anthropic's own model can point at a control accurately
(measured: 8 of 8 controls, all inside the real element), so the second key goes away when that swap
lands. Until then the browser-automation library we use has no Anthropic grounding family, and we
would rather ask you for a second key than pretend one model is doing both jobs. A 60-step map costs
roughly EUR 0.50 on Sonnet or EUR 1.00 on Opus, on your key, plus a fraction of a cent for the
pointing. `--budget` caps it.

## The commands

```
releashed doctor
releashed map <url> [options]
releashed login <url>
releashed mcp <candidate-dir>
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
| `--steps N` | Actions the run may take, 1–60, default 40. |
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

Everything lands under `./releashed` in the directory you ran it from. Nothing is uploaded, and
nothing phones home: **no telemetry, at all.**

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
rotating paywall message) will diff noisily for exactly this reason.

### `releashed explore-mcp [<url>]` — let your agent be the explorer

```sh
claude mcp add releashed-explore -- releashed explore-mcp https://play.grafana.org
```

Same browser, same boundary, same evidence — but your agent supplies the eyes, so it costs no model
key of ours and no spend of yours beyond your own subscription. Four tools: `observe`, `act`,
`record`, `finish`. Copy `skills/releashed-explore/SKILL.md` into your `.claude/skills/` and the
agent knows how to run the loop, including the honesty rules below. (The pointing key is still
needed here too, for now.) Add `--mine` if you own the product, exactly as `releashed map --mine`
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

## Running the tests

```sh
npm install
npx playwright install chromium
npm test
```

`npm test` runs `node --test tests/*.test.mjs` — plain Node's built-in test runner, no framework.
The tests are the clearest description of the safety rules above: what a read-only run refuses to
type, which requests the request boundary blocks, what gets redacted before anything is retained,
what a bot wall or a login wall does to a run. Two of them drive a real, visible-if-you-remove-
headless Chromium instance (`bounded-onboarding.test.mjs` and the fresh-auth-boundary reseal test in
`fresh-auth-boundary.test.mjs`) and can occasionally flake when the whole suite runs under load on a
busy machine; they pass reliably run alone (`node --test tests/bounded-onboarding.test.mjs`).

## Licence and status

MIT. Early: the CLI and the two MCP servers work. The Anthropic-only grounder swap mentioned above
and anything hosted (a dashboard, a scheduler) do not exist yet. Issues and pull requests welcome.
