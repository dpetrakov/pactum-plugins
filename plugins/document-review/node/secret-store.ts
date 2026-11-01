// «Value changed» on this device (W-06c, file-types.md §8, F13): HMAC-SHA256 of secret values under a random
// device key that never leaves the plugin's data directory. For each checkout × file × secret the store keeps the HMAC
// of the value this device last saw; the view compares the current value's HMAC with it. No value, length or plain
// hash is stored; nothing goes to .bb-docs, packages, logs or answers (only the boolean «changed»). Deleting the store
// loses only this hint: shared data does not depend on it.
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hash.ts";

export class SecretStore {
  readonly dir: string;
  private key: Buffer | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "secrets");
  }

  private async deviceKey(): Promise<Buffer> {
    if (this.key) return this.key;
    const file = path.join(this.dir, "device.key");
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700).catch(() => undefined);
    try {
      const bytes = await fs.readFile(file);
      if (bytes.length === 32) {
        await fs.chmod(file, 0o600).catch(() => undefined);
        return (this.key = bytes);
      }
    } catch {
      // created below
    }
    // Missing or damaged (wrong length after a crash): a fresh key replaces it atomically; old HMACs simply stop matching.
    const fresh = randomBytes(32);
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temp, fresh, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
    const stored = await fs.readFile(file);
    this.key = stored.length === 32 ? stored : fresh;
    return this.key;
  }

  /** HMAC of a value under the device key, bound to the secret's place so equal values elsewhere differ. */
  async mac(place: string, value: string): Promise<string> {
    return createHmac("sha256", await this.deviceKey()).update(`${place}\0${value}`).digest("hex");
  }

  private fileOf(root: string, docPath: string): string {
    return path.join(this.dir, "seen", sha256(root).slice(0, 16), `${sha256(docPath).slice(0, 24)}.json`);
  }

  async seen(root: string, docPath: string): Promise<Record<string, string>> {
    try {
      const value = JSON.parse(await fs.readFile(this.fileOf(root, docPath), "utf8")) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(value).filter(([, mac]) => typeof mac === "string" && /^[0-9a-f]{64}$/.test(mac as string))) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** Record what this device saw: `entries` place → HMAC; `replace` drops places that are gone. */
  write(root: string, docPath: string, entries: Record<string, string>, options: { merge?: boolean } = {}): Promise<void> {
    const run = this.queue.catch(() => undefined).then(async () => {
      const file = this.fileOf(root, docPath);
      const current = options.merge ? await this.seen(root, docPath) : {};
      const next = { ...current, ...entries };
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      await fs.writeFile(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
      await fs.rename(temp, file);
    });
    this.queue = run;
    return run as Promise<void>;
  }
}
