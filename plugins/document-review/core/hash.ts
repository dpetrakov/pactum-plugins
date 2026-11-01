import { createHash, randomUUID } from "node:crypto";

/** Lowercase hex sha256 of bytes or of a string encoded as UTF-8. */
export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export const SHA256 = /^[0-9a-f]{64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Random lowercase UUID v4 for operations, documents, annotations, revisions. */
export function newId(): string {
  return randomUUID();
}
