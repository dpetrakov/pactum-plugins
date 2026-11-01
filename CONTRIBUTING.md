# Contributing

Use English for documentation, source comments, commits and pull requests. Localized interface strings and multilingual fixtures are intentional exceptions.

## Setup

Install Git, Node.js 22.19 or later and bb. Then:

```sh
npm ci --prefix plugins/document-review
npm run typecheck --prefix plugins/document-review
npm test --prefix plugins/document-review
bb plugin build plugins/document-review
node scripts/check-public-source.mjs
```

The checked reference bb CLI is `bb-app@0.46.1`; CI installs that exact version. Install the package from a local path for interactive development and use `bb plugin dev plugins/document-review` for rebuild/reload. A local install executes this repository's code on your machine.

## Tests

Tests create temporary Git repositories and never need your private projects. The corpus contains public synthetic examples, hostile markup and deliberate Unicode, CRLF and BOM cases. Random secret canaries verify that hidden values do not enter review storage or tool output.

For browser security tests:

```sh
cd plugins/document-review
npx playwright install chromium
PACTUM_BROWSER_TESTS=1 npm test
```

The historical-source drill is optional on a clean initial import. Set `PACTUM_PREVIOUS_REPOSITORY` to a trusted local repository containing `document-review-v1.3.1` and `document-review-v1.5.2` to run it. Schema-version, read-state and current-format tests run without that history.

## Change review

Explain the user-visible behavior and its validation. Add regression tests for state, security and protocol changes. Keep pure logic separate from SDK registrations. UI changes need screenshots in both themes and at 390 px, plus keyboard, contrast and reduced-motion checks.

Do not add another editable source copy in another repository. Keep stable protocol symbols and plugin IDs even when internal branding changes. Format changes need explicit compatibility and rollback evidence.

Contributions are provided under this repository's Apache-2.0 license. Preserve third-party copyright and license notices.
