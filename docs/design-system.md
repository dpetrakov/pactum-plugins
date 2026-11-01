# Documents interface guidelines

Pactum Docs follows the bb host theme. Dense reading controls use neutral surfaces, thin seams and a 2 px foreground rail to show the current document, section or review stop.

## Tokens and layout

Derive the `--dr-*` roles only from bb CSS variables, optionally with color-mix. Do not introduce color literals or a separate palette into plugin styles. Inherit host fonts. Use Lucide icons, 14 px in rows and 16 px in controls. Buttons use the vendored registry components; actions without labels need accessible names and hints.

Use a 4 px spacing grid, 28/32 px controls, and targets of at least 24 px for a mouse and 40 px on touch. Reading text uses 15 px with a 72ch measure; add the annotation gutter outside that measure. Full-width and embedded modes can use the full column.

## State and feedback

Keep semantic labels, line shapes or icons alongside color. Never make color the only signal. Text contrast must reach 4.5:1 and meaningful controls 3:1 in both themes.

Commands react immediately, ignore repeated activation and preserve focus. Delay the busy indicator by 150 ms and keep it visible for at least 400 ms. Explain waits beyond one second and allow cancellation when possible. Optimistic read/accept operations roll back on failure and provide Undo or Retry. Background loading retains existing content rather than showing a false empty state.

## Overlays and navigation

Use the existing registry popovers, menus and dialogs. Compact screens use responsive sheets. Escape closes the top layer and returns focus to its trigger. Sticky headers and footers must not hide jump targets or focused controls. Reduced-motion preferences disable sliding, rotation and smooth scrolling.

The Info control stays available in the toolbar at narrow widths. Long paths wrap inside its popover/sheet; copying has explicit feedback. Change groups use the same boundaries for visible labels, review stops and read actions.

## Verification

For UI changes verify light and dark themes, a host custom theme, a 390 px touch viewport, keyboard navigation and focus return, computed contrast and reduced motion. Keep visual-only controls outside selectable document text and annotation coordinates. The existing token/component layers in `ui/theme.css`, `ui/files.css` and `ui/kit.tsx` define the current implementation.

The public landing reuses the original Pactum Trinity identity. See [branding.md](branding.md) for its tokens, artwork and source attribution. The plugin continues to use bb host theme tokens.
