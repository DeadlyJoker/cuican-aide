import { useState } from "react";
import { appliedAppearance } from "../../lib/appearance/appearanceRuntime";
import { readLocalAppearance } from "../../lib/appearance/localAppearanceStore";
import {
  detectOperatingSystem,
  detectPlatform,
  detectRuntimeSurface,
} from "../../lib/platform";
import {
  controlSettingsPanel,
  usesControlSettingsPanel,
} from "../../lib/settings/controlSettingsPanels";
import { appearancePanel } from "../../lib/settings/settingsConfigurationPanels";
import type { SettingsSection } from "../../lib/settings/settingsCatalog";
import { CommandSettingsRoute } from "./CommandSettingsRoute";

function ignorePreviewSettingsWrite() {}

/** Existing settings UI, with real local appearance reads and no connected or writable backend. */
export function ShortDramaPreviewSettings({ onBack }: { onBack(): void }) {
  const [section, setSection] = useState<SettingsSection>("config");
  const surface = detectRuntimeSurface();
  const panel =
    section === "appearance"
      ? appearancePanel({
          localPreferences: readLocalAppearance() ?? appliedAppearance(),
          configRead: null,
          currentLocale: "zh",
          currentTheme:
            document.documentElement.dataset.theme === "dark"
              ? "dark"
              : "light",
          cwd: null,
          locale: "zh",
          os: detectOperatingSystem(),
          surface,
        })
      : usesControlSettingsPanel(section)
        ? controlSettingsPanel({
            section,
            locale: "zh",
            state: { status: "error" },
            platformUser: null,
            surface,
          })
        : null;
  return (
    <CommandSettingsRoute
      activeSection={section}
      controlClient={null}
      platformUser={null}
      dataMode="disconnected"
      disabled
      locale="zh"
      notice={null}
      panel={panel}
      platform={detectPlatform()}
      onBack={onBack}
      onDismissNotice={ignorePreviewSettingsWrite}
      onPanelAction={ignorePreviewSettingsWrite}
      onPanelFieldChange={ignorePreviewSettingsWrite}
      onPanelFieldCommit={ignorePreviewSettingsWrite}
      onSectionChange={setSection}
    />
  );
}
