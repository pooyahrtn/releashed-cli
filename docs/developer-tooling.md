# Working efficiently in this repo

`npm run agent:status` shows Git state, the active freeze marker, the current pickup section from
TASKS and the first handover section. It reads those files without changing them. For machine
output use `npm run --silent agent:status -- --json`. TASKS owns pickup order; the handover may
contain an older summary. The status output names the original sources and marks truncation.

The contributor skill is `.agents/skills/flow-map-develop/SKILL.md`. It maps work to modules and
tests and describes the installed-package check. It is separate from the customer skills shipped
under `skills/`.

Default `rg` searches omit generated `artifacts/` and `packs/` via `.ignore`. They remain tracked
and readable. Search evidence deliberately with `rg --no-ignore PATTERN artifacts/<known-path>`.
Nested `.claude/worktrees/`, runtime output and Serena caches are ignored; use another worktree
by changing directory to it, rather than searching through all checkouts from their parent.

## JavaScript language services

The project uses Serena's local TypeScript language server to navigate existing `.mjs` code.
Definitions, references, symbol summaries and inferred type information (`include_info`) are
available through MCP. The source remains plain Node JavaScript. Serena's diagnostic tool missed
an intentional bad assignment in the local trial and is excluded; use `npm run typecheck` instead.

Install the developer tool separately from the product package:

```sh
uv tool install -p 3.13 --no-build-package cryptography serena-agent==1.6.1
serena init
```

This pinned setup was verified on the owner's Intel Mac. The binary-only cryptography constraint
avoids a Rust source build; `serena init` selects the local LSP backend. Node 22+ and npm must be
on PATH. Serena installs its language-server dependencies outside the product's dependencies.
On another machine, follow [Serena's installation instructions](https://oraios.github.io/serena/02-usage/010_installation.html)
if this platform-specific pin is unsuitable.

`.codex/config.toml` enables the server for this trusted repo. Confirm with
`codex mcp get serena --json`, then reconnect MCP or start a fresh Codex session to load the tools.
The current session's tool list may not refresh automatically. If the app cannot find `serena`,
set the command to the absolute path returned by `command -v serena` in your local configuration.
Activate the **actual working-tree path** using `activate_project`, particularly in the desktop
app; never rely on a remembered project name when working in a sibling checkout.
[Codex project configuration](https://learn.chatgpt.com/docs/config-file/config-basic).

The config disables the dashboard/browser window and exposes seven navigation/configuration tools.
The project is read-only from Serena; normal agent file-editing tools remain available.
`jsconfig.json` scopes the source project and disables automatic type downloads. `.serena/project.yml`
excludes generated evidence and nested checkouts. Node processes inherit a 768 MiB heap limit;
that is per process, not a total memory guarantee. No language server is kept running by a cron
job or background daemon; the MCP client owns its subprocess lifecycle.

`npm run typecheck` strictly checks `scripts/agent-status.mjs`, `lib/capture-doctor.mjs`,
`lib/capture-metadata.mjs` and `lib/capture-selection.mjs`, which have JSDoc types and `@ts-check`.
Shared provenance, observation and selected-image contracts live in `lib/capture-types.d.ts`.
It does **not** claim that the whole repo is typed. Add modules to
`tsconfig.check.json` as their contracts become explicit. A future `.ts` migration should cover
shared records first and preserve the installed Node/package entry points and tests.

## Local capture readiness

Plain `releashed doctor` is an API-path check and makes a small paid key-validation call.
The separate capture mode is static and local:

```sh
releashed doctor --capture https://app.example.com --goal "show the session review" \
  --mcp-config /path/to/private-mcp.json --server directed-capture \
  --preparation /path/to/private-attempt.md --json
```

Run it **from the product worktree that will authenticate**, using the same installed package as
the selected server. The config is a JSON object with a `mcpServers` table, such as a Claude-style
`.mcp.json`. Select an exact entry; it never picks one automatically. Example placeholders:

```json
{
  "mcpServers": {
    "directed-capture": {
      "command": "releashed",
      "args": [
        "explore-mcp", "https://app.example.com", "--mine",
        "--goal", "show the session review",
        "--auth-cmd", "<supported product login command>",
        "--identity-label", "<opaque account label>",
        "--precondition", "<verified nonsecret prerequisites>"
      ]
    }
  }
}
```

The checker reads config but never runs its command or auth helper. It verifies Node/Chromium
presence, resolves the executable to this package, compares the full URL and exact goal, checks
owner mode, identity/precondition declarations and referenced runs, and checks sign-in setup and
the preparation file's presence. A saved session is checked for readability, not validity. It
does not print auth commands, environment values or preparation-record contents. It does not
create an output directory. Exit code 1 means at least one local check failed.

Direct `releashed` or `node <package>/bin/releashed.mjs` invocations are supported. Remote servers,
shell/npx wrappers, unresolved client substitutions and other config formats are explicitly outside
this static check. Use an explicit installed entry for the check; this does not prove which
instance the client actually loaded. It also cannot determine client tool permission, current
account eligibility, preparation-record accuracy, cost readiness, authentication success or
destination reachability. Those remain listed as unverified even when every local check passes.
The caller still performs tool discovery/permission checks before `observe`, which authenticates.

The preparation record remains the caller's existing prose or JSON record. There is no new
request language or schema, and a nonempty file is not proof of its claims.

## Verification record

See the developer-tooling outcome review (`docs/reviews/agent-efficiency-2026-09-07.md`, kept
with the project's own history) for measured LSP
lookups, package checks, tests and limits. These are local development checks, not passing live
capture or saved-image acceptance trials.

## TypeScript source and the Node package

Run `npm run build` (Bun) after changing TypeScript runtime source and before running the Node
CLI or plain Node tests. The scoped build emits adjacent, ignored `.mjs` files for the existing
Node entry points; edit `.ts`, never those generated files. `npm test` and `npm pack` build first.
`npm run typecheck` checks the actual source independently. Installed archives still run on Node
22+ and need neither Bun nor the TypeScript development dependency. Migration stays incremental;
the capture memory and freshness modules now use actual `.ts` source, with no new declarations.
