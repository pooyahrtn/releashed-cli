import { lstat, mkdir, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

function identity(metadata) {
  return { dev: metadata.dev, ino: metadata.ino };
}

function safeIdentity(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === ["dev", "ino"].sort().join("\n") &&
    Number.isSafeInteger(value.dev) &&
    value.dev >= 0 &&
    Number.isSafeInteger(value.ino) &&
    value.ino > 0
  );
}

function sameIdentity(metadata, expected) {
  return metadata.dev === expected.dev && metadata.ino === expected.ino;
}

function checkedToken(token) {
  if (
    !token ||
    typeof token !== "object" ||
    Array.isArray(token) ||
    Object.keys(token).sort().join("\n") !== ["parent", "path", "root", "schema_version"].sort().join("\n") ||
    token.schema_version !== 1 ||
    typeof token.path !== "string" ||
    !isAbsolute(token.path) ||
    resolve(token.path) !== token.path ||
    !token.parent ||
    typeof token.parent !== "object" ||
    Array.isArray(token.parent) ||
    Object.keys(token.parent).sort().join("\n") !== ["dev", "ino", "path"].sort().join("\n") ||
    token.parent.path !== dirname(token.path) ||
    !safeIdentity({ dev: token.parent.dev, ino: token.parent.ino }) ||
    !safeIdentity(token.root)
  ) throw new Error("Browser profile ownership token is invalid");
  return token;
}

async function verifiedDirectory(path, expected) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !sameIdentity(metadata, expected)) {
    throw new Error("Browser profile ownership changed");
  }
  return metadata;
}

export async function revalidateOwnedBrowserProfile(rawToken, { requireEmpty = false } = {}) {
  const token = checkedToken(rawToken);
  const parent = await verifiedDirectory(token.parent.path, token.parent);
  const root = await verifiedDirectory(token.path, token.root);
  if ((root.mode & 0o777) !== 0o700) {
    throw new Error("Browser profile ownership changed");
  }
  if (parent.dev !== token.parent.dev || (requireEmpty && (await readdir(token.path)).length !== 0)) {
    throw new Error(requireEmpty ? "Browser profile is not empty" : "Browser profile ownership changed");
  }
  return token;
}

export async function createExclusiveEmptyBrowserProfile(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error("Browser profile path must be absolute and canonical");
  }
  const parentPath = await realpath(dirname(path));
  path = join(parentPath, basename(path));
  const parentMetadata = await lstat(parentPath);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("Browser profile parent ownership could not be verified");
  }
  await mkdir(path, { recursive: false, mode: 0o700 });
  let token = null;
  try {
    const rootMetadata = await lstat(path);
    token = Object.freeze({
      schema_version: 1,
      path,
      parent: Object.freeze({ path: parentPath, ...identity(parentMetadata) }),
      root: Object.freeze(identity(rootMetadata))
    });
    await revalidateOwnedBrowserProfile(token, { requireEmpty: true });
    return token;
  } catch (error) {
    if (token) await removeOwnedBrowserProfile(token, true).catch(() => false);
    throw error;
  }
}

async function removeOwnedEntry(path, expected, ownership) {
  await revalidateOwnedBrowserProfile(ownership);
  const metadata = await lstat(path);
  if (!sameIdentity(metadata, expected) || metadata.dev !== ownership.root.dev) return false;
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    for (const name of await readdir(path)) {
      if (!name || name === "." || name === ".." || name.includes(sep)) return false;
      const childPath = join(path, name);
      const child = await lstat(childPath);
      if (child.dev !== ownership.root.dev) return false;
      if (!await removeOwnedEntry(childPath, identity(child), ownership)) return false;
    }
    await revalidateOwnedBrowserProfile(ownership);
    const final = await lstat(path);
    if (!final.isDirectory() || final.isSymbolicLink() || !sameIdentity(final, expected)) return false;
    await rmdir(path);
    return true;
  }
  const final = await lstat(path);
  if (!sameIdentity(final, expected)) return false;
  await unlink(path);
  return true;
}

export async function removeOwnedBrowserProfile(rawToken, browserStopped) {
  if (!browserStopped) return false;
  let token;
  try {
    token = await revalidateOwnedBrowserProfile(rawToken);
    if (!await removeOwnedEntry(token.path, token.root, token)) return false;
    const parent = await verifiedDirectory(token.parent.path, token.parent);
    if (!sameIdentity(parent, token.parent)) return false;
    try {
      await lstat(token.path);
      return false;
    } catch (error) {
      return error?.code === "ENOENT";
    }
  } catch {
    return false;
  }
}
