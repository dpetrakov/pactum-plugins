// Temporary observations (DR-03): exact bytes of revisions this host served for display, kept in the
// plugin data directory of the host, outside the repository. They prove a client's draft context
// refers to something that was really shown, survive reload and host restart, and may be lost
// (then the user reopens the document). Nothing here is needed to reproduce persistent data.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hash.ts";

const MAX_ENTRIES = 2000;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

interface Meta {
  /** Repo-relative path → persistent head revisions of the document when it was shown. */
  paths: Record<string, string[]>;
  at: number;
  /** W-06c (§8): the bytes are the redacted form under these shared rules (Revision.redacted.rules). */
  rules?: string | null;
}

export class ObservationLog {
  readonly dir: string;
  private writes = 0;
  /** Read-modify-write of one observation's metadata is serialized per sha inside this process. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Observations written by this process (sha, path, heads): showing the same revision again writes nothing. */
  private readonly written = new Map<string, number>();

  async record(input: { sha: string; path: string; heads: string[]; bytes: Uint8Array; rules?: string | null }): Promise<void> {
    const key = `${input.sha}|${input.path}|${[...input.heads].sort().join(",")}`;
    const at = this.written.get(key);
    if (at !== undefined && Date.now() - at < 3600_000) return;
    if (sha256(input.bytes) !== input.sha) throw new Error("observation hash mismatch");
    const previous = this.queues.get(input.sha) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.write(input));
    this.queues.set(input.sha, run);
    try {
      await run;
    } finally {
      if (this.queues.get(input.sha) === run) this.queues.delete(input.sha);
    }
    this.written.set(key, Date.now());
    if (this.written.size > 5000) this.written.delete(this.written.keys().next().value!);
    if (++this.writes % 100 === 0) await this.prune();
  }

  private async atomicWrite(file: string, data: Uint8Array | string) {
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temp, data, { flag: "wx" });
    await fs.rename(temp, file);
  }

  private async write(input: { sha: string; path: string; heads: string[]; bytes: Uint8Array; rules?: string | null }) {
    await fs.mkdir(this.dir, { recursive: true });
    const metaFile = path.join(this.dir, `${input.sha}.json`);
    let meta: Meta = { paths: {}, at: 0 };
    try {
      meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
    } catch {
      // Missing or damaged metadata is rebuilt from this observation.
    }
    meta.paths[input.path] = [...input.heads].sort();
    meta.at = Date.now();
    if (input.rules) meta.rules = input.rules;
    const bytesFile = path.join(this.dir, `${input.sha}.md`);
    const present = await fs.readFile(bytesFile).catch(() => null);
    // A short file from an interrupted write would block this hash forever: rewrite it whole.
    if (!present || sha256(new Uint8Array(present)) !== input.sha) await this.atomicWrite(bytesFile, input.bytes);
    await this.atomicWrite(metaFile, JSON.stringify(meta));
  }

  /** Bytes and context of an observation, or null; the bytes are re-hashed on every read. */
  async get(sha: string): Promise<{ bytes: Uint8Array; path: string; heads: string[] } | null> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    try {
      const bytes = new Uint8Array(await fs.readFile(path.join(this.dir, `${sha}.md`)));
      if (sha256(bytes) !== sha) return null;
      const meta: Meta = JSON.parse(await fs.readFile(path.join(this.dir, `${sha}.json`), "utf8"));
      const [entry] = Object.entries(meta.paths);
      return entry ? { bytes, path: entry[0], heads: entry[1] } : null;
    } catch {
      return null;
    }
  }

  /** The observation as shown at a specific path. */
  async getAt(sha: string, docPath: string): Promise<{ bytes: Uint8Array; heads: string[]; rules: string | null } | null> {
    const found = await this.get(sha);
    if (!found) return null;
    const meta: Meta = JSON.parse(await fs.readFile(path.join(this.dir, `${sha}.json`), "utf8"));
    const heads = meta.paths[docPath];
    return heads ? { bytes: found.bytes, heads, rules: typeof meta.rules === "string" && /^[0-9a-f]{64}$/.test(meta.rules) ? meta.rules : null } : null;
  }

  async prune(): Promise<void> {
    this.written.clear();
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const metas = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const stat = await fs.stat(path.join(this.dir, name)).catch(() => null);
      if (stat) metas.push({ sha: name.slice(0, -5), mtime: stat.mtimeMs });
    }
    metas.sort((a, b) => b.mtime - a.mtime);
    const now = Date.now();
    for (const [index, entry] of metas.entries()) {
      if (index < MAX_ENTRIES && now - entry.mtime < MAX_AGE_MS) continue;
      await fs.rm(path.join(this.dir, `${entry.sha}.json`), { force: true });
      await fs.rm(path.join(this.dir, `${entry.sha}.md`), { force: true });
    }
  }
}
