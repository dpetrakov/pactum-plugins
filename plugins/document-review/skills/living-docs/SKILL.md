---
name: living-docs
description: Keep project documentation living, short and current. Use whenever you write, edit, review, reorganise or archive Markdown documentation in a repository (docs/, README, AGENTS.md), when a decision is made or a question answered that affects documented behaviour, when code, contracts or infrastructure change, or when closing a task or wave with a docs check.
---

# Living documentation

Documentation describes the system as it is: short, exact and always in line with the code and the decisions. Project rules come first: read the project's `AGENTS.md` and its documentation conventions (for example `docs/conventions/documentation.md`) before editing; they refine these rules and win on conflict.

## Where documents live

- All project documentation lives in `docs/`; outside it only the root `README.md` and agent instruction files (`AGENTS.md`, `CLAUDE.md`).
- One document has one type and answers one question:
  - `architecture/` — how the system is built and the main reasons why;
  - `reference/` — exact facts: contracts, parameters, formats, roles;
  - `guides/` — step-by-step instructions, runbooks;
  - `conventions/` — how the team works;
  - `archive/` — outdated documents and decision records, for history only.
- Do not mix types: when a guide needs a "why", move that part to architecture and link to it.

## Rules

1. **Current state only.** Describe how things are, without change history and without time words: "now", "currently", "new", "previously", "for now", "in the future", dates in the body. History lives in git.
2. **A decision goes into the text.** When a decision is made or a question is answered — in chat, in a review annotation, in a meeting note — rewrite the affected documents as if it had always been so. Never leave the answer, the options or the reasoning under the question.
3. **Reasoning goes to the archive or away.** If the options and the reason matter for history, write a short immutable record in `docs/archive/decisions/YYYY-MM-DD-topic.md` with three sections: Context, Decision, Consequences. Otherwise delete the reasoning.
4. **Outdated goes to the archive.** A document that no longer describes the system moves whole to `docs/archive/YYYY-MM-DD-topic/`. Remove every link to it from living documents; the archive is never a source for work.
5. **Same change.** A change of code, contract or infrastructure and its documentation go in one change (commit or PR). Do not finish work that leaves documentation behind the code.
6. **One fact, one place.** A fact is written in one document; others link to it. No copies, no parallel versions.
7. **Short.** The first sentence states the point. Prefer tables and lists to long prose. No introductions, recaps or "in summary".
8. **Open questions are temporary.** Write an unresolved question where it matters: what is unknown and who decides. After the answer delete the question and apply rule 2.

## Diagrams

- A diagram is a ` ```mermaid ` fenced block inside the document: the source is the diagram. No PNG/SVG images, ASCII art or HTML diagrams in documentation.
- Default type is `flowchart` (or `graph`): a compatible installed visualizer can render it with layout, version diff and annotations on nodes and edges. Other Mermaid types (sequence, state, class, …) are shown as code; use them only when a flowchart cannot carry the meaning, and file a task to extend the plugin's visualizers.
- Do not use `style`, `classDef`, `class`, `click`, `%%{init}%%` directives or HTML in labels — they are not applied.
- Node IDs in Latin letters; labels are plain text in the document's language. Boundaries (system, cell, jurisdiction) are `subgraph`s.
- One diagram answers one question, up to about 25 nodes. A diagram adds no new facts: everything it shows is written in the text or in a linked document.
- Before finishing, open the document in the plugin and check the block renders as a diagram with no “Not applied” notice under it.
- Presentation-grade diagrams (HTML, design tools) are made only on request and live outside the documentation tree.

## Working with document review

- Remarks on documents are annotations of the document-review plugin. Answer in the annotation and edit the document text; closing annotations is the human's decision.
- Never edit `.bb-docs/` by hand; commit it together with the documents.
- A batch remark that is a decision triggers rule 2 for every document it affects, not only the annotated one.

## Before you finish

- No text contradicts the code or an accepted decision.
- No options, answers under questions, change history or time words in living documents.
- Links work; no living document links into `archive/`.
- Every diagram is a Mermaid block, flowchart unless there is a stated reason.
- Every outdated document is archived, every important decision record exists.
- Language follows the project rule (English for this repository; localized strings and test data may use other languages).
