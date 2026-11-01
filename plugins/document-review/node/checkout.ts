// Checkout context on the chosen host (EP-007-T02): canonical path, Git state, effective identity, confinement.
// Every path from UI/CLI is untrusted; nothing here falls back to another machine or directory.
import { formatOf } from "../core/formats/registry.ts";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRepoPath } from "../core/schema.ts";

export class CheckoutError extends Error {
  readonly code: "not-found" | "not-a-repo" | "bad-path" | "outside-repo" | "symlink" | "git-failed";
  constructor(code: CheckoutError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Environment for git: no inherited overrides of configuration, repository or identity, so the
 * effective config of the checkout itself decides (repository, worktree, includeIf, global, system).
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^GIT_/.test(key) || /^BB_/.test(key)) continue;
    env[key] = value;
  }
  // A host daemon started by a service manager may run without HOME (systemd units on Linux hosts): git then cannot
  // read ~/.gitconfig and the user's global user.email is invisible (C3). Take it from the account database.
  if (!env.HOME) {
    try { const home = os.userInfo().homedir; if (home) env.HOME = home; } catch { /* no passwd entry: leave unset */ }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

export async function git(cwd: string, args: string[], options: { allowFailure?: boolean; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: gitEnv(), timeout: options.timeoutMs ?? 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      if (error && !options.allowFailure) {
        reject(new CheckoutError("git-failed", `git ${args.join(" ")}: ${stderr.trim() || error.message}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

export interface GitIdentityResult {
  name: string | null;
  email: string | null;
}

export interface CheckoutInfo {
  /** Canonical absolute path of the working tree (realpath of `git rev-parse --show-toplevel`). */
  root: string;
  isRepo: boolean;
  /** HEAD commit, or null for an unborn branch / no Git. */
  head: string | null;
  /** Symbolic branch, or null when detached / no Git. */
  branch: string | null;
  isWorktree: boolean;
  identity: GitIdentityResult;
}

/** Resolve a checkout from an absolute directory on this machine. A folder without Git is read-only (A11). */
export async function resolveCheckout(directory: string): Promise<CheckoutInfo> {
  if (!path.isAbsolute(directory)) throw new CheckoutError("bad-path", `checkout path must be absolute: ${directory}`);
  let real: string;
  try {
    real = await fs.realpath(directory);
    if (!(await fs.stat(real)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new CheckoutError("not-found", `no such directory on this machine: ${directory}`);
  }
  const top = await git(real, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (top.code !== 0) return { root: real, isRepo: false, head: null, branch: null, isWorktree: false, identity: { name: null, email: null } };
  const root = await fs.realpath(top.stdout.trim());
  // A plain folder inside some enclosing repository (e.g. a dotfiles repo in the home directory) is not
  // that repository's checkout: it stays read-only instead of writing .bb-docs into the outer repo.
  if (root !== real) return { root: real, isRepo: false, head: null, branch: null, isWorktree: false, identity: { name: null, email: null } };
  const [head, branch, gitDir, commonDir, name, email] = await Promise.all([
    git(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true }),
    git(root, ["symbolic-ref", "-q", "--short", "HEAD"], { allowFailure: true }),
    git(root, ["rev-parse", "--absolute-git-dir"], { allowFailure: true }),
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { allowFailure: true }),
    git(root, ["config", "--get", "user.name"], { allowFailure: true }),
    git(root, ["config", "--get", "user.email"], { allowFailure: true }),
  ]);
  return {
    root,
    isRepo: true,
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    isWorktree: gitDir.stdout.trim() !== commonDir.stdout.trim(),
    identity: { name: name.code === 0 ? name.stdout.trim() || null : null, email: email.code === 0 ? email.stdout.trim() || null : null },
  };
}

/**
 * Absolute path of a repo-relative path inside `root`, refusing `..`, absolute paths and symlinks anywhere
 * on the way: a symlink out of the repo is an escape, one inside is unsupported in v1 (A8).
 * The target itself may not exist yet.
 */
export async function confine(root: string, relative: string): Promise<string> {
  if (!isRepoPath(relative)) throw new CheckoutError("bad-path", `not a repo-relative path: ${JSON.stringify(relative)}`);
  const segments = relative.split("/");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = await fs.realpath(current).catch(() => null);
      const inside = target !== null && (target === root || target.startsWith(root + path.sep));
      throw new CheckoutError(inside ? "symlink" : "outside-repo", inside ? `symlinks inside the repository are not supported: ${relative}` : `symlink leads outside the repository: ${relative}`);
    }
  }
  const absolute = path.join(root, ...segments);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new CheckoutError("outside-repo", `outside the repository: ${relative}`);
  return absolute;
}

/** Whether Git ignores a repo-relative path (G7: `.bb-docs/` ignored by Git means it is not shared). */
export async function isIgnored(root: string, relative: string): Promise<boolean> {
  const result = await git(root, ["check-ignore", "-q", "--no-index", relative], { allowFailure: true });
  return result.code === 0;
}

/** Files under .bb-docs not yet committed (untracked or modified): what Git does not protect yet (G7). */
export async function uncommittedReviewFiles(root: string): Promise<number> {
  const result = await git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", ".bb-docs"], { allowFailure: true });
  if (result.code !== 0) return 0;
  return result.stdout.split("\n").filter((line) => line.trim()).length;
}

/** Whether `.gitattributes` marks .bb-docs as generated. */
export async function generatedAttribute(root: string): Promise<boolean> {
  const result = await git(root, ["check-attr", "linguist-generated", "--", ".bb-docs/config.json"], { allowFailure: true });
  return /linguist-generated: (set|true)/.test(result.stdout);
}

/**
 * The Git checkout of an absolute file on this machine (file opener of host files, EP-013-T02): the canonical
 * working tree and the repo-relative path. A file outside any repository is refused, never guessed.
 */
export async function locateFile(file: string): Promise<{ root: string; relative: string }> {
  if (!path.isAbsolute(file)) throw new CheckoutError("bad-path", `file path must be absolute: ${file}`);
  if (!formatOf(file)) throw new CheckoutError("bad-path", `not a reviewable file type: ${file}`);
  const real = await fs.realpath(file).catch(() => null);
  if (!real) throw new CheckoutError("not-found", `no such file on this machine: ${file}`);
  const top = await git(path.dirname(real), ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (top.code !== 0) throw new CheckoutError("not-a-repo", `${file} is not inside a Git repository`);
  const root = await fs.realpath(top.stdout.trim());
  const relative = path.relative(root, real).split(path.sep).join("/");
  if (!relative || relative.startsWith("..")) throw new CheckoutError("outside-repo", `${file} is outside ${root}`);
  // No symlink between the repository and the file as it was named (a link into another repository is not followed).
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) throw new CheckoutError("symlink", `${file}: symlinks are not followed`);
    if ((await fs.realpath(current)) === root) break;
    if (path.dirname(current) === current) throw new CheckoutError("outside-repo", `${file} is outside ${root}`);
  }
  return { root, relative };
}

/**
 * A workspace path of a file opened in bb (fileOpener, kind «workspace»), resolved inside the given checkout. bb's chat
 * turns a bare `format.md` into a link with exactly that path, so a path that is not a file of the checkout is matched
 * against the Markdown files Git sees (tracked and untracked, ignored excluded) by its trailing segments: one match is
 * the file, several are offered to the reader, none is reported — the checkout itself is never changed or guessed.
 */
export async function resolveCheckoutFile(root: string, file: string): Promise<{ relative: string | null; candidates: string[] }> {
  const relative = file.replace(/^\.\//, "");
  if (!isRepoPath(relative)) throw new CheckoutError("bad-path", `not a workspace path: ${file}`);
  if (!formatOf(relative)) throw new CheckoutError("bad-path", `not a reviewable file type: ${file}`);
  const base = await fs.realpath(root).catch(() => null);
  if (!base) throw new CheckoutError("not-found", `no such checkout on this machine: ${root}`);
  // A file of the checkout itself: a regular file whose real path stays inside (no symlink out of the repository).
  const inside = async (entry: string) => {
    const full = path.join(base, entry);
    if (!(await fs.lstat(full).catch(() => null))?.isFile()) return false;
    return (await fs.realpath(full).catch(() => "")).startsWith(base + path.sep);
  };
  if (await inside(relative)) return { relative, candidates: [relative] };
  // Files Git sees (tracked and untracked, ignored excluded) of the same name; the registry decides the type (W-06c).
  const name = relative.split("/").pop()!;
  const listed = await git(base, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", `*${name}`], { allowFailure: true });
  if (listed.code !== 0) return { relative: null, candidates: [] };
  const suffix = `/${relative}`;
  const candidates = [...new Set(listed.stdout.split("\0").filter((entry) => entry && entry.endsWith(suffix) && formatOf(entry)))].sort();
  const present: string[] = [];
  for (const candidate of candidates) if (await inside(candidate)) present.push(candidate);
  return { relative: present.length === 1 ? present[0] : null, candidates: present.slice(0, 20) };
}
