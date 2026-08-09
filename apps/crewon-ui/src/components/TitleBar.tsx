import { PanelLeft } from "lucide-react";
import type { Locale } from "../lib/i18n";
import type { PlatformKind } from "../lib/platform";
import type { Theme } from "../lib/theme";
import { TitleBarActions } from "./TitleBarActions";
import { TitleBarWindowControls } from "./TitleBarWindowControls";

type TitleBarProps = {
  locale: Locale;
  platform: PlatformKind;
  capabilityDockOpen: boolean;
  inspectorOpen: boolean;
  sidebarOpen: boolean;
  theme: Theme;
  title: string;
  hideSidebarLabel: string;
  inspectorLabel: string;
  languageLabel: string;
  showSidebarLabel: string;
  themeLabel: string;
  capabilityLabel: string;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onToggleCapabilityDock: () => void;
  onLocaleChange: (locale: Locale) => void;
  onToggleTheme: () => void;
};

export function TitleBar({
  capabilityDockOpen,
  inspectorOpen,
  locale,
  platform,
  sidebarOpen,
  theme,
  title,
  hideSidebarLabel,
  inspectorLabel,
  languageLabel,
  showSidebarLabel,
  themeLabel,
  capabilityLabel,
  onToggleSidebar,
  onToggleInspector,
  onToggleCapabilityDock,
  onLocaleChange,
  onToggleTheme,
}: TitleBarProps) {
  const sidebarLabel = sidebarOpen ? hideSidebarLabel : showSidebarLabel;

  return (
    <header className="titlebar" data-platform={platform}>
      <TitleBarWindowControls locale={locale} platform={platform} />
      <button
        className="icon-button"
        type="button"
        aria-expanded={sidebarOpen}
        aria-label={sidebarLabel}
        title={sidebarLabel}
        onClick={onToggleSidebar}
      >
        <PanelLeft size={17} />
      </button>
      <div className="titlebar-title">
        <strong>{title}</strong>
      </div>
      <TitleBarActions
        capabilityDockOpen={capabilityDockOpen}
        capabilityLabel={capabilityLabel}
        inspectorLabel={inspectorLabel}
        inspectorOpen={inspectorOpen}
        languageLabel={languageLabel}
        locale={locale}
        theme={theme}
        themeLabel={themeLabel}
        onLocaleChange={onLocaleChange}
        onToggleCapabilityDock={onToggleCapabilityDock}
        onToggleInspector={onToggleInspector}
        onToggleTheme={onToggleTheme}
      />
    </header>
  );
}
