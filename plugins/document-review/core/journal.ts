// Journal projection (EP-005-T03): events are replayed by their causal parents, never by clocks or file order.
// Independent events of two branches simply coexist; contradicting concurrent values of one register
// (status, kind, message text, document path) are a visible conflict until a later event dominates them.
import { sha256 } from "./hash.ts";
import {
  type Change, type Config, type ObjectValue, type Operation, parseConfig, parseObject, parseOperation, type VersionVerdict,
} from "./schema.ts";
import { classify, layout, objectReferences, operationReferences, type StorageBackend } from "./store.ts";

export type Severity = "error" | "warning" | "info";

export interface Problem {
  code: string;
  severity: Severity;
  message: string;
  path?: string;
  entity?: string;
}

export interface RepositoryData {
  config: { value: Config | null; sha: string | null; version: VersionVerdict | "missing"; issues: string[] };
  events: Map<string, Operation>;
  /** Events of a newer minor version: projected, but their entities are read-only. */
  newerMinor: Set<string>;
  /**
   * Events of a newer minor version with changes this code cannot parse (G3): not projected, but kept as known events
   * so their children are not incomplete; the entities they name become read-only.
   */
  opaque: Map<string, { parents: string[]; entities: string[]; version: string }>;
  /** Objects of a newer minor version this code cannot parse (EP-040-T06): present, not understood — read-only, not missing. */
  opaqueObjects: Set<string>;
  objects: Map<string, ObjectValue>;
  snapshots: Set<string>;
  problems: Problem[];
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function parseJson(bytes: Uint8Array): { ok: true; value: unknown; text: string } | { ok: false; error: string } {
  try {
    const text = decoder.decode(bytes);
    return { ok: true, value: JSON.parse(text), text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Parsed immutable objects by the sha256 of their bytes (current schema only); the bytes are still read and hashed. */
const parsedObjects = new Map<string, ObjectValue>();

/** Forget parsed objects (measurements of a cold start in one process). */
export function clearParsedObjects(): void {
  parsedObjects.clear();
}

/** Read files with bounded parallelism; results by path, the processing order stays the caller's. */
async function readMany(paths: string[], read: (path: string) => Promise<Uint8Array | null>): Promise<Map<string, Uint8Array | null>> {
  const result = new Map<string, Uint8Array | null>();
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next++];
      result.set(path, await read(path));
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, paths.length) }, worker));
  return result;
}

/**
 * A restorable cache of parsed immutable files (EP-015-T01), kept outside the repository by the host. Events and
 * objects are create-only and named by their id / content hash, so a name seen before stands for the same bytes; only
 * files that parsed as the current schema are cached. Deleting the cache changes only the time (tests compare).
 * validate never uses it: it always reads and hashes every file.
 */
export interface ParsedFileCache {
  get(path: string): unknown | undefined;
  set(path: string, value: unknown): void;
}

/** Read .bb-docs into memory. Damaged files become problems; nothing here throws on bad data. */
export async function loadRepository(store: StorageBackend, options: { cache?: ParsedFileCache } = {}): Promise<RepositoryData> {
  const fileCache = options.cache;
  const problems: Problem[] = [];
  const data: RepositoryData = {
    config: { value: null, sha: null, version: "missing", issues: [] },
    events: new Map(), newerMinor: new Set(), opaque: new Map(), opaqueObjects: new Set(), objects: new Map(), snapshots: new Set(), problems,
  };

  const readSafely = async (path: string) => {
    try {
      return await store.read(path);
    } catch (error) {
      problems.push({ code: "unreadable", severity: "error", path, message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };
  const listSafely = async (dir: string) => {
    try {
      return await store.list(dir);
    } catch (error) {
      problems.push({ code: "unreadable", severity: "error", path: dir, message: error instanceof Error ? error.message : String(error) });
      return [];
    }
  };
  const configBytes = await readSafely(layout.config);
  if (configBytes) {
    data.config.sha = sha256(configBytes);
    const json = parseJson(configBytes);
    if (!json.ok) {
      data.config.version = "invalid";
      data.config.issues = [json.error];
    } else {
      const parsed = parseConfig(json.value);
      data.config.version = parsed.ok ? parsed.version : parsed.version;
      if (parsed.ok) data.config.value = parsed.value;
      else data.config.issues = parsed.issues;
    }
    if (data.config.version !== "current" && data.config.version !== "newer-minor") {
      problems.push({ code: data.config.version === "unknown-major" ? "unknown-schema" : "schema-invalid", severity: "error", path: layout.config, message: data.config.issues.join("; ") });
    }
  }

  for (const path of await listSafely("snapshots")) {
    const file = classify(path);
    if (file.kind === "snapshot") data.snapshots.add(file.sha);
    else problems.push({ code: "unknown-file", severity: "warning", path, message: "not a .bb-docs layout path" });
  }

  const objectPaths = await listSafely("objects");
  const cachedObjects = new Map<string, ObjectValue>();
  if (fileCache) {
    for (const path of objectPaths) {
      const value = fileCache.get(path);
      if (value !== undefined) cachedObjects.set(path, value as ObjectValue);
    }
  }
  const objectBytes = await readMany(objectPaths.filter((path) => classify(path).kind === "object" && !cachedObjects.has(path)), readSafely);
  for (const path of objectPaths) {
    const file = classify(path);
    if (file.kind !== "object") {
      problems.push({ code: "unknown-file", severity: "warning", path, message: "not a .bb-docs layout path" });
      continue;
    }
    const hit = cachedObjects.get(path);
    if (hit) {
      data.objects.set(file.sha, hit);
      continue;
    }
    const bytes = objectBytes.get(path) ?? null;
    if (!bytes) continue;
    if (sha256(bytes) !== file.sha) {
      problems.push({ code: "hash-mismatch", severity: "error", path, message: "content does not match the file name hash" });
      continue;
    }
    // Objects are immutable and named by the hash of their bytes (checked above): a parsed object is reused.
    const cached = parsedObjects.get(file.sha);
    if (cached) {
      data.objects.set(file.sha, cached);
      continue;
    }
    const json = parseJson(bytes);
    const parsed = json.ok ? parseObject(json.value, json.text) : null;
    if (parsed && !parsed.ok && parsed.version === "newer-minor") {
      data.opaqueObjects.add(file.sha);
      problems.push({ code: "read-only", severity: "warning", path, message: "object of a newer schema version; the entities that reference it are read-only until the plugin is updated" });
      continue;
    }
    if (!parsed || !parsed.ok) {
      const unknown = parsed && !parsed.ok && parsed.version === "unknown-major";
      problems.push({ code: unknown ? "unknown-schema" : "schema-invalid", severity: "error", path, message: parsed && !parsed.ok ? parsed.issues.join("; ") : json.ok ? "" : json.error });
      continue;
    }
    data.objects.set(file.sha, parsed.value);
    if (parsed.version === "current") {
      fileCache?.set(path, parsed.value);
      parsedObjects.set(file.sha, parsed.value);
      if (parsedObjects.size > 50_000) parsedObjects.delete(parsedObjects.keys().next().value!);
    }
  }

  const eventPaths = await listSafely("events");
  const cachedEvents = new Map<string, Operation>();
  if (fileCache) {
    for (const path of eventPaths) {
      const value = fileCache.get(path);
      if (value !== undefined) cachedEvents.set(path, value as Operation);
    }
  }
  const eventBytes = await readMany(eventPaths.filter((path) => classify(path).kind === "event" && !cachedEvents.has(path)), readSafely);
  for (const path of eventPaths) {
    const file = classify(path);
    if (file.kind !== "event") {
      problems.push({ code: "unknown-file", severity: "warning", path, message: "not a .bb-docs layout path" });
      continue;
    }
    const hitEvent = cachedEvents.get(path);
    if (hitEvent && hitEvent.id === file.id) {
      data.events.set(file.id, hitEvent);
      continue;
    }
    const bytes = eventBytes.get(path) ?? null;
    if (!bytes) continue;
    const json = parseJson(bytes);
    const parsed = json.ok ? parseOperation(json.value, json.text) : null;
    if (parsed && !parsed.ok && parsed.version === "newer-minor" && json.ok) {
      const opaque = opaqueEvent(json.value, file.id);
      if (opaque) {
        data.opaque.set(file.id, opaque);
        problems.push({ code: "read-only", severity: "warning", path, message: `event of schema ${opaque.version} has changes this plugin does not know; ${opaque.entities.length} entit(ies) are read-only until the plugin is updated` });
        continue;
      }
    }
    if (!parsed || !parsed.ok) {
      const unknown = parsed && !parsed.ok && parsed.version === "unknown-major";
      problems.push({ code: unknown ? "unknown-schema" : "schema-invalid", severity: "error", path, message: parsed && !parsed.ok ? parsed.issues.join("; ") : json.ok ? "" : json.error });
      continue;
    }
    if (parsed.value.id !== file.id) {
      problems.push({ code: "schema-invalid", severity: "error", path, message: `operation id ${parsed.value.id} does not match the file name` });
      continue;
    }
    data.events.set(file.id, parsed.value);
    if (parsed.version === "newer-minor") data.newerMinor.add(file.id);
    else fileCache?.set(path, parsed.value);
  }
  return data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The envelope of an event of a newer minor: its parents and the entities its changes name (G3). */
function opaqueEvent(raw: unknown, id: string): { parents: string[]; entities: string[]; version: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { id?: unknown; parents?: unknown; changes?: unknown; schemaVersion?: unknown };
  if (value.id !== id || !Array.isArray(value.parents) || !Array.isArray(value.changes)) return null;
  const parents = value.parents.filter((parent): parent is string => typeof parent === "string" && UUID.test(parent));
  const entities = new Set<string>();
  for (const change of value.changes) {
    if (!change || typeof change !== "object") continue;
    const fields = change as Record<string, unknown>;
    const idOf = (key: string) => (typeof fields[key] === "string" && UUID.test(fields[key] as string) ? (fields[key] as string) : null);
    if (idOf("docId")) entities.add(entity.doc(idOf("docId")!));
    if (idOf("annotationId")) entities.add(entity.annotation(idOf("annotationId")!));
    if (idOf("runId")) entities.add(entity.run(idOf("runId")!));
    if (typeof fields.readerId === "string" && fields.readerId.length <= 320) entities.add(entity.reader(fields.readerId));
  }
  return { parents, entities: [...entities].sort(), version: String(value.schemaVersion) };
}

// ── entities and registers ────────────────────────────────────────────────

export const entity = {
  doc: (docId: string) => `doc:${docId}`,
  annotation: (annotationId: string) => `annotation:${annotationId}`,
  reader: (readerId: string) => `reader:${readerId}`,
  run: (runId: string) => `run:${runId}`,
  /** 1.3: one reader's layout of one diagram block; hashed so neither an email nor a node id can contain the «#» of a register key. */
  layout: (scope: { doc: string; lineage: string; reader: string }) => `layout:${sha256(`${scope.reader}\n${scope.doc}\n${scope.lineage}`).slice(0, 24)}`,
};

/** Register of one node of a layout entity (the node id is encoded: «#» and «:» never split a key). */
export const layoutNodeRegister = (nodeId: string) => `node:${encodeURIComponent(nodeId)}`;

/** Entities a change belongs to; an operation's parents are the heads of all of them. */
export function changeEntities(change: Change): string[] {
  switch (change.type) {
    case "document.registered":
    case "document.moved":
    case "document.removed":
    case "document.observed":
    case "document.transferred":
      return [entity.doc(change.docId)];
    case "read.acknowledged":
    case "read.revoked":
      return [entity.reader(change.readerId)];
    case "batch.prepared":
    case "batch.dispatched":
    case "batch.input-registered":
    case "batch.finished":
      return [entity.run(change.runId)];
    case "item.result-recorded":
      return [entity.run(change.runId), entity.annotation(change.annotationId)];
    case "layout.pinned":
    case "layout.unpinned":
      return [entity.layout(change.scope)];
    default:
      return [entity.annotation(change.annotationId)];
  }
}

export function operationEntities(operation: Operation): string[] {
  return [...new Set(operation.changes.flatMap(changeEntities))].sort();
}

/** One value slot that concurrent events can disagree on. */
interface Setter {
  eventId: string;
  value: string;
}

export interface Conflict {
  entity: string;
  register: string;
  /** Concurrent maximal events and the values they set. */
  candidates: { eventId: string; value: string }[];
}

function registersOf(change: Change, eventId: string): { key: string; value: string }[] {
  switch (change.type) {
    case "document.registered": return [{ key: `${entity.doc(change.docId)}#path`, value: change.path }];
    case "document.moved": return [{ key: `${entity.doc(change.docId)}#path`, value: change.to }];
    case "annotation.created": {
      const base = entity.annotation(change.annotationId);
      return [{ key: `${base}#status`, value: "open" }, { key: `${base}#kind`, value: change.kind }, { key: `${base}#message:${change.messageId}`, value: eventId }];
    }
    case "annotation.withdrawn": return [{ key: `${entity.annotation(change.annotationId)}#status`, value: "withdrawn" }];
    case "annotation.restored": return [{ key: `${entity.annotation(change.annotationId)}#status`, value: "open" }];
    case "discussion.closed": return [{ key: `${entity.annotation(change.annotationId)}#status`, value: "closed" }];
    case "discussion.reopened": return [{ key: `${entity.annotation(change.annotationId)}#status`, value: "open" }];
    case "annotation.kind-changed": return [{ key: `${entity.annotation(change.annotationId)}#kind`, value: change.kind }];
    case "message.appended":
    case "message.revised":
      return [{ key: `${entity.annotation(change.annotationId)}#message:${change.messageId}`, value: eventId }];
    case "conflict.resolved": {
      const base = entity.annotation(change.annotationId);
      const key = change.field === "message" ? `${base}#message:${change.messageId ?? ""}` : `${base}#${change.field}`;
      return [{ key, value: change.value }];
    }
    case "layout.pinned": { const base = entity.layout(change.scope); return change.nodes.map((node) => ({ key: `${base}#${layoutNodeRegister(node.id)}`, value: `${node.x},${node.y}` })); }
    case "layout.unpinned": { const base = entity.layout(change.scope); return change.nodes.map((id) => ({ key: `${base}#${layoutNodeRegister(id)}`, value: "-" })); }
    default: return [];
  }
}

// ── projection ────────────────────────────────────────────────────────────

export interface RevisionRecord {
  revisionId: string;
  docId: string;
  eventId: string;
  objectSha: string;
  reason: string;
}

export interface DocumentRecord {
  docId: string;
  /** Current path; null while the path register is in conflict. */
  path: string | null;
  removed: boolean;
  /** Persistent revisions in causal (topological) order. */
  revisions: string[];
  /** Revisions that no other revision of this document names as parent. */
  headRevisions: string[];
  /**
   * Concurrent branches disagree about the path (two renames) or the presence (renamed or changed on one branch,
   * removed on the other). The document stays reachable at `path` (a candidate path) but is read-only until an
   * explicit resolution event that descends from all candidates (EP-014-T02). Never last-write-wins.
   */
  conflict: { register: "path" | "presence"; candidates: { eventId: string; value: string }[] } | null;
  /** 1.2 (§9, F15): the latest transfer of the document's review data; after "to-local" the shared data is read-only. */
  transferred?: "to-git" | "to-local" | null;
}

export interface State {
  /** Events in a deterministic topological order (parents first, ties by id). */
  order: string[];
  events: Map<string, Operation>;
  heads: Map<string, string[]>;
  /** entity → reasons; incomplete entities allow no dangerous writes. */
  incomplete: Map<string, string[]>;
  readOnly: Map<string, string[]>;
  /** Unknown major somewhere: the whole repository opens without writes (G3). */
  repoReadOnly: string[];
  registers: Map<string, { value: string | null; setters: string[] }>;
  conflicts: Conflict[];
  documents: Map<string, DocumentRecord>;
  revisions: Map<string, RevisionRecord>;
  /** Events touching each entity, in `order`. */
  byEntity: Map<string, string[]>;
  /** a is a strict causal ancestor of b (any entities; bounded search). */
  isAncestor(a: string, b: string): boolean;
  /**
   * a is a strict ancestor of b along events of one entity. Honest writers name the entity's heads as
   * parents, so its own events carry its causality; crafted parents can only make this say "no",
   * which surfaces as a conflict, never as a silent override.
   */
  isAncestorIn(entityKey: string, a: string, b: string): boolean;
  objects: Map<string, ObjectValue>;
  snapshots: Set<string>;
  /** Changes the projection refused (agent decisions, reused message ids, invalid resolutions…); validate reports them. */
  ignored: { eventId: string; reason: string; messageId?: string }[];
}

function addReason(map: Map<string, string[]>, key: string, reason: string) {
  const list = map.get(key) ?? [];
  if (!list.includes(reason)) list.push(reason);
  map.set(key, list);
}

/** Kahn's algorithm with the smallest id first among ready events: independent of file order. */
function topologicalOrder(events: Map<string, Operation>): string[] {
  const children = new Map<string, string[]>();
  const pending = new Map<string, number>();
  for (const [id, operation] of events) {
    const present = operation.parents.filter((parent) => events.has(parent));
    pending.set(id, present.length);
    for (const parent of present) children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const ready = [...pending].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const left = pending.get(child)! - 1;
      pending.set(child, left);
      if (left === 0) {
        // Keep `ready` sorted; journals are small enough for an insertion.
        let index = 0;
        while (index < ready.length && ready[index] < child) index++;
        ready.splice(index, 0, child);
      }
    }
  }
  // A cycle is impossible with create-only ids, but damaged data must not hang or vanish silently.
  if (order.length < events.size) for (const id of [...events.keys()].sort()) if (!order.includes(id)) order.push(id);
  return order;
}

export function project(data: RepositoryData): State {
  const events = data.events;
  const order = topologicalOrder(events);
  const position = new Map(order.map((id, index) => [id, index]));

  // Depth bounds the ancestor search: an ancestor is always shallower.
  const depth = new Map<string, number>();
  for (const id of order) {
    const parents = events.get(id)!.parents.filter((parent) => depth.has(parent));
    depth.set(id, parents.length ? Math.max(...parents.map((parent) => depth.get(parent)!)) + 1 : 0);
  }
  const ancestorCache = new Map<string, boolean>();
  const isAncestor = (a: string, b: string): boolean => {
    if (a === b || !events.has(a) || !events.has(b)) return false;
    const key = `${a}>${b}`;
    const cached = ancestorCache.get(key);
    if (cached !== undefined) return cached;
    const floor = depth.get(a)!;
    const stack = [b];
    const seen = new Set<string>();
    let found = false;
    while (stack.length && !found) {
      const current = stack.pop()!;
      for (const parent of events.get(current)?.parents ?? []) {
        if (parent === a) { found = true; break; }
        if (seen.has(parent) || !events.has(parent) || depth.get(parent)! <= floor) continue;
        seen.add(parent);
        stack.push(parent);
      }
    }
    if (ancestorCache.size > 50_000) ancestorCache.clear();
    ancestorCache.set(key, found);
    return found;
  };

  const incomplete = new Map<string, string[]>();
  const readOnly = new Map<string, string[]>();
  const repoReadOnly: string[] = [];
  if (data.config.version === "unknown-major") repoReadOnly.push("config.json has an unsupported major schema version");
  if (data.config.version === "newer-minor") repoReadOnly.push("config.json is from a newer schema version");
  if (data.config.version === "invalid") repoReadOnly.push("config.json is damaged");
  if (data.problems.some((problem) => problem.code === "unreadable")) repoReadOnly.push("part of .bb-docs cannot be read (symlink or not a regular file)");
  if (data.problems.some((problem) => problem.code === "unknown-schema" && problem.path?.startsWith("events/"))) {
    repoReadOnly.push("the journal contains events of an unsupported major schema version");
  }

  const byEntity = new Map<string, string[]>();
  const referenced = new Set<string>();
  for (const id of order) {
    const operation = events.get(id)!;
    const entities = operationEntities(operation);
    for (const key of entities) byEntity.set(key, [...(byEntity.get(key) ?? []), id]);
    for (const parent of operation.parents) {
      referenced.add(parent);
      // A parent of a newer schema minor exists, it is only not understood: the entity is read-only, not incomplete.
      if (data.opaque.has(parent)) for (const key of entities) addReason(readOnly, key, `history contains event ${parent} of a newer schema version`);
      else if (!events.has(parent)) for (const key of entities) addReason(incomplete, key, `missing parent event ${parent}`);
    }
    if (data.newerMinor.has(id)) for (const key of entities) addReason(readOnly, key, `event ${id} is from a newer schema version`);
    const refs = operationReferences(operation);
    for (const sha of refs.objects) {
      if (data.opaqueObjects.has(sha)) for (const key of entities) addReason(readOnly, key, `object ${sha} is from a newer schema version`);
      else if (!data.objects.has(sha)) for (const key of entities) addReason(incomplete, key, `missing object ${sha}`);
    }
  }

  for (const [id, opaque] of data.opaque) for (const key of opaque.entities) addReason(readOnly, key, `event ${id} is from schema ${opaque.version}, newer than this plugin`);

  // Heads per entity: its events that no later event of the same entity names as parent.
  const heads = new Map<string, string[]>();
  for (const [key, ids] of byEntity) {
    const shadowed = new Set<string>();
    for (const id of ids) for (const parent of events.get(id)!.parents) shadowed.add(parent);
    heads.set(key, ids.filter((id) => !shadowed.has(id)).sort());
  }

  // Ancestry inside one entity as bitsets: O(k²/32) once instead of a search per pair (crafted journals).
  const MAX_ENTITY_EVENTS = 16_384;
  const ancestry = new Map<string, { index: Map<string, number>; bits: Uint32Array[] } | null>();
  const entityAncestry = (key: string) => {
    if (ancestry.has(key)) return ancestry.get(key)!;
    const ids = byEntity.get(key) ?? [];
    if (ids.length > MAX_ENTITY_EVENTS) {
      addReason(readOnly, key, `more than ${MAX_ENTITY_EVENTS} events in one entity`);
      ancestry.set(key, null);
      return null;
    }
    const index = new Map(ids.map((id, i) => [id, i]));
    const words = Math.ceil(ids.length / 32) || 1;
    const bits = ids.map(() => new Uint32Array(words));
    ids.forEach((id, i) => {
      for (const parent of events.get(id)!.parents) {
        const p = index.get(parent);
        if (p === undefined || p >= i) continue;
        const target = bits[i];
        const source = bits[p];
        for (let w = 0; w < words; w++) target[w] |= source[w];
        target[p >>> 5] |= 1 << (p & 31);
      }
    });
    const value = { index, bits };
    ancestry.set(key, value);
    return value;
  };
  const isAncestorIn = (key: string, a: string, b: string): boolean => {
    const table = entityAncestry(key);
    if (!table) return false;
    const i = table.index.get(a);
    const j = table.index.get(b);
    if (i === undefined || j === undefined || i === j) return false;
    return (table.bits[j][i >>> 5] & (1 << (i & 31))) !== 0;
  };

  // Registers: the maximal setters decide; disagreement is a conflict, never last-write-wins.
  const setters = new Map<string, Setter[]>();
  // A message belongs to the side that wrote it; a revision from the other side is not a value of it.
  const messageSide = new Map<string, string>();
  const ignored: { eventId: string; reason: string; messageId?: string }[] = [];
  for (const id of order) {
    const operation = events.get(id)!;
    for (const change of operation.changes) {
      const reject = (reason: string) => ignored.push({ eventId: id, reason, ...("messageId" in change && change.messageId ? { messageId: change.messageId } : {}) });
      // Decisions belong to people (DR-04): an agent cannot close, withdraw, retype or resolve.
      if (operation.actor.kind === "agent" && ["discussion.closed", "discussion.reopened", "annotation.withdrawn", "annotation.restored", "annotation.kind-changed", "conflict.resolved"].includes(change.type)) {
        reject(`${change.type} by an agent is ignored`);
        continue;
      }
      // A personal layout is written by its reader only (1.3, like receipts): anything else is attribution noise.
      if ((change.type === "layout.pinned" || change.type === "layout.unpinned")
        && !(operation.actor.kind === "human" && operation.actor.email.trim().toLowerCase() === change.scope.reader)) {
        reject(`${change.type} for reader ${change.scope.reader} by another actor is ignored`);
        continue;
      }
      if (change.type === "annotation.created" || change.type === "message.appended") {
        const messageKey = `${change.annotationId}/${change.messageId}`;
        // A message id is created once; reusing it would overwrite somebody else's message.
        if (messageSide.has(messageKey)) {
          reject(`message ${change.messageId} already exists`);
          continue;
        }
        messageSide.set(messageKey, operation.actor.kind);
      }
      if (change.type === "message.revised" && messageSide.get(`${change.annotationId}/${change.messageId}`) !== operation.actor.kind) {
        reject(`message ${change.messageId} revised by the other side`);
        continue;
      }
      if (change.type === "conflict.resolved") {
        const key = entity.annotation(change.annotationId);
        const valid = change.field === "status" ? ["open", "closed", "withdrawn"].includes(change.value)
          : change.field === "kind" ? ["action", "note"].includes(change.value)
          : (setters.get(`${key}#message:${change.messageId ?? ""}`) ?? []).some((setter) => setter.eventId === change.value);
        const ancestors = change.resolves.every((resolved) => isAncestorIn(key, resolved, id));
        if (!valid || !ancestors) {
          reject(!valid ? `conflict.resolved with an invalid value for ${change.field}` : "conflict.resolved names events that are not its ancestors");
          continue;
        }
      }
      for (const { key, value } of registersOf(change, id)) setters.set(key, [...(setters.get(key) ?? []), { eventId: id, value }]);
    }
  }
  const registers = new Map<string, { value: string | null; setters: string[] }>();
  const conflicts: Conflict[] = [];
  for (const key of [...setters.keys()].sort()) {
    const all = setters.get(key)!;
    // Several setters in one event: the last change of the event wins inside that event.
    const lastPerEvent = new Map<string, Setter>();
    for (const setter of all) lastPerEvent.set(setter.eventId, setter);
    const list = [...lastPerEvent.values()];
    const [entityKey] = key.split("#");
    // Maximal setters: those no other setter descends from (one union of ancestor bitsets).
    const table = entityAncestry(entityKey);
    let maximal = list;
    if (table) {
      const union = new Uint32Array(table.bits[0]?.length ?? 1);
      for (const setter of list) {
        const row = table.bits[table.index.get(setter.eventId)!];
        for (let w = 0; w < union.length; w++) union[w] |= row[w];
      }
      maximal = list.filter((setter) => {
        const i = table.index.get(setter.eventId)!;
        return (union[i >>> 5] & (1 << (i & 31))) === 0;
      });
    }
    const values = new Set(maximal.map((setter) => setter.value));
    if (values.size === 1) {
      registers.set(key, { value: maximal[0].value, setters: maximal.map((setter) => setter.eventId).sort() });
    } else {
      registers.set(key, { value: null, setters: maximal.map((setter) => setter.eventId).sort() });
      conflicts.push({
        entity: entityKey,
        register: key.slice(entityKey.length + 1),
        candidates: maximal.map((setter) => ({ eventId: setter.eventId, value: setter.value })).sort((a, b) => (a.eventId < b.eventId ? -1 : 1)),
      });
    }
  }

  // Documents and persistent revisions.
  const documents = new Map<string, DocumentRecord>();
  const revisions = new Map<string, RevisionRecord>();
  const docFor = (docId: string) => {
    let record = documents.get(docId);
    if (!record) {
      record = { docId, path: null, removed: false, revisions: [], headRevisions: [], conflict: null };
      documents.set(docId, record);
    }
    return record;
  };
  // Presence follows causality like a register: the maximal presence-setting events of the document decide.
  const presence = new Map<string, Setter[]>();
  const setPresence = (docId: string, eventId: string, value: "present" | "removed") => {
    const list = presence.get(docId) ?? [];
    const same = list.findIndex((setter) => setter.eventId === eventId);
    if (same >= 0) list[same] = { eventId, value };
    else list.push({ eventId, value });
    presence.set(docId, list);
  };
  for (const id of order) {
    for (const change of events.get(id)!.changes) {
      if (change.type === "document.registered" || change.type === "document.moved") {
        docFor(change.docId);
        setPresence(change.docId, id, "present");
      }
      if (change.type === "document.removed") {
        docFor(change.docId);
        setPresence(change.docId, id, "removed");
      }
      if (change.type === "document.transferred") docFor(change.docId).transferred = change.direction;
      if (change.type === "document.observed") {
        const object = data.objects.get(change.revision);
        if (object && (object.type !== "Revision" || object.revisionId !== change.revisionId || object.docId !== change.docId)) {
          addReason(incomplete, entity.doc(change.docId), `event ${id}: revision object does not match ${change.revisionId}`);
          ignored.push({ eventId: id, reason: `revision object does not match document.observed ${change.revisionId}` });
          continue;
        }
        const record = docFor(change.docId);
        setPresence(change.docId, id, "present");
        if (!revisions.has(change.revisionId)) {
          revisions.set(change.revisionId, { revisionId: change.revisionId, docId: change.docId, eventId: id, objectSha: change.revision, reason: change.reason });
          record.revisions.push(change.revisionId);
        }
      }
    }
  }
  for (const record of documents.values()) {
    const key = entity.doc(record.docId);
    const setters = presence.get(record.docId) ?? [];
    const table = entityAncestry(key);
    const maximal = table ? setters.filter((setter) => !setters.some((other) => other !== setter && isAncestorIn(key, setter.eventId, other.eventId))) : setters.slice(-1);
    const values = new Set(maximal.map((setter) => setter.value));
    record.removed = values.size === 1 && values.has("removed");
    if (values.size > 1) {
      const candidates = maximal.map((setter) => ({ eventId: setter.eventId, value: setter.value })).sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
      record.conflict = { register: "presence", candidates };
      conflicts.push({ entity: key, register: "presence", candidates });
    }
    const path = registers.get(`${key}#path`);
    record.path = path?.value ?? null;
    if (path && path.value === null) {
      // Two renames on two branches: keep the document reachable at one candidate path, read-only until resolved.
      const conflict = conflicts.find((entry) => entry.entity === key && entry.register === "path");
      if (conflict) {
        record.conflict = { register: "path", candidates: conflict.candidates };
        record.path = [...conflict.candidates].map((candidate) => candidate.value).sort()[0] ?? null;
      }
    }
    if (!path) addReason(incomplete, entity.doc(record.docId), "document has no registered path");
    const parentsOfAny = new Set<string>();
    for (const revisionId of record.revisions) {
      const revision = data.objects.get(revisions.get(revisionId)!.objectSha);
      if (!revision || revision.type !== "Revision") continue;
      const refs = objectReferences(revision);
      for (const parent of refs.revisions) {
        parentsOfAny.add(parent);
        if (!revisions.has(parent)) addReason(incomplete, entity.doc(record.docId), `revision ${revisionId} names unknown parent ${parent}`);
      }
      for (const sha of refs.snapshots) {
        if (!data.snapshots.has(sha)) addReason(incomplete, entity.doc(record.docId), `revision ${revisionId} snapshot ${sha} is missing`);
      }
    }
    record.headRevisions = record.revisions.filter((revisionId) => !parentsOfAny.has(revisionId)).sort();
  }

  // References from events to revisions (receipts, targets, results) must resolve in this checkout.
  for (const id of order) {
    const operation = events.get(id)!;
    const refs = operationReferences(operation);
    for (const revisionId of refs.revisions) {
      if (!revisions.has(revisionId)) for (const key of operationEntities(operation)) addReason(incomplete, key, `unknown revision ${revisionId}`);
    }
    for (const sha of refs.objects) {
      const object = data.objects.get(sha);
      if (!object) continue;
      const objectRefs = objectReferences(object);
      for (const revisionId of objectRefs.revisions) {
        if (!revisions.has(revisionId)) for (const key of operationEntities(operation)) addReason(incomplete, key, `object ${sha} names unknown revision ${revisionId}`);
      }
      for (const snapshot of objectRefs.snapshots) {
        if (!data.snapshots.has(snapshot)) for (const key of operationEntities(operation)) addReason(incomplete, key, `object ${sha} snapshot ${snapshot} is missing`);
      }
    }
  }
  for (const conflict of conflicts) addReason(readOnly, conflict.entity, `conflict in ${conflict.register}`);

  return {
    order, events, heads, incomplete, readOnly, repoReadOnly, registers, conflicts, documents, revisions, byEntity,
    isAncestor: (a, b) => position.has(a) && position.has(b) && isAncestor(a, b),
    isAncestorIn,
    ignored,
    objects: data.objects, snapshots: data.snapshots,
  };
}

/** Parents for a new operation touching `entities`: the union of their current heads. */
export function parentsFor(state: State, entities: string[]): string[] {
  return [...new Set(entities.flatMap((key) => state.heads.get(key) ?? []))].sort();
}

/** Why a write to these entities must be refused, if it must (incomplete data, conflict, newer schema). */
export function writeBlockers(state: State, entities: string[]): string[] {
  const reasons = [...state.repoReadOnly];
  for (const key of entities) {
    for (const reason of state.incomplete.get(key) ?? []) reasons.push(`${key}: ${reason}`);
    for (const reason of state.readOnly.get(key) ?? []) reasons.push(`${key}: ${reason}`);
  }
  return reasons;
}

/** Revision ids that are causal ancestors of `revisionId` (inclusive), through Revision.parents. */
export function revisionHistory(state: State, revisionId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [revisionId];
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    const record = state.revisions.get(current);
    if (!record) continue;
    seen.add(current);
    const object = state.objects.get(record.objectSha);
    if (object?.type === "Revision") stack.push(...object.parents);
  }
  return seen;
}

export function revisionObject(state: State, revisionId: string) {
  const record = state.revisions.get(revisionId);
  const object = record ? state.objects.get(record.objectSha) : undefined;
  return object?.type === "Revision" ? object : null;
}
