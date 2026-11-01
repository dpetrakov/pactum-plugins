// Optimistic read marks predict the write and apply it to the
// shown view and tree at once. Pure functions over the host's data — the store applies them as overlays until the
// write lands (or removes them when it fails), so a mark is visible in the same frame as the click.
import { sectionBlocks } from "../core/targets.ts";
import type { DocumentView, ViewAnnotation, ViewBlock } from "../node/view.ts";
import type { Overlay, TreeEntryInfo, TreeInfo } from "./store.ts";

const isUnread = (block: { read: ViewBlock["read"] }) => block.read === "unread" || block.read === "ambiguous";
const countUnread = (view: DocumentView) => view.blocks.filter(isUnread).length + view.removed.length;

/** What an «Mark read» covers: blocks by index, a section by its heading, removed blocks, or the whole document. */
export type ReadTarget = { scope: "block" | "section" | "document"; blocks?: number[]; heading?: number; tombstones?: string[] };

/** Block indices and tombstones a read target marks in this view. */
export function readSet(view: DocumentView, target: ReadTarget): { blocks: Set<number>; tombstones: Set<string> } {
  if (target.scope === "document") return { blocks: new Set(view.blocks.map((block) => block.index)), tombstones: new Set(view.removed.map((entry) => entry.tombstoneId)) };
  const blocks = target.scope === "section" && target.heading !== undefined ? sectionBlocks(view.blocks, target.heading) : target.blocks ?? [];
  return { blocks: new Set(blocks), tombstones: new Set(target.tombstones ?? []) };
}

/** The view with these blocks read and these removed blocks acknowledged; the unread count follows. */
export function markRead(view: DocumentView, set: { blocks: Set<number>; tombstones: Set<string> }): DocumentView {
  let changed = false;
  const blocks = view.blocks.map((block) => {
    if (!set.blocks.has(block.index) || !isUnread(block)) return block;
    changed = true;
    return { ...block, read: "read" as const };
  });
  const removed = view.removed.filter((entry) => !set.tombstones.has(entry.tombstoneId));
  if (!changed && removed.length === view.removed.length) return view;
  const next = { ...view, blocks, removed };
  return { ...next, unread: countUnread(next) };
}

/** Put back the read state of these blocks and removed blocks as it was in `before` (undo of a read mark). */
export function restoreRead(view: DocumentView, before: DocumentView, set: { blocks: Set<number>; tombstones: Set<string> }): DocumentView {
  const old = new Map(before.blocks.map((block) => [block.index, block]));
  let changed = false;
  const blocks = view.blocks.map((block) => {
    const was = old.get(block.index);
    if (!set.blocks.has(block.index) || !was || was.lineageId !== block.lineageId || was.read === block.read) return block;
    changed = true;
    return { ...block, read: was.read, change: was.change, diff: was.diff };
  });
  const present = new Set(view.removed.map((entry) => entry.tombstoneId));
  const back = before.removed.filter((entry) => set.tombstones.has(entry.tombstoneId) && !present.has(entry.tombstoneId));
  if (!changed && !back.length) return view;
  const next = { ...view, blocks, removed: [...view.removed, ...back].sort((a, b) => a.after - b.after) };
  return { ...next, unread: countUnread(next) };
}

/** The tree entry of a document after `delta` of its unread changes were read (or put back with a negative delta). */
export function treeUnread(tree: TreeInfo, path: string, delta: number, all = false): TreeInfo {
  let docsDelta = 0;
  const entries = tree.entries.map((entry): TreeEntryInfo => {
    if (entry.path !== path) return entry;
    const wasUnread = entry.state === "unread" || entry.state === "changed" || entry.state === "new";
    const unread = all ? 0 : Math.max(0, (entry.unread ?? 0) - delta);
    if (!wasUnread || delta <= 0) return entry;
    if (unread > 0) return { ...entry, state: "unread", unread };
    docsDelta = 1;
    return { ...entry, state: "read", unread: 0 };
  });
  if (entries.every((entry, index) => entry === tree.entries[index])) return tree;
  return { ...tree, entries, totals: { ...tree.totals, unreadDocs: Math.max(0, tree.totals.unreadDocs - docsDelta), unread: Math.max(0, tree.totals.unread - Math.max(0, delta)) } };
}

/** Overlay of «Mark read» (block, section, removed block, document): the view and the document's row in the tree. */
export function readOverlay(view: DocumentView, target: ReadTarget): { overlay: Overlay; set: { blocks: Set<number>; tombstones: Set<string> }; count: number } {
  const set = readSet(view, target);
  const after = markRead(view, set);
  const count = view.unread - after.unread;
  const path = view.document.path;
  return {
    set, count,
    overlay: {
      view: (current) => (current.document.path === path ? markRead(current, set) : current),
      tree: (tree) => treeUnread(tree, path, count, target.scope === "document"),
    },
  };
}

/** Overlay of «Undo» after «Mark read»: the blocks and removed blocks come back unread, the tree row too. */
export function unreadOverlay(before: DocumentView, set: { blocks: Set<number>; tombstones: Set<string> }, treeBefore: TreeInfo | null): Overlay {
  const path = before.document.path;
  const row = treeBefore?.entries.find((entry) => entry.path === path) ?? null;
  return {
    view: (current) => (current.document.path === path ? restoreRead(current, before, set) : current),
    tree: (tree) => (row ? restoreEntries(tree, [row], treeBefore!.totals) : tree),
  };
}

/** Annotation fields an optimistic decision changes. */
export type AnnotationPatch = Partial<Pick<ViewAnnotation, "status" | "kind" | "waiting">> & { dropConflict?: string };

export function patchAnnotation(view: DocumentView, annotationId: string, patch: AnnotationPatch): DocumentView {
  let changed = false;
  const annotations = view.annotations.map((annotation) => {
    if (annotation.annotationId !== annotationId) return annotation;
    changed = true;
    const { dropConflict, ...fields } = patch;
    return { ...annotation, ...fields, ...(dropConflict ? { conflicts: annotation.conflicts.filter((conflict) => conflict.register !== dropConflict) } : {}) };
  });
  return changed ? { ...view, annotations } : view;
}

/** What «Close», «Reopen», «Withdraw», «Restore», «Make a note», «For agent» show at once. */
export function decisionPatch(action: "close" | "reopen" | "withdraw" | "restore" | "note" | "action"): AnnotationPatch {
  switch (action) {
    case "close": return { status: "closed", waiting: false };
    case "reopen": return { status: "open" };
    case "withdraw": return { status: "withdrawn", waiting: false };
    case "restore": return { status: "open" };
    case "note": return { kind: "note" };
    case "action": return { kind: "action" };
  }
}

/** A conflict register after a merge resolved by the chosen value (EP-014-T02): status or kind take the value. */
export function conflictPatch(register: string, value: string): AnnotationPatch {
  if (/(^|#)status$/.test(register) && (value === "open" || value === "closed" || value === "withdrawn")) return { dropConflict: register, status: value };
  if (/(^|#)kind$/.test(register) && (value === "action" || value === "note")) return { dropConflict: register, kind: value };
  return { dropConflict: register };
}

/** «Accept»: the annotation closes and its linked edits are read. */
export function acceptOverlay(view: DocumentView, annotation: ViewAnnotation): Overlay {
  const path = view.document.path;
  const set = { blocks: new Set((annotation.latest?.linked ?? []).map((entry) => entry.block)), tombstones: new Set<string>() };
  const count = view.unread - markRead(view, set).unread;
  return {
    view: (current) => (current.document.path === path ? patchAnnotation(markRead(current, set), annotation.annotationId, { status: "closed", waiting: false }) : current),
    tree: (tree) => treeUnread(tree, path, count),
  };
}

/** Rows a visibility or tracking rule applies to: the path itself, or everything under a directory. */
const under = (path: string, isDir: boolean) => (entry: { path: string }) => (isDir ? entry.path.startsWith(`${path}/`) : entry.path === path);

/** «Hide / Show», «Untracked / Track» in the tree at once. */
export function ruleOverlay(input: { list: "hidden" | "untracked"; path: string; isDir: boolean; action: "add" | "remove" }): Overlay {
  const on = input.action === "add";
  const from = on && input.isDir ? `${input.path}/` : null;
  const match = under(input.path, input.isDir);
  return {
    tree: (tree) => ({
      ...tree,
      entries: tree.entries.map((entry) => (!match(entry) ? entry : input.list === "hidden"
        ? { ...entry, hidden: on, hiddenFrom: on ? from : null }
        : entry.supported ? { ...entry, untracked: on, untrackedFrom: on ? from : null } : entry)),
      virtual: input.list === "hidden" ? tree.virtual.map((entry) => (match(entry) ? { ...entry, hidden: on } : entry)) : tree.virtual,
    }),
  };
}

/** «All read» / «Accept current state»: every document row read, the shown document read. */
export function readAllOverlay(): Overlay {
  return {
    view: (view) => markRead(view, readSet(view, { scope: "document" })),
    tree: (tree) => ({
      ...tree,
      entries: tree.entries.map((entry) => (entry.state === "unread" || entry.state === "changed" || entry.state === "new" ? { ...entry, state: "read", unread: 0 } : entry)),
      totals: { ...tree.totals, unreadDocs: 0, changedDocs: 0, unread: 0 },
    }),
  };
}

/** Put tree rows (and the totals) back as they were before a mark (undo). */
export function restoreEntries(tree: TreeInfo, rows: TreeEntryInfo[], totals: TreeInfo["totals"] | null): TreeInfo {
  const old = new Map(rows.map((row) => [row.path, row]));
  return {
    ...tree,
    entries: tree.entries.map((entry) => old.get(entry.path) ?? entry),
    ...(totals ? { totals: { ...tree.totals, unreadDocs: totals.unreadDocs, changedDocs: totals.changedDocs, unread: totals.unread } } : {}),
  };
}

/** Undo of «All read»: the rows and the shown document as they were. */
export function unreadAllOverlay(viewBefore: DocumentView | null, treeBefore: TreeInfo | null): Overlay {
  const rows = (treeBefore?.entries ?? []).filter((entry) => entry.state === "unread" || entry.state === "changed" || entry.state === "new");
  const set = viewBefore ? readSet(viewBefore, { scope: "document" }) : null;
  return {
    view: (view) => (viewBefore && set && view.document.path === viewBefore.document.path ? restoreRead(view, viewBefore, set) : view),
    tree: (tree) => (treeBefore ? restoreEntries(tree, rows, treeBefore.totals) : tree),
  };
}
