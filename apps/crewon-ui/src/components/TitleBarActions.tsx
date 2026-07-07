import {
  ChevronDown,
  Code2,
  Moon,
  PanelRight,
  SlidersHorizontal,
  Sun,
} from "lucide-react";

import type { Locale } from "../lib/i18n";
import type { Theme } from "../lib/theme";
import { TitleBarLanguageMenu } from "./TitleBarLanguageMenu";

export function TitleBarActions({
  capabilityDockOpen,
  capabilityLabel,
  inspectorLabel,
  inspectorOpen,
  languageLabel,
  locale,
  theme,
  themeLabel,
  onLocaleChange,
  onToggleCapabilityDock,
  onToggleInspector,
  onToggleTheme,
}: {
  capabilityDockOpen: boolean;
  capabilityLabel: string;
  inspectorLabel: string;
  inspectorOpen: boolean;
  languageLabel: string;
  locale: Locale;
  theme: Theme;
  themeLabel: string;
  onLocaleChange: (locale: Locale) => void;
  onToggleCapabilityDock: () => void;
  onToggleInspector: () => void;
  onToggleTheme: () => void;
}) {
  return (
    <div className="titlebar-actions">
      <button
        className="icon-button titlebar-model-button"
        type="button"
        aria-label="Model"
      >
        <Code2 size={14} />
        <ChevronDown size={12} />
      </button>
      <TitleBarLanguageMenu
        locale={locale}
        languageLabel={languageLabel}
        onLocaleChange={onLocaleChange}
      />
      <button
        className="icon-button"
        type="button"
        aria-label={themeLabel}
        title={themeLabel}
        onClick={onToggleTheme}
      >
        {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
      </button>
      <button
        className="icon-button titlebar-env-toggle"
        type="button"
        aria-expanded={inspectorOpen}
        aria-label={inspectorLabel}
        title={inspectorLabel}
        onClick={onToggleInspector}
      >
        <SlidersHorizontal size={15} />
      </button>
      <button
        className="icon-button capability-dock-trigger"
        type="button"
        aria-expanded={capabilityDockOpen}
        aria-label={capabilityLabel}
        title={capabilityLabel}
        onClick={onToggleCapabilityDock}
      >
        <PanelRight size={16} />
      </button>
    </div>
  );
}
