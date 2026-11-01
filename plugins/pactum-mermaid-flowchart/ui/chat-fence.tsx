import { tr } from "../core/i18n.ts";
// Mermaid flowcharts in agent replies use the same read-only canvas. Unsupported or incomplete
// sources fall back to bb's original code fence; the Code toggle always exposes the source.
import type { ExperimentalCodeFenceRendererProps } from "@get-bb/plugin-sdk/app";
import { type CSSProperties, useMemo, useState } from "react";
import { layoutWith } from "../core/layout.ts";
import { parseMermaid } from "../core/mermaid.ts";
import { HEADER } from "./adapter.ts";
import { cachedAuto, Diagram } from "./diagram.tsx";

const noop = () => undefined;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ChatMermaid({ code, status, index, message, Original }: ExperimentalCodeFenceRendererProps) {
  const [showCode, setShowCode] = useState(false);
  const flowchart = status === "closed" && HEADER.test(code);
  const parsed = useMemo(() => (flowchart ? parseMermaid(code) : null), [flowchart, code]);
  const model = parsed?.ok ? parsed.model : null;
  const layout = useMemo(() => (model ? layoutWith(model, cachedAuto(model, code), {}) : null), [model, code]);
  if (!model || !layout) return <Original />;
  const uid = `pmf${`${message.id}x${index}`.replace(/[^a-zA-Z0-9]/g, "")}`;
  return <figure className="pmf-chat">
    <figcaption className="pmf-chat__bar">
      <span className="pmf-chat__title">{tr("Diagram · Mermaid", "Схема · Mermaid")}</span>
      <button type="button" className="pmf-chat__toggle" aria-pressed={showCode} onClick={() => setShowCode((value) => !value)}
        title={showCode ? tr("Show diagram", "Показать схему") : tr("Show Mermaid source", "Показать исходник Mermaid")}>{tr("Code", "Код")}</button>
    </figcaption>
    {showCode ? <pre className="pmf-chat__code"><code>{code}</code></pre> : <div className="pmf-chat__canvas" style={{ "--pmf-w": String(Math.round(layout.width)) } as CSSProperties}>
      <Diagram model={model} layout={layout} moving={false} uid={uid} selected={null} onSelect={noop} zoom={1} marks={null}
        onDrag={noop} onDrop={noop} onCancel={noop} reducedMotion={reducedMotion()} />
    </div>}
  </figure>;
}
