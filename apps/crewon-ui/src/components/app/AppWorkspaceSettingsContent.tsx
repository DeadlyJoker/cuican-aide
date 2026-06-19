import { Suspense, lazy } from "react";

import type { CapabilityPanel } from "../../lib/capability/capabilityPanelTypes";
import { translate, type Locale } from "../../lib/i18n";

const SettingsContent = lazy(() =>
  import("../settings/SettingsContent").then((module) => ({
    default: module.SettingsContent,
  })),
);

export function AppWorkspaceSettingsContent({
  capabilityPanel,
  disabled,
  locale,
  onPanelAction,
  onPanelFieldChange,
}: {
  capabilityPanel: CapabilityPanel | null;
  disabled: boolean;
  locale: Locale;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
}) {
  const t = translate(locale);

  return (
    <Suspense
      fallback={
        <section className="settings-page" aria-label={t.settings}>
          <main className="settings-content">
            <p className="settings-loading">{t.loadingThreads}</p>
          </main>
        </section>
      }
    >
      <SettingsContent
        disabled={disabled}
        locale={locale}
        panel={capabilityPanel}
        onPanelAction={onPanelAction}
        onPanelFieldChange={onPanelFieldChange}
      />
    </Suspense>
  );
}
