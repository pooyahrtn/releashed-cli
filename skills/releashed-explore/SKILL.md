---
name: releashed-explore
description: Explore a deployed web product you know nothing about and turn what you see into a map of its user flows. Use when the user asks you to map, explore, or walk through a product's screens and journeys from its URL, or points at the releashed explore MCP server. Needs the `releashed-explore` MCP server (observe, act, record, finish).
---

# Map a product by looking at it

You are the eyes. The `releashed-explore` MCP server is the hands and the notebook: it drives a real
browser behind a request boundary, and it keeps the evidence that becomes the map. Nothing you
believe about the product counts; only what a screenshot showed and the server recorded.

## Run this in a subagent

Sixty screenshots do not belong in the user's main thread. Launch a subagent scoped to the
`releashed-explore` server and let it run the whole loop, then report back the map path and a
paragraph about what the product does. If you are already that subagent, just run the loop.

## The loop

1. **`observe`** — look at the screen. You get a screenshot, the current address, and how many steps
   are left.
2. **Decide from the screenshot.** One action a curious new user would try next and a short
   noun phrase naming it: the server points from your phrase on the bytes you just saw, so omit
   `coordinate`/`drop_coordinate` -- sending one is refused, never used as a fallback. Never a CSS
   selector, an XPath or an element id. A scroll says `direction: "up"` or `"down"` (with an
   optional pane point); each scroll is exactly 600 pixels. A locator miss dispatches nothing --
   rephrase the target or try a different control. (Only an explicitly legacy server without its
   own locator wants your pixel coordinate; the installed server refuses to start that way.)
3. **`act`** — hand over that instruction. It answers whether the screen changed and where you now
   are.
4. **`record`** — keep the transition. **An act you do not record never happened**: it is not in the
   map, and the map is the only deliverable. Record every act whose result you believe. To save a
   turn, combine keep-and-look: `observe` with `record_previous: true` keeps the pending transition
   and returns the already-cached new screen (the screenshot `act` just took, not a fresh capture).
   Standalone `record` then `observe` still works as a fallback.
5. Repeat until the step budget runs out or you genuinely have nothing new to try, then **`finish`**,
   which packages the evidence and renders `map.html`. Give it one sentence saying why you stopped.

## Keep your own history compact, in text

You will run out of context long before you run out of steps if you lean on the screenshots. After
each step write yourself one short line — `12: tapped "Dashboards" -> dashboards list, new page` —
and reason from that list. Do not re-read old screenshots; if you are unsure what is on screen, call
`observe` again. The current screen is the only picture you need.

## What to explore

In discovery mode, map the whole product. When one thing is finished, blocked, or repeating, find
a different kind of part through navigation visible on screen. In directed capture mode, keep the
given goal and conduct policy in view: stop when the requested destination is visibly reached and
recorded; do not turn a capture into a survey.

Prefer screens you can *do* something on — sign up, create, configure, search, book, buy — over
screens that only describe the product: documentation, blog posts, changelogs, help articles, legal
pages. Reading material tells you what the product claims; only an interactive screen tells you what
it does.

**Carry one of each kind of task all the way to its end before you move on.** A product's most
telling screens are the ones that only appear when something is finished: the result, the score, the
confirmation, the receipt, the "what next" it offers you afterwards. Opening a quiz and closing it
after two questions maps the door and never the room. So the first time you meet a kind of task,
complete it — answer every question, submit the form, reach whatever the product shows at the end —
and only then go looking for a different kind of task. Later examples of that same kind you may
sample and leave.

Prefer an address you have not visited over one that only redraws the address you are on. Opening a
tab or toggling a switch can change the picture completely and still be the same page. When an area
stops producing new addresses, backtrack to something you left untried elsewhere rather than
concluding the product is exhausted.

## The honesty rules — these are not negotiable

- **Never evade a bot check, a paywall or a login wall.** A wall is a finding. Record it and finish;
  do not look for a back door, a different user agent, an API, or a "test" route.
- **Never sign up or type credentials.** A stranger-mode server refuses contact details and passwords.
  For an owner's authenticated capture, the owner may start the server with their repository's
  supported `--auth-cmd` or an already saved `--login` session; this is bootstrap outside the walk,
  not a navigation step.
- **Never invent a value to get past a form.** A made-up email address is both a lie in the evidence
  and a push against a door we promised not to push.
- **Respect the action boundary.** Stranger mode is read-only. With explicit `--mine`, ordinary
  own-product actions may be allowed, while payment, deletion, billing, checkout, subscriptions,
  and account destruction remain refused. Do not work around a refusal; record it and finish.
- **Say what you saw, not what you assume.** If you did not see a screen, it is not in the map, and
  your summary may not claim it exists.
- Off-site links are not followed. The server puts the browser back where it was and tells you so;
  take that as a closed door and try something else.

## When you finish

For a directed capture, `finish` accepts `goal_reached: true` with ordered `goal_screenshots`
paths from `observe`/`record`. Select the requested evidence even if the walk continued afterward.
Only recorded images qualify. Without explicit selection, the compatibility claim uses the
current image; do not use that default when the goal was on an earlier screen.

Report three things to the user: the path of `map.html`, how many transitions were recorded, and a
short plain-English description of what the product does and which parts you could not reach and
why. Then tell them they can serve the finished map to any agent with `releashed mcp <candidate-dir>`.
