// .bb-docs on a local file system (runs inside the host worker of the chosen machine).
// Create-only: temp file + fsync + link(2), which fails with EEXIST instead of replacing; then fsync of the directory.
// Replace (config CAS): compare hash, temp file + fsync + rename(2) + directory fsync, serialized per path in this process.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hash.ts";
import { isLayoutPath, type StorageBackend, StoreError } from "../core/store.ts";

const TEMP_PREFIX = ".tmp-";

async function fsyncDir(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unsupported on some file systems; rename/link durability is then up to the OS.
  } finally {
    await handle?.close();
  }
}

async function writeTemp(dir: string, bytes: Uint8Array): Promise<string> {
  const temp = path.join(dir, `${TEMP_PREFIX}${randomBytes(8).toString("hex")}`);
  const handle = await fs.open(temp, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}

const MAX_FILE = 64 * 1024 * 1024;

const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK"]);

export class FsBackend implements StorageBackend {
  private readonly queues = new Map<string, Promise<unknown>>();
  /** How the last create-only write was made; "exclusive-open" means a file system without hard links. */
  lastCreateMode: "link" | "exclusive-open" | null = null;

  readonly root: string;
  /** `root` is the absolute, already confined path of the .bb-docs directory. */
  constructor(root: string) {
    this.root = root;
  }

  private resolve(relative: string, allowDirs = false): string {
    if (!allowDirs && !isLayoutPath(relative)) throw new StoreError("bad-path", `not a .bb-docs path: ${relative}`);
    if (allowDirs && !/^(|config\.json|(events|objects|snapshots)(\/[0-9a-f]{2})?)$/.test(relative)) throw new StoreError("bad-path", `not a .bb-docs directory: ${relative}`);
    return path.join(this.root, relative);
  }

  /**
   * Refuse symlinks anywhere from .bb-docs down to the target: a repository is untrusted input, and a
   * committed symlink would otherwise redirect reads and writes outside the checkout. Missing parts are fine.
   */
  private async guard(relative: string): Promise<void> {
    const parts = relative === "" ? [] : relative.split("/");
    let current = this.root;
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = path.join(current, parts[index]);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new StoreError("bad-path", `symlink inside .bb-docs is not allowed: ${path.relative(path.dirname(this.root), current) || ".bb-docs"}`);
      const last = index === parts.length - 1;
      if (!last && !stat.isDirectory()) throw new StoreError("bad-path", `not a directory: ${path.relative(path.dirname(this.root), current)}`);
    }
  }

  async read(relative: string): Promise<Uint8Array | null> {
    const target = this.resolve(relative);
    await this.guard(relative);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") throw new StoreError("bad-path", `symlink inside .bb-docs is not allowed: ${relative}`);
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new StoreError("bad-path", `not a regular file: ${relative}`);
      if (stat.size > MAX_FILE) throw new StoreError("bad-path", `file larger than ${MAX_FILE} bytes: ${relative}`);
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  async list(dir: string): Promise<string[]> {
    const base = this.resolve(dir.replace(/\/$/, ""), true);
    await this.guard(dir.replace(/\/$/, ""));
    let entries: import("node:fs").Dirent[];
    try {
      // Entry types come with the listing: no lstat per file (thousands on a large journal, EP-015-T01).
      entries = await fs.readdir(base, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const prefix = dir === "" ? "" : `${dir.replace(/\/$/, "")}/`;
    const files: string[] = [];
    // Symlinks are never listed (a Dirent of a symlink is not a file); recursive readdir does not descend into them.
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(TEMP_PREFIX)) continue;
      const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath ?? (entry as unknown as { path?: string }).path ?? base;
      const relative = path.relative(base, path.join(parent, entry.name)).split(path.sep).join("/");
      files.push(`${prefix}${relative}`);
    }
    return files.sort();
  }

  async createExclusive(relative: string, bytes: Uint8Array): Promise<"created" | "exists"> {
    const target = this.resolve(relative);
    const dir = path.dirname(target);
    await this.guard(relative);
    await fs.mkdir(dir, { recursive: true });
    await this.guard(relative);
    const temp = await writeTemp(dir, bytes);
    try {
      await fs.link(temp, target);
      this.lastCreateMode = "link";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST") return "exists";
      if (!LINK_UNSUPPORTED.has(code)) throw error;
      // No hard links here: exclusive create of the final name. Exclusive, but a crash mid-write can leave
      // a short file, which validate reports as a hash or parse error.
      try {
        const handle = await fs.open(target, "wx", 0o644);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.lastCreateMode = "exclusive-open";
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw inner;
      }
    } finally {
      await fs.rm(temp, { force: true });
    }
    await fsyncDir(dir);
    return "created";
  }

  async replace(relative: string, bytes: Uint8Array, expectedSha256: string | null): Promise<"replaced" | "mismatch"> {
    const target = this.resolve(relative);
    const previous = this.queues.get(target) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      await this.guard(relative);
      const current = await this.read(relative);
      const currentSha = current ? sha256(current) : null;
      if (currentSha !== expectedSha256) return "mismatch" as const;
      const dir = path.dirname(target);
      await fs.mkdir(dir, { recursive: true });
      const temp = await writeTemp(dir, bytes);
      try {
        await fs.rename(temp, target);
      } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
      }
      await fsyncDir(dir);
      return "replaced" as const;
    });
    this.queues.set(target, run);
    try {
      return await run;
    } finally {
      if (this.queues.get(target) === run) this.queues.delete(target);
    }
  }
}
