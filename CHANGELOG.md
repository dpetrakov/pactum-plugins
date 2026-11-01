# Changelog

## Documents 1.13.1

- Heading gutters show the section-read action and comment action without a duplicate single check. The gutter stays 76 px wide; touch targets wrap inside it.
- Public landing examples use the real Documents renderer and Mermaid canvas, with a synthetic comment-to-agent review round, table resizing, tracked folders and independent Git readers.
- No review-storage schema change.

## Mermaid flowchart 0.3.0

- First standalone public visualizer package in this collection.
- Compare Mermaid flowchart nodes and connections, including removed elements.
- Move nodes by pointer, touch or keyboard without editing source; attach comments to diagram elements through Documents.
- Self-contained parser, layout engine, English/Russian localization and contract tests.

## Documents 1.13.0

First public Pactum Docs source release for bb.

- Standalone Documents package with English documentation and source comments.
- Document information popover: absolute/relative paths, copy controls, file type, size and original-file download.
- New files start human change tracking on their first explicit viewer opening; passive discovery and agent registration alone do not mark the initial draft unread.
- Adjacent visual change groups are marked read in one action, including review-pass navigation and Undo.
- English default interface with optional Russian localization.
- Secret masking, annotation anchoring, causal read receipts, review rounds and the open visualizer contract retain existing storage compatibility.
- Update Zod to 4.6.7 to address GHSA-mrhx-c7xc-m3w5.
- Self-contained public test corpus, CI and GitHub Pages project site.

No `.bb-docs` schema migration is introduced by this release.

The CLI core check also verifies repositories that ignore `.bb-docs`: generated test data is carried between its temporary clones without changing the source checkout.
