// Host side of secrets (W-06c, file-types.md §8, EP-039-T05/T07): «Reveal value» for this checkout's UI only
// (context checked like a write, one value, never cached), «value changed» cleared by looking, and «Not a secret»
// exemptions use personal display settings for the current reader, or shared repository rules for everyone in
// config.json `secretExemptions` (CAS, the value becomes shared). Explicit secrets are never exempted; an ignored .env
// only «for me». Every refusal is decided here, not by the client.
import { canonicalBytes } from "../core/canonical-json.ts";
import { tr } from "../core/i18n.ts";
import type { PathSegment } from "../core/formats/assemble.ts";
import { exemptionFor, MASK } from "../core/formats/secrets.ts";
import { parseStructured } from "../core/formats/structured.ts";
import { formatOf } from "../core/formats/registry.ts";
import { sha256 } from "../core/hash.ts";
import { normalizeReaderId } from "../core/reading.ts";
import { type Config, configVersion, parseConfig } from "../core/schema.ts";
import { layout, writeConfig } from "../core/store.ts";
import type { Revision } from "../core/types.ts";
import { readRegular, revealValue, sharedRules } from "./content.ts";
import { ReviewError, type ReviewService } from "./service.ts";
import { updateUserSettings } from "./user-settings.ts";
import { markSecretsSeen } from "./view.ts";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** One secret value for «Reveal value»: the checkout must be the one shown (HEAD and branch), never cached. */
export async function revealSecret(service: ReviewService, input: { path: string; keyPath?: string | null; line?: number | null; place?: string | null; head?: string | null; branch?: string | null }) {
  const info = await service.checkout();
  // The context is required (security review): the value is shown only for the checkout state the UI showed.
  if (input.head === undefined || input.branch === undefined) throw new ReviewError("context-changed", "the shown checkout state (head, branch) is required to reveal a value");
  if (input.head !== info.head) throw new ReviewError("context-changed", "the checkout moved since the document was shown; reopen it");
  if (input.branch !== info.branch) throw new ReviewError("context-changed", "the branch changed since the document was shown; reopen it");
  const found = await revealValue(service, input.path, { keyPath: input.keyPath ?? null, line: input.line ?? null, place: input.place ?? null });
  if (!found) throw new ReviewError("not-found", "no such secret in the current file");
  // Looking at the value is «seen» on this device — except a file outside Git: nothing is stored for it.
  if (service.reviews(await service.fileClass(input.path))) await markSecretsSeen(service, input.path, [found.place]).catch(() => undefined);
  return { value: found.value, length: found.length, place: found.place };
}

function readerOf(info: { identity: { email: string | null } }): string {
  try {
    return normalizeReaderId(info.identity.email);
  } catch (error) {
    throw new ReviewError("no-identity", error instanceof Error ? error.message : String(error));
  }
}

/** How many stored revisions of the file already hold the value at this path unmasked (it stays in Git history). */
async function revisionsWithValue(service: ReviewService, docPath: string, keyPath: PathSegment[]): Promise<number> {
  const format = formatOf(docPath);
  if (!format) return 0;
  const state = await service.state();
  const docId = service.docIdOf(state, docPath);
  if (!docId) return 0;
  let count = 0;
  for (const revisionId of state.documents.get(docId)?.revisions ?? []) {
    const record = state.revisions.get(revisionId);
    const revision = record ? (state.objects.get(record.objectSha) as Revision | undefined) : undefined;
    const bytes = revision ? await service.store.read(layout.snapshot(revision.snapshot)) : null;
    if (!bytes) continue;
    const text = decoder.decode(bytes);
    if (format === "dotenv") {
      const key = String(keyPath[0]);
      const line = text.split("\n").find((entry) => entry.replace(/^export\s+/, "").startsWith(`${key}=`));
      if (line && !line.includes(MASK)) count++;
      continue;
    }
    const parsed = parseStructured(format as "yaml", text);
    if (!parsed.ok) continue;
    const atom = parsed.atoms.find((candidate) => candidate.meta?.path && JSON.stringify(candidate.meta.path) === JSON.stringify(keyPath));
    if (atom && atom.meta?.value !== undefined && !atom.meta.value.includes(MASK)) count++;
  }
  return count;
}

export interface ExemptionInput {
  path: string;
  /** Concrete key path of the leaf (JSON array), or [KEY] of a .env value. */
  keyPath: string;
  level: "me" | "repo";
  action: "add" | "remove";
  /** Only compute what would happen (repository level): nothing is written. */
  preview?: boolean;
  configSha?: string | null;
  head?: string | null;
  branch?: string | null;
}

export async function setSecretExemption(service: ReviewService, input: ExemptionInput) {
  return service.serial(async () => {
    const info = await service.checkout();
    if (input.head !== undefined && input.head !== info.head) throw new ReviewError("context-changed", "the checkout moved since the document was shown; nothing was saved");
    let keyPath: PathSegment[];
    try {
      keyPath = JSON.parse(input.keyPath) as PathSegment[];
      if (!Array.isArray(keyPath) || !keyPath.length) throw new Error("empty");
    } catch {
      throw new ReviewError("bad-input", "keyPath is a JSON array of key path segments");
    }
    const absolute = await service.documentFile(input.path);
    const source = decoder.decode(await readRegular(absolute));
    const fileClass = await service.fileClass(input.path);
    const configRead = await service.config();
    const config = configRead.value;
    const readerId = readerOf(info);
    if (input.level === "me") {
      if (!config) throw new ReviewError("not-enabled", "review is not enabled in this checkout");
      if (input.action === "add") {
        const check = exemptionFor(input.path, source, keyPath, sharedRules(config, input.path, fileClass));
        if ("error" in check) throw new ReviewError(check.error === "explicit" ? "explicit-secret" : "bad-input", check.error === "explicit" ? "an explicit secret (private key, URL password) cannot be exempted" : `not an exemptable secret: ${check.error}`);
      }
      if (input.preview) return { status: "preview" as const, level: "me" as const, shared: false };
      const settings = await updateUserSettings(service.dataDir, readerId, (next) => {
        const files = (next.exemptions[config.repoId] ??= {});
        const list = new Set(files[input.path] ?? []);
        if (input.action === "add") list.add(JSON.stringify(keyPath));
        else list.delete(JSON.stringify(keyPath));
        files[input.path] = [...list].sort();
        if (!files[input.path].length) delete files[input.path];
      });
      service.invalidate();
      return { status: "saved" as const, level: "me" as const, exemptions: settings.exemptions[config.repoId]?.[input.path] ?? [] };
    }
    // Repository level: the value becomes part of the shared data (.bb-docs, Git history, packages).
    const { actor } = await service.writable(input);
    void actor;
    if (fileClass === "outside" && formatOf(input.path) === "dotenv") throw new ReviewError("outside-git", "a .env ignored by Git is exempted only «for me»");
    if (fileClass !== "git") throw new ReviewError("not-in-git", "«for everyone in the repository» needs the file in the Git index; commit it first or exempt «for me»");
    if (!config) throw new ReviewError("not-enabled", "review is not enabled in this checkout");
    const rules = sharedRules(config, input.path, fileClass);
    let exemptionKey: string | null = null;
    if (input.action === "add") {
      const check = exemptionFor(input.path, source, keyPath, rules);
      if ("error" in check) throw new ReviewError(check.error === "explicit" ? "explicit-secret" : "bad-input", check.error === "explicit" ? "an explicit secret (private key, URL password) cannot be exempted" : `not an exemptable secret: ${check.error}`);
      exemptionKey = check.keyPath;
    }
    const existing = (config.secretExemptions ?? []).filter((entry) => entry.path === input.path);
    const removeKeys = input.action === "remove" ? existing.filter((entry) => {
      try {
        const parsed = JSON.parse(entry.keyPath) as unknown[];
        return parsed.length === keyPath.length && parsed.every((segment, index) => (segment && typeof segment === "object" && "i" in (segment as object) ? true : segment === keyPath[index]));
      } catch {
        return false;
      }
    }).map((entry) => entry.keyPath) : [];
    const preview = {
      where: [tr(".bb-docs (snapshots, Git history)", ".bb-docs (снимки, история Git)"), tr("review batches for the agent", "пакеты агенту"), tr("logs and the CLI", "журналы и CLI")],
      irreversible: input.action === "add",
      revisionsWithValue: input.action === "remove" ? await revisionsWithValue(service, input.path, keyPath) : 0,
    };
    if (input.preview) return { status: "preview" as const, level: "repo" as const, shared: true, ...preview };
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await service.config();
      if (!read.value || read.readOnly) throw new ReviewError("read-only", read.problem ?? "config.json cannot be used for writing");
      if (input.configSha !== undefined && input.configSha !== null && input.configSha !== read.sha) throw new ReviewError("stale", "config.json changed since it was shown; review it again");
      const current = read.value.secretExemptions ?? [];
      const nextList = input.action === "add"
        ? [...current.filter((entry) => !(entry.path === input.path && entry.keyPath === exemptionKey)), { path: input.path, keyPath: exemptionKey! }]
        : current.filter((entry) => !(entry.path === input.path && removeKeys.includes(entry.keyPath)));
      if (input.action === "remove" && nextList.length === current.length) return { status: "unchanged" as const, level: "repo" as const };
      const next: Config = { ...read.value, secretExemptions: nextList.sort((a, b) => (a.path + a.keyPath < b.path + b.keyPath ? -1 : 1)) };
      if (!next.secretExemptions!.length) delete next.secretExemptions;
      next.schemaVersion = configVersion(next) === "1.2" || read.value.schemaVersion === "1.2" ? "1.2" : read.value.schemaVersion;
      const parsed = parseConfig(next);
      if (!parsed.ok) throw new ReviewError("bad-input", parsed.issues.join("; "));
      if ((await writeConfig(service.store, canonicalBytes(next), read.sha)) !== "replaced") continue;
      service.invalidate();
      return { status: "saved" as const, level: "repo" as const, configSha: sha256(canonicalBytes(next)), ...preview };
    }
    throw new ReviewError("config-conflict", "config.json keeps changing concurrently; reload and try again");
  });
}
