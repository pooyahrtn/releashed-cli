import { createHash } from "node:crypto";

export function validateConsumedPublicSource({ sourceBytes, source }) {
  if (!(sourceBytes instanceof Uint8Array)) return { ok: false, reason: "Consumed public source does not match the frozen manifest" };
  const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
  if (sha256 !== source?.derived_text_sha256 || sourceBytes.byteLength !== source?.derived_text_bytes) return { ok: false, reason: "Consumed public source does not match the frozen manifest" };
  return { ok: true };
}
