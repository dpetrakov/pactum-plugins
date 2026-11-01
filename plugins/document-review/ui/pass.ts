import { changeRuns, type ChangeBlock } from "./change-runs.ts";
// The single pass through a document (EP-010-T01, I2): stops in text order; an annotation and an edit of the same
// place are one stop; read blocks and resolved annotations are never stops.

export type PassMode = "all" | "changes" | "comments";

type PassBlock = ChangeBlock;
interface PassRemoved {
  tombstoneId: string;
  after: number;
}
interface PassAnnotation {
  annotationId: string;
  status: string | null;
  kind: string | null;
  waiting: boolean;
  anchor: { status: string; place: number | null; blocks: number[] };
  latest: { linked: { block: number }[] } | null;
}
export interface PassView {
  blocks: PassBlock[];
  removed: PassRemoved[];
  annotations: PassAnnotation[];
}

export interface Stop {
  /** Stable while the stop exists: the first block, removal or annotation it was built from. */
  key: string;
  /** Text order: block index, removals between blocks, document-level first. */
  order: number;
  blocks: number[];
  tombstones: string[];
  annotations: string[];
}

const NEEDS_PLACE = new Set(["approximate", "ambiguous", "orphaned"]);

/** Does the annotation need the user: an agent answer awaits a decision, or its place needs attention (D6). */
export function annotationNeedsUser(annotation: PassAnnotation): boolean {
  return annotation.status === "open" && (annotation.waiting || NEEDS_PLACE.has(annotation.anchor.status));
}

export function passStops(view: PassView, mode: PassMode): Stop[] {
  const stops: Stop[] = [];
  const byBlock = new Map<number, Stop>();
  const blockStop = (index: number) => {
    let stop = byBlock.get(index);
    if (!stop) {
      stop = { key: `b${index}`, order: index, blocks: [], tombstones: [], annotations: [] };
      byBlock.set(index, stop);
      stops.push(stop);
    }
    return stop;
  };
  if (mode !== "comments") {
    for (const run of changeRuns(view)) {
      const stop = blockStop(run[0]);
      stop.blocks.push(...run);
      for (const index of run) byBlock.set(index, stop);
    }
    for (const removed of view.removed) {
      stops.push({ key: `t${removed.tombstoneId}`, order: removed.after + 0.5, blocks: [], tombstones: [removed.tombstoneId], annotations: [] });
    }
  }
  if (mode !== "changes") {
    for (const annotation of view.annotations) {
      if (annotation.status !== "open") continue;
      if (mode === "all" && !annotationNeedsUser(annotation)) continue;
      // One stop per place: the annotation joins a stop of one of its blocks or of its linked edits.
      const places = [...annotation.anchor.blocks, ...(annotation.latest?.linked.map((entry) => entry.block) ?? [])];
      const existing = places.map((index) => byBlock.get(index)).find((stop) => stop !== undefined);
      if (existing) {
        existing.annotations.push(annotation.annotationId);
        continue;
      }
      const place = annotation.anchor.place ?? annotation.anchor.blocks[0] ?? null;
      if (place === null) {
        stops.push({ key: `a${annotation.annotationId}`, order: -1, blocks: [], tombstones: [], annotations: [annotation.annotationId] });
        continue;
      }
      const stop = blockStop(place);
      stop.annotations.push(annotation.annotationId);
    }
    // Linked edits of an annotation already at a stop belong to that stop, not to a second one.
    if (mode === "all") {
      for (const annotation of view.annotations) {
        const home = stops.find((stop) => stop.annotations.includes(annotation.annotationId));
        if (!home) continue;
        for (const entry of annotation.latest?.linked ?? []) {
          const other = byBlock.get(entry.block);
          if (!other || other === home || other.annotations.length) continue;
          home.blocks.push(...other.blocks);
          stops.splice(stops.indexOf(other), 1);
          for (const block of other.blocks) byBlock.set(block, home);
        }
      }
    }
  }
  return stops.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1));
}

/** Index of the stop to show after the list was recomputed: the same key, else the next one in text order. */
export function nextIndex(stops: Stop[], previous: Stop | null): number {
  if (!stops.length) return -1;
  if (!previous) return 0;
  const same = stops.findIndex((stop) => stop.key === previous.key);
  if (same >= 0) return same;
  const after = stops.findIndex((stop) => stop.order > previous.order);
  return after >= 0 ? after : stops.length - 1;
}
