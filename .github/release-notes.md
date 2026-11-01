Pactum Docs is a standalone document review plugin for bb.

Track unread changes, discuss precise annotations, send an agent a review batch and accept the result. Shared review history stays in `.bb-docs` in your Git checkout.

```sh
bb plugin install git:https://github.com/dpetrakov/pactum-plugins.git@^1.13.0 --plugin document-review --tag-prefix document-review-
```

Requires bb 0.46 or later and Plugin SDK 0.6.49 or later. No other Pactum plugin is required. This release does not include an external MCP server or additional diagram visualizers.

See CHANGELOG.md and the repository documentation for details.
