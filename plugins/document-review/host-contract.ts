// Contract between the server entry and the host entry of the chosen machine. Inputs are validated on
// both sides; results travel as {ok, result} | {ok:false, error} so domain error codes survive the hop.
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

const Root = z.string().min(1).max(4096);
const DocPath = z.string().min(1).max(4096);
const Expect = { head: z.string().max(64).nullable().optional(), branch: z.string().max(512).nullable().optional() };
const Observation = z.object({ sha: z.string().regex(/^[0-9a-f]{64}$/), text: z.string().max(8 * 1024 * 1024).optional() }).strict();
const Range = z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }).strict();
const Uuid = z.string().uuid();
const Heads = z.array(Uuid).max(256);
export const ScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document"), path: DocPath }).strict(),
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("annotation"), annotationId: Uuid }).strict(),
]);
export const RecipientSchema = z.object({ mode: z.enum(["current-thread", "new-thread"]), threadId: z.string().max(200).nullable() }).strict();
const AgentSchema = z.object({ model: z.string().min(1).max(256), threadId: z.string().max(200).nullable() }).strict();

export const Envelope = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }) }),
]);

// W-06c «Review settings» (EP-045): a change of the repository level and/or the user's level.
const Patterns = z.array(z.string().min(1).max(4096)).max(4096);
const SettingsChange = { repo: z.object({ roots: z.array(z.string().min(1).max(4096)).max(256).optional(), exclude: Patterns.optional(),
  types: z.array(z.enum(["markdown", "yaml", "json", "toml", "dotenv", "text", "csv"])).max(16).nullable().optional(), secretKeys: z.array(z.string().min(1).max(512)).max(256).optional() }).strict().optional(),
  user: z.object({ exclude: Patterns.optional(), exemptHere: Patterns.optional(), secretKeys: z.array(z.string().min(1).max(512)).max(256).optional(), retentionDays: z.number().int().min(0).max(3650).nullable().optional() }).strict().optional() };

/** Every host call carries the window's language for the texts it returns (EP-126; the server adds it). */
const Lang = { lang: z.enum(["en", "ru"]).optional() };
const withLang = <I extends z.ZodType>(input: I): I => (input instanceof z.ZodObject ? input.extend(Lang) as unknown as I : input);
const method = <I extends z.ZodType>(input: I, description: string) => ({ input: withLang(input), output: Envelope, experimental_description: description });

export const hostContract = defineRpcContract({
  status: method(z.object({ root: Root }).strict(), "Checkout, identity and review summary"),
  validate: method(z.object({ root: Root, limit: z.number().int().min(1).max(500).optional() }).strict(), "Validate .bb-docs"),
  orphans: method(z.object({ root: Root, apply: z.boolean().optional() }).strict(), "List (and with apply remove) .bb-docs files no event references; referenced history is never touched"),
  enablePlan: method(z.object({ root: Root, roots: z.array(z.string().max(4096)).max(64).optional() }).strict(), "What enabling would write"),
  enable: method(z.object({ root: Root, roots: z.array(z.string().max(4096)).max(64).optional(), markGenerated: z.boolean().optional(), limit: z.number().int().min(1).max(10_000).optional(), budgetMs: z.number().int().min(100).max(60_000).optional(), ...Expect }).strict(), "Enable review (one step: at most `limit` documents, ends after `budgetMs`)"),
  read: method(z.object({ root: Root, path: DocPath }).strict(), "Read a document and record the observation"),
  viewPersonal: method(z.object({ root: Root, path: DocPath }).strict(), "W-06c: the view for CLI and other non-UI outputs — the user's global secret extensions masked, no value lengths"),
  revealSecret: method(z.object({ root: Root, path: DocPath, keyPath: z.string().max(4096).nullable().optional(), line: z.number().int().min(1).nullable().optional(),
    place: z.string().max(4096).nullable().optional(), ...Expect }).strict(), "W-06c: one secret value for «Показать значение» in this checkout's UI (never cached)"),
  secretsSeen: method(z.object({ root: Root, path: DocPath, places: z.array(z.string().max(4096)).max(10_000).nullable().optional() }).strict(), "W-06c: this device saw the current secret values («значение изменено» cleared)"),
  secretExempt: method(z.object({ root: Root, path: DocPath, keyPath: z.string().min(2).max(4096), level: z.enum(["me", "repo"]), action: z.enum(["add", "remove"]), preview: z.boolean().optional(),
    configSha: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(), ...Expect }).strict(), "W-06c: «Не секрет» for me or for everyone in the repository (F17)"),
  readState: method(z.object({ root: Root, path: DocPath }).strict(), "Unread state of a document for this checkout's reader"),
  annotate: method(z.object({ root: Root, path: DocPath, observation: Observation, range: Range.optional(), quote: z.string().max(1_000_000).optional(), text: z.string().min(1).max(1_000_000),
    kind: z.enum(["action", "note"]), targetKind: z.enum(["text", "block", "section", "document", "change"]).optional(), block: z.number().int().min(0).optional(),
    tombstoneId: z.string().max(200).optional(),
    // W-06f (EP-073-T08): an element of an embedded object inside the block (bbdr:ObjectSelector, 1.3).
    element: z.object({ id: z.string().min(1).max(200), kind: z.enum(["node", "edge", "group", "text", "other"]), label: z.string().max(400),
      range: z.object({ line: z.number().int().min(1), start: z.number().int().min(0), end: z.number().int().min(0) }).strict().optional() }).strict().optional(),
    ...Expect }).strict(), "Create an annotation on a shown revision"),
  acknowledge: method(z.object({ root: Root, path: DocPath, observation: Observation, blocks: z.array(z.number().int().min(0)).max(100_000).optional(),
    heading: z.number().int().min(0).optional(), tombstones: z.array(z.string().max(200)).max(100_000).optional(),
    scope: z.enum(["block", "section", "document"]), receiptId: z.string().uuid().optional(), ...Expect }).strict(), "Confirm reading of shown blocks"),
  revoke: method(z.object({ root: Root, receiptId: z.string().uuid(), ...Expect }).strict(), "Revoke one receipt of this reader"),
  layout: method(z.object({ root: Root, path: DocPath, observation: Observation, block: z.number().int().min(0),
    pins: z.array(z.object({ id: z.string().min(1).max(200), x: z.number().int().min(-100_000).max(100_000), y: z.number().int().min(-100_000).max(100_000) }).strict()).max(200).optional(),
    unpin: z.array(z.string().min(1).max(200)).max(400).optional(),
    /** `<pluginId>@<version>/<engine>` of the visualizer that laid the object out (EP-074). */
    engine: z.string().min(1).max(64).optional(), ...Expect }).strict(), "Pin or unpin nodes of this reader's layout of an embedded object (W-06f, 1.3)"),
  revise: method(z.object({ root: Root, annotationId: Uuid, messageId: Uuid, text: z.string().min(1).max(1_000_000), ...Expect }).strict(), "Edit a human message (new revision)"),
  retry: method(z.object({ root: Root, annotationId: Uuid, expectedHeads: Heads, ...Expect }).strict(), "Request processing again"),
  resolveConflict: method(z.object({ root: Root, annotationId: Uuid, register: z.string().max(400), value: z.string().min(1).max(1_000_000), ...Expect }).strict(), "Resolve a merge conflict explicitly"),
  view: method(z.object({ root: Root, path: DocPath, compact: z.boolean().optional(), opened: z.boolean().optional() }).strict(), "Document view: blocks, read state, annotations and anchors, computed on the host; compact — the review overlay without the text"),
  fileInfo: method(z.object({ root: Root, path: DocPath, chunk: z.object({ offset: z.number().int().min(0).max(8 * 1024 * 1024), version: z.string().min(1).max(200) }).strict().optional() }).strict(), "UI-only original file metadata and bounded download"),
  text: method(z.object({ root: Root, path: DocPath, from: z.number().int().min(0).max(1_000_000).optional(), limit: z.number().int().min(1).max(1_000_000).optional(), around: z.string().min(1).max(400).nullable().optional(), outline: z.boolean().optional(), source: z.boolean().optional() }).strict(), "Fast path: projected blocks of a document without review state (first screens or around a heading, then the rest)"),
  documents: method(z.object({ root: Root }).strict(), "Markdown documents of the roots with annotation counts"),
  batchStatus: method(z.object({ root: Root }).strict(), "Batches of the checkout"),
  batchPrepare: method(z.object({ root: Root, scope: ScopeSchema, recipient: RecipientSchema, ...Expect }).strict(), "Prepare a batch (DR-01, DR-04)"),
  batchDispatched: method(z.object({ root: Root, runId: Uuid, attemptId: Uuid, recipient: RecipientSchema, delivery: z.enum(["queued", "sent"]), queuedMessageId: z.string().max(200).nullable().optional() }).strict(), "Record a dispatch"),
  batchUnknown: method(z.object({ root: Root, runId: Uuid, reason: z.string().max(2000) }).strict(), "Mark a dispatch as unknown"),
  batchAbandon: method(z.object({ root: Root, runId: Uuid, outcome: z.enum(["failed", "cancelled"]), reason: z.string().max(2000).optional(), ...Expect }).strict(), "Finish a run without agent work"),
  batchGet: method(z.object({ root: Root, runId: Uuid.optional(), page: z.number().int().min(1).max(10_000).optional(), threadId: z.string().max(200).nullable() }).strict(), "The batch for the agent"),
  documentGet: method(z.object({ root: Root, path: DocPath, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(400_000).optional() }).strict(), "Current text of a document for the agent"),
  discussionGet: method(z.object({ root: Root, annotationId: Uuid }).strict(), "History of one annotation"),
  registerInput: method(z.object({ root: Root, runId: Uuid, path: DocPath, agent: AgentSchema }).strict(), "Register an additional input document (DR-01)"),
  itemReply: method(z.object({ root: Root, runId: Uuid, attemptId: Uuid.optional(), itemId: z.string().min(1).max(64), responseId: z.string().min(1).max(200),
    status: z.enum(["done", "needs-input", "failed", "skipped"]), text: z.string().min(1).max(1_000_000),
    edits: z.array(z.object({ path: DocPath, quote: z.string().min(1).max(100_000).optional(), keyPath: z.string().min(1).max(4096).optional() }).strict()
      .refine((edit) => Boolean(edit.quote || edit.keyPath), "an edit names the new text (quote) or the key path (keyPath)")).max(256).optional(), agent: AgentSchema }).strict(), "Agent result of one item"),
  batchFinish: method(z.object({ root: Root, runId: Uuid, attemptId: Uuid.optional(), agent: AgentSchema.nullable(), ...Expect }).strict(), "Finish a round"),
  roundSummary: method(z.object({ root: Root, runId: Uuid }).strict(), "Summary of a round"),
  accept: method(z.object({ root: Root, annotationId: Uuid, expectedHeads: Heads, resultEventId: Uuid.nullable(), path: DocPath, observation: Observation,
    blocks: z.array(z.number().int().min(0)).max(10_000), ...Expect }).strict(), "«Принять»: close and confirm shown linked edits"),
  undoAccept: method(z.object({ root: Root, annotationId: Uuid, acceptEventId: Uuid, receiptId: Uuid.nullable(), ...Expect }).strict(), "Undo «Принять»"),
  reply: method(z.object({ root: Root, annotationId: z.string().uuid(), text: z.string().min(1).max(1_000_000), reopen: z.boolean().optional(), ...Expect }).strict(), "Append a reply"),
  decide: method(z.object({ root: Root, annotationId: Uuid, action: z.enum(["close", "reopen", "withdraw", "restore", "note", "action"]),
    expectedHeads: Heads, ...Expect }).strict(), "Change status or kind of an annotation"),
  locate: method(z.object({ path: z.string().min(1).max(4096) }).strict(), "Git checkout of an absolute file path on this machine"),
  resolvePath: method(z.object({ root: Root, path: z.string().min(1).max(4096) }).strict(), "A workspace path inside a checkout: exact, or the unique Markdown file ending with it (bare names from bb's chat)"),
  sendSummary: method(z.object({ root: Root, scope: ScopeSchema }).strict(), "Summary before sending: documents, hidden ones with instructions, lost anchors"),
  tree: method(z.object({ root: Root, roots: z.array(DocPath).max(64).optional(), budgetMs: z.number().int().min(100).max(10_000).optional() }).strict(), "Tree of the review roots with per-document signals, virtual and moved documents"),
  search: method(z.object({ root: Root, query: z.string().min(1).max(400), showHidden: z.boolean().optional(), roots: z.array(DocPath).max(64).optional() }).strict(), "Search paths and headings of the roots"),
  settingsGet: method(z.object({ root: Root }).strict(), "«Настройки обзора»: rules in force by level"),
  settingsPreview: method(z.object({ root: Root, ...SettingsChange, budgetMs: z.number().int().min(100).max(30_000).optional() }).strict(), "«Настройки обзора»: what a change would do, nothing written"),
  settingsSave: method(z.object({ root: Root, ...SettingsChange, configSha: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(), ...Expect }).strict(), "«Настройки обзора»: write a change (config.json by CAS, user settings)"),
  trackLocal: method(z.object({ root: Root, path: DocPath, isDir: z.boolean(), action: z.enum(["add", "remove"]), ...Expect }).strict(), "«Отслеживать локально»: a file or folder outside Git (local review, EP-048)"),
  localList: method(z.object({ root: Root }).strict(), "Local review of this reader: rules, documents, store"),
  transferPreview: method(z.object({ root: Root, path: DocPath, direction: z.enum(["to-git", "to-local"]) }).strict(), "What moving the review data of a file would move (§9, F15)"),
  transfer: method(z.object({ root: Root, path: DocPath, direction: z.enum(["to-git", "to-local"]), ...Expect }).strict(), "Move the review data of a file between .bb-docs and the local store"),
  keepLocal: method(z.object({ root: Root, path: DocPath, ...Expect }).strict(), "«Оставить локальными»: the local data of a file now in Git stays read-only"),
  localBind: method(z.object({ root: Root, storeDir: z.string().min(1).max(4096) }).strict(), "«Привязать к этой рабочей копии»: the local data of a moved checkout"),
  localForgetStore: method(z.object({ root: Root, storeDir: z.string().min(1).max(4096) }).strict(), "«Забыть» the local data of a checkout that is gone"),
  localForget: method(z.object({ root: Root, path: DocPath, ...Expect }).strict(), "«Забыть файл»: remove this reader's local data of one document"),
  setRule: method(z.object({ root: Root, list: z.enum(["hidden", "untracked"]), path: DocPath, isDir: z.boolean(), action: z.enum(["add", "remove"]), configSha: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(), ...Expect }).strict(), "Hide/show or untrack/track a path (config.json, CAS)"),
  resolveMove: method(z.object({ root: Root, docId: Uuid, to: DocPath.nullable(), ...Expect }).strict(), "Answer a rename proposal: moved to a path, or removed"),
  resolveMoves: method(z.object({ root: Root, items: z.array(z.object({ docId: Uuid, to: DocPath.nullable() }).strict()).min(1).max(500) }).strict(),
    "Answer several rename proposals in one call (W-19: «Разобрать» в «Документах»); each answer on its own, failures reported per document"),
  acknowledgeAll: method(z.object({ root: Root, expectedDocuments: z.number().int().min(0).optional(), ...Expect }).strict(), "Accept the current state of every tracked document with unread changes for this reader (new reader, «всё прочитано»)"),
  revokeMany: method(z.object({ root: Root, receiptIds: z.array(Uuid).min(1).max(10_000), ...Expect }).strict(), "Revoke several receipts of this reader in one operation (undo of «всё прочитано»)"),
  resolveDocumentConflict: method(z.object({ root: Root, docId: Uuid, choice: z.union([DocPath, z.enum(["keep", "removed"])]), ...Expect }).strict(), "Resolve a branch conflict about a document's path or presence explicitly"),
  resolveConfigConflict: method(z.object({ root: Root, configSha: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(), ...Expect }).strict(), "Write the three-way merge of a config.json left unmerged by Git and mark it resolved"),
  watch: method(z.object({ root: Root, enabled: z.boolean() }).strict(), "Start or stop watching a checkout"),
  perf: method(z.object({ root: Root.optional(), bundle: z.string().min(1).max(4096).optional(), keep: z.boolean().optional(), docs: z.array(DocPath).max(20).optional(), rounds: z.number().int().min(1).max(10).optional(), clean: z.boolean().optional() }).strict(), "Measure the tree and document views (cold and warm) of a checkout or a cloned Git bundle"),
  summary: method(z.object({ root: Root.optional(), bundle: z.string().min(1).max(4096).optional(), reader: z.string().min(3).max(320) }).strict(), "Digest of the persistent review state for a reader; optionally of a cloned Git bundle"),
  check: method(z.object({ root: Root, keep: z.boolean().optional() }).strict(), "End-to-end core check on a temporary clone of a repository"),
  drillStart: method(z.object({}).strict(), "Cross-machine merge drill, machine 1: base and branch `first` in a temporary repository, exported as a Git bundle"),
  drillMerge: method(z.object({ bundle: z.string().min(1).max(4096) }).strict(), "Cross-machine merge drill, machine 2: branch `second`, Git merge of `first`, explicit resolutions, merged bundle"),
  drillClean: method(z.object({}).strict(), "Remove drill bundles from this host's plugin temporary directory"),
});

export const hostSignals = {
  changed: { payload: z.object({ root: z.string(), kind: z.enum(["changed", "rescan-required", "watch-error"]), paths: z.array(z.string()).max(64), message: z.string().optional() }) },
} satisfies ExperimentalHostSignals;
