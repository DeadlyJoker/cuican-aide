import { PanelRight } from "lucide-react";

import type { Locale } from "../lib/i18n";
import type { Theme } from "../lib/theme";

export function TitleBarActions({
  capabilityDockOpen,
  capabilityLabel,
  onToggleCapabilityDock,
}: {
  capabilityDockOpen: boolean;
  capabilityLabel: string;
  languageLabel: string;
  locale: Locale;
  theme: Theme;
  themeLabel: string;
  onLocaleChange: (locale: Locale) => void;
  onToggleCapabilityDock: () => void;
  onToggleTheme: () => void;
}) {
  return (
    <div className="titlebar-actions">
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
