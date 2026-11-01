# Visualizer extensions

Documents can render embedded fences or supported whole-file objects through a separate trusted bb plugin. The first public Documents package does not bundle an extra visualizer; unhandled objects remain readable as source.

`plugins/document-review/visualizers-contract.ts` is the portable contract source. A visualizer bundles a compatible copy, registers at app-overlay mount and disposes its registration on unmount. Read its exported types for the exact methods and host context.

A registration declares language/extension claims, a pure match function, canvas mode and capabilities. A specific dialect match wins; ties follow the reader's device-local preference. The host supplies object source and immutable file-change marks. A personal layout changes positions, not document source.

- Interactive canvases implement mounting, update and disposal and publish supported layout changes through the host callback.
- Static canvases return SVG that the host sanitizes.
- `diff` describes source-file changes, including removals, rather than just local position changes.
- `a11y` provides a textual representation. A visualizer missing required comparison/accessibility capabilities falls back to source.
- Element annotations identify stable nodes, edges or groups with a readable label. Keep element IDs stable across file edits.

Use only inherited theme tokens, preserve focus and pointer behavior, and respect reduced motion. Follow the host sanitizer/audit corpus. The visualizer is trusted installed code; host output sanitization does not turn arbitrary plugin code into a sandbox.
