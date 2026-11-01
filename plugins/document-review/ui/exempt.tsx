// Not a secret exemptions on a masked value:
// Only for me displays the value without a click while shared data remains masked; or
// «For everyone in the repository…» — the host's preview first: where the value will be (.bb-docs, Git history, packages to the
// agent), that it cannot be taken back after a commit; then the confirmation. Explicit secrets (a private key, a URL
// password) cannot be exempted — the host refuses, the dialog says so before asking. Writes go through `mutate` (W-06b).
import { useEffect, useState } from "react";
import type { ViewSecret } from "../node/view.ts";
import { call, explain, mutate } from "./actions.ts";
import { Icon } from "./icons.tsx";
import { Banner, Button, CommandButton, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Segments } from "./kit.tsx";
import { dottedPath } from "../core/formats/paths.ts";
import { getUi, notify } from "./store.ts";
import { tr } from "../core/i18n.ts";

type Preview = { where: string[]; irreversible: boolean; revisionsWithValue: number };

export function ExemptDialog({ doc, secret, fileClass, onClose }: { doc: string; secret: ViewSecret | null; fileClass: string; onClose: () => void }) {
  const [level, setLevel] = useState<"me" | "repo">("me");
  const [preview, setPreview] = useState<Preview | { error: string } | null>(null);
  const keyPath = secret?.path ? JSON.stringify(secret.path) : null;
  const removing = secret?.exempt === "me" && level === "me";
  const repoAllowed = fileClass === "git";
  useEffect(() => { setLevel("me"); setPreview(null); }, [secret?.place]);
  useEffect(() => {
    if (!secret || !keyPath || level !== "repo" || !repoAllowed) return;
    let cancelled = false;
    setPreview(null);
    const { target } = getUi();
    void call<Preview>("review.secret.exempt", { target, path: doc, keyPath, level: "repo", action: "add", preview: true }).then((reply) => {
      if (cancelled) return;
      setPreview(reply.ok ? (reply as unknown as { result: Preview }).result : { error: explain(reply.error) });
    });
    return () => { cancelled = true; };
  }, [secret, keyPath, level, doc, repoAllowed]);
  if (!secret) return null;
  const name = secret.path ? dottedPath(secret.path) : secret.key ?? tr("value", "значение");
  const save = async () => {
    const done = await mutate<{ status: string }>("review.secret.exempt", { path: doc, keyPath, level, action: removing ? "remove" : "add" }, { verb: tr("save", "Сохранить") });
    if (!done) return;
    notify(level === "repo" ? tr(`“${name}” is not a secret for everyone in the repository: the value goes to the shared data with the next snapshot`, `«${name}» — не секрет для всех в репозитории: значение уйдёт в общие данные со следующим снимком`)
      : removing ? tr(`“${name}” is hidden from you again`, `«${name}» снова скрыт для вас`) : tr(`“${name}” is shown to you without a click`, `«${name}» показывается вам без клика`));
    onClose();
  };
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent data-dr data-exempt-dialog>
      <DialogHeader>
        <DialogTitle>{tr("Not a secret:", "Не секрет:")} <code>{name}</code></DialogTitle>
        <DialogDescription>{tr("The secret key pattern hid this value. The exemption applies only to this key of this file; the mask comes back by itself if the key disappears or is renamed.", "Шаблон секретных ключей скрыл это значение. Отмена действует только на этот ключ этого файла; маска вернётся сама, если ключ исчезнет или переименуется.")}</DialogDescription>
      </DialogHeader>
      {secret.explicit
        ? <Banner icon="Shield" role="status">{tr("This is an explicit secret (a private key or a password in a URL). Its mask cannot be lifted, neither for you nor for the repository.", "Это явный секрет (закрытый ключ или пароль в адресе) — его маскирование не отменяется ни для себя, ни для репозитория.")}</Banner>
        : <>
          <Segments label={tr("For whom", "Для кого")} value={level} onChange={setLevel} items={[
            { value: "me", label: <><Icon name="User" />{tr("Only for me", "Только для меня")}</> },
            { value: "repo", label: <><Icon name="Users" />{tr("For everyone in the repository…", "Для всех в репозитории…")}</>, aria: tr("For everyone in the repository", "Для всех в репозитории") },
          ]} />
          {level === "me" && <p className="dr-meta">{removing
            ? tr("This value is shown to you without a click now. Remove the exemption and the value is masked again.", "Сейчас это значение показывается вам без клика. Снять отмену — значение снова будет под маской.")
            : tr("The value will be shown to you without a click on this device. Shared data (.bb-docs), batches to the agent, logs and the CLI keep the mask.", "Значение будет показываться вам без клика на этом устройстве. Общие данные (.bb-docs), пакеты агенту, журналы и CLI сохраняют маску.")}</p>}
          {level === "repo" && !repoAllowed && <Banner icon="Info" role="status">{fileClass === "outside"
            ? tr("The file is outside Git: values of an ignored .env can be unmasked only for yourself.", "Файл вне Git: значения игнорируемого .env отменяются только для себя.")
            : tr("The file is not in the Git index yet: commit it first, or unmask the value only for yourself.", "Файл ещё не в индексе Git: сначала закоммитьте его — или отмените маску только для себя.")}</Banner>}
          {level === "repo" && repoAllowed && (preview === null
            ? <p className="dr-meta" aria-busy>{tr("Working out where the value will end up…", "Считаем, где окажется значение…")}</p>
            : "error" in preview
              ? <Banner icon="TriangleAlert" tone="error" role="alert">{preview.error}</Banner>
              : <Banner icon="TriangleAlert" tone="warn" role="alert" data-exempt-warning>
                {tr(`The value becomes visible to all participants: ${preview.where.join(", ")}. After a commit this cannot be undone: it stays in the Git history.`, `Значение станет видно всем участникам: ${preview.where.join(", ")}. После коммита это не отменить — оно останется в истории Git.`)}
              </Banner>)}
        </>}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{tr("Cancel", "Отмена")}</Button>
        {!secret.explicit && (level === "me" || (repoAllowed && preview && !("error" in preview))) && <CommandButton variant={level === "repo" ? "primary" : undefined} icon="ShieldOff" run={save}>
          {level === "repo" ? tr("Make visible to everyone", "Сделать видимым для всех") : removing ? tr("Hide again", "Снова скрывать") : tr("Show me without a click", "Показывать мне без клика")}</CommandButton>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
