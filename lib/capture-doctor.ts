// Static inspection only: never execute an MCP command, auth helper, browser or model request.
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCaptureMetadata } from "./capture-metadata.ts";
import { resolveLocatorConfig } from "./caller-locator.ts";
import { inspectProspectiveOutput } from "./candidate-packager.mjs";
import type { CaptureMetadataInput } from "./capture-types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export type CaptureArgs = CaptureMetadataInput & {
  command: string;
  url?: string | null;
  mine?: boolean;
  login?: boolean;
  authCmd?: string | null;
};

export type CaptureCheckOptions = {
  url: string;
  goal: string;
  server: string;
  mcpConfig: string;
  preparation: string;
};

export type LocalServer = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  type?: string;
  url?: string;
};

export type DoctorDependencies = {
  parseArgs: (args: string[]) => CaptureArgs;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  browser?: () => Promise<void>;
};

async function executable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const paths = command.includes("/")
    ? [resolve(cwd, command)]
    : (env.PATH ?? "")
        .split(delimiter)
        .map((path) => resolve(cwd, path, command));
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return await realpath(path);
    } catch {}
  }
  throw new Error(
    "Configured executable unavailable; use the installed releashed executable or an absolute Node path.",
  );
}

function storeRoot(cwd: string, env: NodeJS.ProcessEnv): string {
  if (env.RELEASHED_OUT) return resolve(cwd, env.RELEASHED_OUT);
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return join(common, "releashed");
  } catch {
    return join(cwd, "releashed");
  }
}

export type DoctorCheck = { name: string; ok: boolean; detail: string };

export async function captureDoctor(
  options: CaptureCheckOptions,
  {
    parseArgs,
    cwd = process.cwd(),
    env = process.env,
    browser = async () => {
      await access(require("playwright").chromium.executablePath());
    },
  }: DoctorDependencies,
) {
  const checks: DoctorCheck[] = [];
  const check = async (
    name: string,
    fn: () => Promise<string>,
  ): Promise<boolean> => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
      return true;
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail:
          error instanceof Error ? error.message : "Local check failed.",
      });
      return false;
    }
  };
  const result = () => ({
    ok: checks.every((entry) => entry.ok),
    cwd,
    checks,
    unverified: [
      "The client loaded this exact server in this working directory and permits its tools; verify tool discovery/permission before observe.",
      "Preparation-record contents, account mapping/eligibility, expiry and cost prerequisites; verify using the actual product worktree before login.",
      "Authentication success and destination reachability; this check performs neither.",
    ],
  });
  await check("Node", async () => {
    if (Number(process.versions.node.split(".")[0]) < 22)
      throw new Error("Install Node 22+.");
    return process.versions.node;
  });
  await check("package", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    return `${pkg.name}@${pkg.version} at ${ROOT}`;
  });
  await check("Chromium", async () => {
    try {
      await browser();
    } catch {
      throw new Error(
        "Chromium unavailable for this installation; run releashed install-browser with this package.",
      );
    }
    return "This package's browser executable exists (not launched).";
  });
  await check("preparation record", async () => {
    const path = resolve(cwd, options.preparation);
    try {
      const info = await stat(path);
      if (!info.isFile() || !info.size) throw new Error();
      await access(path, constants.R_OK);
    } catch {
      throw new Error(
        `Create a readable, nonempty preparation/attempt record at ${path} before authentication.`,
      );
    }
    return `${path} exists; contents and external readiness are not verified.`;
  });
  let server: LocalServer;
  let serverEnv: NodeJS.ProcessEnv;
  let run: CaptureArgs;
  let out: string;
  if (
    !(await check("MCP configuration", async () => {
      let config: { mcpServers?: Record<string, unknown> };
      try {
        config = JSON.parse(await readFile(options.mcpConfig, "utf8"));
      } catch {
        throw new Error(
          `Read a valid JSON MCP configuration from ${options.mcpConfig}.`,
        );
      }
      server = config?.mcpServers?.[options.server] as LocalServer;
      if (!server || typeof server !== "object")
        throw new Error(
          `Select an existing mcpServers entry with --server in ${options.mcpConfig}.`,
        );
      if (
        server.disabled ||
        (server.type && server.type !== "stdio") ||
        server.url
      )
        throw new Error(
          "Selected server must be an enabled local stdio entry; a remote/disabled instance cannot be checked here.",
        );
      if (
        typeof server.command !== "string" ||
        !Array.isArray(server.args) ||
        server.args.some((value) => typeof value !== "string")
      )
        throw new Error(
          "Selected mcpServers entry needs command and a string args array.",
        );
      if (
        server.env &&
        (typeof server.env !== "object" ||
          Array.isArray(server.env) ||
          Object.values(server.env).some((value) => typeof value !== "string"))
      )
        throw new Error("Selected server env must contain string values.");
      if (server.cwd !== undefined && typeof server.cwd !== "string")
        throw new Error("Selected server cwd must be a path string.");
      if (server.cwd && resolve(cwd, server.cwd) !== resolve(cwd))
        throw new Error(
          "Run doctor from the same working directory as the selected server.",
        );
      // Auth helpers may legitimately use shell expansions; their contents are never evaluated here.
      const inspectedValues = [
        server.command,
        server.cwd,
        server.env?.PATH,
        server.env?.RELEASHED_OUT,
        ...server.args.filter(
          (_, index) => server.args[index - 1] !== "--auth-cmd",
        ),
      ];
      if (inspectedValues.some((value) => value?.includes("${")))
        throw new Error(
          "Resolve client variable substitutions in paths/run options before checking this configuration; their values are not known here.",
        );
      serverEnv = { ...env, ...server.env };
      return `Selected entry in ${options.mcpConfig}; command and environment values withheld.`;
    }))
  )
    return result();
  if (
    !(await check("MCP executable", async () => {
      const commandPath = await executable(server.command, cwd, serverEnv);
      let entry: string;
      let args: string[];
      const nodePath = await realpath(process.execPath);
      if (commandPath === nodePath) {
        if (!server.args[0] || server.args[0].startsWith("-"))
          throw new Error(
            "Use node <installed-package>/bin/releashed.mjs explore-mcp ... without Node wrappers/options.",
          );
        entry = resolve(cwd, server.args[0]);
        args = server.args.slice(1);
      } else {
        entry = commandPath;
        args = server.args;
        if ((await executable("node", cwd, serverEnv)) !== nodePath)
          throw new Error(
            "The server PATH selects a different Node; run doctor with that same Node installation.",
          );
      }
      let actual: string;
      try {
        actual = await realpath(entry);
      } catch {
        throw new Error(
          "Configured CLI entry does not exist; point to the installed bin/releashed.mjs.",
        );
      }
      if (actual !== (await realpath(join(ROOT, "bin", "releashed.mjs"))))
        throw new Error(
          "Selected server uses a different executable/package. Run doctor from that installation or correct the server command; wrappers such as npx are not resolved.",
        );
      // Reuse the CLI's parser but never echo a parser error: it may contain an auth command.
      try {
        run = parseArgs(args);
      } catch {
        throw new Error(
          "Configured arguments are invalid; check explore-mcp --goal, --steps and capture metadata in the selected entry.",
        );
      }
      out = storeRoot(cwd, serverEnv);
      return `${actual}; local output root ${out}`;
    }))
  )
    return result();
  if (
    !(await check("output root", async () => {
      // Fail fast on the BL12 C3 configuration: explore-mcp finishes into
      // join(outputRoot, "maps", runId), and the packager refuses any output path
      // through a private input area -- so preflight the known maps directory and its
      // ancestors with a read-only companion using the existing packager policy,
      // before any auth, model or browser effect. The companion keeps the exact
      // forbidden-segment semantics and additionally inspects existing path components:
      // a symlink or file ancestor fails (e.g. a temporary-directory alias where finish
      // requires the canonical target), while nonexistent future children (the generated
      // run id) pass. The fabricated leaf is never probed: an unrelated maps/probe file
      // must not fail a valid root. Read-only: it creates, follows and resolves nothing,
      // and the runtime packaging guards revalidate unchanged. Explicitly not a writability
      // or future-success guarantee.
      // Values are never echoed; only the key and the selected entry are named.
      try {
        await inspectProspectiveOutput(join(out, "maps"), "output");
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message.replace(/^Candidate packaging refused: /, "")
            : "Local check failed.";
        if (/private input area/.test(reason)) {
          throw new Error(
            `Selected server "${options.server}" output root is inside a private input area ` +
              `(RELEASHED_OUT in the selected mcpServers entry or its inherited environment). ` +
              `Keep restricted-access allowed output outside private auth-receipt areas: point ` +
              `RELEASHED_OUT for the selected server at a dedicated directory and keep ` +
              `preparation/auth records separate from it.`,
          );
        }
        throw new Error(
          `Selected server "${options.server}" output root passes through an unusable path component ` +
            `(RELEASHED_OUT in the selected mcpServers entry or its inherited environment): ${reason}. ` +
            `Point RELEASHED_OUT for the selected server at a canonical directory path -- resolve any ` +
            `symlink in the path (for example a temporary-directory alias) to its real target -- and keep ` +
            `preparation/auth records separate from it.`,
        );
      }
      return `Local output root ${out} is outside private input areas and its existing components are ordinary directories (prospective check only; not a writability guarantee).`;
    }))
  )
    return result();
  await check("directed request", async () => {
    if (run.command !== "explore-mcp" || !run.goal?.trim())
      throw new Error(
        "Selected server is not a directed explore-mcp capture; configure --goal on a dedicated instance.",
      );
    if (!run.mine)
      throw new Error(
        "Directed owner capture needs --mine in the selected server arguments.",
      );
    if (!run.url || new URL(run.url).href !== new URL(options.url).href)
      throw new Error(
        "Configured URL does not match the requested product URL.",
      );
    if (run.goal !== options.goal)
      throw new Error(
        "Configured --goal does not match the requested goal; bind the instance for this request.",
      );
    return "explore-mcp, ownership, URL and exact goal match.";
  });
  await check("target locator", async () => {
    // Presence only, for the selected explore-mcp entry: values are never echoed,
    // and nothing here logs in or makes a model call. Generic fixture/coordinate
    // tooling outside this capture entry is not subject to this check.
    const resolution = resolveLocatorConfig(serverEnv);
    if (!resolution.enabled)
      throw new Error(
        `Target locator is not configured for the selected server: ${resolution.reason}. ` +
          `Set RELEASHED_LOCATOR=midscene with MIDSCENE_MODEL_BASE_URL, MIDSCENE_MODEL_NAME and ` +
          `MIDSCENE_MODEL_FAMILY in its environment (verified: codex://app-server, gpt-5.6-sol, gpt-5); ` +
          `confirm access with "codex login status".`,
      );
    const recommended = [
      "MIDSCENE_MODEL_REASONING_ENABLED",
      "MIDSCENE_MODEL_REASONING_EFFORT",
      "MIDSCENE_MODEL_TIMEOUT",
    ].filter((key) => !(serverEnv[key] ?? "").trim());
    return recommended.length
      ? "Locator model is configured; consider also setting MIDSCENE_MODEL_REASONING_ENABLED, MIDSCENE_MODEL_REASONING_EFFORT and MIDSCENE_MODEL_TIMEOUT (verified reasoning effort low, timeout at or below the per-locate budget)."
      : "Locator model and reasoning/timeout pins are configured.";
  });
  await check("identity and precondition", async () => {
    if (!run.identityLabel?.trim() || !run.precondition?.trim())
      throw new Error(
        "Declare --identity-label and --precondition in the dedicated capture entry after verifying the actual account prerequisites.",
      );
    try {
      await validateCaptureMetadata({
        ...run,
        runsRoot: join(out, "runs"),
        mapsRoot: join(out, "maps"),
      });
    } catch {
      throw new Error(
        `Capture metadata is invalid or a referenced run is absent from ${out}/runs and ${out}/maps; check --continues, --precondition and --identity-label.`,
      );
    }
    return "Nonempty declarations and local run references checked; no account data read.";
  });
  await check("sign-in configuration", async () => {
    if (run.authCmd?.trim()) return "Auth helper configured; not executed.";
    if (!run.login)
      throw new Error(
        "Signed-in capture needs --auth-cmd or --login in the selected entry.",
      );
    if (!run.url)
      throw new Error(
        "Saved-session capture needs a product URL in the selected entry.",
      );
    const path = join(
      out,
      "sessions",
      `${new URL(run.url).hostname.replace(/[^a-z0-9]+/gi, "-")}.json`,
    );
    try {
      await access(path, constants.R_OK);
      if (!(await stat(path)).isFile()) throw new Error();
    } catch {
      throw new Error(
        `Saved session unavailable at ${path}; use the product's supported setup before capture.`,
      );
    }
    return "Saved session file exists; contents and expiry were not inspected.";
  });
  return result();
}
