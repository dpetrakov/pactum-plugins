// Toasts of «Documents» through the host's sonner (D6): `import { toast } from "sonner"` is shimmed to bb's Toaster, so
// the plugin mounts no container of its own. Reversible actions carry «Undo»; errors stay until closed.
import { toast } from "sonner";
import { VERB } from "./words.ts";
import { type Notice, setNotifySink } from "./store.ts";

export function bindToasts(): void {
  setNotifySink((notice: Notice) => {
    const action = notice.undo ? { label: notice.actionLabel ?? VERB.undo.button, onClick: () => void notice.undo!() } : undefined;
    const options = { action, duration: notice.ms, ...(notice.id ? { id: notice.id } : {}) };
    if (notice.tone === "error") toast.error(notice.text, options);
    else toast(notice.text, options);
  });
}
