// The review example is browser-local and never touches repository files.
const root = document.documentElement;
const theme = document.querySelector("#theme-toggle");
function updateThemeLabel() { theme.setAttribute("aria-label", `Switch to ${root.classList.contains("dark") ? "light" : "dark"} theme`); }
updateThemeLabel();
theme.addEventListener("click", () => {
  root.classList.toggle("dark");
  try { localStorage.setItem("pactum:site-theme", root.classList.contains("dark") ? "dark" : "light"); } catch { /* Storage is optional. */ }
  updateThemeLabel();
});
const run = document.querySelector("#change-run");
const mark = document.querySelector("#mark-read");
const undo = document.querySelector("#undo-read");
function readState(read) {
  run.toggleAttribute("data-read", read);
  document.querySelector("#change-label").textContent = read ? "Read · both blocks confirmed" : "Changed since your last read";
  document.querySelector("#change-count").textContent = read ? "All changes read" : "2 unread blocks";
  document.querySelector("#demo-status").textContent = read ? "The whole change group is read." : "Try reading this change group.";
  mark.hidden = read; undo.hidden = !read;
  (read ? undo : mark).focus({ preventScroll: true });
}
mark.addEventListener("click", () => readState(true));
undo.addEventListener("click", () => readState(false));
const copy = document.querySelector("#copy-install");
copy.addEventListener("click", async () => {
  if (copy.disabled) return;
  copy.disabled = true;
  const status = document.querySelector("#copy-status");
  try {
    const text = document.querySelector("#install-command").textContent.trim();
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = document.createElement("textarea");area.value = text;area.style.position = "fixed";area.style.opacity = "0";document.body.append(area);area.select();
      const ok = document.execCommand("copy");area.remove();copy.focus({ preventScroll: true });if (!ok) throw new Error("Clipboard unavailable");
    }
    copy.querySelector("use").setAttribute("href", "#check");
    status.textContent = "Installation command copied.";
    setTimeout(() => copy.querySelector("use").setAttribute("href", "#copy"), 1500);
  } catch { status.textContent = "Copy is unavailable here. Select the command and copy it manually."; }
  finally { copy.disabled = false; }
});
