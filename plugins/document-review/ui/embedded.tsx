// Entry points of the viewer outside the «Documents» screen (EP-013-T02/T03): the thread side panel (the default
// recipient is that thread), the file opener for Markdown (a file tab next to the chat), and the window-level link
// that «Projects» uses to open the documentation of a concrete checkout. One domain model: the same DocsPage, the
// same store, the same explicit checkout in the route; «In Documents» keeps the document and position (H3).
import { type PluginFileOpenerProps, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { ThreadPanelProps } from "./bb-compat.ts";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { provideDocsLink } from "../docs-link-contract.ts";
import type { rpcContract } from "../server.ts";
import { bindRpc, call } from "./actions.ts";
import { tr } from "../core/i18n.ts";
import { Icon } from "./icons.tsx";
import { Banner, Button, Empty, SkeletonRows } from "./kit.tsx";
import { DocsPage, type Embedded, PANEL_PATH } from "./page.tsx";
import { type Route, subPathOf } from "./route.ts";

type ThreadContext = { environmentId: string | null; hostId: string | null; root: string | null };

function useThreadContext(threadId: string | null): { context: ThreadContext | null; error: string | null } {
  const [state, setState] = useState<{ context: ThreadContext | null; error: string | null }>({ context: null, error: null });
  useEffect(() => {
    if (!threadId) return;
    void call<ThreadContext>("review.threadContext", { threadId }).then((reply) => {
      if (reply.ok) setState({ context: (reply as unknown as { result: ThreadContext }).result, error: null });
      else setState({ context: null, error: reply.error.message });
    });
  }, [threadId]);
  return state;
}

/** Documents in a thread side panel uses that thread's checkout; To current thread targets its owning thread. */
export function ThreadDocsPanel({ threadId, params }: ThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  bindRpc(rpc);
  const initial = params && typeof params === "object" && !Array.isArray(params) && typeof (params as { subPath?: unknown }).subPath === "string" ? (params as { subPath: string }).subPath : null;
  const { context, error } = useThreadContext(initial ? null : threadId);
  const [subPath, setSubPath] = useState<string | null>(initial);
  useEffect(() => {
    if (subPath || !context) return;
    if (context.environmentId) setSubPath(subPathOf({ kind: "env", environmentId: context.environmentId, doc: null }));
  }, [context, subPath]);
  const embedded = useMemo<Embedded>(() => ({ navigate: setSubPath, threadId, kind: "thread-panel" }), [threadId]);
  if (!subPath) return <div className="dr-panel" data-dr>{error || (context && !context.environmentId)
    ? <Empty icon="FolderGit2" title={tr("Couldn't find the thread's checkout", "Рабочая копия треда не определена")}>{error ?? tr("The thread has no checkout. Open “Documents” from the navigation.", "У треда нет рабочей копии — откройте «Документы» из навигации.")}</Empty>
    : <div className="p-3"><SkeletonRows count={6} /></div>}</div>;
  return <div className="h-full min-h-0" data-bb-docs-embedded="thread-panel"><DocsPage subPath={subPath} embedded={embedded} /></div>;
}

type Located = { hostId: string; root: string; relative: string | null; environmentId: string | null; requested?: string; candidates?: string[] };

/** The route of a located file in its checkout: under the environment when bb knows one, else machine + path. */
function routeOf(found: Located, doc: string): Route {
  return found.environmentId ? { kind: "env", environmentId: found.environmentId, doc } : { kind: "host", hostId: found.hostId, root: found.root, doc };
}

/** Open workspace Markdown and host files in the same viewer. Resolve bare chat filenames on the checkout machine: open a unique match, offer multiple matches, and explain no match without claiming a never-existing file was deleted. */
export function MarkdownFileOpener({ path, source, Original }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  bindRpc(rpc);
  const [located, setLocated] = useState<Located | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [plain, setPlain] = useState(false);
  const [subPath, setSubPath] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLocated(null);
    setSubPath(null);
    setProblem(null);
    void (async () => {
      if (source.kind === "thread-storage") { setProblem("thread-storage"); return; }
      const reply = await call<Located>("review.locate", {
        path, kind: source.kind, environmentId: source.environmentId, threadId: source.threadId, hostId: source.experimental_hostId ?? null,
      });
      if (cancelled) return;
      if (!reply.ok) { setProblem(reply.error.message); return; }
      const found = (reply as unknown as { result: Located }).result;
      setLocated(found);
      if (found.relative) setSubPath(subPathOf(routeOf(found, found.relative)));
    })();
    return () => { cancelled = true; };
  }, [path, source.kind, source.environmentId, source.threadId, source.experimental_hostId]);
  const embedded = useMemo<Embedded>(() => ({ navigate: setSubPath, threadId: source.threadId, kind: "file" }), [source.threadId]);
  if (plain || problem === "thread-storage") return <Original />;
  const plainButton = <Button size="sm" onClick={() => setPlain(true)}>{tr("Plain preview", "Обычный просмотр")}</Button>;
  if (problem) return <div className="flex h-full flex-col" data-dr>
    <div className="p-2"><Banner icon="Info" role="status" actions={plainButton}>{tr(`“Documents” couldn't open the file: ${problem}.`, `«Документы» не открыли файл: ${problem}.`)}</Banner></div>
    <div className="min-h-0 flex-1"><Original /></div>
  </div>;
  if (located && !located.relative) {
    const requested = located.requested ?? path;
    const checkout = located.root.split("/").pop() ?? located.root;
    const candidates = located.candidates ?? [];
    return <div className="dr-panel flex h-full flex-col gap-2 p-2" data-dr data-bb-docs-embedded="file" data-locate-choice>
      {candidates.length
        ? <>
          <Banner icon="Files" role="status" actions={plainButton}>{tr(`The checkout ${checkout} has several files “${requested}”. Pick one.`, `В рабочей копии ${checkout} несколько файлов «${requested}» — выберите нужный.`)}</Banner>
          <ul className="m-0 list-none p-0" aria-label={tr(`Files “${requested}”`, `Файлы «${requested}»`)}>
            {candidates.map((candidate) => <li key={candidate}><button type="button" className="dr-option" onClick={() => setSubPath(subPathOf(routeOf(located, candidate)))}>
              <Icon name="FileText" /><span className="dr-trunc" title={candidate}><bdi>{candidate}</bdi></span></button></li>)}
          </ul>
        </>
        : <Banner icon="FileX" tone="error" role="alert" actions={plainButton}>{tr(`No file “${requested}” in the checkout ${checkout}: neither at this path nor by name among the Markdown files in Git.`, `Файла «${requested}» нет в рабочей копии ${checkout} — ни по этому пути, ни по имени среди Markdown-файлов Git.`)}</Banner>}
    </div>;
  }
  if (!located || !subPath) return <div className="dr-panel p-3" data-dr><SkeletonRows count={6} /></div>;
  return <div className="flex h-full min-h-0 flex-col" data-bb-docs-embedded="file" data-dr>
    <div className="flex items-center gap-2 border-b border-[var(--dr-seam)] px-3 py-1 text-[12px] text-muted-foreground"><Icon name="FileText" size={14} /><span className="dr-grow">{tr("Opened in “Documents”", "Открыто в «Документах»")}</span><Button size="sm" variant="ghost" onClick={() => setPlain(true)}>{tr("Plain preview", "Обычный просмотр")}</Button></div>
    <div className="min-h-0 flex-1"><DocsPage subPath={subPath} embedded={embedded} /></div>
  </div>;
}

/** App-wide: publishes the «Documents» link for other plugins of this window (docs-link-contract.ts). */
export function DocsLinkProvider() {
  const navigate = useBbNavigate();
  useLayoutEffect(() => provideDocsLink({
    contract: 1,
    open(target) {
      const doc = target.doc ?? null;
      const annotationId = typeof target.annotationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target.annotationId) ? target.annotationId : null;
      let route: Route;
      if ("environmentId" in target && typeof target.environmentId === "string" && target.environmentId) route = { kind: "env", environmentId: target.environmentId, doc, annotationId };
      else if ("hostId" in target && typeof target.hostId === "string" && typeof target.path === "string" && target.path.startsWith("/")) route = { kind: "host", hostId: target.hostId, root: target.path, doc, annotationId };
      else return false;
      navigate.toPluginPanel(PANEL_PATH, { subPath: subPathOf(route) });
      return true;
    },
  }), [navigate]);
  return null;
}
