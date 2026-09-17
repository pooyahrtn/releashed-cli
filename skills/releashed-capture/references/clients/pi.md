# pi adapter

Optional setup for the [core capture skill](../../SKILL.md). Use only when the authorized caller
is pi and needs this connection route.

Compatibility record — 17 September 2026: this exact configuration was verified locally, end to
end, on a real target -- reached the requested screen and sealed honestly (`goal_reached: true`,
evidence-bound). The pi version used was not pinned in that trial; check `pi --version` and
`pi --help` locally before relying on these flags, and retain any unsupported-flag or capability
result with the attempt, the same as for the other adapters in this directory.

pi reads a project-root `.mcp.json` automatically -- there is no separate `--mcp-config` flag to
pass, unlike the Claude CLI or OpenCode adapters in this directory. Place it in the verified
product working directory pi will run from (its `cwd` binds authentication and shared memory to
that worktree; do not put source or preparation instructions in the vision prompt). One entry,
naming the prepared `releashed explore-mcp <url>` invocation as pi's `command`/`args`, with the
locator model configuration in that SAME entry's `env` block -- not in a shell export, which would
leak into everything else pi runs:

```json
{
  "mcpServers": {
    "releashed": {
      "command": "releashed",
      "args": ["explore-mcp", "<url>", "--mine", "--goal", "<request>", "--policy", "<conduct policy>", "--steps", "10"],
      "env": {
        "RELEASHED_LOCATOR": "midscene",
        "MIDSCENE_MODEL_BASE_URL": "codex://app-server",
        "MIDSCENE_MODEL_NAME": "gpt-5.6-sol",
        "MIDSCENE_MODEL_FAMILY": "gpt-5"
      }
    }
  }
}
```

`command` must resolve to the actually installed `releashed`; an absolute path to
`bin/releashed.mjs` under the installed package is safer than a bare `releashed` if more than one
copy could be on PATH. Everything else in this
core skill's contract is unchanged: only the four capture tools (`observe`, `act`, `record`,
`finish`), the `observe` → `act` → `observe({record_previous:true})` loop, an absolute
`--acquire-until` cutoff derived from the outer deadline, and returning the complete `finish`
response (`evidence_markdown`, `preparation_record`, `diagnostics_dir`) rather than a summary.
