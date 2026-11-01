// Review settings are grouped by ownership: repository settings shared through Git
// include roots, exclusions with explicit built-in exceptions, file types and secret-key patterns;
// pattern, exemptions from masking), «For me on this machine» (global exclusions, exemptions of this repository from
// them, global extensions of the pattern) and «On this device» (the view per file type, wrapping, line numbers,
// column widths). «Check» asks the host for the preview of the consequences; «Save» writes (config.json by
// CAS, the user's settings file). «Exclude folder…» of the tree opens the question of the level with its preview.
// Entry: ⚙ in the tree header and «⋯» of the document header. One panel per page (the first mounted host renders it).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { call, explain, loadTree, mutate } from "./actions.ts";
import { Icon } from "./icons.tsx";
import { Banner, Button, CommandButton, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, IconButton, Segments } from "./kit.tsx";
import { FORMATS, type FormatId, TYPE_GROUPS, GROUP_LABEL, type TypeGroup } from "../core/formats/registry.ts";
import { notify, useUi } from "./store.ts";
import { setNumbers, setViewMode, setWrap, useViewPrefs } from "./viewmode.ts";
import { moveVisualizer, setVisualizerEnabled, useVisualizers } from "./visualizers.ts";
import { counted, num, plural, W } from "./words.ts";
import { forms, LANG_NAME, LANGS, tr } from "../core/i18n.ts";
import { chooseLang, lang } from "./lang.ts";

type Level = "builtin" | "repo" | "global" | "exempt" | "me";
interface Settings {
  configSha: string | null; writable: boolean; readerId: string | null; repoId: string;
  repo: { roots: string[]; exclude: string[]; types: TypeGroup[] | null; secretKeys: string[]; secretExemptions: { path: string; keyPath: string }[]; hidden: string[]; untracked: string[] };
  builtin: { exclude: string[]; immutable: string[]; secretKeys: string[] };
  user: { exclude: string[]; exemptHere: string[]; secretKeys: string[]; exemptions: { path: string; keyPath: string }[]; retentionDays?: number | null;
    missingCheckouts?: { storeDir: string; root: string; documents: number; goneSince: string | null }[] };
  suggestedRoots: string[];
}
interface Draft { roots: string[]; exclude: string[]; types: TypeGroup[] | null; secretKeys: string[]; userExclude: string[]; exemptHere: string[]; userSecretKeys: string[]; retention: number | null }
interface Preview {
  status: "ok" | "invalid"; problems: { field: string; pattern: string; problem: string }[]; partial?: boolean;
  hidden?: { count: number; paths: string[]; reasons: { level: string; pattern: string; count: number }[] }; shown?: { count: number; paths: string[] };
  annotatedDropping?: string[]; secrets?: { values: number; files: number; paths: string[]; inHistory: number; globalWarning: string | null } | null;
}

// ── open state, one host per page ────────────────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
let open: { kind: "panel" } | { kind: "exclude"; path: string } | null = null;
const hosts: symbol[] = [];
const emit = () => { for (const listener of listeners) listener(); };
export function openSettings() { open = { kind: "panel" }; emit(); }
export function openExcludeFolder(path: string) { open = { kind: "exclude", path }; emit(); }
function close() { open = null; emit(); }
const useOpen = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => open, () => open);

const LEVEL: Record<Level, { icon: string; word: string; className: string }> = {
  builtin: { icon: "Package", word: tr("built-in", "встроенное"), className: "dr-lvl" },
  repo: { icon: "GitBranch", word: tr("repository", "репозиторий"), className: "dr-lvl dr-lvl--repo" },
  global: { icon: "User", word: tr("global", "глобальное"), className: "dr-lvl dr-lvl--global" },
  exempt: { icon: "User", word: tr("exempt here", "освобождено здесь"), className: "dr-lvl dr-lvl--off" },
  me: { icon: "User", word: tr("for me", "для меня"), className: "dr-lvl dr-lvl--global" },
};
const LevelBadge = ({ level }: { level: Level }) => <span className={LEVEL[level].className}><Icon name={LEVEL[level].icon} />{LEVEL[level].word}</span>;
const RULE = forms(["rule", "rules"], ["правило", "правила", "правил"]);
const VALUE = forms(["value", "values"], ["значение", "значения", "значений"]);
const EVENT = forms(["event", "events"], ["событие", "события", "событий"]);

function Rule({ pattern, level, why, off, children }: { pattern: string; level: Level; why?: ReactNode; off?: boolean; children?: ReactNode }) {
  return <li className={`dr-set__item${off ? " dr-set__item--off" : ""}`}><span className="dr-set__pat" title={pattern}>{pattern}</span>{why && <span className="dr-set__why">{why}</span>}<LevelBadge level={level} />{children}</li>;
}

const draftOf = (settings: Settings): Draft => ({ roots: settings.repo.roots, exclude: settings.repo.exclude, types: settings.repo.types, secretKeys: settings.repo.secretKeys,
  userExclude: settings.user.exclude, exemptHere: settings.user.exemptHere, userSecretKeys: settings.user.secretKeys, retention: settings.user.retentionDays === undefined ? 30 : settings.user.retentionDays });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The change of a draft against the loaded settings, in the host's shape. */
function changeOf(settings: Settings, draft: Draft) {
  const repo: Record<string, unknown> = {};
  if (!same(draft.roots, settings.repo.roots)) repo.roots = draft.roots;
  if (!same(draft.exclude, settings.repo.exclude)) repo.exclude = draft.exclude;
  if (!same(draft.types, settings.repo.types)) repo.types = draft.types;
  if (!same(draft.secretKeys, settings.repo.secretKeys)) repo.secretKeys = draft.secretKeys;
  const user: Record<string, unknown> = {};
  if (!same(draft.userExclude, settings.user.exclude)) user.exclude = draft.userExclude;
  if (!same(draft.exemptHere, settings.user.exemptHere)) user.exemptHere = draft.exemptHere;
  if (!same(draft.userSecretKeys, settings.user.secretKeys)) user.secretKeys = draft.userSecretKeys;
  if (draft.retention !== (settings.user.retentionDays === undefined ? 30 : settings.user.retentionDays)) user.retentionDays = draft.retention;
  return { ...(Object.keys(repo).length ? { repo } : {}), ...(Object.keys(user).length ? { user } : {}), count: Object.keys(repo).length + Object.keys(user).length };
}

function PreviewBlock({ preview }: { preview: Preview }) {
  // The answer of «Check» is shown where the eye goes next: scrolled into view above the footer.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: "nearest" }); }, [preview]);
  if (preview.status === "invalid") return <div ref={ref}><Banner icon="TriangleAlert" tone="error" role="alert">{preview.problems.map((entry) => tr(`“${entry.pattern}”: ${entry.problem}`, `«${entry.pattern}»: ${entry.problem}`)).join("; ")}</Banner></div>;
  return <div ref={ref} className="dr-prev" role="status" data-settings-preview>
    <div className="dr-prev__head"><Icon name="ScanEye" />{tr("Preview: what will change", "Предпросмотр: что изменится")}{preview.partial && <span className="dr-meta">{tr(" · partly counted (walk budget)", " · посчитано частично (бюджет обхода)")}</span>}</div>
    {preview.hidden && preview.hidden.count > 0 && <>
      <div className="dr-prev__row"><span className="dr-prev__num">−{num(preview.hidden.count)}</span><span>{tr("will be hidden by", "станет скрыто")} {preview.hidden.reasons.map((reason) => `${reason.level === "type" ? tr("type", "типом") : reason.level === "roots" ? tr("roots", "корнями") : tr(`rule ${reason.pattern}`, `правилом ${reason.pattern}`)} (${reason.level === "repo" ? tr("repository", "репозиторий") : reason.level === "global" ? tr("global", "глобальное") : reason.level === "builtin" ? tr("built-in", "встроенное") : reason.pattern})`).join(", ")}</span></div>
      <ul className="dr-prev__paths">{preview.hidden.paths.map((file) => <li key={file}>{file}</li>)}{preview.hidden.count > preview.hidden.paths.length && <li>{tr(`… and ${num(preview.hidden.count - preview.hidden.paths.length)} more`, `… и ещё ${num(preview.hidden.count - preview.hidden.paths.length)}`)}</li>}</ul>
    </>}
    {preview.shown && preview.shown.count > 0 && <>
      <div className="dr-prev__row"><span className="dr-prev__num">+{num(preview.shown.count)}</span><span>{tr("will be shown", "станет видно")}</span></div>
      <ul className="dr-prev__paths">{preview.shown.paths.map((file) => <li key={file}>{file}</li>)}{preview.shown.count > preview.shown.paths.length && <li>{tr(`… and ${num(preview.shown.count - preview.shown.paths.length)} more`, `… и ещё ${num(preview.shown.count - preview.shown.paths.length)}`)}</li>}</ul>
    </>}
    {(preview.annotatedDropping?.length ?? 0) > 0 && <div className="dr-prev__row"><span className="dr-prev__num">{num(preview.annotatedDropping!.length)}</span><span>{plural(preview.annotatedDropping!.length, W.document)} {tr("with comments will drop out of the review:", "с замечаниями выпадут из обзора:")} {preview.annotatedDropping!.join(", ")}</span></div>}
    {preview.secrets && <>
      <div className="dr-prev__row"><span className="dr-prev__num">{num(preview.secrets.values)}</span><span>{plural(preview.secrets.values, VALUE)} {tr("will be hidden in", "станет скрыто в")} {counted(preview.secrets.files, W.file)}</span></div>
      {preview.secrets.inHistory > 0 && <div className="dr-prev__row"><span className="dr-prev__num">{num(preview.secrets.inHistory)}</span><span>{tr("of these files are already in the .bb-docs history as plain text: the values stay there (Git history)", "из этих файлов уже в истории .bb-docs открытым текстом — там значения останутся (история Git)")}</span></div>}
      {preview.secrets.globalWarning && <div className="dr-prev__warn"><Icon name="TriangleAlert" /><span>{tr("The global extension protects display, batches and logs, but not the shared data. To hide the value in .bb-docs too, add the key for the repository.", "Глобальное расширение защищает показ, пакеты и журналы, но не общие данные. Чтобы скрыть и в .bb-docs, добавьте ключ для репозитория.")}</span></div>}
    </>}
    {!preview.hidden?.count && !preview.shown?.count && !preview.secrets?.values && <div className="dr-meta">{tr("The tree and masking won’t change.", "Дерево и маскирование не изменятся.")}</div>}
  </div>;
}

/** Add a pattern with the choice of the level (repository / global) and a check in place. */
function AddPattern({ placeholder, label, onAdd, levels = true, check }: { placeholder: string; label: string; onAdd: (pattern: string, level: "repo" | "global") => void; levels?: boolean; check: (pattern: string) => string | null }) {
  const [value, setValue] = useState("");
  const [level, setLevel] = useState<"repo" | "global">("repo");
  const problem = value.trim() ? check(value.trim()) : null;
  const add = () => { if (!value.trim() || problem) return; onAdd(value.trim(), level); setValue(""); };
  return <>
    <div className="dr-set__add">
      <label className="dr-field"><Icon name="Plus" /><input value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} aria-label={label} aria-invalid={Boolean(problem) || undefined}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} /></label>
      {levels && <Segments label={tr("Level", "Уровень")} value={level} onChange={setLevel} items={[{ value: "repo", label: tr("Repository", "Репозиторий"), title: tr("For everyone, via Git", "Для всех, через Git") }, { value: "global", label: tr("Global", "Глобально"), title: tr("All my checkouts on this machine", "Все мои рабочие копии на этой машине") }]} />}
      <Button onClick={add} aria-disabled={!value.trim() || Boolean(problem) || undefined}>{tr("Add", "Добавить")}</Button>
    </div>
    {problem && <div className="dr-set__hint dr-set__hint--error" role="alert">{problem}</div>}
  </>;
}

const globProblem = (pattern: string) => (/[\0\\\r\n]/.test(pattern) ? tr("pattern with an invalid character", "шаблон с недопустимым символом") : pattern === "!" ? tr("empty pattern", "пустой шаблон") : null);
const keyProblem = (pattern: string) => {
  try {
    new RegExp(`^(?:${pattern})$`, "i");
  } catch {
    return tr("not a regular expression", "не регулярное выражение");
  }
  if (new RegExp(`^(?:${pattern})$`, "i").test("")) return tr("pattern matches an empty name", "шаблон совпадает с пустым именем");
  return null;
};

function SettingsPanel() {
  const target = useUi((ui) => ui.target);
  const prefs = useViewPrefs();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showBuiltin, setShowBuiltin] = useState(false);
  const load = async () => {
    setError(null);
    const reply = await call<Settings>("review.settings.get", { target });
    if (!reply.ok) { setError(explain(reply.error)); return; }
    const value = (reply as unknown as { result: Settings }).result;
    setSettings(value);
    setDraft(draftOf(value));
    setPreview(null);
  };
  useEffect(() => { void load(); }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = useMemo(() => (settings && draft ? changeOf(settings, draft) : { count: 0 }), [settings, draft]);
  const update = (next: Partial<Draft>) => { setDraft((current) => (current ? { ...current, ...next } : current)); setPreview(null); };
  const check = async () => {
    const { count: _count, ...body } = change;
    const reply = await call<Preview>("review.settings.preview", { target, ...body });
    if (!reply.ok) { notify(tr(`Couldn’t compute the preview: ${explain(reply.error)}`, `Предпросмотр не посчитан: ${explain(reply.error)}`), { tone: "error" }); return; }
    setPreview((reply as unknown as { result: Preview }).result);
  };
  const save = async () => {
    const { count: _count, ...body } = change;
    const done = await mutate<{ status: string }>("review.settings.save", { ...body, configSha: settings?.configSha ?? null }, { verb: tr("save", "Сохранить") });
    if (!done) { await load(); return; }
    notify(tr("Review settings saved", "Настройки обзора сохранены"));
    void loadTree();
    await load();
  };
  if (error) return <Banner icon="TriangleAlert" tone="error" role="alert" actions={<CommandButton size="sm" icon="RefreshCw" run={load}>{tr("Retry", "Повторить")}</CommandButton>}>{tr(`Settings not loaded: ${error}`, `Настройки не загружены: ${error}`)}</Banner>;
  if (!settings || !draft) return <div className="dr-set__body" aria-busy><div className="dr-skel" style={{ width: "70%" }} /><div className="dr-skel" style={{ width: "50%", marginTop: 8 }} /></div>;
  const returned = new Set(draft.exclude.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1)));
  const returnedGlobal = new Set(draft.userExclude.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1)));
  const without = (list: string[], pattern: string) => list.filter((entry) => entry !== pattern);
  const types = draft.types ?? TYPE_GROUPS;
  const formats = (Object.keys(FORMATS) as FormatId[]).filter((format) => format !== "jsonc" && format !== "tsv");
  return <>
    <div className="dr-set__body">
      <section className="dr-set__sec" aria-labelledby="dr-set-repo">
        <h3 className="dr-set__title" id="dr-set-repo"><Icon name="GitBranch" />{tr("For the repository (via Git)", "Для репозитория (через Git)")}</h3>
        <p className="dr-set__lead">{tr("Visible to all participants; written to", "Видят все участники; запись — в")} <code>.bb-docs/config.json</code>{tr(", goes to Git with your commit.", ", попадёт в Git вашим коммитом.")}{!settings.writable && tr(" Read-only now.", " Сейчас только для чтения.")}</p>
        <div className="dr-set__label">{tr("Roots", "Корни")}</div>
        <ul className="dr-set__list">{draft.roots.map((root) => <Rule key={root} pattern={root} level="repo" why={root === "." ? tr("whole repository", "весь репозиторий") : undefined}>
          {draft.roots.length > 1 && <IconButton icon="X" small label={tr(`Remove root ${root}`, `Убрать корень ${root}`)} onClick={() => update({ roots: without(draft.roots, root) })} />}</Rule>)}</ul>
        {!draft.roots.includes(".") && <div className="dr-set__hint">{tr("Tip: the root “.” is the whole repository; built-in exclusions remove dependencies and builds.", "Подсказка: корень «.» — весь репозиторий; встроенные исключения убирают зависимости и сборки.")}
          <Button size="sm" variant="ghost" onClick={() => update({ roots: ["."] })}>{tr("Whole repository", "Весь репозиторий")}</Button></div>}
        <div className="dr-set__label">{tr("Exclusions", "Исключения")} <span>· {tr("the last match wins,", "последнее совпадение побеждает,")} <code>{tr("!pattern", "!шаблон")}</code> {tr("brings back", "возвращает")}</span></div>
        <ul className="dr-set__list">
          <Rule pattern={settings.builtin.exclude.slice(0, 4).join("  ") + "  …"} level="builtin" why={counted(settings.builtin.exclude.length, RULE)}>
            <Button size="sm" variant="ghost" aria-expanded={showBuiltin} onClick={() => setShowBuiltin(!showBuiltin)}>{showBuiltin ? tr("Collapse", "Свернуть") : tr("Override…", "Отменить…")}</Button></Rule>
          {showBuiltin && settings.builtin.exclude.map((pattern) => <Rule key={`b${pattern}`} pattern={pattern} level="builtin" off={returned.has(pattern) || returnedGlobal.has(pattern)}
            why={returned.has(pattern) ? tr(`overridden here: !${pattern}`, `отменено здесь: !${pattern}`) : returnedGlobal.has(pattern) ? tr(`overridden globally: !${pattern}`, `отменено глобально: !${pattern}`) : undefined}>
            {!returned.has(pattern) && !returnedGlobal.has(pattern) && <>
              <Button size="sm" variant="ghost" onClick={() => update({ exclude: [...draft.exclude, `!${pattern}`] })}>{tr("Override here", "Отменить здесь")}</Button>
              <Button size="sm" variant="ghost" onClick={() => update({ userExclude: [...draft.userExclude, `!${pattern}`] })}>{tr("Override globally", "Отменить глобально")}</Button></>}
          </Rule>)}
          {draft.exclude.map((pattern) => <Rule key={`r${pattern}`} pattern={pattern} level="repo" why={pattern.startsWith("!") ? tr("brings back", "возвращает") : undefined}>
            <IconButton icon="X" small label={tr(`Delete ${pattern}`, `Удалить ${pattern}`)} onClick={() => update({ exclude: without(draft.exclude, pattern) })} /></Rule>)}
          {draft.userExclude.map((pattern) => {
            const exempt = draft.exemptHere.includes(pattern);
            return <Rule key={`g${pattern}`} pattern={pattern} level={exempt ? "exempt" : "global"} off={exempt}>
              {exempt ? <Button size="sm" variant="ghost" onClick={() => update({ exemptHere: without(draft.exemptHere, pattern) })}>{tr("Restore here", "Вернуть здесь")}</Button>
                : <Button size="sm" variant="ghost" onClick={() => update({ exemptHere: [...draft.exemptHere, pattern] })}>{tr("Exempt here", "Освободить здесь")}</Button>}
              <IconButton icon="X" small label={tr(`Delete global ${pattern}`, `Удалить глобальное ${pattern}`)} onClick={() => update({ userExclude: without(draft.userExclude, pattern) })} />
            </Rule>;
          })}
          {settings.builtin.immutable.map((pattern) => <Rule key={`i${pattern}`} pattern={pattern} level="builtin" why={tr("can’t be changed", "не меняется")} />)}
        </ul>
        <AddPattern placeholder={tr("Pattern, as in .gitignore", "Шаблон, как в .gitignore")} label={tr("New exclusion", "Новое исключение")} check={globProblem}
          onAdd={(pattern, level) => (level === "repo" ? update({ exclude: [...draft.exclude, pattern] }) : update({ userExclude: [...draft.userExclude, pattern] }))} />
        <div className="dr-set__label">{tr("File types", "Типы файлов")}</div>
        <div className="dr-set__chips" role="group" aria-label={tr("File types", "Типы файлов")}>{TYPE_GROUPS.map((group) => {
          const on = types.includes(group);
          return <button key={group} type="button" className="dr-tgl" aria-pressed={on} onClick={() => {
            const next = on ? types.filter((entry) => entry !== group) : [...types, group];
            update({ types: next.length === TYPE_GROUPS.length ? null : TYPE_GROUPS.filter((entry) => next.includes(entry)) });
          }}><Icon name={FORMATS[(group === "csv" ? "csv" : group) as FormatId]?.icon ?? "File"} />{GROUP_LABEL[group]}</button>;
        })}</div>
        <div className="dr-set__label">{tr("Secret key pattern", "Шаблон секретных ключей")} <span>· {tr("the built-in set can only be extended", "встроенный набор только расширяется")}</span></div>
        <ul className="dr-set__list">
          <Rule pattern={settings.builtin.secretKeys.join("|")} level="builtin" why={tr("can’t be narrowed", "нельзя сузить")} />
          {draft.secretKeys.map((pattern) => <Rule key={`s${pattern}`} pattern={pattern} level="repo"><IconButton icon="X" small label={tr(`Delete ${pattern}`, `Удалить ${pattern}`)} onClick={() => update({ secretKeys: without(draft.secretKeys, pattern) })} /></Rule>)}
          {draft.userSecretKeys.map((pattern) => <Rule key={`u${pattern}`} pattern={pattern} level="global" why={tr("only display, batches, logs", "только показ, пакеты, журналы")}><IconButton icon="X" small label={tr(`Delete ${pattern}`, `Удалить ${pattern}`)} onClick={() => update({ userSecretKeys: without(draft.userSecretKeys, pattern) })} /></Rule>)}
        </ul>
        <AddPattern placeholder={tr("Key name or expression, e.g. signing_salt", "Имя ключа или выражение, например signing_salt")} label={tr("New secret key", "Новый секретный ключ")} check={keyProblem}
          onAdd={(pattern, level) => (level === "repo" ? update({ secretKeys: [...draft.secretKeys, pattern] }) : update({ userSecretKeys: [...draft.userSecretKeys, pattern] }))} />
        <div className="dr-set__label">{tr("Masking exemptions", "Исключения из маскирования")}</div>
        {settings.repo.secretExemptions.length + settings.user.exemptions.length === 0
          ? <div className="dr-set__hint">{tr("None. “Not a secret…” is on a masked value in the document.", "Нет. «Не секрет…» — на замаскированном значении в документе.")}</div>
          : <ul className="dr-set__list">
            {settings.repo.secretExemptions.map((entry) => <Rule key={`x${entry.path}${entry.keyPath}`} pattern={`${entry.path} · ${entry.keyPath}`} level="repo">
              <CommandButton size="sm" variant="ghost" run={async () => { await mutate("review.secret.exempt", { path: entry.path, keyPath: entry.keyPath, level: "repo", action: "remove" }, { verb: tr("remove", "Снять") }); await load(); }}>{tr("Remove", "Снять")}</CommandButton></Rule>)}
            {settings.user.exemptions.map((entry) => <Rule key={`m${entry.path}${entry.keyPath}`} pattern={`${entry.path} · ${entry.keyPath}`} level="me">
              <CommandButton size="sm" variant="ghost" run={async () => { await mutate("review.secret.exempt", { path: entry.path, keyPath: entry.keyPath, level: "me", action: "remove" }, { verb: tr("remove", "Снять") }); await load(); }}>{tr("Remove", "Снять")}</CommandButton></Rule>)}
          </ul>}
      </section>
      <section className="dr-set__sec" aria-labelledby="dr-set-me">
        <h3 className="dr-set__title" id="dr-set-me"><Icon name="User" />{tr("For me on this machine", "Для меня на этой машине")}</h3>
        <p className="dr-set__lead">{tr("Only you, in all checkouts on this machine; never goes to the repository. Global exclusions and the pattern are in the lists above with the “global” badge.", "Только вы, во всех рабочих копиях на этой машине; в репозиторий не попадает. Глобальные исключения и шаблон — в списках выше с бейджем «глобальное».")}</p>
        <div className="dr-set__label">{tr("Keep data of deleted local files", "Хранение данных удалённых локальных файлов")} <span>· {tr("review of files outside Git", "обзор файлов вне Git")}</span></div>
        <Segments label={tr("Keep data of deleted local files", "Хранение данных удалённых локальных файлов")} value={draft.retention === null ? "never" : String(draft.retention)} onChange={(next) => update({ retention: next === "never" ? null : Number(next) })}
          items={[{ value: "0", label: tr("Don’t keep", "Сразу") }, { value: "30", label: tr("30 days", "30 дней") }, { value: "90", label: tr("90 days", "90 дней") }, { value: "never", label: tr("Forever", "Никогда") }]} />
        <div className="dr-set__label">{tr("Missing checkouts", "Исчезнувшие рабочие копии")}</div>
        {(settings.user.missingCheckouts ?? []).length === 0
          ? <div className="dr-set__hint">{tr("None: local data of all your checkouts of this repository are in place.", "Нет: локальные данные всех ваших рабочих копий этого репозитория на месте.")}</div>
          : <ul className="dr-set__list">{(settings.user.missingCheckouts ?? []).map((entry) => <li key={entry.storeDir} className="dr-set__item">
            <span className="dr-set__pat" title={entry.root}>{entry.root}</span><span className="dr-set__why">{counted(entry.documents, EVENT)}</span>
            <CommandButton size="sm" variant="ghost" run={async () => { if (await mutate("review.local.bind", { storeDir: entry.storeDir }, { withContext: false, verb: tr("attach", "Привязать") })) { notify(tr("Local data attached to this checkout", "Локальные данные привязаны к этой рабочей копии")); await load(); } }}>{tr("Attach here", "Привязать сюда")}</CommandButton>
            <CommandButton size="sm" variant="ghost" run={async () => { if (await mutate("review.local.forgetStore", { storeDir: entry.storeDir }, { withContext: false, verb: tr("forget", "Забыть") })) { notify(tr(`Forgot local data of ${entry.root}`, `Забыты локальные данные ${entry.root}`)); await load(); } }}>{tr("Forget", "Забыть")}</CommandButton>
          </li>)}</ul>}
      </section>
      <section className="dr-set__sec" aria-labelledby="dr-set-device">
        <h3 className="dr-set__title" id="dr-set-device"><Icon name="MonitorSmartphone" />{tr("On this device", "На этом устройстве")}</h3>
        <p className="dr-set__lead">{tr("Only this browser; applies immediately.", "Только этот браузер; применяется сразу.")}</p>
        <div className="dr-set__label" id="dr-set-lang"><Icon name="Languages" />{tr("Language", "Язык")} <span>· {tr("the window reloads", "окно перезагрузится")}</span></div>
        <div className="dr-set__chips" role="group" aria-labelledby="dr-set-lang">
          {LANGS.map((value) => <button key={value} type="button" className="dr-tgl" lang={value} aria-pressed={lang() === value} onClick={() => chooseLang(value)}>{LANG_NAME[value]}</button>)}
        </div>
        <div className="dr-set__label">{tr("Default view", "Вид по умолчанию")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "6px 12px", alignItems: "center", justifyContent: "start" }}>
          {formats.map((format) => <FormatMode key={format} format={format} mode={prefs.modes[format] ?? "pretty"} />)}
        </div>
        <div className="dr-set__label">{tr("“Raw”", "«Как есть»")}</div>
        <div className="dr-set__chips">
          <button type="button" className="dr-tgl" aria-pressed={prefs.wrap} onClick={() => setWrap(!prefs.wrap)}><Icon name="WrapText" />{tr("Wrap lines", "Перенос строк")}</button>
          <button type="button" className="dr-tgl" aria-pressed={prefs.numbers} onClick={() => setNumbers(!prefs.numbers)}><Icon name="ListOrdered" />{tr("Line numbers", "Номера строк")}</button>
        </div>
        <div className="dr-set__label">{tr("Table column widths", "Ширины колонок таблиц")}</div>
        <Button size="sm" onClick={() => { try { localStorage.removeItem("bbdr:column-widths:v1"); } catch { /* blocked storage */ } notify(tr("Column widths reset: tables fit their content", "Ширины колонок сброшены — таблицы подстроятся по содержимому")); }}><Icon name="RotateCcw" />{tr("Reset", "Сбросить")}</Button>
        <div className="dr-set__label">{tr("Embed visualizers", "Визуализаторы вложений")} <span>· {tr("the order settles a dispute over one language", "порядок решает спор за один язык")}</span></div>
        <Visualizers />
      </section>
      {(settings.repo.hidden.length > 0 || settings.repo.untracked.length > 0) && <section className="dr-set__sec">
        <h3 className="dr-set__title"><Icon name="ListTree" />{tr("Tree actions", "Действия дерева")}</h3>
        <p className="dr-set__lead">{tr("“Hide” and “Untracked” are set in the tree row menu; here is the list.", "«Скрыть» и «Без отслеживания» задаются в меню строки дерева; здесь — список.")}</p>
        <ul className="dr-set__list">
          {settings.repo.hidden.map((pattern) => <Rule key={`h${pattern}`} pattern={pattern} level="repo" why={tr("hidden", "скрыто")} />)}
          {settings.repo.untracked.map((pattern) => <Rule key={`t${pattern}`} pattern={pattern} level="repo" why={tr("untracked", "без отслеживания")} />)}
        </ul>
      </section>}
      {preview && <PreviewBlock preview={preview} />}
    </div>
    <div className="dr-set__foot">
      <span className="dr-meta">{change.count ? tr(`Unsaved changes: ${num(change.count)}`, `Изменения не сохранены: ${num(change.count)}`) : tr("No changes", "Изменений нет")}</span>
      <Button variant="ghost" aria-disabled={!change.count || undefined} onClick={() => { if (change.count) { setDraft(draftOf(settings)); setPreview(null); } }}>{tr("Discard", "Отменить")}</Button>
      <CommandButton icon="ScanEye" run={check} disabled={!change.count}>{tr("Check", "Проверить")}</CommandButton>
      <CommandButton variant="primary" icon="Check" run={save} disabled={!change.count || !preview || preview.status !== "ok"}>{tr("Save", "Сохранить")}</CommandButton>
    </div>
  </>;
}

/** Visualizers registered in this window: enable/disable and choose priority order. */
function Visualizers() {
  const { entries, prefs, order } = useVisualizers();
  if (!entries.length) return <div className="dr-set__hint">{tr("No visualizers installed: embeds are shown as code.", "Нет установленных визуализаторов — вложения показываются кодом.")}</div>;
  const byId = new Map(entries.map((entry) => [entry.registration.id, entry]));
  return <ul className="dr-set__list" aria-label={tr("Embed visualizers", "Визуализаторы вложений")}>{order.map((id, index) => {
    const entry = byId.get(id);
    if (!entry) return null;
    const { registration, status } = entry;
    const blocked = prefs.blocked[id];
    const off = Boolean(blocked) || prefs.disabled.includes(id);
    const types = [...(registration.claims.languages ?? []).map((language) => `\`\`\`${language}`), ...(registration.claims.extensions ?? [])].join(" · ");
    return <li key={id} className={`dr-set__item${off ? " dr-set__item--off" : ""}`}>
      <Icon name={registration.icon ?? "Workflow"} />
      <span className="dr-set__pat" style={{ fontFamily: "var(--font-sans)" }} title={`${id} ${registration.version}`}>{registration.title}</span>
      <span className="dr-set__why">{types} · {registration.canvas === "static" ? tr("static", "статичный") : tr("interactive", "интерактивный")}</span>
      {blocked && <span className="dr-lvl dr-lvl--off" title={blocked}><Icon name="ShieldOff" />{tr("off: violation", "выключен: нарушение")}</span>}
      {!status.complete && <span className="dr-lvl" title={tr(`missing ${status.missing.join(", ")}`, `нет ${status.missing.join(", ")}`)}><Icon name="Info" />{tr("no comparison", "без сравнения")}</span>}
      <IconButton icon="ChevronUp" small label={tr(`Move up: ${registration.title}`, `Выше: ${registration.title}`)} disabled={index === 0} onClick={() => moveVisualizer(id, -1)} />
      <IconButton icon="ChevronDown" small label={tr(`Move down: ${registration.title}`, `Ниже: ${registration.title}`)} disabled={index === order.length - 1} onClick={() => moveVisualizer(id, 1)} />
      <button type="button" className="dr-tgl" aria-pressed={!off} onClick={() => setVisualizerEnabled(id, off)}>{off ? tr("Turn on", "Включить") : tr("On", "Включён")}</button>
    </li>;
  })}</ul>;
}

function FormatMode({ format, mode }: { format: FormatId; mode: "pretty" | "raw" }) {
  return <>
    <span>{FORMATS[format].label}</span>
    <Segments label={tr(`${FORMATS[format].label} view`, `Вид ${FORMATS[format].label}`)} value={mode} onChange={(next) => setViewMode(format, next)} items={[{ value: "pretty", label: tr("Pretty", "Красиво") }, { value: "raw", label: tr("Raw", "Как есть") }]} />
  </>;
}

/** «Exclude folder…» of the tree: only in this repository (for everyone, through Git) or globally, with the preview. */
function ExcludeFolder({ path }: { path: string }) {
  const target = useUi((ui) => ui.target);
  const [level, setLevel] = useState<"repo" | "global">("repo");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const pattern = `${path.replace(/\/$/, "")}/`;
  useEffect(() => {
    let cancelled = false;
    void call<Settings>("review.settings.get", { target }).then((reply) => { if (!cancelled && reply.ok) setSettings((reply as unknown as { result: Settings }).result); });
    return () => { cancelled = true; };
  }, [target]);
  const body = settings ? (level === "repo" ? { repo: { exclude: [...settings.repo.exclude, pattern] } } : { user: { exclude: [...settings.user.exclude, pattern] } }) : null;
  useEffect(() => {
    if (!body) return;
    let cancelled = false;
    setPreview(null);
    void call<Preview>("review.settings.preview", { target, ...body }).then((reply) => { if (!cancelled && reply.ok) setPreview((reply as unknown as { result: Preview }).result); });
    return () => { cancelled = true; };
  }, [level, settings, target]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!body) return;
    const done = await mutate("review.settings.save", { ...body, configSha: settings?.configSha ?? null }, { verb: tr("exclude", "Исключить") });
    if (!done) return;
    notify(level === "repo" ? tr(`Folder ${pattern} excluded in this repository`, `Папка ${pattern} исключена в этом репозитории`) : tr(`Folder ${pattern} excluded globally`, `Папка ${pattern} исключена глобально`));
    void loadTree();
    close();
  };
  return <>
    <DialogHeader><DialogTitle><Icon name="FolderX" /> {tr("Exclude folder", "Исключить папку")} <code>{pattern}</code></DialogTitle>
      <DialogDescription>{tr("Excluded items are not shown in the tree and not tracked; files and review data are not deleted.", "Исключённое не показывается в дереве и не отслеживается; файлы и данные обзора не удаляются.")}</DialogDescription></DialogHeader>
    <div role="radiogroup" aria-label={tr("Where to exclude", "Где исключить")} className="flex flex-col gap-2">
      {([["repo", "GitBranch", tr("Only in this repository", "Только в этом репозитории"), tr("For everyone, via Git: .bb-docs/config.json", "Для всех, через Git: .bb-docs/config.json")], ["global", "User", tr("Globally", "Глобально"), tr("All my checkouts on this machine; other participants are not affected", "Все мои рабочие копии на этой машине; другие участники не затронуты")]] as const).map(([value, icon, title, lead]) =>
        <button key={value} type="button" role="radio" aria-checked={level === value} className="dr-choice" onClick={() => setLevel(value)}>
          <Icon name={icon} /><span><b>{title}</b><span className="dr-meta" style={{ display: "block" }}>{lead}</span></span></button>)}
    </div>
    {preview ? <PreviewBlock preview={preview} /> : <p className="dr-meta" aria-busy>{tr("Working out the consequences…", "Считаем последствия…")}</p>}
    <DialogFooter><Button variant="ghost" onClick={close}>{tr("Cancel", "Отмена")}</Button><CommandButton variant="primary" icon="FolderX" run={save} disabled={!preview || preview.status !== "ok"}>{tr("Exclude", "Исключить")}</CommandButton></DialogFooter>
  </>;
}

/** Renders the panel or the exclusion dialog — only in the first mounted host of the page. */
export function SettingsHost() {
  const state = useOpen();
  const [me] = useState(() => Symbol("settings-host"));
  useEffect(() => { hosts.push(me); emit(); return () => { hosts.splice(hosts.indexOf(me), 1); emit(); }; }, [me]);
  if (!state || hosts[0] !== me) return null;
  return <Dialog open onOpenChange={(next) => { if (!next) close(); }}>
    <DialogContent data-dr data-settings={state.kind} className={state.kind === "panel" ? "dr-set" : undefined} style={state.kind === "panel" ? { maxWidth: 640, width: "100%", maxHeight: "86vh", padding: 0, gap: 0, display: "flex", flexDirection: "column", overflow: "hidden" } : undefined}>
      {state.kind === "panel"
        ? <><DialogHeader style={{ padding: "12px 16px", borderBottom: "1px solid var(--dr-seam)" }}><DialogTitle className="flex items-center gap-2"><Icon name="Settings" />{tr("Review settings", "Настройки обзора")}</DialogTitle>
          <DialogDescription className="dr-sr">{tr("Review rules of this checkout, by where they are stored", "Правила обзора этой рабочей копии по месту хранения")}</DialogDescription></DialogHeader><SettingsPanel /></>
        : <ExcludeFolder path={state.path} />}
    </DialogContent>
  </Dialog>;
}
