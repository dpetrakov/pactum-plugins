// Schema migrations (G3, EP-014-T04). A migration never rewrites an existing event, object, snapshot or config field: it
// can only append new operations through the normal publish protocol (create-only), so an interrupted migration is
// finished by running it again and Git history keeps every earlier file. A newer minor is read by this code directly
// when its meaning is a superset of the older one; then the migration plan is empty.
import { type State } from "./journal.ts";
import { SCHEMA_LATEST, SCHEMA_VERSION } from "./schema.ts";
import type { OperationDraft } from "./store.ts";

export interface Migration {
  from: string;
  to: string;
  /** What changes in meaning, for validate and the release notes. */
  describe: string;
  /** Operations to append; never a rewrite. Empty when old data is read as is. */
  plan(state: State): OperationDraft[];
}

export const MIGRATIONS: Migration[] = [
  {
    from: "1.0",
    to: "1.1",
    describe: "1.1 adds read.acknowledged scope «removal»: the deletion of a whole document is acknowledged per reader. "
      + "1.0 document.removed stays valid: it is the checkout's fact «removed, not renamed» and its author's own acknowledgement; "
      + "for other readers the deletion is unread. Nothing is rewritten; events that need 1.1 declare it, all others stay 1.0.",
    plan: () => [],
  },
  {
    from: "1.1",
    to: "1.2",
    describe: "1.2 (W-06c) adds files of any type: Revision profiles bbdr-structured and bbdr-lines with block types node, group, line "
      + "and a redaction flag, annotation selectors bbdr:KeyPathSelector and bbdr:LineRangeSelector, config exclude/types/secretKeys/"
      + "secretExemptions and document.transferred. Markdown data keeps its meaning and its version; nothing is rewritten.",
    plan: () => [],
  },
  {
    from: "1.2",
    to: "1.3",
    describe: "1.3 (W-06f) adds a reader's personal layout of embedded diagrams: layout.pinned and layout.unpinned with a nested "
      + "scope {doc, lineage, reader}; entity layout:<hash>, one register per node. Nothing else changes; nothing is rewritten.",
    plan: () => [],
  },
];

/** Versions declared by the events of a journal, for diagnostics (validate, status). */
export function versionsInUse(state: State): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const operation of state.events.values()) counts[operation.schemaVersion] = (counts[operation.schemaVersion] ?? 0) + 1;
  return counts;
}

/** The migrations needed to read data written at `from` with this code (in order). */
export function migrationPath(from: string): Migration[] {
  const path: Migration[] = [];
  let version = from;
  while (version !== SCHEMA_LATEST) {
    const next = MIGRATIONS.find((migration) => migration.from === version);
    if (!next) break;
    path.push(next);
    version = next.to;
  }
  return path;
}

export const WRITE_DEFAULT = SCHEMA_VERSION;
