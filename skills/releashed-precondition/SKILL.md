---
name: releashed-precondition
description: Arrange and declare starting state for an owner's aimed releashed capture using the customer's existing fixture, seed or admin tools. Use for flows that require prior activity, elapsed time or a backend condition. Does not seed the destination or supply routes to the walker.
---

# Arrange the starting state, then let the walk reach the screen

Work in the customer's repo. A capture takes `--goal` and optionally `--policy`; its setup belongs
in `--precondition`, which is retained as provenance and is not given to the walker. This skill
does not apply to source-blind discovery.

## Establish what must already be true

Identify the target environment, the authorized test identity and the state needed before the
flow starts. Use an opaque, nonsecret identity label consistently across runs. A session filename
or persona name alone does not establish which account is signed in or what progress it has.

Search the repo's fixtures, seeds, admin commands and existing capture helpers. Read their scope
and verification paths before invoking them. Reuse the supported mechanism for that environment;
do not invent a production write path from a staging example. Existing authorization determines
which setup actions you can perform. Resolve a missing account or environment choice before
changing product state. Keep credentials and raw query results in the customer's secret/private
storage, never in releashed artifacts.

Use the request's acceptance contract to distinguish prerequisites from the destination. A short
prepared capture may arrange supported prior activity, but must leave the real final trigger to
the browser; never fabricate the destination, completion receipt or claimed transition. Declare
what was prepared rather than claiming the walk performed it. Yesterday's eligible activity may
prepare a next-day campaign; the browser must still reach and open the real campaign.

## Arrange and verify

Use the smallest scoped setup that supplies the missing precondition. Check it through the
customer's API or database using existing read paths, independently of the walk. Record a short
nonsecret summary: environment, identity label, what was changed or already present, what was
checked, when it was checked, and when it expires (including timezone). Verify account state,
not merely that the setup command exited successfully.
Check current entitlement and whether a once-per-day destination was already consumed. Prefer an
eligible authorized account over resetting consumed state. Record any task-created access and its
cleanup command; revoke it and verify removal after success or failure, preserving real progress.

Time-dependent flows may also depend on eligibility, a background job and delivery state. A past
exercise row does not by itself prove a campaign exists. Check those prerequisites in the customer
repo. If a required count is not met, record that gap instead of weakening the requested condition.
For a pending job, establish whether the capture needs in-product availability or actual delivery;
use the normal processing path when it can meet the capture window. A fake clock must be scoped to
the authorized test environment; a browser clock change does
not advance the backend. Do not trigger real messages to other people as a side effect of setup
without explicit authorization. If the environment cannot arrange the state, report the missing
condition and the existing tool or job that owns it.

## Declare and capture

Supply the setup summary as `--precondition` and the opaque account label as `--identity-label`.
When earlier capture evidence supports it, include `run <run-id>` in the declaration and keep that
run available under the same releashed output root. The command checks that the referenced record
exists; it does not verify the truth of the declaration. Include the actual setup check and its
lifetime even when referencing a run.

Use the customer's existing programmatic login; `releashed-setup` in this skill bundle describes
the `--auth-cmd` contract if it has not been configured. Run inside the verified lifetime, with
the intended goal, policy, step limit and remaining spend budget. Source inspected for setup must
not enter the walk as journey hints, selectors, destination imagery or a click sequence.

For an interrupted same-day capture, `--continues <run-id>` only records a relationship. Reuse the
same account, goal and policy, and confirm the relevant state still exists; the flag does not
restore a browser or validate persistence. Do not conflate that with a next-day precondition.

Read the resulting `get_flow` provenance and inspect its claim screenshot. `goal_claimed` is the
walker's statement, not independent verification. Report the artifact/run reference, declared
setup, what the screenshot actually shows and any condition that remained unmet. Never edit a
sealed candidate to add the declaration afterwards; pass it before the run is packaged.
