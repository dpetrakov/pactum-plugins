// Local intent record of a two-step catalog write (EP-014-T01): «Track» writes config.json (CAS) and then the
// tracking-resumed bases of the documents. Both cannot be one atomic write, so the intent is recorded on the host
// before the config and cleared after the bases. A crash or restart in between leaves the intent: the next catalog
// command of this checkout finishes it (the rule is kept, the pause is never shown as read). Like the launch record
// it lives in the plugin data directory of the machine with the checkout and is only a recovery aid: losing it
// shows the pause as unread changes, which is visible and never claims anything as read.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hash.ts";

export interface ResumeIntent {
  /** sha256 of the config.json this write is going to produce. */
  configSha: string;
  /** Documents whose tracking resumes with that config. */
  docs: string[];
  startedAt: string;
}

export class IntentLog {
  readonly file: string;

  constructor(dataDir: string, root: string) {
    this.file = path.join(dataDir, "intents", `${sha256(root).slice(0, 16)}.resume.json`);
  }

  async get(): Promise<ResumeIntent | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.file, "utf8")) as ResumeIntent;
      return typeof value?.configSha === "string" && Array.isArray(value.docs) && value.docs.every((doc) => typeof doc === "string") ? value : null;
    } catch {
      return null;
    }
  }

  async put(intent: ResumeIntent): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temp, JSON.stringify(intent), { flag: "wx" });
    await fs.rename(temp, this.file);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}
