<p><img src="site/assets/favicon-512x512.png" width="64" height="64" alt="Pactum seal with witness dot"></p>

# Pactum

Open-source tools for reviewing documents with AI agents.

Pactum Docs is a standalone plugin for [bb](https://getbb.app). Read a document, see what changed since your last review, leave precise comments and ask an agent to handle them in a review round. Your final acceptance stays yours.

## Install Documents

With bb 0.46 or later and a compatible Plugin SDK installed:

```sh
bb plugin install git:https://github.com/dpetrakov/pactum-plugins.git@^1.13.0 --plugin document-review --tag-prefix document-review-
```

The public product is **Pactum Docs**. Its stable bb plugin ID is `document-review` and the installed display name is **Documents**.

Open Documents, select a Git checkout and enable review when you are ready to save comments and read marks. The plugin needs a Git name and email for writes. It works without any other Pactum or bb-workbench plugin.

## What you get

- Markdown and structured/text formats: YAML, JSON/JSONC, TOML, environment files, plain text and CSV/TSV.
- Changes relative to your read state, including additions, edits, moves and removals.
- Inline annotations, discussions, agent batches and explicit acceptance.
- One-click reading of adjacent change groups, with Undo.
- Document information, path copying and original-file downloads.
- Git-backed shared review data in `.bb-docs`; optional device-local review for ignored files.
- An open visualizer contract for embedded objects. Additional diagram visualizers are not bundled in this first release; unhandled fences remain source code.

English is the default interface language. Russian is available in settings.

## Documentation

- [Getting started](docs/getting-started.md)
- [Storage, privacy and supported formats](docs/data-format.md)
- [Architecture](docs/architecture.md)
- [Visualizer extensions](docs/visualizers.md)
- [Development and contributions](CONTRIBUTING.md)
- [Release procedure](docs/releasing.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Development

Use Node.js 22.19 or later and Git. The reference CLI is `bb-app@0.46.1`.

```sh
npm ci --prefix plugins/document-review
npm run typecheck --prefix plugins/document-review
npm test --prefix plugins/document-review
bb plugin build plugins/document-review
node scripts/check-public-source.mjs
```

This repository is the source of truth for the public plugins. Each plugin owns its package manifest, dependencies and release tags. The static project website lives in `site/` and is deployed to GitHub Pages.

## Scope

The first release targets bb. An external MCP server, packages for other agent clients and hosted team features are future work, not part of this release. The plugin has no Pactum account, subscription or Pactum cloud backend.

## License

Apache-2.0 for project-owned code. Vendored components and dependencies keep their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). The license does not grant rights to the Pactum name or marks beyond the license terms.
