---
name: pactum-mermaid-flowchart
description: Mermaid flowchart/graph visualizer for Documents in bb, with personal layout, file-change comparison and comments on elements.
---

# Mermaid flowcharts in Documents

This plugin renders `flowchart`/`graph` Mermaid fences and `.mmd`/`.mermaid` files through the Documents visualizer contract v1. It does not render other Mermaid diagram types; their source stays visible.

The host owns review data, personal positions, comparison and comments. The canvas reports node/edge/group geometry and commits personal positions. A layout move is not a source edit. Agents must not mark diagrams read or accept review work on behalf of a person.

Use simple flowchart source when making a document for interactive review. Keep node identifiers stable so comments and comparison stay connected. Source styling, HTML, click actions and directives are not executed. Limits are 64 KiB, 200 nodes, 400 edges and 64 groups. Subgraph-specific direction is not applied.

Run package typecheck, tests and the security corpus before release. See the package README and the public repository's visualizer contract documentation.
