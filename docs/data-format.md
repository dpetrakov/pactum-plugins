# Storage, privacy and formats

## Shared review data

Shared data lives in `.bb-docs` inside the selected checkout: configuration, immutable events, content-addressed objects and snapshots. Commit it alongside reviewed documents when you want Git to share the review. The plugin does not create a Pactum cloud account or upload data to a Pactum backend.

Events form a causal history. A read receipt names the displayed block versions or removal markers; it never confirms an unseen newer edit. Undo revokes only its own contribution. Annotations use text quotes, positions and block lineage to survive edits; ambiguous targets need an explicit user decision.

Do not hand-edit events or snapshots. Use the plugin operations and `bb document-review validate` to inspect consistency. Newer incompatible data opens read-only rather than being overwritten.

## Local data

Ignored files can be tracked explicitly in a device-local review. Their data belongs to the machine, checkout and Git reader identity and stays outside `.bb-docs`. Changes in Git classification can offer a transfer between local and shared storage; the UI explains what will move. Cache/observation data is disposable and does not replace persistent history.

## Supported formats

Markdown, YAML, JSON/JSONC, TOML, environment files, plain text, CSV and TSV are supported. Structured files use key-path anchors; line formats use line ranges. Invalid structured content falls back to a safe line view with a parse error.

The viewer accepts supported regular files up to 8 MiB. It rejects traversal, symbolic links, service directories and excluded types. It does not execute raw HTML or remote images automatically.

## Secrets and agent access

Environment values and configured secret-key patterns are masked before review snapshots or agent-facing text are produced. Shared and personal settings can extend masking. Review exemptions carefully. An agent must not write mask characters back into the source or invent a hidden value.

The reviewer can reveal a value temporarily or explicitly download the original file. Those actions are different from agent tool output. A user-authorized batch shares its text with the selected bb agent provider under that provider's normal policies.

The storage directory remains `.bb-docs`. The first public release keeps the existing 1.x schema family, including layout data where present; it does not migrate data to a new directory or format.
