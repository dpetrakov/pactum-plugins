# Diagram motion and comparison

Pactum's interactive flowchart uses the same canvas in bb and on the landing.

## Pointer gestures

Inside the visible scrollport a node follows the pointer immediately. The gesture captures one coordinate basis and a stable SVG viewport. Recomputing that basis from changing SVG bounds creates a positive feedback loop, especially with negative coordinates and centered canvases. Scene bounds and pointer input must not drive each other's scale or origin.

An out-of-bounds pointer is clamped to the visible scrollport. Panning starts only after **650 ms** outside, ramps over **400 ms**, and is capped at **24 CSS pixels per second**, including diagonals. The same policy applies at every zoom level and frame rate. Returning inside, reversing direction, dropping, cancelling or losing capture stops it. A stalled frame is capped at 50 ms of movement. There is no inertia or distance-based acceleration.

The viewport includes its ancestors' clipping and the browser viewport. During the gesture it never resizes. On drop the screen anchor is preserved and bounds grow only enough to retain the complete drawing. The next gesture starts from that view. Reset layout or changing the source restores the natural view. This viewport is ephemeral; stored node coordinates and Mermaid source formats are unchanged.

Touch uses a 12 px inner edge zone with the same delay and speed cap, because a finger cannot move outside the physical display. Direct pointer tracking remains immediate inside that zone.

Touch handling consumes native scrolling only when a node or group-title handle is grabbed. Empty canvas retains native scrolling. A second touch cancels a one-pointer drag.

Keyboard movement keeps the existing Enter / arrows / Shift+arrows / Enter controls, with Escape to cancel. Pointer movement can also be cancelled with Escape. Reduced motion disables decorative transitions; deliberate, bounded movement remains directly controlled by the gesture.

## Removed elements

A removed connection drawn using an old layout may leave a short red dashed fragment over the current graph. That is misleading geometry rather than a new source edge. Render its ghost only if both endpoints still match the base geometry, the entire route is visible and no current node occludes it. Otherwise retain the removal in the complete change list. Removed nodes use the same visibility/non-overlap rule. Never hide the fact that an element was removed.

## Primary references

- [Atlassian auto-scroll](https://atlassian.design/components/pragmatic-drag-and-drop/optional-packages/auto-scroll) and its [configuration source](https://github.com/atlassian/pragmatic-drag-and-drop/blob/main/packages/auto-scroll/src/shared/configuration.ts) separate elapsed-time dampening from capped, frame-independent speed. Pactum deliberately uses a much lower cap for precision editing.
- [React Flow viewport controls](https://reactflow.dev/api-reference/react-flow) separate node dragging, auto-pan and pan speed. Its [drag implementation](https://github.com/xyflow/xyflow/blob/main/packages/system/src/xydrag/XYDrag.ts) updates the node position as the view pans and cancels animation frames on drag end.

- [MDN touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action) and [Touch Events](https://developer.mozilla.org/en-US/docs/Web/API/Touch_events) describe native-scroll cancellation and the role of non-passive touch handlers. SVG-handle gestures are verified with actual touch input, not mouse emulation.

These implementations informed the interaction model; no third-party drag implementation was copied or added as a dependency.
