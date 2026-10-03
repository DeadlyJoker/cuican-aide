import { X } from "lucide-react";
import type { ControlApiClient } from "@crewon/control-client";
import type { AgentPlatformUser } from "../../lib/agent-platform/agentPlatformSession";
import { usesControlSettingsPanel } from "../../lib/settings/controlSettingsPanels";
import { ControlSettingsContent } from "./ControlSettingsContent";
import type { TaskPackDraftHandler } from "../../lib/plugin/prepareTaskPackDraft";

import type { CapabilityPanel } from "../../lib/capability/capabilityPanelTypes";
import type { Locale } from "../../lib/i18n";
import type { NoticeState } from "../../lib/shared/noticeState";
import type { PlatformKind } from "../../lib/platform";
import type { SettingsSection } from "../../lib/settings/settingsCatalog";
import {
  SettingsContent,
  type SettingsDataMode,
} from "../settings/SettingsContent";
import { SettingsNavigation } from "../settings/SettingsNavigation";

export type CommandSettingsRouteProps = {
  onPrepareTaskPack?: TaskPackDraftHandler;
  controlClient?: ControlApiClient | null;
  platformUser?: AgentPlatformUser | null;
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
  onPrepareTaskPack,
  controlClient = null,
  platformUser = null,
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
          hiddenSections={
            controlClient && dataMode !== "demo"
              ? ["computer-control"]
              : undefined
          }
          activeSection={activeSection}
          locale={locale}
          onBack={onBack}
          onSectionChange={onSectionChange}
        />
        <section className="command-canvas settings-command-canvas">
          {notice ? (
            <div
              className="settings-command-notice"
              data-tone={notice.tone}
              role="status"
            >
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
          {controlClient &&
          dataMode !== "demo" &&
          usesControlSettingsPanel(activeSection) ? (
            <ControlSettingsContent
              onPrepareTaskPack={onPrepareTaskPack}
              key={activeSection}
              activeSection={activeSection}
              client={controlClient}
              pluginConfigurationClient={controlClient}
              locale={locale}
              platformUser={platformUser}
              onSectionChange={onSectionChange}
            />
          ) : (
            <SettingsContent
              activeSection={activeSection}
              dataMode={dataMode}
              disabled={disabled}
              locale={locale}
              panel={panel}
              onPanelAction={onPanelAction}
              onPanelFieldChange={onPanelFieldChange}
              onPanelFieldCommit={onPanelFieldCommit}
              onSectionChange={onSectionChange}
            />
          )}
        </section>
      </section>
    </section>
  );
}
