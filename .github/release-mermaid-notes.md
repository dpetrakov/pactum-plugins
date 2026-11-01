First standalone public Mermaid flowchart visualizer for Pactum Docs in bb.

- Compare nodes and edges against the last read source, including removed connections.
- Move nodes by pointer, touch or keyboard without modifying the source.
- Attach comments to diagram elements through Documents.
- Render supported Mermaid fences in agent replies.
- Supports `flowchart`/`graph`; other diagram types remain source.

```sh
bb plugin install git:https://github.com/dpetrakov/pactum-plugins.git@^0.3.0 --plugin pactum-mermaid-flowchart --tag-prefix pactum-mermaid-flowchart-
```

Install Documents separately for document review. Requires bb 0.46+ and Plugin SDK 0.6.49+. No Pactum account or service is needed.
