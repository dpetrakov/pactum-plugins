# Pactum Mermaid flowchart

An optional visualizer for Pactum Docs in bb. It renders Mermaid `flowchart` and `graph` blocks and `.mmd`/`.mermaid` files, compares changes to nodes, edges and groups, and supports each reader's own layout.

```sh
bb plugin install git:https://github.com/dpetrakov/pactum-plugins.git@^0.3.0 --plugin pactum-mermaid-flowchart --tag-prefix pactum-mermaid-flowchart-
```

Install Documents separately. The plugin uses the public visualizer contract; it has no private repository imports or hosted backend. Node positions are personal review data; dragging a node does not rewrite Mermaid source. Documents owns comment markers, comparison selection and storage.

Move nodes and group titles with pointer or touch. With keyboard, focus a node, press Enter, use arrows (Shift for larger steps), then Enter to commit or Escape to cancel. Code remains available in the host frame.

Only flowchart/graph is interactive. Other Mermaid diagram types remain code. Source styles, classes, click handlers, frontmatter directives and HTML are not executed. Limits: 64 KiB source, 200 nodes, 400 edges and 64 groups. A subgraph's own direction does not affect layout.

Development: `npm ci`, `npm run typecheck`, `npm test`, then `bb plugin build plugins/pactum-mermaid-flowchart` from the repository root. The security corpus is package-local. Apache-2.0; Dagre and Graphlib retain their MIT licenses.
