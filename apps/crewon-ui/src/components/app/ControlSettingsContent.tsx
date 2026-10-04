import { useEffect, useState } from "react";
import type { ControlApiClient } from "@crewon/control-client";
import type { AgentPlatformUser } from "../../lib/agent-platform/agentPlatformSession";
import type { Locale } from "../../lib/i18n";
import { detectRuntimeSurface, hasDesktopBridge } from "../../lib/platform";
import {
  controlSettingsPanel,
  type SettingsCatalogState,
} from "../../lib/settings/controlSettingsPanels";
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "../../lib/settings/settingsCatalog";
import { SettingsContent } from "../settings/SettingsContent";
import { readControlSettingsCatalog } from "../../lib/settings/controlSettingsCatalog";
import { BundledTaskPackSettings } from "../settings/BundledTaskPackSettings";
import { InstalledPluginSettings } from "../settings/InstalledPluginSettings";
import type { TaskPackDraftHandler } from "../../lib/plugin/prepareTaskPackDraft";
import type { InstalledPluginConfigurationClient } from "../../lib/plugins/useInstalledPluginConfiguration";
import type { DesktopLocalPluginSourceImportAccess } from "../../lib/desktop/desktopLocalPluginSourceImportProtocol";
import { InstalledPluginSettingsLocalImport } from "../settings/InstalledPluginSettingsLocalImport";
import { InstalledPluginCreditSettings } from "../settings/InstalledPluginCreditSettings";

export function ControlSettingsContent({
  activeSection,
  client,
  pluginConfigurationClient,
  localSourceImport = null,
  locale,
  platformUser,
  onSectionChange,
  onPrepareTaskPack,
}: {
  activeSection: SettingsSection;
  client: Pick<ControlApiClient, "getActiveAgentVersionCatalog"> &
    Partial<Pick<ControlApiClient, "plugins" | "pluginCredits">>;
  pluginConfigurationClient?: InstalledPluginConfigurationClient;
  localSourceImport?: DesktopLocalPluginSourceImportAccess | null;
  locale: Locale;
  platformUser: AgentPlatformUser | null;
  onSectionChange: (section: SettingsSection) => void;
  onPrepareTaskPack?: TaskPackDraftHandler;
}) {
  const [state, setState] = useState<SettingsCatalogState>({
    status: "loading",
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (activeSection !== "connections") return;
    const controller = new AbortController();
    void readControlSettingsCatalog({
      client,
      signal: controller.signal,
      onState: setState,
    });
    return () => controller.abort();
  }, [activeSection, client, revision]);
  return (
    <SettingsContent
      activeSection={activeSection}
      locale={locale}
      presentation="authored"
      panel={controlSettingsPanel({
        section: activeSection,
        locale,
        state,
        platformUser,
        surface: detectRuntimeSurface(),
      })}
      onPanelFieldChange={() => {}}
      onSectionChange={onSectionChange}
      onPanelAction={(action) => {
        if (action === "settings-refresh") setRevision((value) => value + 1);
        const target = SETTINGS_SECTIONS.find(
          (section) => action === `settings-open:${section}`,
        );
        if (target) onSectionChange(target);
      }}
    >
      {activeSection === "mcp-servers" && localSourceImport && (
        <InstalledPluginSettingsLocalImport
          client={localSourceImport.client}
          ownerKey={localSourceImport.ownerKey}
          locale={locale}
        />
      )}
      {activeSection === "mcp-servers" && client.plugins && (
        <InstalledPluginSettings
          client={client.plugins}
          configurationClient={pluginConfigurationClient}
          locale={locale}
        />
      )}
      {activeSection === "mcp-servers" && client.pluginCredits && (
        <InstalledPluginCreditSettings
          client={client.pluginCredits}
          accountSource={hasDesktopBridge() ? "localDevice" : "currentUser"}
          ownerKey={
            platformUser
              ? String(platformUser.id)
              : (localSourceImport?.ownerKey ?? "local-management")
          }
          locale={locale}
        />
      )}
      {activeSection === "mcp-servers" && platformUser && (
        <BundledTaskPackSettings
          locale={locale}
          userId={platformUser.id}
          onPrepare={onPrepareTaskPack}
        />
      )}
    </SettingsContent>
  );
}
