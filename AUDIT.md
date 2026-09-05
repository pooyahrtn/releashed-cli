# Audit

This repository was assembled fresh (no `.git` carried over) from the private `flow-map-lab` lab
repository, keeping only the shipping CLI, its library and renderer code, the skill, the tests, and
user-facing docs. This file records what was checked before the first commit.

## Every file, and why it's here

### Root

- `README.md` — install, usage, and refusal rules for a stranger.
- `LICENSE` — MIT.
- `package.json` / `package-lock.json` — the manifest and its lockfile.
- `.gitignore` — keeps `node_modules/`, `.env*`, and the CLI's own `./releashed` output directory
  out of git.
- `AUDIT.md` — this file.

### `bin/releashed.mjs`

The CLI entry point: `doctor`, `map`, `login`, `mcp`, `diff`, `explore-mcp`.

### `lib/` — library code the CLI and scripts import

- `auth-cmd.mjs` — runs `--auth-cmd` to sign a run in without a human.
- `ax-line-format.mjs`, `ax-visibility.mjs` — format/classify the accessibility-tree line the
  explorer and renderer read.
- `bounded-child.mjs`, `bounded-run-prep.mjs` — the sandboxed harness and config-builder for a
  bounded run against a product the runner owns.
- `browser-runtime-limits.mjs` — browser step/resource limits.
- `candidate-packager.mjs` — seals a run into `map.html` / `map.json` / `manifest.json`; contains
  the secret/PII scan gate that refuses to package anything credential- or PII-shaped.
- `clerk-auth.mjs` — Clerk sign-in ticket/token handling for the owner-authority auth path.
- `completed-owner-bundle-retirement.mjs` — retires a finished private "owner bundle."
- `explore-mcp.mjs` — the `explore-mcp` MCP server (`observe`/`act`/`record`/`finish`).
- `explorer-client.mjs` — the model client for the explorer's next-instruction call.
- `explorer-evidence.mjs` — builds `observations.jsonl` evidence records.
- `explorer-model-runtime.mjs` — model-call cap accounting for the explorer.
- `explorer-protocol.mjs` — the explorer's decide-loop and evidence contract.
- `explorer-supervisor-bridge.mjs` — bridges the explorer process to the browser/model brokers.
- `fresh-start-contract.mjs` — enforces a session starts from a clean, unauthenticated state.
- `gate-a-evaluation.mjs`, `gate-a-review.mjs` — scoring helpers exercised by `tests/`; no CLI
  entry point ships for these (kept because `lib/` was already a wholesale-include and nothing in
  them is target-specific).
- `map-diff.mjs` — implements `releashed diff`.
- `model-guards.mjs` — guards on model identity/pricing.
- `owner-bundle.mjs` — creates an immutable bundle of a run's private inputs.
- `public-pack-author.mjs`, `public-pack-fetch.mjs`, `public-pack-rebind.mjs`,
  `public-pack-runtime.mjs`, `public-pack-schema.mjs` — the public-pack (landing-page facts)
  pipeline `author-target-pack.mjs` and the packager use.
- `publish-map.mjs` — generic HTML/asset hashing and noindex-injection helpers (no publishing
  target baked in; the actual "publish to releashed.io" script was deliberately left out, see below).
- `run-limits.mjs` — the request/action boundary: refuses mutating requests off-limits verbs, and
  redacts contact details before anything is retained.
- `scaffold.mjs` — shared filesystem/hash/JSON helpers.
- `target-runtime.mjs` — builds and validates a target's runtime config from `--target-config`.

### `renderer/render-map.mjs`

Renders `map.json` + screenshots into the standalone `map.html`.

### `scripts/` — CLI-invokable pieces

- `author-target-pack.mjs` — authors a public pack for any target URL, from its landing page's own
  markup, no model call. What `releashed map` actually calls.
- `caption-screens.mjs` — writes each screen's caption.
- `capture-session.mjs` — `releashed login`'s browser-based cookie capture.
- `create-owner-bundle.mjs`, `prepare-target-run.mjs`, `prepare-bounded-onboarding-run.mjs`,
  `retire-completed-owner-bundle.mjs`, `rebind-public-pack.mjs` — thin CLI wrappers around the
  matching `lib/` function.
- `explorer-ruler.mjs` — deterministic, no-model scoring of a run's coverage.
- `map-mcp.mjs` — the `releashed mcp` server.
- `package-candidate.mjs` — CLI wrapper for `lib/candidate-packager.mjs`.
- `prepare-public-pack-run.mjs` — prepares a sandboxed public-pack-author run's config.
- `reconcile-recovery.mjs` — reconciles/cleans up an interrupted run's private custody files.
- `run-production-explorer.mjs` — CLI wrapper for `supervisor/explorer-session.mjs`.
- `trusted-control-probe.mjs` — a calibration probe for the sandboxed browser control.
- `vision-explorer-run.mjs` — the explorer loop `releashed map` actually runs.
- `vision-explorer-spike.mjs` — the underlying screenshot → instruction → grounding → dispatch
  loop `vision-explorer-run.mjs` imports.

Left out of `scripts/` on purpose (present in the lab, not here): `author-public-pack.mjs` (an
owner-authority tool that spends a model call and reads a Clerk secret key to author a pack for
one specific product the lab owns — not something a stranger's install should reach for),
`preflight.mjs`, `gate-a-review.mjs`, `grounding-offset-probe.mjs` (lab calibration tooling, one of
them naming a specific benchmark run against a personal target), `driver-spike.mjs`,
`signup-driver.mjs`, `cap-lock-probe.mjs`, and `publish-map.mjs` (publishes to the separate,
private `releashed-site` repo). `package.json`'s `scripts` block was trimmed to match.

### `supervisor/` — process brokers

- `browser-broker.mjs`, `browser-broker-process.mjs` — the Playwright-driving child process and
  its harness; what `vision-explorer-run.mjs` actually drives a browser through.
- `browser-profile-custody.mjs` — keeps a browser profile's private files off-limits.
- `clerk-bootstrap.mjs` — provisions/reconciles a disposable Clerk test identity for
  owner-authority runs.
- `explorer-session.mjs`, `target-session.mjs` — an earlier, macOS-`sandbox-exec`-based explorer
  path (not what `releashed map` runs; `vision-explorer-run.mjs` is). Kept because `supervisor/`
  was already a wholesale include and their own tests (dependency-injected, no real sandbox
  invocation) pass; `sandbox/` below exists to satisfy their real, non-test code path too.

### `sandbox/` — the macOS `sandbox-exec` children the two legacy brokers above spawn

- `explorer.mjs` — the sandboxed legacy explorer's own process.
- `public-input-integrity.mjs` — verifies fetched public-pack bytes match the frozen manifest.
- `target-isolation-preflight.mjs` — proves the sandbox denies file/network escape.

### `fixture/authenticated-target.mjs`

A local synthetic HTTP server (no external calls) used only by tests, standing in for an
authenticated product.

### `skills/releashed-explore/SKILL.md`

The skill `releashed explore-mcp` tells a coding agent to load.

### `docs/map-schema.md`

The `map.json` schema, linked from the README.

### `tests/` (54 files)

One test file per module above, kept in full — per the task, they're the clearest documentation of
the safety rules (what a read-only run refuses to type, what the request boundary blocks, what gets
redacted, what a bot/login wall does). Three changes were made to keep them free of anything
private (detailed below); everything else is unmodified. `npm test` runs all of them
(`node --test tests/*.test.mjs`).

## Test suite result

`npm install && npx playwright install chromium && npm test`: **853 passed, 0 failed**, run twice
to confirm. `tests/bounded-onboarding.test.mjs` (real Chromium) flaked once under full-suite load
and passed on retry and alone, exactly as expected — this is the flake the task description
pre-warned about. `tests/fresh-auth-boundary.test.mjs`'s reseal test was checked standalone too and
passed cleanly.

## Changes made to remove private references (not just omissions)

1. **A hardcoded default target.** `scripts/vision-explorer-run.mjs` had a "no `--target-config`"
   fallback that pointed at one specific real product the lab owns (`app.inburgering.coach`) and a
   packaged profile of it under `packs/`, which is exactly the kind of run artifact the task says
   must never ship. Checked and confirmed this fallback is **dead code for the shipped CLI** —
   `bin/releashed.mjs`'s `map` command always passes `--target-config`. Removed the fallback
   entirely (`resolveTarget` now throws asking for `--target-config` instead of defaulting), and
   rewrote the two `tests/vision-explorer-target.test.mjs` tests that exercised it to use a
   generic `cal.com`-shaped config fixture instead.
2. **A real, hardcoded local username in two file paths.** `scripts/reconcile-recovery.mjs` and
   `scripts/trusted-control-probe.mjs` both had `defaultOwnerDirectory` hardcoded to
   `/Users/[REDACTED]/Projects/flow-map-lab-private/spike-a`. Replaced with
   `resolve(repository, "../flow-map-lab-private/spike-a")`, matching the pattern already used in
   `scripts/prepare-target-run.mjs`. No behavior change, no username on disk.
3. **A real third-party small business's contact details in a test fixture.**
   `tests/vision-explorer-readonly.test.mjs` had a redaction test using an actual email address and
   phone number the lab captured from a real business's OpenStreetMap listing during a real run
   ("the exact values that made a complete OpenStreetMap candidate unpackageable"). Replaced with
   an `example.test` email and a `555-` fictitious-exchange phone number; the test still exercises
   the same redaction regexes.
4. **One whole test file removed.** `tests/public-pack-cli.test.mjs` tested only
   `scripts/author-public-pack.mjs` (the owner-authority, model-calling, Clerk-secret-reading tool
   named above, not shipped). Deleted rather than ported, since porting it would mean either
   shipping that tool or faking coverage of a feature that isn't here.
5. **One test file's fixture replaced with synthetic data.** `tests/map-mcp.test.mjs` loaded a real
   run artifact, `artifacts/vision-prod-20260904T201637Z-described/`, containing real screenshots
   and captions from a real product (51 real screens, real titles, a real URL). `artifacts/` is
   exactly what the task says must never ship. Rewrote the file to build a small synthetic
   candidate directory (in a temp dir, at test time) with invented screens/transitions that
   exercise the same code paths — ranking by query terms, a screen left twice, screenshot resizing,
   unknown-id errors — and updated every assertion to match the synthetic data instead of deleting
   coverage.

## Secrets and key scan

Searched every file for `sk_`, `sk-ant-`, `re_`, `AIza`, `ghp_`, `-----BEGIN`, `xox`, `api_key`,
`password`, `secret`, `token`, and any 32+ character random-looking run. Result: **no real secret
values found.** Every `sk_test_...` / `sk_live_...` / `apiKey` occurrence is either:

- a reference to an **environment variable name** the tool reads at runtime (`ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, `CLERK_SECRET_KEY`, `SPIKE_EXPLORER_API_KEY`) — never a value, e.g.
  `bin/releashed.mjs:396`, `scripts/vision-explorer-run.mjs:464-478`; or
- a **self-labeled fixture placeholder** in a test, e.g. `tests/owner-bundle.test.mjs:15`
  (`sk_live_fixture_never_output`), `tests/clerk-session-lifecycle.test.mjs` (`sk_test_private`,
  repeated) — these tests exist specifically to prove such values never appear in retained output.

One item flagged for awareness rather than removed: `tests/vision-explorer-boundary.test.mjs:30`
uses `sess_[REDACTED, Clerk-session-id-shaped]` as input to a path-masking test
(`maskOpaqueIds`). It reads as a synthetic, hand-typed example (the surrounding fixtures in the same
file are openstreetmap.org paths and made-up ad-tracker ids), not a captured real session id, but I
did not independently verify that — flagging it so the owner can look once. `package-lock.json`'s
base64 strings are ordinary npm package integrity hashes, not secrets.

## Personal data and third-party reference scan

- **Real email addresses / personal names**: none found besides the author's own name in
  `LICENSE` (expected for an MIT license) and `git commit` authorship. Test fixtures use
  `@example.com` / `@example.test` throughout, plus two references to `support@cal.com` /
  `someone-else@cal.com` (cal.com's own public support address, used as a realistic-looking test
  value — same treatment any OSS test suite gives a well-known public company).
- **A real third-party business's contact details**: found and removed — see item 3 above.
- **Company names from outreach research**: none found. `docs/outreach/`, `docs/BUSINESS.md`, and
  every other lab-only doc were never copied.
- **URLs of products the lab walked, used as realistic test examples**: `cal.com`, `booking.com`,
  `openstreetmap.org`, `brandfetch.com`, `play.grafana.org` appear in tests, comments and the
  README as illustrative URLs (a `POST /checkout/confirm` to test the money-verb refusal, a
  `brandfetch.com` comment explaining why a hard `networkidle` wait was dropped). These are the
  ordinary "here's a realistic-looking domain" test data any HTTP-handling test suite uses — no
  screenshot, scraped content, or commentary about any of them is included. Flagging `brandfetch.com`
  specifically since the comment does describe real observed behavior of that real site; low risk,
  but the owner may want it genericized too.
- **The one real product name and its real captured content** (`inburgering.coach`, and the real
  screens/captions describing it): removed from the shipped code path and its test fixture — see
  items 1 and 5 above. It still appears as an ordinary-looking example URL in a handful of other
  tests' fixture data (`tests/public-pack-author.test.mjs`, `tests/public-pack-runtime.test.mjs`,
  `lib/public-pack-fetch.mjs`'s unused frozen-fetch-policy constants) where it is only ever used as
  a URL string in synthetic JSON, never with any of its real page content. Left in place as low-risk;
  flagged below for the owner's own call, since it is a real domain.

## For the owner to decide

- Whether `inburgering.coach` should be scrubbed from the remaining handful of test-fixture strings
  and from `lib/public-pack-fetch.mjs`'s frozen-policy constants (unused by anything the CLI ships,
  but still names it) — I judged this low-risk since no real page content travels with it, but it is
  your domain to decide about, not mine.
- Whether the `brandfetch.com` behavior comment (`scripts/vision-explorer-run.mjs`,
  `tests/vision-explorer-public-entry.test.mjs`) is fine as public engineering commentary or should
  be genericized.
- The `sess_...`-shaped test value in `tests/vision-explorer-boundary.test.mjs:30` — I believe it's
  synthetic but did not independently verify against your Clerk logs.
- `README.md`'s "measured: 8 of 8 controls" and "roughly EUR 0.50 / EUR 1.00" cost figures were
  carried over verbatim from the lab's own README, which is where the shipping tool's already-public
  facing copy lived; I did not re-derive them from a run record myself, since the lab's other run
  logs (where that derivation would live) are exactly what this exercise keeps private. Worth a
  quick gut-check that they still hold before this goes out.

## Ruled on before publishing (2026-09-06)

- The Clerk-session-shaped test value was replaced with an obviously fake one.
- The author's own product name was removed from code comments and from the refusal test.
- The `brandfetch.com` behaviour comment was generalised; no third party is named in the code now.
- **One deliberate exception:** `lib/public-pack-fetch.mjs` pins its "sole approved public source" to
  the author's own site, and two tests assert that rule. It is a rail from an early spike, unused by
  `releashed map`, and the rule is only meaningful to its author. It stays as is rather than being
  loosened, because weakening a safety rail to tidy a repo is the wrong trade. A later cleanup should
  delete that pipeline from this package rather than re-point it.
- The README's cost and grounding numbers come from the author's own recorded runs; the grounding one
  now says plainly that it was a small probe.
