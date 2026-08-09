import { PanelRight, SlidersHorizontal } from "lucide-react";

import type { Locale } from "../lib/i18n";
import type { Theme } from "../lib/theme";

export function TitleBarActions({
  capabilityDockOpen,
  capabilityLabel,
  inspectorLabel,
  inspectorOpen,
  onToggleCapabilityDock,
  onToggleInspector,
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
