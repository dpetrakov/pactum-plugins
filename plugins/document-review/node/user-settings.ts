// Settings of one user on this machine (W-06c, file-types.md §4, §8, §12): global exclusion rules and exemptions from
// them per repository, global secret-key pattern extensions, personal secret exemptions, retention of
// local data. One JSON file per reader in the plugin's data directory (never in a repository, never in .bb-docs);
// written atomically. Unknown or damaged content reads as empty settings — nothing here is needed for shared data.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hash.ts";

export interface UserSettings {
  version: 1;
  /** Global exclusion rules (gitignore syntax) for all checkouts of this user on this machine. */
  exclude: string[];
  /** Exemptions from global exclusion rules for one repository: repoId → patterns not applied there. */
  exemptFromGlobal: Record<string, string[]>;
  /** Global extensions of the secret-key pattern (display, packages, logs, CLI, local store). */
  secretKeys: string[];
  /** «Not a secret — for me»: repoId → file path → key paths (JSON) shown without a click. */
  exemptions: Record<string, Record<string, string[]>>;
  /** Retention of data of deleted local files: days, 0 = at once, null = never (EP-048). */
  retentionDays: number | null;
}

export const EMPTY_SETTINGS: UserSettings = { version: 1, exclude: [], exemptFromGlobal: {}, secretKeys: [], exemptions: {}, retentionDays: 30 };

function fileOf(dataDir: string, readerId: string): string {
  return path.join(dataDir, "user-settings", `${sha256(readerId.trim().toLowerCase()).slice(0, 24)}.json`);
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 4096) : []);

function normalize(raw: unknown): UserSettings {
  if (!raw || typeof raw !== "object") return structuredClone(EMPTY_SETTINGS);
  const value = raw as Record<string, unknown>;
  const exemptFromGlobal: Record<string, string[]> = {};
  for (const [repoId, list] of Object.entries((value.exemptFromGlobal as Record<string, unknown>) ?? {})) exemptFromGlobal[repoId] = strings(list);
  const exemptions: Record<string, Record<string, string[]>> = {};
  for (const [repoId, files] of Object.entries((value.exemptions as Record<string, unknown>) ?? {})) {
    if (!files || typeof files !== "object") continue;
    exemptions[repoId] = {};
    for (const [file, list] of Object.entries(files as Record<string, unknown>)) exemptions[repoId][file] = strings(list);
  }
  const retention = value.retentionDays;
  return {
    version: 1,
    exclude: strings(value.exclude),
    exemptFromGlobal,
    secretKeys: strings(value.secretKeys),
    exemptions,
    retentionDays: retention === null ? null : typeof retention === "number" && Number.isInteger(retention) && retention >= 0 && retention <= 3650 ? retention : 30,
  };
}

const cache = new Map<string, { at: number; value: UserSettings }>();

export async function readUserSettings(dataDir: string, readerId: string | null): Promise<UserSettings> {
  if (!readerId) return structuredClone(EMPTY_SETTINGS);
  const file = fileOf(dataDir, readerId);
  const hit = cache.get(file);
  if (hit && Date.now() - hit.at < 2000) return hit.value;
  let value: UserSettings;
  try {
    value = normalize(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    value = structuredClone(EMPTY_SETTINGS);
  }
  cache.set(file, { at: Date.now(), value });
  return value;
}

/** Atomic read-modify-write of one user's settings (serialized inside this process). */
let queue: Promise<unknown> = Promise.resolve();
export function updateUserSettings(dataDir: string, readerId: string, change: (settings: UserSettings) => void): Promise<UserSettings> {
  const run = queue.catch(() => undefined).then(async () => {
    const file = fileOf(dataDir, readerId);
    cache.delete(file);
    const current = await readUserSettings(dataDir, readerId);
    const next = structuredClone(current);
    change(next);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
    cache.set(file, { at: Date.now(), value: next });
    return next;
  });
  queue = run;
  return run;
}
