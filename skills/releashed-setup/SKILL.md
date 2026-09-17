---
name: releashed-setup
description: Set up a signed-in walk of a deployed product without a human at a browser — find the repo's own programmatic login, wrap it as the `--auth-cmd` command, verify it, and pick the identity the flow you want actually needs. Use before `releashed map` or the `releashed-explore` MCP server on any product behind a sign-in wall, or when a run stops at a login screen, a paywall, or an empty account.
---

# Sign the walk in, using the repo's own login

A map of a signed-out product is a map of its front door. Everything worth photographing is behind
the wall, and `releashed login` means a human in a browser window before every run — which is the
thing this tool exists to remove.

Almost every repo with end-to-end tests already mints sessions programmatically. **Your job is to
find that, wrap it, and check it — not to write a new login and not to ask the user for a password.**

Reading source to sign in is allowed and always has been. Reading source to learn journeys is not:
nothing you discover here may tell the walk where to click. Login only.

## 1. Find the login that already exists

Search the repo before writing anything. It is usually in end-to-end tests, screenshot/capture
scripts, or a post-deploy smoke check:

```
rg -l "sign_in_token|signInToken|createSession|magic.?link|loginAs|storageState|setSession" \
   --glob '!node_modules'
rg -l "clerk|supabase|next-auth|auth0|firebase" --glob '!node_modules' -i
```

Then look in the obvious places: `e2e/`, `tests/`, `scripts/`, `server/scripts/`, `.github/workflows/`
(CI has to sign in headlessly too, so its recipe is usually the honest one).

**If you find a script that already mints a session, you are done searching. Use it.** Do not write a
second one. A repo that captures screenshots nightly has already solved every hard part.

## 2. The contract `--auth-cmd` expects

`--auth-cmd "<command>"` runs the command and reads **stdout**, which must be exactly one of:

- a **one-shot sign-in URL** the browser can redeem, or
- a **`schema_version`-1 session file** (a saved cookie jar).

Nothing else on stdout. All logging, progress and warnings go to **stderr**. If the command prints a
banner before the URL, the run fails on the banner.

The session file's fields are defined in `supervisor/target-session.mjs` in the releashed repo — read
it if you ever have to write one from scratch. Usually you do not: if the repo mints a session
anywhere already, imitate that instead.

Prefer printing the **session** over the URL when the sign-in link points at a hosted account portal
(Clerk's `accounts.*`, Auth0's `*.auth0.com`). Those portals often sit behind a bot check that a
fresh automated browser never clears, and **a bot check is a finding, not an obstacle — never try to
get around one.** The app's own domain usually has no such check.

## 3. Two things that waste an hour if you miss them

**The working directory.** `--auth-cmd` runs in the directory the `releashed` command was invoked
from, not the repo root. A relative path like `bun scripts/x.ts` fails with a bare "Module not found"
if you ran from a subdirectory. A failure now names the directory it ran in — read that line. Use a
path that works from where you will actually run, or an absolute one.

**The key it needs.** A test/dev key often *silently* mints something unusable rather than failing —
sign-in tokens come back empty and the walk lands on a login page with no error. If the repo's script
distinguishes live from test keys, respect that. If it does not, check which key you are handing it.

## 4. Pick the identity the flow needs

This is the step that quietly wrecks runs. A valid session is not enough — the account must be able
to *reach* the screens you want.

Before running, ask what state the flow requires and confirm the account has it:

- **Access level.** A free account on a metered product hits the paywall partway in, and you get a
  map of the wall instead of the flow. If the flow sits past a limit, the identity needs full access.
- **Progress state.** "Finish today's tasks" needs an account with tasks still pending; "returning
  user" needs one with history. A brand-new account cannot reach either.
- **State drift — check the label against the account, not the roster.** A persona called
  `fresh-signup` is a claim made on the day it was written, and persistent test accounts age: a
  nightly job, an earlier walk, or a colleague may have walked it forward months ago. The roster will
  still say "fresh". **Confirm the current state before you spend a run.** The cheapest check is
  where the sign-in actually lands — an account that still needs onboarding gets redirected into it,
  one that lands on the logged-in home has already finished. If the landing page disagrees with the
  label, believe the landing page. Select or prepare an eligible test account through supported
  helpers within existing authority; identify missing authority only when it is actually needed.
- **Feature flags.** A flow behind a flag that is off for this account does not exist for this
  account. Check the flag's live value rather than assuming.

If the repo has a roster of test personas (a `personas.json`, a `--list` flag, a seed script), read it
and choose deliberately. Say in your report which identity you picked and why.

## 5. Verify before you spend a run

```
releashed install-browser             # once; uses Releashed's installed Playwright version
<your auth command>                   # prints a URL or a session, and nothing else, on stdout
```

For caller-coordinate MCP capture, do not run `releashed doctor` as a prerequisite: it checks the
separate API-driven `map` path and makes paid key checks. Use it only before that API-driven path.

Then a short real check: start the walk and confirm the first screenshot is a signed-in screen, not a
login page. A 60-step run that was signed out for all 60 steps costs real money and proves nothing.

## 6. Wrap it up for next time

Once it works, write the command down where the next agent will find it — a line in the repo's
`AGENTS.md`/`CLAUDE.md`, or a short script of its own. (Working read-only on this repo? Skip this
step and put the command in your report instead.) The point is that nobody re-derives this.
**Never commit a key, a token, a cookie jar or a password.** The command should read its secret from
the environment or the repo's existing secret store, the same way the script you found does.

## Recipes

**Clerk.** Create a sign-in token with the backend API (`POST /v1/sign_in_tokens`, `sk_live_…`), then
redeem it *in the page* with the JS SDK's ticket strategy and export the cookie jar. Do not send the
browser to the hosted account portal. An `sk_test` key silently returns nothing usable on a
production instance — refuse it outright rather than debugging a blank page.

**Supabase.** `auth.admin.generateLink({ type: 'magiclink' })` with the service-role key, then redeem
the link on the app's own origin. Or sign in with a seeded test user and export the session.

**NextAuth.** Sign a session JWT with `NEXTAUTH_SECRET` and set it as the session cookie directly;
this is what most NextAuth e2e suites already do.

**Auth0.** Resource-owner password grant against a dedicated test connection, or a seeded user plus a
programmatic login endpoint the app already exposes for its own tests. Avoid the universal login page.

**Firebase.** `admin.auth().createCustomToken(uid)`, then `signInWithCustomToken` in the page and
export the resulting session.

## Never

- Evade a bot check, CAPTCHA, or rate limit. A wall is a finding; report it and stop.
- Use credentials belonging to a real end user, or any account you were not given for this purpose.
- Put a secret in the map repo, in a run artifact, or in your report.
