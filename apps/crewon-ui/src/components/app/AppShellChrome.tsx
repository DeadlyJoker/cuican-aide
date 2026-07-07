import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { TitleBar } from "../TitleBar";
import type { AppView } from "../../lib/shared/appView";
import type { NoticeState } from "../../lib/shared/noticeState";
import type { Locale } from "../../lib/i18n";
import type { PlatformKind } from "../../lib/platform";
import type { Theme } from "../../lib/theme";

type AppShellChromeProps = {
  appView: AppView;
  capabilityDockOpen: boolean;
  capabilityLabel: string;
  children: ReactNode;
  dismissLabel: string;
  hasCapabilityPanel: boolean;
  hideSidebarLabel: string;
  inspectorLabel: string;
  inspectorOpen: boolean;
  languageLabel: string;
  locale: Locale;
  notice: NoticeState | null;
  platform: PlatformKind;
  showSidebarLabel: string;
  sidebarOpen: boolean;
  theme: Theme;
  themeLabel: string;
  title: string;
  onCloseSidebar: () => void;
  onDismissNotice: () => void;
  onLocaleChange: (locale: Locale) => void;
  onToggleCapabilityDock: () => void;
  onToggleInspector: () => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
};

export function AppShellChrome({
  appView,
  capabilityDockOpen,
  capabilityLabel,
  children,
  dismissLabel,
  hasCapabilityPanel,
  hideSidebarLabel,
  inspectorLabel,
  inspectorOpen,
  languageLabel,
  locale,
  notice,
  platform,
  showSidebarLabel,
  sidebarOpen,
  theme,
  themeLabel,
  title,
  onCloseSidebar,
  onDismissNotice,
  onLocaleChange,
  onToggleCapabilityDock,
  onToggleInspector,
  onToggleSidebar,
  onToggleTheme,
}: AppShellChromeProps) {
  return (
    <div
      className="app-shell"
      data-inspector-open={inspectorOpen}
      data-right-sidebar-open={
        capabilityDockOpen && hasCapabilityPanel && appView !== "settings"
      }
      data-has-notice={Boolean(notice)}
      data-sidebar-open={sidebarOpen}
    >
      <TitleBar
        capabilityDockOpen={capabilityDockOpen}
        inspectorOpen={inspectorOpen}
        locale={locale}
        platform={platform}
        sidebarOpen={sidebarOpen}
        theme={theme}
        title={title}
        hideSidebarLabel={hideSidebarLabel}
        capabilityLabel={capabilityLabel}
        inspectorLabel={inspectorLabel}
        languageLabel={languageLabel}
        showSidebarLabel={showSidebarLabel}
        themeLabel={themeLabel}
        onToggleSidebar={onToggleSidebar}
        onToggleCapabilityDock={onToggleCapabilityDock}
        onToggleInspector={onToggleInspector}
        onLocaleChange={onLocaleChange}
        onToggleTheme={onToggleTheme}
      />
      <div className="workspace">
        {notice ? (
          <div className="notice-stack">
            <div
              className="connection-notice"
              data-tone={notice.tone}
              role="status"
            >
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{notice.text}</span>
              <button
                type="button"
                aria-label={dismissLabel}
                title={dismissLabel}
                onClick={onDismissNotice}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </div>
        ) : null}
        {sidebarOpen ? (
          <button
            className="sidebar-scrim"
            type="button"
            aria-label={hideSidebarLabel}
            onClick={onCloseSidebar}
          />
        ) : null}
        {children}
      </div>
    </div>
  );
}
