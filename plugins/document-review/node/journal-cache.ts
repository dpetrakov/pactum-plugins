// Host-side cache of parsed .bb-docs files (EP-015-T01): one file per checkout in the plugin data directory, so a cold
// host (after a restart) does not read and validate thousands of immutable files again. It is restorable: a missing,
// damaged or foreign cache is ignored and rebuilt; deleting it changes only the time (tests compare the projections).
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hash.ts";
import type { ParsedFileCache } from "../core/journal.ts";
import { SCHEMA_LATEST } from "../core/schema.ts";

/** Bumped whenever the parsed shape could differ for the same bytes. */
const FORMAT = `journal-cache/1 schema ${SCHEMA_LATEST}`;

export class JournalCache implements ParsedFileCache {
  readonly file: string;
  private entries: Map<string, unknown> | null = null;
  private touched = new Set<string>();
  private dirty = false;

  constructor(dataDir: string, root: string) {
    this.file = path.join(dataDir, "cache", `journal-${sha256(root).slice(0, 16)}.json`);
  }

  /** Forget the in-memory and disk journal cache. Rebuilding a local review after Forget file may reuse event IDs with new contents, so names no longer imply identical bytes. */
  async reset(): Promise<void> {
    this.entries = null;
    this.touched = new Set();
    this.dirty = false;
    await fs.rm(this.file, { force: true });
  }

  /** Load the cache file once per process; anything unexpected starts empty. */
  async open(): Promise<this> {
    if (this.entries) return this;
    this.entries = new Map();
    try {
      const value = JSON.parse(await fs.readFile(this.file, "utf8")) as { format?: string; entries?: [string, unknown][] };
      if (value.format === FORMAT && Array.isArray(value.entries)) for (const [key, entry] of value.entries) if (typeof key === "string") this.entries.set(key, entry);
    } catch {
      // No cache yet, or a damaged one: rebuilt by this load.
    }
    this.touched = new Set();
    return this;
  }

  get(key: string): unknown | undefined {
    const value = this.entries?.get(key);
    if (value !== undefined) this.touched.add(key);
    return value;
  }

  set(key: string, value: unknown): void {
    if (!this.entries) return;
    this.entries.set(key, value);
    this.touched.add(key);
    this.dirty = true;
  }

  /** Write the entries of the last load (files that left the journal, e.g. on another branch, are dropped). */
  async flush(): Promise<void> {
    if (!this.entries) return;
    const stale = this.entries.size !== this.touched.size;
    if (!this.dirty && !stale) return;
    const entries = [...this.touched].map((key) => [key, this.entries!.get(key)] as const);
    this.entries = new Map(entries);
    this.dirty = false;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
      await fs.writeFile(temp, JSON.stringify({ format: FORMAT, entries }));
      await fs.rename(temp, this.file);
    } catch {
      // The cache is an optimisation; a failed write costs time on the next cold start only.
    }
    this.touched = new Set();
  }
}
