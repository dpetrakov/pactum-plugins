/**
 * The public tab API changed after bb 0.46. Keep capability checks at this
 * boundary so the same plugin still loads on its minimum supported host.
 * Registrations and panel targets retain their original IDs and JSON values.
 */
type Registration = Record<string, unknown>;
type App = {
  slots: {
    navPanel(registration: Registration): void;
    experimental_tab?: (registration: Registration) => void;
    threadPanelAction?: (registration: Registration) => void;
  };
};

/** Props shared by the legacy thread panel and the current thread action tab. */
export type ThreadPanelProps = { threadId: string; params: unknown };

export function registerNavPanel(app: unknown, registration: Registration & { id: string; fixedTabs?: readonly Registration[] }): void {
  const { slots } = app as App;
  if (typeof slots.experimental_tab !== "function") {
    slots.navPanel(registration);
    return;
  }
  const { fixedTabs = [], ...panel } = registration;
  slots.navPanel(panel);
  for (const tab of fixedTabs) {
    // panelId belongs to the old reference, not to the modern registration.
    const { panelId: _panelId, ...definition } = tab;
    slots.experimental_tab({ ...definition, context: { kind: "nav-panel", panelId: registration.id }, availability: "fixed" });
  }
}

export function registerThreadPanel(app: unknown, registration: Registration): void {
  const { slots } = app as App;
  if (typeof slots.experimental_tab === "function") {
    slots.experimental_tab({ ...registration, context: { kind: "thread" }, availability: "action" });
  } else if (typeof slots.threadPanelAction === "function") {
    slots.threadPanelAction(registration);
  } else {
    throw new Error("This bb host does not support thread panel tabs");
  }
}

type FixedTabOptions = { surface: { kind: "current" }; tab: { id: string; panelId: string }; target?: unknown };
type ThreadTabOptions = { actionId: string; title?: string; params?: unknown };
type Panel = {
  openTab?: (options: Registration) => boolean;
  openFixedTab?: (options: FixedTabOptions) => boolean;
};
type Navigate = { openThreadPanel?: (options: ThreadTabOptions) => boolean };

/** Prefer the current-surface controller, retaining the old host's refusal. */
export function openFixedTab(panel: unknown, options: FixedTabOptions): boolean {
  const controller = panel as Panel;
  if (typeof controller.openTab === "function") {
    return controller.openTab({
      tab: { id: options.tab.id, context: { kind: "nav-panel", panelId: options.tab.panelId }, availability: "fixed" },
      ...(options.target === undefined ? {} : { target: options.target }),
    });
  }
  return controller.openFixedTab?.(options) ?? false;
}

export function openThreadTab(panel: unknown, navigate: unknown, options: ThreadTabOptions): boolean {
  const controller = panel as Panel;
  if (typeof controller.openTab === "function") {
    const { actionId, ...instance } = options;
    return controller.openTab({ tab: { id: actionId, context: { kind: "thread" }, availability: "action" }, ...instance });
  }
  return (navigate as Navigate).openThreadPanel?.(options) ?? false;
}
