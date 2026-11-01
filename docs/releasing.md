# Releasing

## Documents

The stable plugin ID is `document-review`. Keep the package version and tag aligned, for example `1.13.0` and `document-review-v1.13.0`.

1. Run a clean dependency install, typecheck, tests, dependency audit, `bb plugin build` and the public-source check.
2. Verify a clean install in an isolated bb server and a representative review workflow.
3. Update CHANGELOG.md, package metadata, website commands and marketplace entries as needed.
4. Commit reviewed source and publish an immutable version tag. Never move an existing tag to a different commit.
5. The release workflow rechecks the tagged source and creates GitHub release notes. The Pages workflow publishes the static site from main.
6. Verify the public repository, release, collection install and site without account-specific access.

The collection is `.bb/plugins.json`. The site marketplace pins the public repository, plugin subdirectory, compatible version range and `document-review-` tag prefix. Each future plugin gets its own prefix and compatibility ranges.

Do not release private review events, snapshots, local paths, credentials or personal project fixtures. Do not publish generated host/server bundles unless their source and license notices are present. Generated build output is excluded from Git; bb builds Git installs through its own trusted plugin installer.

For a format-changing release, test current -> previous -> current with representative data before release. A code-only release still needs current-schema and data-preservation checks but does not invent a migration or rename `.bb-docs`.

## Mermaid flowchart

`pactum-mermaid-flowchart` is independently versioned. Run its package typecheck, tests, audit and `bb plugin build plugins/pactum-mermaid-flowchart`. Its immutable release tags use `pactum-mermaid-flowchart-vX.Y.Z`; the corresponding Git install prefix is `pactum-mermaid-flowchart-`. The dedicated release workflow verifies the package and creates its release. Keep `ui/register.ts`'s visualizer version aligned with the package version.

When changing landing fixtures or either renderer, rebuild the [landing examples](landing-examples.md) and run their browser checks before publishing main.
