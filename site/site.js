import { sources } from "./demos/fixtures.mjs";
// Examples are synthetic and local to this page. No agent or Git calls are made.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const root = document.documentElement;
const theme = $("#theme-toggle");
function themeLabel() {
  const dark = root.classList.contains("dark");
  theme.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} theme`);
  theme.querySelector("use").setAttribute("href", dark ? "#sun" : "#moon");
}
themeLabel();
theme.addEventListener("click", () => {
  root.classList.toggle("dark");
  try { localStorage.setItem("pactum:site-theme", root.classList.contains("dark") ? "dark" : "light"); } catch { /* Storage is optional. */ }
  themeLabel();
});
let current = 1, baseline = 0, previousBaseline = null, actionKind = true, pending = false, timer;
let quote = "The release owner publishes changes after the automated checks and a written summary.";
let returnFocus = $("#open-comment");
let comments = [];
const initialComments = $("#demo-comments").cloneNode(true);
const doc = $("#review-document");
const notice = (message) => { $("#review-notice").textContent = message; };
function renderDocument() {
  const template = $(`#document-${current}-${baseline}`);
  doc.replaceChildren(template.content.cloneNode(true));
  const unread = Number(template.dataset.unread);
  $$("[data-review-count]").forEach(element => { element.textContent = unread; });
  $("#read-all").disabled = !unread;
  $("#review-progress").textContent = unread ? `${unread} unread change${unread === 1 ? "" : "s"}` : "All changes read by Alex";
  $("#raw-source").textContent = sources[current];
  $("#undo-read").hidden = previousBaseline === null;
}
function markRead() {
  if (baseline === current) return;
  previousBaseline = baseline; baseline = current; renderDocument();
  notice("The whole change group is read. Alex's baseline is now the current version.");
  $("#undo-read").focus({ preventScroll: true });
}
$("#read-all").addEventListener("click", markRead);
$("#undo-read").addEventListener("click", () => {
  baseline = previousBaseline ?? baseline; previousBaseline = null; renderDocument();
  notice("Read undone. The previous baseline is restored."); $("#read-all").focus({ preventScroll: true });
});
function tab(name, focus = false) {
  for (const item of ["comments", "agent"]) {
    const active = name === item;
    $(`#${item}-tab`).setAttribute("aria-selected", String(active));
    $(`#${item}-tab`).tabIndex = active ? 0 : -1;
    $(`#${item}-panel`).hidden = !active;
  }
  if (focus) $(`#${name}-tab`).focus();
}
for (const name of ["comments", "agent"]) {
  $(`#${name}-tab`).addEventListener("click", () => tab(name));
  $(`#${name}-tab`).addEventListener("keydown", event => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault(); tab(event.key === "Home" ? "comments" : event.key === "End" ? "agent" : name === "comments" ? "agent" : "comments", true);
    }
  });
}
$("#back-comments").addEventListener("click", () => tab("comments", true));
function openComment(trigger, selectedQuote) {
  returnFocus = trigger || $("#open-comment");
  const selection = window.getSelection();
  const selected = selectedQuote || (selection?.anchorNode && doc.contains(selection.anchorNode) ? selection.toString().trim() : "");
  if (selected) quote = selected.slice(0, 350);
  tab("comments"); $("#comment-form").hidden = false; $("#comment-quote").textContent = quote;
  $("#comment-text").focus();
}
for (const selector of ["#open-comment", "#add-comment"]) $(selector).addEventListener("click", event => openComment(event.currentTarget));
function closeComment() { $("#comment-form").hidden = true; returnFocus?.isConnected && returnFocus.focus({ preventScroll: true }); }
$("#close-comment").addEventListener("click", closeComment);
$("#comment-form").addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); closeComment(); } });
$("#comment-text").addEventListener("input", () => { $("#save-comment").disabled = !$("#comment-text").value.trim(); });
for (const [selector, action] of [["#kind-action", true], ["#kind-note", false]]) $(selector).addEventListener("click", () => {
  actionKind = action; $("#kind-action").setAttribute("aria-pressed", String(action)); $("#kind-note").setAttribute("aria-pressed", String(!action));
});
function updateCommentCounts() {
  for (const selector of ["#comment-count", "#panel-count"]) $(selector).textContent = 1 + comments.length;
  const queued = comments.filter(c => c.action && !c.sent).length;
  $("#send-count").textContent = queued;
  $("#send-agent").disabled = pending || !queued;
}
function createComment(author, text, quoted, kind) {
  const article = document.createElement("article"); article.className = "comment-card";
  const header = document.createElement("div"); header.className = "comment-author";
  const avatar = document.createElement("span"); avatar.className = "avatar"; avatar.textContent = author[0];
  const name = document.createElement("b"); name.textContent = author;
  const badge = document.createElement("span"); badge.className = "note-kind"; badge.textContent = kind;
  header.append(avatar, name, badge);
  const blockquote = document.createElement("blockquote"); blockquote.textContent = quoted;
  const p = document.createElement("p"); p.textContent = text;
  article.append(header, blockquote, p); return article;
}
$("#comment-form").addEventListener("submit", event => {
  event.preventDefault(); const text = $("#comment-text").value.trim(); if (!text) return;
  comments.push({ text, quote, action: actionKind, sent: false });
  $("#demo-comments").append(createComment("Alex Rivera", text, quote, actionKind ? "For the agent" : "Team note"));
  $("#demo-comments").lastElementChild.scrollIntoView({ block: "nearest" });
  $("#comment-text").value = ""; $("#save-comment").disabled = true; closeComment(); updateCommentCounts();
  notice(actionKind ? "Comment saved with its context. Send the batch when you're ready." : "Team note saved. It is shared with the project, outside the agent batch.");
});
doc.addEventListener("click", event => {
  const button = event.target.closest("button"); if (!button) return;
  const block = button.closest("[data-block]");
  if (button.querySelector(".lucide-check,.lucide-check-check")) { markRead(); return; }
  if (button.classList.contains("dr-cmark")) { tab("comments", true); return; }
  const currentText = block?.querySelector(".dr-txt")?.cloneNode(true);
  currentText?.querySelectorAll("[data-skip]").forEach(node => node.remove());
  const text = currentText?.textContent;
  openComment(button, text);
});
$(".document-pane").addEventListener("keydown", event => {
  if (event.target.closest("input,textarea,button") || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() === "r") { event.preventDefault(); markRead(); }
  if (event.key.toLowerCase() === "c") { event.preventDefault(); openComment($("#open-comment")); }
});
$("#raw-toggle").addEventListener("click", () => {
  const raw = $("#raw-toggle").getAttribute("aria-pressed") !== "true";
  $("#raw-toggle").setAttribute("aria-pressed", String(raw)); doc.hidden = raw; $("#raw-source").hidden = !raw;
});
$("#select-review").addEventListener("click", () => { doc.hidden = false; $("#raw-source").hidden = true; $("#raw-toggle").setAttribute("aria-pressed", "false"); doc.querySelector("[data-block]")?.focus(); });
const agentSummary = $(".agent-summary");
function clearAgentExtras() { agentSummary.querySelectorAll(".agent-command,.agent-result-action").forEach(node => node.remove()); }
function addAgentAction(label, handler) {
  const button = document.createElement("button"); button.type = "button"; button.className = "tool agent-result-action"; button.textContent = label;
  button.addEventListener("click", handler); agentSummary.append(button);
}
$("#send-agent").addEventListener("click", () => {
  if (pending) return;
  const batch = comments.filter(c => c.action && !c.sent); if (!batch.length) return;
  pending = true; batch.forEach(c => { c.sent = true; }); updateCommentCounts(); tab("agent"); clearAgentExtras();
  $("#agent-state").textContent = "Example agent is working…";
  $("#agent-description").textContent = `One batch carries ${batch.length} instruction${batch.length === 1 ? "" : "s"}, the selected quotes and document context.`;
  const command = document.createElement("code"); command.className = "agent-command"; command.textContent = `Review batch · docs/release-plan.md\n${batch.map((c, i) => `${i + 1}. ${c.text}\n   On: “${c.quote}”`).join("\n")}`;
  agentSummary.append(command); notice("Sending the example batch. This simulation does not contact an agent.");
  $("#agent-panel").setAttribute("aria-busy", "true");
  timer = setTimeout(() => {
    pending = false; current = 2; previousBaseline = null; renderDocument(); updateCommentCounts();
    $("#agent-panel").setAttribute("aria-busy", "false");
    $("#agent-state").textContent = "Ready for your review";
    $("#agent-description").textContent = "This scripted example adds a human review before release. Compare the edit, then accept the response or ask for another pass.";
    notice("The example agent added a human review. The new edit is unread until you review it.");
    addAgentAction("View the edit", () => { doc.hidden = false; $("#raw-source").hidden = true; $("#raw-toggle").setAttribute("aria-pressed", "false"); doc.querySelector(".dr-blk--changed")?.focus(); });
    addAgentAction("Accept response", event => {
      $("#agent-state").textContent = "Response accepted by Alex"; $("#agent-description").textContent = "The instruction is accepted. Read receipts stay a separate, personal decision.";
      clearAgentExtras(); notice("You accepted the example response. Mark the edit read when you've checked it.");
    });
    addAgentAction("Ask for another pass", () => { actionKind = true; $("#kind-action").setAttribute("aria-pressed", "true"); $("#kind-note").setAttribute("aria-pressed", "false"); openComment($("#open-comment")); });
  }, 900);
});
$("#reset-review").addEventListener("click", () => {
  clearTimeout(timer); current = 1; baseline = 0; previousBaseline = null; comments = []; pending = false; clearAgentExtras();
  $("#demo-comments").replaceChildren(...[...initialComments.childNodes].map(node => node.cloneNode(true)));
  $("#agent-state").textContent = "Ready for an instruction"; $("#agent-description").textContent = "Save a comment for the agent, then send the batch from the document toolbar.";
  $("#agent-panel").setAttribute("aria-busy", "false"); $("#comment-form").hidden = true; $("#comment-text").value = ""; $("#save-comment").disabled = true;
  doc.hidden = false; $("#raw-source").hidden = true; $("#raw-toggle").setAttribute("aria-pressed", "false"); tab("comments"); renderDocument(); updateCommentCounts();
  notice("Demo restarted. Two paragraphs changed since Alex last read this document.");
});
renderDocument();

// Table dividers support pointer, touch and keyboard without editing Markdown.
const initialWidths = [220, 180, 560]; let widths = [...initialWidths];
const table = $("#resize-table"), cols = [...table.querySelectorAll("col")];
function updateWidths(index) {
  cols.forEach((col, i) => { col.style.width = `${widths[i]}px`; });
  table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
  $$("[data-column]").forEach((button, i) => { button.setAttribute("aria-valuenow", widths[i]); });
  $("#table-feedback").textContent = index === undefined ? "Widths restored. Drag a divider, or focus it and use ← / →." : `${["Decision", "Owner", "Review note"][index]} column: ${widths[index]} px. The Markdown source is unchanged.`;
}
for (const handle of $$("[data-column]")) {
  const index = Number(handle.dataset.column);
  handle.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); widths[index] = event.key === "Home" ? 100 : event.key === "End" ? 600 : Math.max(100, Math.min(600, widths[index] + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 8))); updateWidths(index);
  });
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0) return; event.preventDefault(); handle.focus(); handle.setPointerCapture(event.pointerId);
    const startX = event.clientX, startWidth = widths[index];
    const move = event => { widths[index] = Math.max(100, Math.min(600, Math.round(startWidth + event.clientX - startX))); updateWidths(index); };
    const stop = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); handle.removeEventListener("lostpointercapture", stop); };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", stop); handle.addEventListener("pointercancel", stop); handle.addEventListener("lostpointercapture", stop);
  });
}
$("#reset-columns").addEventListener("click", () => { widths = [...initialWidths]; updateWidths(); }); updateWidths();

// A shared project configuration, with independent read receipts for two people.
const roots = { docs: true, architecture: true, generated: false };
const readers = { alex: { name: "Alex Rivera", counts: { docs: 2, architecture: 1, generated: 4 } }, sam: { name: "Sam Chen", counts: { docs: 0, architecture: 1, generated: 4 } } };
let activeReader = "alex";
const paths = { docs: "docs/release-plan.md", architecture: "architecture/decisions.md", generated: "generated/api-reference.md" };
function renderTeam() {
  for (const [id, reader] of Object.entries(readers)) {
    const count = Object.keys(roots).reduce((sum, dir) => sum + (roots[dir] ? reader.counts[dir] : 0), 0);
    $(`#${id}-count`).textContent = `${count} unread`; $(`#reader-${id}`).setAttribute("aria-pressed", String(id === activeReader));
  }
  const reader = readers[activeReader]; $("#active-reader-name").textContent = reader.name; $("#note-author").textContent = reader.name.split(" ")[0];
  const list = $("#team-file-list"); list.replaceChildren();
  for (const dir of Object.keys(roots).filter(dir => roots[dir])) {
    const row = document.createElement("div"); row.className = "team-file";
    const text = document.createElement("div"), name = document.createElement("b"), count = document.createElement("small");
    name.textContent = paths[dir]; count.textContent = reader.counts[dir] ? `${reader.counts[dir]} changes since ${reader.name.split(" ")[0]}'s last read` : "Read by this reader"; text.append(name, count);
    const button = document.createElement("button"); button.className = "tool"; button.type = "button"; button.textContent = reader.counts[dir] ? "Mark read" : "Read"; button.disabled = !reader.counts[dir]; button.setAttribute("aria-label", `Mark ${paths[dir]} read as ${reader.name}`);
    button.addEventListener("click", () => { reader.counts[dir] = 0; renderTeam(); $("#team-explainer").textContent = `${reader.name} read ${paths[dir]}. The other reader's state is unchanged.`; $(`#reader-${activeReader}`).focus({ preventScroll: true }); });
    row.append(text, button); list.append(row);
  }
  if (!list.childElementCount) { const p = document.createElement("p"); p.textContent = "No folders tracked. Enable a review root to see its files."; list.append(p); }
}
for (const id of Object.keys(readers)) $(`#reader-${id}`).addEventListener("click", () => { activeReader = id; renderTeam(); $("#team-explainer").textContent = `Now viewing ${readers[id].name}'s personal read state. The discussion stays shared.`; });
for (const button of $$("[data-root]")) button.addEventListener("click", () => {
  const dir = button.dataset.root; roots[dir] = !roots[dir]; button.setAttribute("aria-pressed", String(roots[dir])); button.querySelector("span").textContent = roots[dir] ? "Tracked" : "Excluded";
  $("#root-feedback").textContent = `${dir}/ is ${roots[dir] ? "tracked for review" : "excluded from review"}. Both readers use these roots.`; renderTeam();
});
$("#team-note-form").addEventListener("submit", event => {
  event.preventDefault(); const input = $("#team-note-text"), text = input.value.trim(); if (!text) return;
  const article = document.createElement("article"); article.className = "team-note";
  const header = document.createElement("div"), avatar = document.createElement("span"), name = document.createElement("b"), badge = document.createElement("span"), p = document.createElement("p");
  avatar.className = "avatar"; avatar.textContent = readers[activeReader].name[0]; name.textContent = readers[activeReader].name; badge.textContent = "Note"; p.textContent = text; header.append(avatar, name, badge); article.append(header, p);
  $("#team-notes").append(article); article.scrollIntoView({ block: "nearest" }); input.value = ""; $("#team-explainer").textContent = `Note shared by ${readers[activeReader].name}. Switch readers to see the same discussion.`;
});
renderTeam();

// Load the actual Mermaid canvas only as it approaches the viewport.
let diagramLoading = false;
async function loadDiagram() {
  if (diagramLoading) return; diagramLoading = true;
  try { const { mountDiagram } = await import("./assets/diagram-demo.js"); mountDiagram(); }
  catch {
    $("#diagram-canvas").setAttribute("aria-busy", "false"); $("#diagram-canvas").replaceChildren();
    const retry = document.createElement("button"); retry.type = "button"; retry.className = "tool"; retry.textContent = "Diagram could not load. Retry";
    retry.addEventListener("click", () => { diagramLoading = false; loadDiagram(); }); $("#diagram-canvas").append(retry);
    $("#diagram-counts").textContent = "Diagram unavailable";
  }
}
if ("IntersectionObserver" in window) { const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); loadDiagram(); } }, { rootMargin: "350px" }); observer.observe($("#diagrams")); } else loadDiagram();
const copy = $("#copy-install");
copy.addEventListener("click", async () => {
  if (copy.disabled) return; copy.disabled = true;
  try {
    const text = $("#install-command").textContent.trim();
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = document.createElement("textarea"); area.value = text; area.style.position = "fixed"; area.style.opacity = "0"; document.body.append(area); area.select();
      const ok = document.execCommand("copy"); area.remove(); copy.focus({ preventScroll: true }); if (!ok) throw new Error("Clipboard unavailable");
    }
    copy.querySelector("use").setAttribute("href", "#check"); $("#copy-status").textContent = "Both installation commands copied.";
    setTimeout(() => copy.querySelector("use").setAttribute("href", "#copy"), 1500);
  } catch { $("#copy-status").textContent = "Copy is unavailable here. Select the commands and copy manually."; }
  finally { copy.disabled = false; }
});
