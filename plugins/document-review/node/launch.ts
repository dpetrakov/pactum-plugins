// Local launch record of a checkout (DR-01): which run this host is dispatching, and how far it got. It lives in
// the plugin data directory of the machine that has the checkout, keyed by the canonical checkout path, so two
// environments of one checkout share it. It is a coordination aid, not the truth: after a restart the journal
// and bb's thread state are reconciled; losing the file never hides an unfinished run (the journal still has it).
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hash.ts";

export type LaunchState = "dispatching" | "queued" | "sent" | "dispatch-unknown";

export interface LaunchRecord {
  runId: string;
  attemptId: string;
  state: LaunchState;
  recipient: { mode: "current-thread" | "new-thread"; threadId: string | null };
  /** Queued bb message carrying the batch while the thread is busy. */
  queuedMessageId: string | null;
  startedAt: string;
  updatedAt: string;
  reason: string | null;
  /** sha256 of every tracked document at preparation: edits outside the batch are found by comparing at finish. */
  shas: Record<string, string>;
}

export class LaunchLog {
  readonly file: string;

  constructor(dataDir: string, root: string) {
    this.file = path.join(dataDir, "launch", `${sha256(root).slice(0, 16)}.json`);
  }

  async get(): Promise<LaunchRecord | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.file, "utf8")) as LaunchRecord;
      return typeof value?.runId === "string" && typeof value.attemptId === "string" ? value : null;
    } catch {
      return null;
    }
  }

  async put(record: LaunchRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ ...record, updatedAt: new Date().toISOString() }), { flag: "wx" });
    await fs.rename(temp, this.file);
  }

  async update(runId: string, patch: Partial<LaunchRecord>): Promise<LaunchRecord | null> {
    const current = await this.get();
    if (!current || current.runId !== runId) return null;
    const next = { ...current, ...patch };
    await this.put(next);
    return next;
  }

  /** Remove the record of this run only; another run's record is never dropped by a late call. */
  async clear(runId: string): Promise<void> {
    const current = await this.get();
    if (current?.runId === runId) await fs.rm(this.file, { force: true });
  }
}
