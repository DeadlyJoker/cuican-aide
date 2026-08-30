import { X } from "lucide-react";

import type { CapabilityPanel } from "../../lib/capability/capabilityPanelTypes";
import type { Locale } from "../../lib/i18n";
import type { NoticeState } from "../../lib/shared/noticeState";
import type { PlatformKind } from "../../lib/platform";
import type { SettingsSection } from "../../lib/settings/settingsCatalog";
import { SettingsContent, type SettingsDataMode } from "../settings/SettingsContent";
import { SettingsNavigation } from "../settings/SettingsNavigation";

export type CommandSettingsRouteProps = {
  activeSection: SettingsSection;
  dataMode: SettingsDataMode;
  disabled: boolean;
  locale: Locale;
  notice: NoticeState | null;
  panel: CapabilityPanel | null;
  platform: PlatformKind;
  onBack: () => void;
  onDismissNotice: () => void;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onPanelFieldCommit: (fieldId: string, value: string) => void;
  onSectionChange: (section: SettingsSection) => void;
};

export function CommandSettingsRoute({
  activeSection,
  dataMode,
  disabled,
  locale,
  notice,
  panel,
  platform,
  onBack,
  onDismissNotice,
  onPanelAction,
  onPanelFieldChange,
  onPanelFieldCommit,
  onSectionChange,
}: CommandSettingsRouteProps) {
  return (
    <section className="screen-shell command-screen settings-command-screen">
      <section className="desktop-window command-window settings-command-window">
        <SettingsNavigation
          activeSection={activeSection}
          locale={locale}
          onBack={onBack}
          onSectionChange={onSectionChange}
        />
        <section className="command-canvas settings-command-canvas">
          {notice ? (
            <div className="settings-command-notice" data-tone={notice.tone}>
              <span>{notice.text}</span>
              <button
                type="button"
                aria-label={locale === "zh" ? "关闭" : "Dismiss"}
                onClick={onDismissNotice}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <SettingsContent
            activeSection={activeSection}
            dataMode={dataMode}
            disabled={disabled}
            locale={locale}
            panel={panel}
            onPanelAction={onPanelAction}
            onPanelFieldChange={onPanelFieldChange}
            onPanelFieldCommit={onPanelFieldCommit}
          />
        </section>
      </section>
    </section>
  );
}
