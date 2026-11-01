# Pactum Docs for bb

Read documents, track unread changes and review AI-agent edits in explicit rounds.

See the [repository README](../../README.md) for installation and the [getting-started guide](../../docs/getting-started.md) for the reviewer workflow. The stable plugin ID is `document-review`; the bb display name is **Documents**.

This package includes the viewer, host service, CLI and agent tools. It works without other Pactum plugins. Supported formats are Markdown, YAML, JSON/JSONC, TOML, environment files, plain text and CSV/TSV. Shared review state stays in `.bb-docs` in the selected Git checkout; optional local review stays on the checkout machine.

```sh
npm ci
npm run typecheck
npm test
bb plugin build .
```

English is the default interface language; Russian is optional. Source comments and project documentation use English. Localization strings and multilingual test fixtures are intentional.
