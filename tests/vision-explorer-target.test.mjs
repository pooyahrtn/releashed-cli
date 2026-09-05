import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveTarget, savedSessionCookies } from "../scripts/vision-explorer-run.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// resolveTarget() is the whole "which target, how does it sign in, which public-pack hash" decision.
// There is no built-in default target: every target, including a local one, needs --target-config.
test("resolveTarget refuses to run without a --target-config", async () => {
  await assert.rejects(
    () => resolveTarget("https://app.cal.com", null),
    /--target-config/,
  );
});

test("resolveTarget loads a saved-session target from its config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-target-"));
  try {
    const configPath = join(dir, "target.json");
    const packBytes = "a real pack's bytes";
    await writeFile(join(dir, "pack.json"), packBytes);
    await writeFile(
      configPath,
      JSON.stringify({
        url: "https://app.example.com",
        authMode: "saved-session",
        savedSessionPath: "./session.json",
        publicPackSha256: sha256(packBytes),
        publicPackPath: "./pack.json",
      }),
    );
    const resolved = await resolveTarget("https://app.example.com", configPath);
    assert.equal(resolved.authMode, "saved-session");
    assert.equal(resolved.publicPackSha256, sha256(packBytes));
    // Resolved relative to the config file's own directory, not the process cwd.
    assert.equal(resolved.savedSessionPath, join(dir, "session.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The third auth mode: no identity at all, just whatever a logged-out visitor can reach.
test("resolveTarget accepts a public (no-auth) target and leaves savedSessionPath null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-target-"));
  try {
    const configPath = join(dir, "target.json");
    const packBytes = "a real pack's bytes";
    await writeFile(join(dir, "pack.json"), packBytes);
    await writeFile(
      configPath,
      JSON.stringify({
        url: "https://example.com",
        authMode: "public",
        publicPackSha256: sha256(packBytes),
        publicPackPath: "./pack.json",
      }),
    );
    const resolved = await resolveTarget("https://example.com", configPath);
    assert.equal(resolved.authMode, "public");
    assert.equal(resolved.savedSessionPath, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The gap this closes: a malformed hash was already rejected before a run started, but a
// well-formed, 64-hex, WRONG hash used to sail through config-load and only fail at packaging --
// long after the run and its model spend. It must now fail loudly right here.
test("resolveTarget rejects a well-formed but wrong public-pack hash at config-load time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-target-"));
  try {
    const configPath = join(dir, "target.json");
    await writeFile(join(dir, "pack.json"), "the actual pack contents");
    await writeFile(
      configPath,
      JSON.stringify({
        url: "https://app.example.com",
        authMode: "clerk",
        // Well-formed 64-char hex, but does not match pack.json's real bytes.
        publicPackSha256: "b".repeat(64),
        publicPackPath: "./pack.json",
      }),
    );
    await assert.rejects(
      () => resolveTarget("https://app.example.com", configPath),
      /does not match the actual bytes/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The SPIKE_APP_URL/config mismatch is the exact footgun the top-of-file comment warns about:
// signIn() (clerk mode) closes over its own module-level SPIKE_APP_URL, so a config allowed to
// name a different url could silently navigate somewhere this script doesn't think it's exploring.
test("resolveTarget refuses a config whose url disagrees with SPIKE_APP_URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-target-"));
  try {
    const configPath = join(dir, "target.json");
    await writeFile(
      configPath,
      JSON.stringify({
        url: "https://app.example.com",
        authMode: "clerk",
        publicPackSha256: "a".repeat(64),
      }),
    );
    await assert.rejects(
      () => resolveTarget("https://app.other.com", configPath),
      /does not match SPIKE_APP_URL/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveTarget fails loudly when a target config omits a real public-pack hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-target-"));
  try {
    const configPath = join(dir, "target.json");
    await writeFile(
      configPath,
      JSON.stringify({
        url: "https://app.example.com",
        authMode: "clerk",
        publicPackSha256: "not-a-hash",
      }),
    );
    await assert.rejects(
      () => resolveTarget("https://app.example.com", configPath),
      /64-char hex sha256/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A target can legitimately span more than one host of its OWN product (cal.com's marketing site
// vs. app.cal.com's product) -- resolveTarget must widen the bound-origin allow-list to cover both
// when a config names them, while a config that names none still gets exactly the one origin.
test("resolveTarget widens allowedOrigins from additionalOrigins, and defaults to just the target's own origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-target-"));
  try {
    const packBytes = "a real pack's bytes";
    await writeFile(join(dir, "pack.json"), packBytes);

    const multiOriginConfigPath = join(dir, "multi.json");
    await writeFile(
      multiOriginConfigPath,
      JSON.stringify({
        url: "https://cal.com",
        authMode: "public",
        publicPackSha256: sha256(packBytes),
        publicPackPath: "./pack.json",
        additionalOrigins: ["https://app.cal.com"],
      }),
    );
    const multi = await resolveTarget("https://cal.com", multiOriginConfigPath);
    assert.deepEqual(multi.allowedOrigins, ["https://cal.com", "https://app.cal.com"]);

    const singleOriginConfigPath = join(dir, "single.json");
    await writeFile(
      singleOriginConfigPath,
      JSON.stringify({
        url: "https://app.example.com",
        authMode: "public",
        publicPackSha256: sha256(packBytes),
        publicPackPath: "./pack.json",
      }),
    );
    const single = await resolveTarget("https://app.example.com", singleOriginConfigPath);
    assert.deepEqual(single.allowedOrigins, ["https://app.example.com"]);

    const badOriginConfigPath = join(dir, "bad.json");
    await writeFile(
      badOriginConfigPath,
      JSON.stringify({
        url: "https://app.example.com",
        authMode: "public",
        publicPackSha256: sha256(packBytes),
        publicPackPath: "./pack.json",
        additionalOrigins: ["https://app.example.com/some/path"],
      }),
    );
    await assert.rejects(
      () => resolveTarget("https://app.example.com", badOriginConfigPath),
      /normalized origin/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The viewport is per-target and defaults to the original phone size when a config omits "viewport".
test("resolveTarget defaults to the phone viewport and lets a config override it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-target-"));
  try {
    const configPath = join(dir, "target.json");
    const packBytes = "a real pack's bytes";
    await writeFile(join(dir, "pack.json"), packBytes);
    await writeFile(
      configPath,
      JSON.stringify({
        url: "https://cal.com",
        authMode: "public",
        publicPackSha256: sha256(packBytes),
        publicPackPath: "./pack.json",
      }),
    );
    const defaultTarget = await resolveTarget("https://cal.com", configPath);
    assert.deepEqual(defaultTarget.viewport, { width: 390, height: 844 });

    await writeFile(
      configPath,
      JSON.stringify({
        url: "https://cal.com",
        authMode: "public",
        publicPackSha256: sha256(packBytes),
        publicPackPath: "./pack.json",
        viewport: { width: 1440, height: 900 },
      }),
    );
    const resolved = await resolveTarget("https://cal.com", configPath);
    assert.deepEqual(resolved.viewport, { width: 1440, height: 900 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// savedSessionCookies() is the pure shape-check reused by the saved-session sign-in path -- it
// takes exactly the file shape scripts/capture-session.mjs already writes.
test("savedSessionCookies normalizes a captured-session file's cookies", () => {
  const cookies = savedSessionCookies({
    cookies: [{ name: "session", value: "abc", domain: "app.example.com" }],
  });
  assert.deepEqual(cookies, [
    {
      name: "session",
      value: "abc",
      domain: "app.example.com",
      path: "/",
      expires: undefined,
      httpOnly: false,
      secure: false,
    },
  ]);
});

test("savedSessionCookies rejects a file that isn't the expected shape", () => {
  assert.throws(() => savedSessionCookies({ cookies: "not-an-array" }), /unexpected shape/);
});
