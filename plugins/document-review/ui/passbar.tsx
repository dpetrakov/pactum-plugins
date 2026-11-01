// The pass footer (EP-010-T01, EP-012-T03; design EP-020-T05): the mode «All | Changes | Comments» and the scope
// «Document | All documents» as segments (a menu on a narrow column), K/J «3 of 8», the description of the stop, one
// main action with its key («Mark read and next R» / «Accept A») and «Reply E»; the horizontal progress rail on top.
import { tr } from "../core/i18n.ts";
import type { ViewAnnotation } from "../node/view.ts";
import { Icon } from "./icons.tsx";
import { Button, IconButton, Kbd, Menu, MenuContent, MenuLabel, MenuRadio, MenuRadioGroup, MenuSeparator, MenuTrigger, Segments, Tip } from "./kit.tsx";
import { AGENT_LABEL } from "./labels.ts";
import type { PassMode, Stop } from "./pass.ts";
import { useUi } from "./store.ts";
import { VERB, W, counted, num } from "./words.ts";

const MODES: { value: PassMode; label: string }[] = [{ value: "all", label: tr("All", "Всё") }, { value: "changes", label: tr("Changes", "Изменения") }, { value: "comments", label: tr("Comments", "Замечания") }];

export function PassBar({ stops, index, mode, scope, docs, docIndex, narrow, onMode, onScope, onMove, onRead, onAccept, onReply }: { stops: Stop[]; index: number; mode: PassMode; scope: "document" | "all"; docs: string[]; docIndex: number; narrow: boolean; onMode: (mode: PassMode) => void; onScope: (scope: "document" | "all") => void; onMove: (delta: number) => void; onRead: () => void; onAccept: () => void; onReply: () => void }) {
  const view = useUi((ui) => ui.view);
  const stop = stops[index] ?? null;
  const annotations = (stop?.annotations ?? []).map((id) => view?.annotations.find((annotation) => annotation.annotationId === id)).filter((value): value is ViewAnnotation => Boolean(value));
  const acceptable = annotations.find((annotation) => annotation.waiting && annotation.latest);
  const nextDoc = scope === "all" ? docs[docIndex + 1] ?? null : null;
  const describe = () => {
    if (!stop) {
      if (nextDoc) return tr(`All done here. Next: ${nextDoc.split("/").pop()} (J)`, `Здесь всё — дальше ${nextDoc.split("/").pop()} (J)`);
      return mode === "changes" ? tr("No unread changes", "Непрочитанных изменений нет") : mode === "comments" ? tr("No open comments", "Открытых замечаний нет") : tr("Everything read and resolved", "Всё прочитано и решено");
    }
    const parts: string[] = [];
    if (stop.blocks.length) parts.push(stop.blocks.length > 1 ? tr(`${counted(stop.blocks.length, W.block)} changed`, `${counted(stop.blocks.length, W.block)} изменено`) : tr("Block changed", "Блок изменён"));
    if (stop.tombstones.length) parts.push(tr("deletion", "удаление"));
    for (const annotation of annotations) parts.push(`${tr(`comment “${(annotation.messages[0]?.text ?? "").slice(0, 60)}”`, `замечание «${(annotation.messages[0]?.text ?? "").slice(0, 60)}»`)}${annotation.agent ? ` · ${AGENT_LABEL[annotation.agent] ?? annotation.agent}` : ""}`);
    return parts.join(" · ");
  };
  const description = describe();
  const progress = stops.length ? Math.round(((index + 1) / stops.length) * 100) : 0;
  const readable = stop && (stop.blocks.length > 0 || stop.tombstones.length > 0);
  const modeLabel = MODES.find((entry) => entry.value === mode)?.label ?? "";
  return <div className="dr-pass" role="toolbar" aria-label={tr("Pass", "Проход")} data-dr-sticky="bottom" data-pass-key={stop?.key ?? ""} data-pass-scope={scope} style={{ ["--dr-progress" as string]: `${progress}%` }}>
    {narrow
      ? <Menu>
        <MenuTrigger asChild><Button size="sm" variant="ghost" aria-label={tr(`Pass mode: ${modeLabel}; scope: ${scope === "document" ? "document" : "all documents"}`, `Режим прохода: ${modeLabel}; область: ${scope === "document" ? "документ" : "все документы"}`)}><Icon name="ListFilter" />{modeLabel}<Icon name="ChevronDown" /></Button></MenuTrigger>
        <MenuContent align="start" mobileTitle={tr("Pass", "Проход")}>
          <MenuLabel>{tr("Mode", "Режим")}</MenuLabel>
          <MenuRadioGroup value={mode} onValueChange={(next) => onMode(next as PassMode)}>
            {MODES.map((entry) => <MenuRadio key={entry.value} value={entry.value}>{entry.label}</MenuRadio>)}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuLabel>{tr("Scope", "Область")}</MenuLabel>
          <MenuRadioGroup value={scope} onValueChange={(next) => onScope(next as "document" | "all")}>
            <MenuRadio value="document">{tr("Document", "Документ")}</MenuRadio>
            <MenuRadio value="all">{tr("All documents", "Все документы")}</MenuRadio>
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      : <>
        <Segments value={mode} onChange={onMode} label={tr("Pass mode", "Режим прохода")} items={MODES} />
        <Segments value={scope} onChange={onScope} label={tr("Pass scope", "Область прохода")} items={[{ value: "document", label: tr("Document", "Документ") }, { value: "all", label: <>{tr("All", "Все")}<span className="dr-hide-md">{tr(" documents", " документы")}</span></>, aria: tr("All documents", "Все документы") }]} />
      </>}
    <span className="dr-pass__nav" data-pass-counter title={description}>
      <IconButton icon="ChevronUp" label={tr("Previous", "Предыдущая")} keys="K" small onClick={() => onMove(-1)} disabled={!stops.length && docIndex <= 0} />
      {scope === "all" && docs.length > 1 && <span className="dr-hide-md" title={tr("Pass document", "Документ прохода")}>{tr(`document ${num(docIndex + 1)} of ${num(docs.length)}`, `документ ${num(docIndex + 1)} из ${num(docs.length)}`)} ·&nbsp;</span>}
      {stops.length ? <><b>{num(index + 1)}</b>&nbsp;{tr("of", "из")}&nbsp;{num(stops.length)}</> : <b>0</b>}
      <IconButton icon="ChevronDown" label={tr("Next", "Следующая")} keys="J" small onClick={() => onMove(1)} disabled={!stops.length && !nextDoc} />
    </span>
    <span className="dr-pass__what" aria-live="polite" title={description}>{description}</span>
    {narrow && <span className="dr-grow" />}
    {annotations.length > 0 && <Tip label={tr("Reply in the comment", "Ответить в замечании")} keys="E"><Button size="sm" variant="ghost" onClick={onReply} aria-label={tr("Reply (E)", "Ответить (E)")}><Icon name="Reply" /><span className="dr-hide-md">{VERB.reply.button}</span> <Kbd>E</Kbd></Button></Tip>}
    {readable && !(narrow && acceptable) && <Tip label={VERB.readNext.button} keys="R"><Button size="sm" variant={acceptable ? "default" : "primary"} onClick={onRead}><Icon name="Check" />{tr("Mark read", "Прочитано")}<span className="dr-hide-md">{tr(" and next", " и дальше")}</span> <Kbd>R</Kbd></Button></Tip>}
    {acceptable && <Tip label={acceptable.latest!.linked.length ? tr(`Accept and next: ${counted(acceptable.latest!.linked.length, W.edit)} will be marked read`, `Принять и дальше: ${counted(acceptable.latest!.linked.length, W.edit)} отметятся прочитанными`) : tr("Accept and next", "Принять и дальше")} keys="A">
      <Button size="sm" variant="primary" onClick={onAccept}><Icon name="CheckCheck" />{VERB.accept.button} <Kbd>A</Kbd></Button>
    </Tip>}
  </div>;
}
