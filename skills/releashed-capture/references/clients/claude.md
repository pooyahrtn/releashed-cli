# Claude CLI adapter

Optional setup for the [core capture skill](../../SKILL.md). Use only when the authorized caller
is Claude CLI and needs a fresh configured connection; prefer already available native MCP tools
when the caller also meets the core source-separation contract.

Compatibility record — 9 September 2026: this is the existing documented route, not freshly
retested today. Its tested CLI version is not recorded here. Check `claude --version` and
`claude --help` locally before using the flags; verify changed versions against that help and
retain unsupported-flag or permission failures. Do not infer compatibility from this example.

Use a private empty working directory for the fresh vision process when the coordinator read
product source. Bind the prepared server to the verified product working directory through its
launch configuration; never put source or preparation instructions in the vision prompt.

For a Claude CLI caller, write the attempt's private MCP JSON and start a **new client process**
with it. Registering a server with `claude mcp add-json` does not give an already-running client
its tools. An unavailable tool in that old client is a client-binding problem; it does not require
another login or an owner restart. For an entry named `releashed-capture`, the fresh vision process is:

```sh
capture_client_exit=0
claude -p --mcp-config <private-attempt-mcp.json> --strict-mcp-config \
  --tools '' --permission-mode dontAsk \
  --allowedTools 'mcp__releashed-capture__observe,mcp__releashed-capture__act,mcp__releashed-capture__record,mcp__releashed-capture__finish' \
  --append-system-prompt 'Return the complete finish result, including evidence_markdown, preparation_record and diagnostics_dir. Preserve its paths and capture timestamps exactly.' \
  --output-format json -- '<goal, conduct policy, and remaining action allowance only>' \
  > /private/attempt/vision-result.pending.json 2> /private/attempt/vision-stderr.log \
  || capture_client_exit=$?
mv /private/attempt/vision-result.pending.json /private/attempt/vision-result.json
printf '%s\n' "$capture_client_exit" > /private/attempt/vision-exit.txt
```

Run that complete block once, with new paths in the attempt's private directory. The exit file is
written only after the client exits; a partial result file or first browser observation is not
completion. If your execution tool yields a session or cell ID, retain its returned object and poll
that ID until completion. Preserve the returned result as well as the execution handle.
Do not start a replacement client, revoke its session or perform cleanup while the client is still
running. An intentional cancellation must end the client before cleanup begins.

Read `vision-exit.txt`, the complete `vision-result.json` and any error log before deciding the
outcome. A successful child result may arrive after an early tool yield. Look up its returned run
and inspect the retained selected images before reporting that capture failed. Keep these client
records alongside the preparation and cleanup evidence, including failed attempts.

The documented `--output-format json` result must contain the child's final answer with the
complete finish response. Read the full result and any permission/error fields, rather than
inferring success from process exit. If the installed client changes its result format, verify
that format locally before interpreting the receipt. Then continue with the core skill's
capture stamp, image inspection and exact-session cleanup.
