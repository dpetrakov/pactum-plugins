// Pure model of the tree (EP-011-T01) and of the pass across documents (EP-012-T03): folders and files of the
// roots in display order, hidden entries only on request, documents that have something for a pass mode.
import type { PassMode } from "./pass.ts";
import type { TreeEntryInfo, TreeInfo } from "./store.ts";

export interface DirNode { name: string; path: string; dirs: Map<string, DirNode>; files: TreeEntryInfo[]; virtual: TreeInfo["virtual"]; attention: number; hidden: boolean }

export function buildTree(tree: TreeInfo, showHidden: boolean): DirNode {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [], virtual: [], attention: 0, hidden: false };
  const dirOf = (file: string) => {
    let node = root;
    const parts = file.split("/").slice(0, -1);
    parts.forEach((part, index) => {
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, path: parts.slice(0, index + 1).join("/"), dirs: new Map(), files: [], virtual: [], attention: 0, hidden: true };
        node.dirs.set(part, next);
      }
      node = next;
    });
    return node;
  };
  const touch = (file: string, attention: number, hidden: boolean) => {
    let node = root;
    for (const part of file.split("/").slice(0, -1)) {
      node = node.dirs.get(part)!;
      node.attention += attention;
      if (!hidden) node.hidden = false;
    }
  };
  for (const entry of [...tree.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (entry.hidden && !showHidden) continue;
    dirOf(entry.path).files.push(entry);
    touch(entry.path, entry.waiting + (entry.state === "unread" || entry.state === "new" ? 1 : 0), entry.hidden);
  }
  for (const entry of tree.virtual) {
    if (entry.hidden && !showHidden) continue;
    dirOf(entry.path).virtual.push(entry);
    touch(entry.path, entry.waiting + (entry.reason === "missing" ? 1 : 0), entry.hidden);
  }
  return root;
}

/** Documents in tree order (folders before files at each level, like the tree shows them). */
export function treeOrder(tree: TreeInfo, showHidden = false): string[] {
  const out: string[] = [];
  const walk = (node: DirNode) => {
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) walk(dir);
    for (const file of node.files) if (file.supported && file.kind === "file") out.push(file.path);
    for (const entry of node.virtual) out.push(entry.path);
  };
  walk(buildTree(tree, showHidden));
  return out;
}

/** Documents of the checkout that have something for the pass mode, in tree order (I2 across documents). */
export function passDocuments(tree: TreeInfo | null, mode: PassMode, current: string | null, showHidden = false): string[] {
  if (!tree) return current ? [current] : [];
  const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
  const virtual = new Map(tree.virtual.map((entry) => [entry.path, entry]));
  return treeOrder(tree, showHidden).filter((path) => {
    if (path === current) return true;
    const entry = byPath.get(path);
    const gone = virtual.get(path);
    const changes = entry ? entry.state === "unread" || entry.state === "new" || entry.state === "changed" : gone?.reason === "missing";
    const comments = (entry?.waiting ?? gone?.waiting ?? 0) > 0;
    return mode === "changes" ? changes : mode === "comments" ? comments : changes || comments;
  });
}

