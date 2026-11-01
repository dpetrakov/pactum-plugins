// The real Mermaid canvas, hosted by a synthetic landing example instead of bb.
import { mountMermaidCanvas } from "../../plugins/pactum-mermaid-flowchart/ui/canvas.tsx";
import { mermaidDiff } from "../../plugins/pactum-mermaid-flowchart/ui/adapter.ts";
import type { CanvasSlot, CanvasReport } from "../../plugins/pactum-mermaid-flowchart/visualizers-contract.ts";
import { diagramBefore, diagramAfter } from "./fixtures.mjs";
export function mountDiagram() {
  const element = document.querySelector<HTMLElement>("#diagram-canvas")!;
  const feedback = document.querySelector<HTMLElement>("#diagram-feedback")!;
  const selectLabel = document.querySelector<HTMLElement>("#diagram-selection")!;
  const commentButton = document.querySelector<HTMLButtonElement>("#diagram-comment")!;
  const commentForm = document.querySelector<HTMLFormElement>("#diagram-comment-form")!;
  const input = document.querySelector<HTMLInputElement>("#diagram-comment-text")!;
  const changesButton = document.querySelector<HTMLButtonElement>("#diagram-changes")!;
  const sourceButton = document.querySelector<HTMLButtonElement>("#diagram-source")!;
  const code = document.querySelector<HTMLElement>("#diagram-code")!;
  const scroll = document.querySelector<HTMLElement>("#diagram-scroll")!;
  const reset = document.querySelector<HTMLButtonElement>("#reset-diagram")!;
  const diff = mermaidDiff(diagramBefore, diagramAfter);
  if (!("items" in diff)) throw new Error(diff.unsupported);
  const marks = Object.fromEntries(diff.items.filter(i => i.change).map(i => [i.id, i.change!])) as Record<string, "added" | "changed" | "removed">;
  let geometry: CanvasReport | null = null;
  let selected: string | null = null;
  let handle: ReturnType<typeof mountMermaidCanvas>;
  const slot: CanvasSlot = {
    generation: 1, blockKey: "landing-flowchart", element,
    props: { source: diagramAfter, context: { kind: "fence", path: "docs/architecture.md", language: "mermaid", dialect: "flowchart" }, theme: document.documentElement.classList.contains("dark") ? "dark" : "light", zoom: 1, moving: true, readOnly: false, positions: {}, selected: null, compare: { base: diagramBefore, marks }, annotations: {}, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches },
    actions: {
      commit(positions, remove = []) {
        slot.props = { ...slot.props, positions: { ...slot.props.positions, ...positions } };
        for (const id of remove) delete slot.props.positions[id];
        handle.update(slot);
        feedback.textContent = "Personal layout updated. The Mermaid source is unchanged.";
      },
      select(id) {
        selected = id;
        slot.props = { ...slot.props, selected: id };
        handle.update(slot);
        const item = id && geometry?.elements[id];
        selectLabel.textContent = item ? `Selected: ${item.label}` : "No node selected";
        commentButton.disabled = !item;
      },
      report(report) { geometry = report; element.setAttribute("aria-busy", "false"); },
      fail(failure) { feedback.textContent = failure.message; element.setAttribute("aria-busy", "false"); },
    },
  };
  handle = mountMermaidCanvas(slot);
  code.textContent = diagramAfter;
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const item of diff.items) if (item.change) counts[item.change]++;
  document.querySelector("#diagram-counts")!.textContent = `+${counts.added} added · ~${counts.changed} changed · −${counts.removed} removed`;
  const list = document.querySelector<HTMLElement>("#diagram-change-list")!;
  for (const item of diff.items) {
    const li = document.createElement("li");
    li.dataset.change = item.change;
    li.textContent = `${item.change === "added" ? "+" : item.change === "removed" ? "−" : "~"} ${item.label}`;
    list.append(li);
  }
  changesButton.addEventListener("click", () => {
    const shown = changesButton.getAttribute("aria-pressed") !== "true";
    changesButton.setAttribute("aria-pressed", String(shown));
    slot.props = { ...slot.props, compare: shown ? { base: diagramBefore, marks } : null };
    list.hidden = !shown;
    handle.update(slot);
    feedback.textContent = shown ? "Comparing the current file with the last read version." : "Current diagram. Your personal positions are preserved.";
  });
  sourceButton.addEventListener("click", () => {
    const shown = sourceButton.getAttribute("aria-pressed") !== "true";
    sourceButton.setAttribute("aria-pressed", String(shown));
    code.hidden = !shown; scroll.hidden = shown;
  });
  reset.addEventListener("click", () => {
    slot.props = { ...slot.props, positions: {} };
    handle.update(slot); feedback.textContent = "Automatic layout restored. The source is unchanged.";
  });
  const openComment = () => {
    if (!selected) return;
    const item = geometry?.elements[selected];
    document.querySelector("#diagram-comment-label")!.textContent = `Note on ${item?.label ?? selected}`;
    commentForm.hidden = false; input.focus();
  };
  commentButton.addEventListener("click", openComment);
  element.addEventListener("keydown", event => { if (event.key.toLowerCase() === "c" && selected) { event.preventDefault(); openComment(); } });
  commentForm.addEventListener("submit", event => {
    event.preventDefault(); if (!input.value.trim() || !selected) return;
    const item = geometry?.elements[selected];
    feedback.textContent = `Note on ${item?.label ?? selected}: ${input.value.trim()}`;
    input.value = ""; commentForm.hidden = true; commentButton.focus();
  });
  const themeObserver = new MutationObserver(() => {
    slot.props = { ...slot.props, theme: document.documentElement.classList.contains("dark") ? "dark" : "light" };
    handle.update(slot);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => { themeObserver.disconnect(); handle.dispose(); };
}
