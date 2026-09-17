# Muse adapter

Optional setup for the [core capture skill](../../SKILL.md). Use only when the authorized caller
is Muse and needs this connection route; prefer native MCP if its installed version provides it.

Compatibility record — 9 September 2026: Muse Code 1.0.3 was locally probed for persistent PTY,
MCP initialize/tool discovery and native image opening. The path-only server was separately
verified with an installed-package local browser loop; this is not production acceptance.
The 9 September normal-profile Muse browser trial failed before page load with Chromium 1243
SIGSEGV; the cause remains unestablished. Handshake/image-tool checks do not certify browser
compatibility: require a successful local browser check before production, retain failures, and do not bypass permissions.
Check `muse --version`, `muse exec --help` and the current shell/image tool schemas before using
these flags. For another version, verify its local help and capabilities rather than assuming
these commands still apply. Retain any unsupported-flag or capability result with the attempt.

For a Muse coordinator, create a private empty vision directory and a private prompt file.
Give the prompt only the request, conduct policy, remaining action/time allowance, prepared
capture invocation with its verified product working directory, and the protocol/image-opening
instructions below. Do not include source, routes, preparation helpers or a navigation sequence.
From that empty directory start a fresh Muse process:

```sh
capture_client_exit=0
muse exec --workspace <private-empty-vision-directory> --trust-workspace \
  --no-foreign-personal-context --disable-web-tools --session-id <new-UUID> \
  --prompt-file <private-vision-prompt> --json \
  > /private/attempt/vision-result.pending.json 2> /private/attempt/vision-stderr.log \
  || capture_client_exit=$?
mv /private/attempt/vision-result.pending.json /private/attempt/vision-result.json
printf '%s\n' "$capture_client_exit" > /private/attempt/vision-exit.txt
```

Use the normal Muse profile; no permission overrides. This separates model context, but Muse
does not expose a capture-only tool allowlist. Audit the retained child activity for source reads
or unrelated browser tools before accepting the walk. Tell the child to return the complete
`finish` response, including `evidence_markdown`, `preparation_record` and `diagnostics_dir`.
Await the terminal result and retain these same three client artifacts before inspecting images,
stamping phases or cleaning up. Continue with the core skill's completion handling after reading
the terminal result.
Muse `--json` writes JSON Lines, even though the shared result filename ends in `.json`.
Inspect its terminal entry with `payload.kind == "run_terminal"` and `terminal == "completed"`;
its text is the child's final answer. A zero process exit or an early observation alone is not
proof of a completed capture. Retain errors and the actual complete finish response.

For the Muse vision child with persistent shell input and a native image reader, use the same
MCP server with `--image-output paths`. Start it once through `muse.bash` with `tty: true`;
a non-PTY shell can close stdin immediately. Retain the returned `session_id`. Use the verified
product working directory and the core skill's prepared capture invocation, adding only
`--image-output paths`.
The coordinator must start a fresh source-blind vision context; do not inherit preparation source.
Keep the server stderr and the complete exchange in the private attempt record.

Send these newline-terminated JSON lines through `muse.bash_input(session_id, chars, ...)`,
then wait for the matching response id before the next request:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"muse-capture","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

Tool discovery does not authenticate or open a browser. Confirm the four capture tools before
sending the first observation, which authenticates:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"observe","arguments":{}}}
```

The text content contains absolute `image_path`; open that exact original with
`muse.read_file(path)` before choosing coordinates. Preserve the accompanying relative
`screenshot_path` for `finish.goal_screenshots`. Path output omits inline base64 only; it
does not alter screenshot bytes, the action boundary or retained evidence. Continue with the
same `tools/call` form for `act`, `record`, and `finish`, using new ids and the discovered schemas.
JSON and terminal echo are not image inspection. Never start another server for each call.
Instruct the vision child to use only this protocol and native opening of its returned originals;
verify that constraint in its retained activity.

Retain and inspect the complete `finish` response. Finish closes the browser and local attempt
session files; then end stdin with EOF and wait for the process to exit. If cancelling, terminate
the server and wait for exit before the coordinator performs customer exact-session cleanup.
Keep the supplied browser-time allowance; `--steps` alone is not a wall-clock timer. A timeout or
cleanup failure is a failed attempt to report, not permission to restart authentication.
