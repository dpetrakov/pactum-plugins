import fs from "node:fs/promises";
import { formatOf } from "../core/formats/registry.ts";
import { ReviewError, type ReviewService } from "./service.ts";

/** UI-only download of the original file. Bounded chunks stay below the host RPC limit. */
export async function documentFileInfo(service: ReviewService, docPath: string, chunk?: { offset: number; version: string }) {
  const config = (await service.config()).value;
  if (config) await service.refuseExcluded(config, docPath);
  const absolutePath = await service.documentFile(docPath);
  const file = await fs.open(absolutePath, "r");
  try {
    const stat = await file.stat();
    const version = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const info = { absolutePath, relativePath: docPath, format: formatOf(docPath), size: stat.size, version };
    if (!chunk) return info;
    if (chunk.version !== version) throw new ReviewError("stale", "The file changed. Open its information again and retry the download.");
    const bytes = Buffer.alloc(Math.min(512 * 1024, Math.max(0, stat.size - chunk.offset)));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, chunk.offset);
    const after = await file.stat();
    if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== version) throw new ReviewError("stale", "The file changed during download. Retry the download.");
    return { ...info, content: bytes.subarray(0, bytesRead).toString("base64"), next: chunk.offset + bytesRead };
  } finally { await file.close(); }
}
