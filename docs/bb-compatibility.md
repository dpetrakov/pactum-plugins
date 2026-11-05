# bb compatibility

Documents 1.13.2 retains its declared minimum bb version of 0.46, minimum SDK of 0.6.49 and development SDK pin of 0.6.49. The supported old build line is bb 0.46.1; bb 0.46.0 bundles SDK 0.6.37 and lacks the existing `experimental_saveFile` export. Loading registrations with SDK 0.6.37 is a narrower check and does not establish full support for that host. Installing a newer bb does not require a review-data migration.

The frontend isolates the tab API boundary in `plugins/document-review/ui/bb-compat.ts`:

- Hosts exposing `slots.experimental_tab` receive explicit nav-panel fixed tabs and thread action tabs. Older hosts receive their original `fixedTabs` and `threadPanelAction` registrations.
- Panel controllers exposing `openTab` receive an explicit tab context. Older controllers retain `openFixedTab` or navigation through `openThreadPanel`.
- A refusal from the host is returned unchanged. It does not trigger a second open through the other API.
- Tab IDs, target values, persisted instance parameters and titles remain stable. Shared thread-panel props are structural so the source does not import a type removed from newer SDK declarations.

Run the package typecheck, the compatibility boundary tests and the full test suite before release. In addition, build with the target bb CLI and load its bundle through the minimum and target SDK collectors. Collectors validate registration only; they do not establish routing, rendering, settings persistence or live host behavior.

The CSS Custom Highlight API is intentional. Optimizer warnings about `::highlight(...)` must not be resolved by replacing it with a pseudo-class. Verify text highlighting in a browser supporting this API.
