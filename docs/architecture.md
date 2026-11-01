# Architecture

Documents has three main boundaries:

- `core/` contains pure projection, lineage, anchoring, causal journal, discussion, read-state and schema logic.
- `node/` confines filesystem/Git access, masks content, maintains snapshots and observations, serves views and applies domain operations on the checkout machine.
- `host.ts` registers strict host RPC methods. `server.ts` resolves explicit checkout targets and connects bb RPC, CLI and agent tools. `app.tsx` and `ui/` render the host-computed view.

The frontend never reparses documents to invent persistent identities. A fast text response can render before the review overlay; hashes ensure that the overlay belongs to the same text. Writes refer to shown observations and recheck checkout context.

One unfinished batch owns the checkout's agent-review round. Agent answers are idempotent by response key and target individual items. New user instructions remain pending for a later round. Human acceptance is distinct from an agent reporting completion.

Optional integrations use portable window contracts: `docs-link-contract.ts`, `sidebar-tabs-contract.ts`, `focus-contract.ts` and `visualizers-contract.ts`. Stable symbols retain historical names for interoperability. None of the optional providers is required to use Documents.

See [data-format.md](data-format.md) for storage guarantees and [visualizers.md](visualizers.md) for the extension boundary. Runtime API contracts are defined by the exported TypeScript/Zod declarations in the package.
