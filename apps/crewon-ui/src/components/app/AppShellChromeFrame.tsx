import type { ReactNode } from "react";

import { AppShellChrome } from "./AppShellChrome";
import type { AppView } from "../../lib/shared/appView";
import type { NoticeState } from "../../lib/shared/noticeState";
import { translate, type Locale } from "../../lib/i18n";
import type { PlatformKind } from "../../lib/platform";
import type { Theme } from "../../lib/theme";

type AppShellChromeFrameProps = {
  appView: AppView;
  capabilityDockOpen: boolean;
  children: ReactNode;
  hasCapabilityPanel: boolean;
  locale: Locale;
  notice: NoticeState | null;
  platform: PlatformKind;
  sidebarOpen: boolean;
  theme: Theme;
  title: string;
  onCloseSidebar: () => void;
  onDismissNotice: () => void;
  onLocaleChange: (locale: Locale) => void;
  onToggleCapabilityDock: () => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
};

export function AppShellChromeFrame({
  appView,
  capabilityDockOpen,
  children,
  hasCapabilityPanel,
  locale,
  notice,
  platform,
  sidebarOpen,
  theme,
  title,
  onCloseSidebar,
  onDismissNotice,
  onLocaleChange,
  onToggleCapabilityDock,
  onToggleSidebar,
  onToggleTheme,
}: AppShellChromeFrameProps) {
  const t = translate(locale);

  return (
    <AppShellChrome
      appView={appView}
      capabilityDockOpen={capabilityDockOpen}
      capabilityLabel={locale === "zh" ? "能力" : "Capabilities"}
      dismissLabel={t.dismiss}
      hasCapabilityPanel={hasCapabilityPanel}
      hideSidebarLabel={t.hideSidebar}
      languageLabel={t.language}
      locale={locale}
      notice={notice}
      platform={platform}
      showSidebarLabel={t.showSidebar}
      sidebarOpen={sidebarOpen}
      theme={theme}
      themeLabel={theme === "light" ? t.themeDark : t.themeLight}
      title={title}
      onCloseSidebar={onCloseSidebar}
      onDismissNotice={onDismissNotice}
      onLocaleChange={onLocaleChange}
      onToggleCapabilityDock={onToggleCapabilityDock}
      onToggleSidebar={onToggleSidebar}
      onToggleTheme={onToggleTheme}
    >
      {children}
    </AppShellChrome>
  );
}
