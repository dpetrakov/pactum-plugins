// Frontend of «Documents»: the viewer in a navPanel with the explicit checkout in the route, the «Comments» and
// «Agent» tabs of bb's right panel (the «waiting for you» counter is the badge of the «Documents» sidebar tab: bb 0.46's
// navigation rail shows no accessory, EP-099); the tree of the roots as a view of the
// sidebar-tabs host (column without the host), the viewer in a thread's side panel and as the Markdown file opener,
// and the window link for «Projects» (W-04).
// The language first (EP-126): every module below builds its wording in it. Shared feedback elements next (W-06b,
// EP-032): the plugin's own classes of the same specificity win over them.
import "./ui/lang.ts";
import "./feedback.css";
import "./ui/theme.css";
import "./ui/files.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { tr } from "./core/i18n.ts";
import { AgentTab } from "./ui/agent.tsx";
import { DocsLinkProvider, MarkdownFileOpener, ThreadDocsPanel } from "./ui/embedded.tsx";
import { OPENER_EXTENSIONS } from "./core/formats/registry.ts";
import { SidebarView } from "./ui/sidebar.tsx";
import { CommentsTab } from "./ui/comments.tsx";
import { DocsPage, PANEL_PATH } from "./ui/page.tsx";
import { agentTab, commentsTab } from "./ui/tabs.ts";
import { bindToasts } from "./ui/toast.ts";

bindToasts();

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "docs", title: tr("Documents", "Документы"), icon: "FileText", path: PANEL_PATH, component: DocsPage,
    fixedTabs: [
      { ...commentsTab, title: tr("Comments", "Замечания"), icon: "MessageSquare", layout: "flush", component: CommentsTab },
      { ...agentTab, title: tr("Agent", "Агент"), icon: "Bot", layout: "flush", component: AgentTab },
    ],
  });
  // The tree as a tab of the sidebar-tabs host (contract v1); nothing renders without the host.
  app.slots.experimental_appOverlay({ id: "sidebar-view", component: SidebarView });
  // «Documents» for other plugins of the window (docs-link-contract.ts).
  app.slots.experimental_appOverlay({ id: "docs-link", component: DocsLinkProvider });
  // The same viewer next to the chat (H3): the thread's checkout, this thread as the default recipient.
  app.slots.threadPanelAction({ id: "docs", title: tr("Documents", "Документы"), icon: "FileText", layout: "flush", component: ThreadDocsPanel });
  // Links and files of every supported format open in the viewer. Standard preview
  // falls back to bb's preview. Keep the markdown opener ID so existing user preferences survive updates.
  app.slots.fileOpener({ id: "markdown", title: tr("Documents (review)", "Документы (обзор)"), extensions: OPENER_EXTENSIONS, component: MarkdownFileOpener });
});
