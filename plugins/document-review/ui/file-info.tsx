import { experimental_saveFile } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { locale, tr } from "../core/i18n.ts";
import { FORMATS, type FormatId } from "../core/formats/registry.ts";
import { useCommand } from "../feedback.ts";
import type { DocumentView } from "../node/view.ts";
import { call, explain } from "./actions.ts";
import { CopyButton } from "./copy.tsx";
import { Button, busyProps, BusyGlyph, IconButton, InlineError, Popover, PopoverContent, PopoverTrigger, Skeleton, WaitNote } from "./kit.tsx";
import { getUi, notify } from "./store.ts";

interface FileInfo { absolutePath: string; relativePath: string; format: FormatId; size: number; version: string }
interface FileChunk extends FileInfo { content: string; next: number }

export function FileInfoButton({ view }: { view: DocumentView }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState(0);
  const target = getUi().target;
  const path = view.document.path;
  useEffect(() => {
    if (!open || view.document.missing) return;
    let disposed = false;
    setInfo(null); setError(null);
    void call<FileInfo>("review.fileInfo", { target, path }).then((reply) => {
      if (disposed) return;
      if (reply.ok) setInfo(reply.result!);
      else setError(explain(reply.error));
    });
    return () => { disposed = true; };
  }, [open, path, attempt, view.document.missing]); // target belongs to this keyed document
  const download = useCommand(async (signal) => {
    if (!info) return;
    setError(null); setProgress(0);
    try {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let offset = 0;
      do {
        const reply = await call<FileChunk>("review.fileInfo", { target, path, chunk: { offset, version: info.version } });
        if (signal.aborted) return;
        if (!reply.ok) throw new Error(explain(reply.error));
        const chunk = reply.result!;
        if (chunk.next <= offset && offset < info.size) throw new Error(tr("The file could not be read", "Не удалось прочитать файл"));
        parts.push(Uint8Array.from(atob(chunk.content), (char) => char.charCodeAt(0)));
        offset = chunk.next;
        setProgress(info.size ? Math.round(offset / info.size * 100) : 100);
      } while (offset < info.size);
      const outcome = await experimental_saveFile({ fileName: path.split("/").pop()!, blob: new Blob(parts, { type: "application/octet-stream" }) });
      if (outcome === "started") notify(tr("Download started", "Скачивание началось"));
      else setError(tr("Could not start the download. Try again.", "Не удалось начать скачивание. Повторите попытку."));
    } catch (error) { if (!signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
  });
  useEffect(() => () => download.cancel(), [download.cancel]);
  return <Popover open={open} onOpenChange={(next) => { if (!next) download.cancel(); setOpen(next); }}>
    <PopoverTrigger asChild><IconButton icon="Info" label={tr("Document information", "Информация о документе")} /></PopoverTrigger>
    <PopoverContent align="end" mobileTitle={tr("Document information", "Информация о документе")} className="dr-file-info" aria-label={tr("Document information", "Информация о документе")}>
      <b>{tr("Document information", "Информация о документе")}</b>
      {view.document.missing ? <p>{tr("The file was deleted. The last review revision is shown.", "Файл удалён. Показана последняя редакция из обзора.")}</p> : <>
        {!info && !error && <Skeleton label={tr("Loading file information", "Загружаю сведения о файле")} />}
        {info && <>
          <div className="dr-file-info__path"><span className="dr-meta">{tr("Absolute path", "Абсолютный путь")}</span><code>{info.absolutePath}</code><CopyButton text={info.absolutePath} label={tr("Copy absolute path", "Копировать абсолютный путь")} size="md" /></div>
          <div className="dr-file-info__path"><span className="dr-meta">{tr("Relative to checkout", "Относительно рабочей копии")}</span><code>{info.relativePath}</code><CopyButton text={info.relativePath} label={tr("Copy relative path", "Копировать относительный путь")} size="md" /></div>
          <dl className="dr-file-info__meta"><dt>{tr("Type", "Тип")}</dt><dd>{FORMATS[info.format]?.label ?? info.format}</dd><dt>{tr("Size", "Размер")}</dt><dd>{new Intl.NumberFormat(locale()).format(info.size)} {tr("bytes", "байт")}</dd></dl>
          <Button {...busyProps(download.state)} disabled={download.state.running} onClick={() => void download.start()}><BusyGlyph name="Download" />{tr("Download original", "Скачать оригинал")}</Button>
          {download.state.slow && <><Button variant="ghost" onClick={() => download.cancel()}>{tr("Cancel", "Отменить")}</Button><WaitNote>{tr(`Downloading: ${progress}%`, `Скачиваю: ${progress}%`)}</WaitNote></>}
        </>}
      </>}
      {error && <InlineError onRetry={() => { setInfo(null); setAttempt((value) => value + 1); }}>{error}</InlineError>}
    </PopoverContent>
  </Popover>;
}
