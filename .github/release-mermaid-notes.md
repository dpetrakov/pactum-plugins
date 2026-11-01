Mermaid flowchart 0.3.1 fixes uncontrolled canvas growth while dragging beyond the visible area.

- Stable gesture coordinates with immediate pointer tracking inside the viewport.
- Outside dwell of 650 ms, a 400 ms ramp, and a maximum pan speed of 24 CSS px/s. Returning, dropping or cancelling stops panning.
- Screen position is preserved on drop, including repeated gestures. Escape cancels pointer movement.
- Removed edges whose old geometry is no longer meaningful stay in the change list instead of appearing as orphan dashed fragments.
- The landing uses the same canvas and restores the approved Pactum logo.

```sh
bb plugin install git:https://github.com/dpetrakov/pactum-plugins.git@^0.3.1 --plugin pactum-mermaid-flowchart --tag-prefix pactum-mermaid-flowchart-
```

Documents remains an independent install. No Mermaid-source or stored-position format changes are introduced. Existing layouts can be restored with Reset layout.
