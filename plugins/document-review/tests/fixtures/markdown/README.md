# Markdown test corpus

Syntax fixtures cover lists, tables, links, hostile HTML, source coordinates, Unicode, BOM and line endings. The `real/` directory contains synthetic long-form public documents with realistic structure, not personal project material.

Sequence fixtures provide versioned inputs and explicit block-mapping truth. Deliberate Cyrillic and emoji are test data, not untranslated project documentation. Keep byte-sensitive CRLF/BOM files unchanged.

## Inventory

- `real/agent-handbook.md`
- `real/format-reference.md`
- `real/reference-catalog.md`
- `real/review-architecture.md`
- `real/review-guide.md`
- `real/team-review.md`
- `real/workflow-decisions.md`
- `syntax/blockquote.md`
- `syntax/bom.md`
- `syntax/code-gallery.md`
- `syntax/code.md`
- `syntax/cr.md`
- `syntax/crlf.md`
- `syntax/entities.md`
- `syntax/footnotes.md`
- `syntax/frontmatter.md`
- `syntax/html.md`
- `syntax/links.md`
- `syntax/lists.md`
- `syntax/tables.md`
- `syntax/unicode.md`
- `sequences/dup-adjacent`
- `sequences/dup-delete-first`
- `sequences/dup-delete-second`
- `sequences/dup-section-swap`
- `sequences/real-guide`
- `sequences/rename-delete`
- `sequences/revert`
- `sequences/rewrap`
- `sequences/rewrite`
- `sequences/section-move`
- `sequences/split-merge`
- `sequences/table-rows`
- `sequences/url-only`
- `syntax/event-table.md`: synthetic public review event table with dotted and hyphenated identifiers for table text/selection wrapping checks.
