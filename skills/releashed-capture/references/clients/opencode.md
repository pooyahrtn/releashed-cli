# OpenCode adapter

Use only when OpenCode is the authorized capture client. Muse accessed as a model through
OpenCode uses this adapter; it is a different client from Muse Code. Preserve the owner's
chosen provider/model. Check `opencode --version`, `opencode run --help` and
[native MCP configuration](https://opencode.ai/docs/mcp-servers/) against the installed version.

Verified locally on 9 September 2026 with OpenCode 1.18.30 and the owner-authorized
`opencode/muse-spark-1.3-contributor-free`: native stdio discovery, inline screenshot inspection,
act/record/finish and a complete final response from a real installed-package browser loop.
The caller recovered from initial record/finish ordering errors on the same instance.
This local fixture establishes client compatibility, not production acceptance.

Create a private vision directory outside the product repository and preparation context.
Place an attempt-local `opencode.json` there, using OpenCode's `mcp` schema:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "releashed_capture": {
      "type": "local",
      "command": ["/absolute/node", "/absolute/installed/releashed", "explore-mcp", "https://app.example.com", "--mine", "--auth-cmd", "<supported login command>", "--goal", "<request>", "--policy", "<conduct policy>", "--identity-label", "<opaque label>", "--precondition", "<nonsecret preparation summary>", "--steps", "<bounded steps>", "--acquire-until", "<absolute ISO cutoff>"],
      "cwd": "/absolute/verified/product/worktree",
      "enabled": true
    }
  }
}
```

The server's `cwd` binds authentication and shared memory to the actual product worktree;
the client's `--dir` keeps its fresh context apart. Use the installed executable and runtime.
If that installation uses a dedicated Playwright browser directory, supply its verified
`PLAYWRIGHT_BROWSERS_PATH` in this server entry's `environment` object. Do not copy a browser
revision or machine path from another installation without checking compatibility.
Keep default inline image output so native MCP can deliver the screenshot directly.
Do not add path-only output unless the client's native original-image reading is already verified.

Run `opencode mcp list` from the vision directory before authentication and confirm this
dedicated instance connects. This discovers tools without logging in; the first `observe`
authenticates. The core skill's doctor accepts `mcpServers`, not this OpenCode schema:
if using that check, derive an equivalent private `mcpServers` record with the identical
command, arguments, cwd and environment, and separately verify OpenCode's actual connection.

Start a fresh client once, without `--continue`, `--session`, or `--fork`.
Do not add `--auto`, blanket permission grants, or security overrides to this launch:

```sh
opencode run --dir <private-vision-directory> --model <authorized-provider/model> \
  --format json '<request, conduct policy, remaining allowance and capture handoff only>'
```

Derive `--acquire-until` from the original request deadline minus a finish/seal/cleanup
reserve (for example 90 seconds), and pass that absolute ISO timestamp to the capture
server. It is an absolute wall-clock cutoff, not elapsed time since browser startup:
preparation and authentication count against it and never reset it. The cutoff limits NEW
INPUT, not client lifetime: keep the child execution alive after the cutoff so it can
`record`, `finish` and seal. After it passes the server refuses new `act` (including
`wait`) before dispatch but still allows a pending `record`, `observe` for necessary
current evidence, and `finish`/seal/cleanup. Actions already in flight when the cutoff
passes may finish so a started gesture is not stranded; only new dispatches refuse. An
expiry before the first `observe` starts no login, and an expiry after authentication
starts no browser; end that attempt honestly within the original outer deadline without
resetting the cutoff or reserve. The existing outer supervisor deadline still applies
unchanged.

Derive the child shell timeout from the original outer deadline minus an explicit caller
inspection/cleanup/final reserve, and compute the remaining time (child hard stop minus
now) at launch: never a fixed timeout, never reset from preparation. The child hard stop
MUST be later than the acquisition cutoff, never at or before it. For example, with a 600s
outer deadline: acquisition at 450s, child hard stop at 510s, 90s caller reserve — 60s
child seal plus 90s caller work, 150s protected reserve in total. If too little time remains
before authentication, stop honestly instead of launching. After the cutoff, never kill the
child merely for reaching it: it records any pending act, then calls `finish`
(`goal_reached: true` only for a screen actually observed, otherwise `false`).

Tell it to use only the prepared capture tools, inspect returned images, and return the entire
`finish` response, including `evidence_markdown`, `preparation_record`, `diagnostics_dir`,
selected originals and dates. Do not give it preparation source or navigation instructions.
Its tool loop is mandatory: `observe` → `act` → `observe({record_previous:true})` for every
executed action (waits and no-change results included), then choose the next action from that
returned image. This explicitly saves the transition and returns the cached view, without a
second `observe`. Standalone `record` then `observe` remains a fallback. While `unrecorded_act`
is true, keep the pending transition before any new `act`.
`observe` also reports `acquire_until`/`acquire_ms_left` when a cutoff was configured:
stop dispatching new `act` before the cutoff so `record` and `finish` still fit.
If `finish` rejects `goal_screenshots` (unknown, duplicate, or out-of-order), the run is
retained: retry `finish` on the same instance with corrected recorded ordered unique refs,
without abandoning the originals. No silent dedupe and no stale-current substitution.
An empty directory does not remove global client configuration or enforce a tool allowlist:
inspect discovery and audit retained activity; describe this as instructed context separation.
Use normal permissions. A denied tool or external image read ends that route; retain the
failure, without relocating denied resources or changing security settings to make it pass.

## Bounded visual history (dedicated vision sessions only, OpenCode 1.18.30)

Tested only on OpenCode **1.18.30** (`opencode --version` must print it). Other
versions are untested: do not assume the hook or the serialization below.
Unfamiliar payloads fail closed with a `visual-history refused` diagnostic;
end that attempt honestly instead of working around it.

The repo ships an opt-in file plugin, `lib/opencode-visual-history.mjs`
(built from `lib/opencode-visual-history.ts` by `npm run build`; pure logic
in `lib/visual-history-filter.mjs`). The entry module exports ONLY its
default plugin function: the 1.18.30 loader calls every function export as a
plugin and throws on any non-function export, so the split is load-bearing.
Keep that sink path stable. It caps the
OUTBOUND model request at 8 image attachments of any kind, omitting older
prunable screenshots in one batch to retain the latest 2, with a per-session
omission ledger so pruned images never reappear on resume, retry or
compaction. Only flat `FilePart` attachments are understood (nested provider
output is built downstream from them); nested structures refuse explicitly.
Archive, stored conversation, text, tool pairing, reference IDs and retained
image bytes are untouched; permanent goal/conduct travel in the system
prompt, which the hook never sees. Partial configuration (exactly one of the
two variables below) refuses instead of silently disabling. Pure offline
tests: `node --test
tests/opencode-visual-history.test.mjs`.

Scope it to the private vision directory only. Never add it to a global or
editor OpenCode config. In the attempt-local `opencode.json` beside the `mcp`
entry above:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/repo/lib/opencode-visual-history.mjs"],
  "mcp": { "releashed_capture": { "type": "local", "command": [], "enabled": true } }
}
```

The plugin is a no-op unless BOTH environment entries are absolute paths in
the vision process (the MCP server entry's `environment` is a suitable
scoped place; never export them globally):

- `RELEASHED_VISUAL_HISTORY_DIR`: dedicated per-session ledger directory
  (created if missing; holds one `<sessionID>.json` omission ledger outside
  the stored conversation).
- `RELEASHED_VISUAL_HISTORY_SCREENSHOT_ROOT`: absolute fixture/capture
  screenshot root. Native read attachments carry no filename (verified
  read.ts: only `{type:'file', mime, url:'data:...'}`), so root scoping comes
  from the parent read `state.input.filePath`, else from our own observe
  output text (`screenshot_path`/`image_path`); images outside it are
  preserved, never counted, and provenance-less images refuse explicitly.

Two paths bypass the hook, so both are mandatory launch controls:

- Always pass an explicit non-default `--title` to `opencode run`: the
  first-step title call converts the first user context WITHOUT the hook and
  bills a real model call.
- Keep the initial ask text-only (no `-f/--file` attachments): arbitrary
  initial user attachments are not covered by the plugin-alone claim.
  A non-screenshot user image in the main loop is preserved by the filter;
  anything image-bearing but unfamiliar refuses explicitly.

Mutation contract the request-sink proof must show: the hook splices filtered
clones into the SAME `output.messages` array in place (assigning
`output.messages` alone has no effect: the runner converts the original array
reference), while all original nested stored records stay deep-equal.

Retain stdout JSON Lines, stderr, the actual client session ID and terminal exit status privately.
Supervise the returned execution handle until terminal, with the remaining wall-clock allowance
computed at launch (child hard stop minus now); `--steps` limits actions only. Never end the
child merely for reaching the acquisition cutoff: it stays alive to record, finish and seal,
and the parent supervises it through its terminal result before cleanup, inspection and the
final report. On cancellation, ensure the client and its capture server stop
before exact-session cleanup. Read all error/tool events and the final text: process exit zero
or a `step_finish` event alone does not establish a finished capture. Recover the complete
`finish` tool result -- a blocked NOT-reached finish is also complete -- and verify its returned
originals before the core skill's phase
stamps, cleanup and unchanged final report. Use only the fields that result already returned;
do not re-read the candidate directory, map, or preparation record from the filesystem to
reconstruct them. Keep usage and unknown costs alongside the result.
