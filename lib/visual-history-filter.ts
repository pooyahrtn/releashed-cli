// Pure bounded-visual-history filter + ledger helpers (no plugin entry here).
//
// The OpenCode file-plugin entry (lib/opencode-visual-history.ts) must export
// NOTHING but its default plugin function: the 1.18.30 loader iterates every
// module export and calls each function as a plugin, throwing on any
// non-function export. All logic lives here so the entry stays default-only.
//
// Actual 1.18.30 shapes only:
//   - user `file` parts: {type:'file', mime, filename?, url}
//   - flat completed tool state.attachments FilePart[] (MCP nested provider
//     output is created DOWNSTREAM from these flat attachments, so nested
//     attachment structures are explicitly refused, never walked).
// Read-tool image attachments carry ONLY {type:'file', mime, url:'data:...'}
// with no filename: root scoping comes from the parent read
// state.input.filePath (exact casing per Parameters), else from our own
// explore observe output text. No provenance refuses explicitly.
//
// The ceiling counts ALL outgoing image attachments, not only screenshots.
// Images proven outside the screenshot root, and pathless user data images
// (no proven screenshot provenance: never silently pruned), are preserved and
// count as unprunable. If unprunable images plus the retained latest 2 exceed
// 8, the transform refuses instead of breaching the ceiling.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  readImageReferences,
  type ImageReference,
} from "./image-references.ts";

/** Only OpenCode version this adapter was tested against. Others are untested: do not assume. */
export const SUPPORTED_OPENCODE_VERSION = "1.18.30";
/** Absolute per-session omission-ledger directory. */
export const VISUAL_HISTORY_DIR_ENV = "RELEASHED_VISUAL_HISTORY_DIR";
/** Absolute screenshot root scoping which images are prunable screenshots. */
export const VISUAL_HISTORY_SCREENSHOT_ROOT_ENV =
  "RELEASHED_VISUAL_HISTORY_SCREENSHOT_ROOT";
/** At most this many image attachments stay visible in one outbound request. */
export const MAX_IMAGES = 8;
/** When images exceed MAX_IMAGES, retain this many newest prunable ones. */
export const RETAIN_LATEST = 2;
/** Tiny omission marker prefix. Markers name the omission; they never summarize content. */
export const OMITTED_MARKER_PREFIX = "[releashed visual-history:";

const LEDGER_VERSION = 1;

/** Precise diagnostic refusal. Fail closed: the caller ends the attempt honestly, never unbounded. */
export class VisualHistoryRefusal extends Error {
  constructor(message: string) {
    super(`visual-history refused: ${message}`);
    this.name = "VisualHistoryRefusal";
  }
}

// Structural minimum of OpenCode's SessionV1 WithParts. No SDK import: the
// hook receives plain records and structural typing is adequate.
export type VisualInfo = {
  id: string;
  role: string;
  sessionID?: string;
  time?: { created: number };
  [key: string]: unknown;
};
export type VisualPart = {
  type: string;
  id?: string;
  messageID?: string;
  sessionID?: string;
  [key: string]: unknown;
};
export type VisualMessage = {
  info: VisualInfo;
  parts: VisualPart[];
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Actual 1.18.30 isImageAttachment: image/* except svg and fastbidsheet. Anything else is not an image. */
function isImageMime(mime: unknown): boolean {
  return (
    typeof mime === "string" &&
    mime.startsWith("image/") &&
    mime !== "image/svg+xml" &&
    mime !== "image/vnd.fastbidsheet"
  );
}

const MIME_TOKEN_RE = /^image\/[A-Za-z0-9.+-]+$/;
/** Every image/* is counted or explicitly refused: unsupported image mimes (svg, fastbidsheet) refuse, never silently skip. */
function refuseIfUnsupportedImageMime(mime: unknown, where: string): void {
  if (
    typeof mime === "string" &&
    mime.startsWith("image/") &&
    !isImageMime(mime)
  )
    throw new VisualHistoryRefusal(
      `${where} uses unsupported image mime ${JSON.stringify(mime)}; refusing`,
    );
}
const DATA_URL_RE =
  /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)(\?.*)?$/i;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Filesystem path when the value names an absolute one, else null (data:/http(s): URLs and bare names carry no scope). */
function asFilePath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("file://")) {
    try {
      const decoded = fileURLToPath(trimmed);
      return isAbsolute(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null;
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed))
    return trimmed;
  return null;
}

function isUnderRoot(candidatePath: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidatePath));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Validate an actual MIME/data-URL image payload. Returns 'pathless' for data: URLs, the scoped path otherwise. */
function checkImagePayload(
  mime: unknown,
  url: unknown,
  where: string,
  screenshotRoot: string,
): { path: string | null } {
  if (
    typeof mime !== "string" ||
    !MIME_TOKEN_RE.test(mime) ||
    !isImageMime(mime)
  )
    throw new VisualHistoryRefusal(
      `${where} has a malformed image mime; refusing`,
    );
  if (typeof url !== "string" || url === "")
    throw new VisualHistoryRefusal(`${where} has no image url; refusing`);
  const data = DATA_URL_RE.exec(url);
  if (data) {
    if (data[1].toLowerCase() !== mime.toLowerCase())
      throw new VisualHistoryRefusal(
        `${where} declares ${mime} but carries ${data[1]}; refusing`,
      );
    const b64 = data[2];
    if (
      b64.length === 0 ||
      b64.length % 4 !== 0 ||
      Buffer.from(b64, "base64").length === 0
    )
      throw new VisualHistoryRefusal(
        `${where} carries malformed base64; refusing`,
      );
    return { path: null };
  }
  const scoped = asFilePath(url);
  if (scoped === null)
    throw new VisualHistoryRefusal(
      `${where} has an unfamiliar image url shape; refusing`,
    );
  void screenshotRoot;
  return { path: scoped };
}

/** Parent read state.input.filePath (exact casing per read.ts Parameters). */
function readProvenance(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const filePath = input["filePath"];
  return typeof filePath === "string" && filePath !== "" ? filePath : undefined;
}

/**
 * Dedicated capture-server provenance: our own explore observe text carries
 * screenshot_path/image_path alongside steps_used/steps_left. Scopes an
 * actual typed image attachment only, never invents one.
 */
function observeProvenance(
  output: unknown,
  screenshotRoot: string,
): string | undefined {
  if (typeof output !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (
    typeof parsed["steps_used"] !== "number" &&
    typeof parsed["steps_left"] !== "number"
  )
    return undefined;
  const shot = parsed["image_path"] ?? parsed["screenshot_path"];
  if (typeof shot !== "string" || !IMAGE_EXT.test(shot.trim()))
    return undefined;
  return asFilePath(shot) ?? join(screenshotRoot, shot);
}

function memoryReferences(output: unknown): ImageReference[] | undefined {
  let value: unknown;
  try {
    value = readImageReferences(output);
  } catch {
    throw new VisualHistoryRefusal(
      "malformed saved-image references; refusing",
    );
  }
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !Array.isArray(value["images"])
  )
    throw new VisualHistoryRefusal(
      "unfamiliar saved-image references; refusing",
    );
  for (const ref of value["images"]) {
    if (
      !isRecord(ref) ||
      typeof ref["screenshot_path"] !== "string" ||
      !isAbsolute(ref["screenshot_path"]) ||
      !IMAGE_EXT.test(ref["screenshot_path"]) ||
      typeof ref["screenshot_sha256"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(ref["screenshot_sha256"])
    )
      throw new VisualHistoryRefusal(
        "invalid saved-image path or digest; refusing",
      );
  }
  return value["images"] as ImageReference[];
}

/** Bind bytes, not attachment order; repeated images and prior pruning are safe. */
function memoryProvenance(
  refs: ImageReference[] | undefined,
  url: unknown,
  root: string,
): string | undefined {
  if (refs === undefined || typeof url !== "string") return undefined;
  const data = DATA_URL_RE.exec(url);
  if (!data) return undefined;
  const digest = createHash("sha256")
    .update(Buffer.from(data[2]!, "base64"))
    .digest("hex");
  const matches = refs.filter((ref) => ref.screenshot_sha256 === digest);
  if (matches.length === 0)
    throw new VisualHistoryRefusal(
      "saved-image bytes have no matching provenance digest; refusing",
    );
  // If identical bytes also name an outside-root file, preserve them as unprunable.
  return (matches.find((ref) => !isUnderRoot(ref.screenshot_path, root)) ??
    matches[0])!.screenshot_path;
}

type ImageRecord =
  | {
      prunable: true;
      key: string;
      messageIndex: number;
      partIndex: number;
      attachmentIndex: number | null;
    }
  | { prunable: false; messageIndex: number; partIndex: number };

/** Enumerate ALL outgoing image attachments in outbound order. Unknown, malformed or unprovenanced images refuse. */
function enumerateImages(
  messages: VisualMessage[],
  screenshotRoot: string,
): ImageRecord[] {
  const images: ImageRecord[] = [];
  messages.forEach((message, messageIndex) => {
    if (
      !isRecord(message) ||
      !isRecord(message["info"]) ||
      !Array.isArray(message["parts"])
    )
      throw new VisualHistoryRefusal(
        `message at index ${messageIndex} is malformed; refusing`,
      );
    message.parts.forEach((part, partIndex) => {
      if (!isRecord(part) || typeof part["type"] !== "string")
        throw new VisualHistoryRefusal(
          `part ${messageIndex}.${partIndex} is malformed; refusing`,
        );
      const where = `part ${JSON.stringify(typeof part["id"] === "string" && part["id"] !== "" ? part["id"] : `${messageIndex}.${partIndex}`)}`;
      if (part["type"] === "file") {
        if (typeof part["id"] !== "string" || part["id"] === "")
          throw new VisualHistoryRefusal(
            `user file ${where} has no stable occurrence id; refusing`,
          );
        const mime = part["mime"];
        if (mime === "text/plain" || mime === "application/x-directory") return;
        if (mime !== undefined && typeof mime !== "string")
          throw new VisualHistoryRefusal(
            `user file ${where} has a non-string mime; refusing`,
          );
        if (typeof mime !== "string" || !isImageMime(mime)) {
          refuseIfUnsupportedImageMime(mime, `user file ${where}`);
          if (typeof mime !== "string") {
            const url = part["url"];
            const filename = part["filename"];
            if (
              (typeof url === "string" &&
                (url.startsWith("data:image/") ||
                  IMAGE_EXT.test(url.trim()))) ||
              (typeof filename === "string" && IMAGE_EXT.test(filename.trim()))
            )
              throw new VisualHistoryRefusal(
                `user file ${where} is image-bearing but untyped; refusing`,
              );
          }
          return;
        }
        const { path } = checkImagePayload(
          mime,
          part["url"],
          `user file ${where}`,
          screenshotRoot,
        );
        if (path === null) {
          images.push({ prunable: false, messageIndex, partIndex });
          return;
        }
        if (!isUnderRoot(path, screenshotRoot)) {
          images.push({ prunable: false, messageIndex, partIndex });
          return;
        }
        images.push({
          prunable: true,
          key: `file:${part["id"] as string}:${sha256Hex(`${mime}\n${part["url"] as string}`)}`,
          messageIndex,
          partIndex,
          attachmentIndex: null,
        });
        return;
      }
      if (part["type"] === "tool") {
        if (typeof part["id"] !== "string" || part["id"] === "")
          throw new VisualHistoryRefusal(
            `tool ${where} has no stable occurrence id; refusing`,
          );
        const state = part["state"];
        if (!isRecord(state) || typeof state["status"] !== "string")
          throw new VisualHistoryRefusal(
            `tool ${where} has no status; refusing`,
          );
        if (state["status"] !== "completed") {
          if (
            state["status"] === "pending" ||
            state["status"] === "running" ||
            state["status"] === "error"
          )
            return;
          throw new VisualHistoryRefusal(
            `tool ${where} has unfamiliar status ${JSON.stringify(state["status"])}; refusing`,
          );
        }
        const attachments = state["attachments"];
        if (attachments === undefined) return;
        if (!Array.isArray(attachments))
          throw new VisualHistoryRefusal(
            `tool ${where} has non-array attachments; refusing`,
          );
        const savedImages = memoryReferences(state["output"]);
        attachments.forEach((entry, attachmentIndex) => {
          const at = `tool ${where} attachment ${attachmentIndex}`;
          if (Array.isArray(entry))
            throw new VisualHistoryRefusal(
              `${at} is a nested array; nested attachments are unsupported, refusing`,
            );
          if (!isRecord(entry))
            throw new VisualHistoryRefusal(`${at} is not an object; refusing`);
          if (
            entry["content"] !== undefined ||
            entry["parts"] !== undefined ||
            entry["items"] !== undefined
          )
            throw new VisualHistoryRefusal(
              `${at} has nested content; nested attachments are unsupported, refusing`,
            );
          if (entry["type"] === "text" && typeof entry["text"] === "string")
            return;
          if (entry["type"] !== "file")
            throw new VisualHistoryRefusal(
              `${at} has unfamiliar type ${JSON.stringify(entry["type"])}; refusing`,
            );
          const mime = entry["mime"] ?? entry["mimeType"];
          if (mime !== undefined && typeof mime !== "string")
            throw new VisualHistoryRefusal(
              `${at} has a non-string mime; refusing`,
            );
          if (typeof mime !== "string" || !isImageMime(mime)) {
            refuseIfUnsupportedImageMime(mime, at);
            return;
          }
          const { path } = checkImagePayload(
            mime,
            entry["url"] ?? entry["data"],
            at,
            screenshotRoot,
          );
          const own = path;
          const parent =
            own ??
            ((): string => {
              const fromRead = readProvenance(state["input"]);
              if (fromRead !== undefined) {
                const scoped = asFilePath(fromRead);
                if (scoped === null)
                  throw new VisualHistoryRefusal(
                    `${at} parent read filePath is not absolute; refusing`,
                  );
                return scoped;
              }
              const fromObserve = observeProvenance(
                state["output"],
                screenshotRoot,
              );
              if (fromObserve !== undefined) return fromObserve;
              const fromMemory = memoryProvenance(
                savedImages,
                entry["url"] ?? entry["data"],
                screenshotRoot,
              );
              if (fromMemory !== undefined) return fromMemory;
              throw new VisualHistoryRefusal(
                `${at} has no screenshot provenance (no path, no read filePath, no capture output reference); refusing`,
              );
            })();
          if (!isUnderRoot(parent, screenshotRoot)) {
            images.push({ prunable: false, messageIndex, partIndex });
            return;
          }
          images.push({
            prunable: true,
            key: `tool:${part["id"] as string}:${attachmentIndex}:${sha256Hex(`${mime}\n${String(entry["url"] ?? entry["data"])}`)}`,
            messageIndex,
            partIndex,
            attachmentIndex,
          });
        });
      }
    });
  });
  return images;
}

export type FilterOptions = {
  omittedKeys?: Iterable<string>;
  screenshotRoot: string;
};

export type FilterResult = {
  messages: VisualMessage[];
  omittedKeys: string[];
  totalImages: number;
  visibleCount: number;
  newOmissions: string[];
};

/**
 * Pure bounded filter. Never mutates its input. Omits ledgered images always;
 * when visible images exceed MAX_IMAGES it retains the newest RETAIN_LATEST
 * prunable images plus every unprunable one, refusing when even that exceeds
 * the ceiling. The newest image is always intact.
 */
export function filterVisualHistory(
  messages: VisualMessage[],
  options: FilterOptions,
): FilterResult {
  const omitted = new Set(options.omittedKeys ?? []);
  const clones = structuredClone(messages) as VisualMessage[];
  const images = enumerateImages(clones, options.screenshotRoot);
  const omitNow = new Set<string>();
  for (const image of images) {
    if (image.prunable && omitted.has(image.key)) omitNow.add(image.key);
  }
  const visible = images.filter(
    (image) =>
      !(image.prunable && (omitNow.has(image.key) || omitted.has(image.key))),
  );
  const newOmissions: string[] = [];
  if (visible.length > MAX_IMAGES) {
    const prunableVisible = visible.filter(
      (image): image is Extract<ImageRecord, { prunable: true }> =>
        image.prunable,
    );
    const unprunableVisible = visible.length - prunableVisible.length;
    const keep = new Set(
      prunableVisible
        .slice(prunableVisible.length - RETAIN_LATEST)
        .map((image) => image.key),
    );
    if (
      unprunableVisible + Math.min(RETAIN_LATEST, prunableVisible.length) >
      MAX_IMAGES
    )
      throw new VisualHistoryRefusal(
        `unprunable images (${unprunableVisible}) plus the retained latest leave no room under ${MAX_IMAGES}; refusing`,
      );
    for (const image of prunableVisible) {
      if (keep.has(image.key)) continue;
      if (omitNow.has(image.key)) continue;
      omitNow.add(image.key);
      newOmissions.push(image.key);
    }
    for (const key of newOmissions) omitted.add(key);
  }
  const toolMarkers = new Map<number, { count: number; keys: string[] }>();
  // Group omitted tool-attachment indices per part FIRST, then filter each
  // attachment array exactly once against its ORIGINAL indices. Filtering
  // per omitted image would shift later indices and over-prune.
  const omittedAttachmentIndices = new Map<string, Set<number>>();
  for (const image of images) {
    if (!image.prunable || !omitNow.has(image.key)) continue;
    const message = clones[image.messageIndex];
    if (!message) continue;
    if (image.attachmentIndex === null) {
      const original = message.parts[image.partIndex] as VisualPart;
      message.parts[image.partIndex] = {
        type: "text",
        ...(typeof original["id"] === "string" ? { id: original["id"] } : {}),
        ...(typeof original["messageID"] === "string"
          ? { messageID: original["messageID"] }
          : {}),
        ...(typeof original["sessionID"] === "string"
          ? { sessionID: original["sessionID"] }
          : {}),
        text: `${OMITTED_MARKER_PREFIX} screenshot omitted: ${image.key}]`,
      };
    } else {
      const slot = `${image.messageIndex}.${image.partIndex}`;
      let indices = omittedAttachmentIndices.get(slot);
      if (!indices) {
        indices = new Set<number>();
        omittedAttachmentIndices.set(slot, indices);
      }
      indices.add(image.attachmentIndex);
      const marker = toolMarkers.get(image.messageIndex) ?? {
        count: 0,
        keys: [],
      };
      marker.count += 1;
      marker.keys.push(image.key);
      toolMarkers.set(image.messageIndex, marker);
    }
  }
  for (const [slot, indices] of omittedAttachmentIndices) {
    const [messageIndex, partIndex] = slot.split(".").map(Number) as [
      number,
      number,
    ];
    const part = clones[messageIndex]?.parts[partIndex] as
      | Record<string, unknown>
      | undefined;
    const state = part?.["state"] as Record<string, unknown> | undefined;
    if (!Array.isArray(state?.["attachments"])) continue;
    state["attachments"] = (state["attachments"] as unknown[]).filter(
      (_, index) => !indices.has(index),
    );
  }
  for (const [messageIndex, marker] of toolMarkers) {
    const message = clones[messageIndex];
    if (!message) continue;
    message.parts.push({
      type: "text",
      id: `releashed-visual-history-omitted-${messageIndex}`,
      ...(typeof message.info.sessionID === "string"
        ? { sessionID: message.info.sessionID }
        : {}),
      ...(typeof message.info.id === "string"
        ? { messageID: message.info.id }
        : {}),
      text: `${OMITTED_MARKER_PREFIX} ${marker.count} screenshot(s) omitted: ${marker.keys.join(", ")}]`,
    });
  }
  const remaining = images.filter(
    (image) => !(image.prunable && omitNow.has(image.key)),
  ).length;
  if (remaining > MAX_IMAGES)
    throw new VisualHistoryRefusal(
      `visible images (${remaining}) exceed the ceiling of ${MAX_IMAGES} after filtering; refusing`,
    );
  return {
    messages: clones,
    omittedKeys: [...omitted].sort(),
    totalImages: images.length,
    visibleCount: remaining,
    newOmissions,
  };
}

/** Collision-free ledger path: full SHA-256 of the session id, never a truncated sanitization. */
export function ledgerPath(dir: string, sessionID: string): string {
  return join(dir, `${sha256Hex(sessionID)}.json`);
}

/** Inter-process lock path for the session ledger (tested directly; never invent another lock service). */
export function ledgerLockPath(dir: string, sessionID: string): string {
  return lockPath(dir, sessionID);
}

function lockPath(dir: string, sessionID: string): string {
  return join(dir, `${sha256Hex(sessionID)}.lock`);
}

/** Every message must carry the same non-missing session id, else refuse. */
export function requireSessionID(messages: VisualMessage[]): string {
  const ids = new Set<string>();
  for (const message of messages) {
    const sessionID =
      isRecord(message) && isRecord(message["info"])
        ? message["info"]["sessionID"]
        : undefined;
    if (typeof sessionID !== "string" || sessionID === "")
      throw new VisualHistoryRefusal(
        "a message has a missing session id; refusing",
      );
    ids.add(sessionID);
  }
  if (ids.size > 1)
    throw new VisualHistoryRefusal(
      `one transform holds ${ids.size} distinct sessions; refusing`,
    );
  const only = ids.values().next();
  if (only.done)
    throw new VisualHistoryRefusal("no session id found; refusing");
  return only.value as string;
}

export async function loadOmittedKeys(
  dir: string,
  sessionID: string,
): Promise<Set<string>> {
  const path = ledgerPath(dir, sessionID);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw new VisualHistoryRefusal(
      `cannot read omission ledger at ${path}: ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VisualHistoryRefusal(
      `omission ledger at ${path} is not valid JSON; refusing`,
    );
  }
  if (
    !isRecord(parsed) ||
    parsed["version"] !== LEDGER_VERSION ||
    !Array.isArray(parsed["omitted"])
  )
    throw new VisualHistoryRefusal(
      `omission ledger at ${path} has an unfamiliar shape; refusing`,
    );
  if (parsed["sessionID"] !== sessionID)
    throw new VisualHistoryRefusal(
      `omission ledger at ${path} belongs to another session; refusing`,
    );
  const keys = new Set<string>();
  for (const key of parsed["omitted"] as unknown[]) {
    if (typeof key !== "string" || key === "")
      throw new VisualHistoryRefusal(
        `omission ledger at ${path} holds a malformed key; refusing`,
      );
    keys.add(key);
  }
  return keys;
}

/** Atomic private (0600) temp-file plus rename. Write failures refuse. */
export async function storeOmittedKeys(
  dir: string,
  sessionID: string,
  keys: Iterable<string>,
): Promise<void> {
  const path = ledgerPath(dir, sessionID);
  const body = `${JSON.stringify({ version: LEDGER_VERSION, sessionID, omitted: [...keys].sort(), updatedAt: new Date().toISOString() })}\n`;
  const tmp = join(dir, `.${sha256Hex(sessionID)}.${process.pid}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    throw new VisualHistoryRefusal(
      `cannot write omission ledger at ${path}: ${(error as Error).message}`,
    );
  }
}

async function acquireLock(dir: string, sessionID: string): Promise<void> {
  const path = lockPath(dir, sessionID);
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new VisualHistoryRefusal(
      `cannot prepare omission ledger dir at ${dir}: ${(error as Error).message}`,
    );
  }
  const claim = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  try {
    await writeFile(path, claim, { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new VisualHistoryRefusal(
        `cannot claim ledger lock at ${path}: ${(error as Error).message}`,
      );
  }
  // No stale takeover: an existing lock always refuses, however old. A
  // possibly live holder is never stolen from; stale cleanup is an explicit
  // caller action outside this adapter.
  throw new VisualHistoryRefusal(
    `omission ledger for this session is locked by a concurrent transform; refusing rather than risk resurrecting pruned images`,
  );
}

async function releaseLock(dir: string, sessionID: string): Promise<void> {
  try {
    await unlink(lockPath(dir, sessionID));
  } catch {
    // Lock already gone: nothing to release.
  }
}

/** In-process per-session serialization: concurrent transforms queue instead of racing the ledger. */
const sessionLocks = new Map<string, Promise<void>>();
function withSessionLock<T>(
  sessionID: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionLocks.get(sessionID) ?? Promise.resolve();
  let release: () => void = () => {};
  const mine = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  sessionLocks.set(
    sessionID,
    prev.then(() => mine),
  );
  return prev.then(fn).finally(release);
}

export type TransformOutput = {
  messages: VisualMessage[];
};

function readEnv(): { dir: string; root: string } | null {
  const dir = (process.env[VISUAL_HISTORY_DIR_ENV] ?? "").trim();
  const root = (process.env[VISUAL_HISTORY_SCREENSHOT_ROOT_ENV] ?? "").trim();
  if (dir === "" && root === "") return null;
  if (dir === "" || root === "")
    throw new VisualHistoryRefusal(
      `partial visual-history config: ${VISUAL_HISTORY_DIR_ENV} is ${dir === "" ? "missing" : "set"} but ${VISUAL_HISTORY_SCREENSHOT_ROOT_ENV} is ${root === "" ? "missing" : "set"}; refusing instead of silently disabling`,
    );
  if (!isAbsolute(dir))
    throw new VisualHistoryRefusal(
      `${VISUAL_HISTORY_DIR_ENV} must be absolute, got ${JSON.stringify(dir)}`,
    );
  if (!isAbsolute(root))
    throw new VisualHistoryRefusal(
      `${VISUAL_HISTORY_SCREENSHOT_ROOT_ENV} must be absolute, got ${JSON.stringify(root)}`,
    );
  return { dir, root };
}

/**
 * OpenCode `experimental.chat.messages.transform` hook. Disabled (no-op) only
 * when BOTH opt-in variables are absent; partial config refuses. Otherwise it
 * loads the ledger, filters clones, persists the decision FIRST, then splices
 * the clones into the SAME array in place (the runner converts the original
 * array reference). Original nested stored records are never mutated.
 */
export async function visualHistoryTransform(
  _input: unknown,
  output: TransformOutput,
): Promise<void> {
  const env = readEnv();
  if (env === null) return;
  if (!isRecord(output) || !Array.isArray(output["messages"]))
    throw new VisualHistoryRefusal(
      `unfamiliar transform payload (output.messages is not an array); refusing (tested OpenCode ${SUPPORTED_OPENCODE_VERSION} only)`,
    );
  const messages = output["messages"] as VisualMessage[];
  if (messages.length === 0) return;
  const sessionID = requireSessionID(messages);
  await withSessionLock(sessionID, async () => {
    await acquireLock(env.dir, sessionID);
    try {
      const omitted = await loadOmittedKeys(env.dir, sessionID);
      const result = filterVisualHistory(messages, {
        omittedKeys: omitted,
        screenshotRoot: env.root,
      });
      await storeOmittedKeys(env.dir, sessionID, result.omittedKeys);
      messages.splice(0, messages.length, ...result.messages);
    } finally {
      await releaseLock(env.dir, sessionID);
    }
  });
}

export type VisualHistoryHooks = {
  "experimental.chat.messages.transform": typeof visualHistoryTransform;
};
