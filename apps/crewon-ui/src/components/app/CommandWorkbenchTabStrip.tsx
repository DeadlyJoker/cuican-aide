import { PanelRight, Plus, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import type { Locale } from "../../lib/i18n";

/** One tab strip for tools and plugin pages. Hiding a pane never closes its tabs. */
export function CommandWorkbenchTabStrip({
  tabs,
  locale,
  launcherOpen,
  launcherRef,
  launcher,
  windowActions,
  onToggleLauncher,
  onHide,
}: {
  tabs: readonly {
    id: string;
    label: ReactNode;
    closeLabel: string;
    active: boolean;
    activate(): void;
    close(): void;
  }[];
  locale: Locale;
  launcherOpen: boolean;
  launcherRef: RefObject<HTMLDivElement | null>;
  launcher: ReactNode;
  windowActions?: ReactNode;
  onToggleLauncher(): void;
  onHide(): void;
}) {
  return (
    <header className="command-workbench-tabbar" data-desktop-drag-region="">
      <div
        className="command-workbench-tabs"
        role="tablist"
        aria-label={locale === "zh" ? "工作台页面" : "Workbench pages"}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.active}
            className="command-workbench-tab"
            data-active={tab.active ? "true" : undefined}
          >
            <button type="button" onClick={tab.activate}>
              <span>{tab.label}</span>
            </button>
            <button
              type="button"
              className="command-workbench-tab-close"
              aria-label={tab.closeLabel}
              onClick={tab.close}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        ))}
        <div className="command-workbench-launcher-anchor" ref={launcherRef}>
          <button
            type="button"
            className="command-workbench-add"
            aria-label={locale === "zh" ? "打开工具" : "Open tool"}
            aria-haspopup="menu"
            aria-expanded={launcherOpen}
            aria-controls="command-workbench-launcher-menu"
            onClick={onToggleLauncher}
          >
            <Plus aria-hidden="true" />
          </button>
        </div>
      </div>
      {launcherOpen ? launcher : null}
      {windowActions}
      <button
        type="button"
        className="command-workbench-close"
        aria-label={locale === "zh" ? "收起工作台" : "Hide workbench"}
        onClick={onHide}
      >
        <PanelRight aria-hidden="true" />
      </button>
    </header>
  );
}
