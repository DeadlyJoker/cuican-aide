import { LoaderCircle } from "lucide-react";
import { Suspense, lazy } from "react";

import type { CapabilityPanel } from "../../lib/capability/capabilityPanelTypes";
import { translate, type Locale } from "../../lib/i18n";
import type { SettingsSection } from "../../lib/settings/settingsCatalog";
import type { SettingsDataMode } from "../settings/SettingsContent";

const SettingsContent = lazy(() =>
  import("../settings/SettingsContent").then((module) => ({
    default: module.SettingsContent,
  })),
);

export function AppWorkspaceSettingsContent({
  activeSection,
  capabilityPanel,
  dataMode,
  disabled,
  locale,
  onPanelAction,
  onPanelFieldCommit,
  onPanelFieldChange,
}: {
  activeSection: SettingsSection;
  capabilityPanel: CapabilityPanel | null;
  dataMode: SettingsDataMode;
  disabled: boolean;
  locale: Locale;
  onPanelAction: (actionId: string) => void;
  onPanelFieldCommit: (fieldId: string, value: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
}) {
  const t = translate(locale);

  return (
    <Suspense
      fallback={
        <section className="settings-page" aria-label={t.settings}>
          <main className="settings-content">
            <div className="route-loading-state" role="status" aria-live="polite">
              <LoaderCircle aria-hidden="true" size={18} />
              <strong>{t.loadingThreads}</strong>
              <small>{t.loadingRouteHint}</small>
            </div>
          </main>
        </section>
      }
    >
      <SettingsContent
        activeSection={activeSection}
        dataMode={dataMode}
        disabled={disabled}
        locale={locale}
        panel={capabilityPanel}
        onPanelAction={onPanelAction}
        onPanelFieldCommit={onPanelFieldCommit}
        onPanelFieldChange={onPanelFieldChange}
      />
    </Suspense>
  );
}
