// Storage of .bb-docs and the publish protocol (architecture §4, format.md):
// snapshots and objects are created once under their content hash, the event file is written last and
// is the commit point. A crash before it leaves only unreferenced objects; replay restores the rest.
import { canonicalBytes } from "./canonical-json.ts";
import { sha256 } from "./hash.ts";
import { type ObjectValue, type Operation, parseObject, parseOperation } from "./schema.ts";

/** Files under one .bb-docs directory. Paths are relative to it and always produced by `layout`. */
export interface StorageBackend {
  read(path: string): Promise<Uint8Array | null>;
  /** Files under `dir` (recursive), relative to the storage root; a missing directory is empty. */
  list(dir: string): Promise<string[]>;
  /** Atomically create the file; never replaces. "exists" leaves the present bytes untouched. */
  createExclusive(path: string, bytes: Uint8Array): Promise<"created" | "exists">;
  /** Atomically replace the file iff its sha256 equals `expectedSha256` (null: it must not exist). */
  replace(path: string, bytes: Uint8Array, expectedSha256: string | null): Promise<"replaced" | "mismatch">;
}

export const layout = {
  config: "config.json",
  event: (id: string) => `events/${id.slice(0, 2)}/${id}.json`,
  object: (sha: string) => `objects/${sha.slice(0, 2)}/${sha}.json`,
  snapshot: (sha: string) => `snapshots/${sha.slice(0, 2)}/${sha}.md`,
};

const EVENT_PATH = /^events\/([0-9a-f]{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const OBJECT_PATH = /^objects\/([0-9a-f]{2})\/([0-9a-f]{64})\.json$/;
const SNAPSHOT_PATH = /^snapshots\/([0-9a-f]{2})\/([0-9a-f]{64})\.md$/;

export type StoredFile =
  | { kind: "config" }
  | { kind: "event"; id: string }
  | { kind: "object"; sha: string }
  | { kind: "snapshot"; sha: string }
  | { kind: "unknown" };

/** What a path inside .bb-docs is; anything not produced by `layout` is "unknown". */
export function classify(path: string): StoredFile {
  if (path === layout.config) return { kind: "config" };
  let match = EVENT_PATH.exec(path);
  if (match && match[2].startsWith(match[1])) return { kind: "event", id: match[2] };
  match = OBJECT_PATH.exec(path);
  if (match && match[2].startsWith(match[1])) return { kind: "object", sha: match[2] };
  match = SNAPSHOT_PATH.exec(path);
  if (match && match[2].startsWith(match[1])) return { kind: "snapshot", sha: match[2] };
  return { kind: "unknown" };
}

export function isLayoutPath(path: string): boolean {
  return classify(path).kind !== "unknown";
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/** In-memory backend for tests and for building data before it reaches a host. */
export class MemoryBackend implements StorageBackend {
  readonly files = new Map<string, Uint8Array>();

  async read(path: string) {
    const bytes = this.files.get(path);
    return bytes ? bytes.slice() : null;
  }

  async list(dir: string) {
    const prefix = dir === "" ? "" : `${dir.replace(/\/$/, "")}/`;
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort();
  }

  async createExclusive(path: string, bytes: Uint8Array) {
    if (!isLayoutPath(path)) throw new StoreError("bad-path", `not a .bb-docs path: ${path}`);
    if (this.files.has(path)) return "exists" as const;
    this.files.set(path, bytes.slice());
    return "created" as const;
  }

  async replace(path: string, bytes: Uint8Array, expectedSha256: string | null) {
    if (!isLayoutPath(path)) throw new StoreError("bad-path", `not a .bb-docs path: ${path}`);
    const current = this.files.get(path);
    const currentSha = current ? sha256(current) : null;
    if (currentSha !== expectedSha256) return "mismatch" as const;
    this.files.set(path, bytes.slice());
    return "replaced" as const;
  }

  /** Copy of the files: a "clone" of the repository data. */
  clone(): MemoryBackend {
    const copy = new MemoryBackend();
    for (const [path, bytes] of this.files) copy.files.set(path, bytes.slice());
    return copy;
  }
}

export type StoreErrorCode =
  | "bad-path"
  | "invalid-operation"
  | "invalid-object"
  | "missing-reference"
  | "corrupt-object"
  | "operation-conflict"
  | "read-only"
  | "crash";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ── references ─────────────────────────────────────────────────────────────

export interface References {
  objects: string[];
  snapshots: string[];
  revisions: string[];
  events: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Everything an operation points at: object hashes, persistent revisions and parent events. */
export function operationReferences(operation: Operation): References {
  const objects: string[] = [];
  const revisions: string[] = [];
  for (const change of operation.changes) {
    switch (change.type) {
      case "document.observed": objects.push(change.revision); break;
      case "annotation.created": objects.push(change.annotation); break;
      case "annotation.reanchored": objects.push(change.target); revisions.push(change.revisionId); break;
      case "anchor.resolved": objects.push(change.resolution); revisions.push(change.revisionId); break;
      case "read.acknowledged": revisions.push(change.revisionId); break;
      case "layout.pinned":
      case "layout.unpinned": revisions.push(change.revisionId); break;
      case "batch.prepared": objects.push(change.manifest); break;
      case "batch.input-registered": revisions.push(change.revisionId); break;
      case "item.result-recorded":
        revisions.push(...change.before, ...change.after, ...change.claimedEdits.map((edit) => edit.revisionId));
        break;
      default: break;
    }
  }
  return { objects: unique(objects), snapshots: [], revisions: unique(revisions), events: unique(operation.parents) };
}

/** What an object points at. Revision parents and targets must be persistent revisions (DR-03). */
export function objectReferences(object: ObjectValue): References {
  switch (object.type) {
    case "Revision": return { objects: [], snapshots: [object.snapshot], revisions: unique(object.parents), events: [] };
    case "Annotation": return { objects: [], snapshots: [object.target["bbdr:snapshot"]], revisions: [object.target["bbdr:revisionId"]], events: [] };
    case "AnchorResolution": return { objects: [], snapshots: [], revisions: [object.revisionId], events: [] };
    case "BatchManifest": return { objects: [], snapshots: [], revisions: unique(object.documents.map((doc) => doc.revisionId)), events: [] };
  }
}

/** Revisions an operation makes persistent: `document.observed` revision ids. */
export function observedRevisions(operation: Operation): string[] {
  return operation.changes.flatMap((change) => change.type === "document.observed" ? [change.revisionId] : []);
}

// ── publish ───────────────────────────────────────────────────────────────

export interface OperationDraft {
  operation: Operation;
  objects: ObjectValue[];
  /** Raw Markdown bytes of revisions referenced by objects of this operation. */
  snapshots: Uint8Array[];
}

export interface PublishContext {
  /** True when the revision is already persistent in this checkout's journal. */
  isKnownRevision(revisionId: string): boolean;
}

export interface PublishResult {
  status: "published" | "duplicate";
  eventId: string;
  created: { snapshots: number; objects: number };
}

export function encodeOperation(operation: Operation): Uint8Array {
  return canonicalBytes(operation);
}

export function encodeObject(object: ObjectValue): { sha: string; bytes: Uint8Array } {
  const bytes = canonicalBytes(object);
  return { sha: sha256(bytes), bytes };
}

async function ensureFile(store: StorageBackend, path: string, bytes: Uint8Array): Promise<boolean> {
  const outcome = await store.createExclusive(path, bytes);
  if (outcome === "created") return true;
  const present = await store.read(path);
  if (present && sameBytes(present, bytes)) return false;
  // The name is the hash of the content. Bytes that do not even match their own name are a damaged write
  // (a short file after a crash): replace them atomically. Bytes that match the name but differ cannot exist.
  const expected = sha256(bytes);
  if (present && sha256(present) !== expected && (await store.replace(path, bytes, sha256(present))) === "replaced") return true;
  throw new StoreError("corrupt-object", `${path} exists with different bytes`);
}

async function presentWithHash(store: StorageBackend, path: string, sha: string): Promise<boolean> {
  const bytes = await store.read(path);
  return bytes !== null && sha256(bytes) === sha;
}

/**
 * Publish one operation. Order: verify → snapshots → objects → event (create-only, last).
 * Repeating the same operation id with identical bytes is "duplicate"; with other bytes it is refused
 * and the existing event is never replaced.
 */
export async function publish(store: StorageBackend, draft: OperationDraft, context: PublishContext): Promise<PublishResult> {
  const parsed = parseOperation(draft.operation);
  if (!parsed.ok) throw new StoreError("invalid-operation", parsed.issues.join("; "));
  if (parsed.version !== "current") throw new StoreError("read-only", "operation of a newer schema version");
  const operation = parsed.value;
  const eventBytes = encodeOperation(operation);

  const snapshots = new Map<string, Uint8Array>();
  for (const bytes of draft.snapshots) snapshots.set(sha256(bytes), bytes);
  const objects = new Map<string, { bytes: Uint8Array; value: ObjectValue }>();
  for (const object of draft.objects) {
    const checked = parseObject(object);
    if (!checked.ok || checked.version !== "current") throw new StoreError("invalid-object", checked.ok ? "newer schema version" : checked.issues.join("; "));
    const { sha, bytes } = encodeObject(checked.value);
    objects.set(sha, { bytes, value: checked.value });
  }

  // Every reference must resolve before anything is written.
  const references = operationReferences(operation);
  const observed = new Set(observedRevisions(operation));
  const knownRevision = (id: string) => observed.has(id) || context.isKnownRevision(id);
  const missing: string[] = [];
  for (const sha of references.objects) {
    if (!objects.has(sha) && !(await presentWithHash(store, layout.object(sha), sha))) missing.push(`object ${sha}`);
  }
  for (const id of references.revisions) if (!knownRevision(id)) missing.push(`revision ${id}`);
  for (const id of references.events) if ((await store.read(layout.event(id))) === null) missing.push(`parent event ${id}`);
  for (const { value } of objects.values()) {
    const refs = objectReferences(value);
    for (const sha of refs.snapshots) {
      if (!snapshots.has(sha) && !(await presentWithHash(store, layout.snapshot(sha), sha))) missing.push(`snapshot ${sha}`);
    }
    for (const id of refs.revisions) if (!knownRevision(id)) missing.push(`revision ${id}`);
  }
  for (const change of operation.changes) {
    if (change.type !== "document.observed") continue;
    const revision = objects.get(change.revision)?.value;
    if (revision && (revision.type !== "Revision" || revision.revisionId !== change.revisionId || revision.docId !== change.docId)) {
      throw new StoreError("invalid-operation", `document.observed ${change.revisionId} does not match its Revision object`);
    }
  }
  if (missing.length) throw new StoreError("missing-reference", `unresolved: ${missing.slice(0, 10).join(", ")}`);

  let createdSnapshots = 0;
  let createdObjects = 0;
  for (const [sha, bytes] of [...snapshots].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (await ensureFile(store, layout.snapshot(sha), bytes)) createdSnapshots++;
  }
  for (const [sha, { bytes }] of [...objects].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (await ensureFile(store, layout.object(sha), bytes)) createdObjects++;
  }

  const path = layout.event(operation.id);
  const outcome = await store.createExclusive(path, eventBytes);
  if (outcome === "exists") {
    const present = await store.read(path);
    if (!present || !sameBytes(present, eventBytes)) throw new StoreError("operation-conflict", `operation ${operation.id} already exists with other content`);
    return { status: "duplicate", eventId: operation.id, created: { snapshots: createdSnapshots, objects: createdObjects } };
  }
  return { status: "published", eventId: operation.id, created: { snapshots: createdSnapshots, objects: createdObjects } };
}

/** Compare-and-swap of config.json (the only mutable file). */
export async function writeConfig(store: StorageBackend, bytes: Uint8Array, expectedSha256: string | null): Promise<"replaced" | "mismatch"> {
  return store.replace(layout.config, bytes, expectedSha256);
}

// ── fault injection ───────────────────────────────────────────────────────

/**
 * Wraps a backend and "crashes" at mutating step `crashAt` (0-based): `before` loses that write,
 * `after` performs it and then fails, like a process killed right after rename.
 */
export class CrashingBackend implements StorageBackend {
  steps = 0;
  private readonly inner: StorageBackend;
  private readonly crashAt: number;
  private readonly when: "before" | "after";
  constructor(inner: StorageBackend, crashAt: number, when: "before" | "after") {
    this.inner = inner;
    this.crashAt = crashAt;
    this.when = when;
  }

  read(path: string) { return this.inner.read(path); }
  list(dir: string) { return this.inner.list(dir); }

  private async step<T>(run: () => Promise<T>): Promise<T> {
    const index = this.steps++;
    if (index === this.crashAt && this.when === "before") throw new StoreError("crash", `crash before step ${index}`);
    const result = await run();
    if (index === this.crashAt && this.when === "after") throw new StoreError("crash", `crash after step ${index}`);
    return result;
  }

  createExclusive(path: string, bytes: Uint8Array) { return this.step(() => this.inner.createExclusive(path, bytes)); }
  replace(path: string, bytes: Uint8Array, expectedSha256: string | null) { return this.step(() => this.inner.replace(path, bytes, expectedSha256)); }
}
