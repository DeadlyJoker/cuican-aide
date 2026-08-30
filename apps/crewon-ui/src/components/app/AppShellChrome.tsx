import { useEffect, type ReactNode } from "react";
import { toast } from "sonner";

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
  // Surface transient notices through the shared sonner toaster instead of a
  // bespoke overlay. The state is cleared immediately so `data-has-notice`
  // never lingers; the toast owns its own dismissal lifecycle from here.
  useEffect(() => {
    if (!notice) {
      return;
    }
    const show = notice.tone === "success" ? toast.success : toast.warning;
    show(notice.text, { id: "app-shell-notice" });
    onDismissNotice();
  }, [notice, onDismissNotice]);

  return (
    <div
      className="app-shell"
      data-inspector-open={inspectorOpen}
      data-right-sidebar-open={
        capabilityDockOpen && hasCapabilityPanel && appView !== "settings"
      }
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
