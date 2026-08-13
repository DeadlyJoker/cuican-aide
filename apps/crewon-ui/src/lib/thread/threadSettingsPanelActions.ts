import type { ConfigReadResponse } from "@crewon-ui-model/v2/ConfigReadResponse";
import type { ConfigRequirementsReadResponse } from "@crewon-ui-model/v2/ConfigRequirementsReadResponse";
import type { ModelListResponse } from "@crewon-ui-model/v2/ModelListResponse";
import type { ThreadGoalView } from "@crewon/contracts";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import { settledValue } from "../shared/settledResults";
import {
  buildThreadSettingsFieldMetadata,
  threadSettingsInitialPanel,
  threadSettingsMetadataPanel,
  threadSettingsMissingThreadPanel,
} from "./threadSettingsPanel";

type ThreadSettingsPanelClient = {
  listModels(): Promise<ModelListResponse>;
  readConfig(cwd?: string | null): Promise<ConfigReadResponse>;
  readConfigRequirements(): Promise<ConfigRequirementsReadResponse>;
};

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export type OpenThreadSettingsPanelActionParams = {
  client: ThreadSettingsPanelClient | null | undefined;
  cwd: string | null;
  hasBackendThread: boolean;
  isConnected: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  resolveBackendCwd: () => Promise<string | null | undefined>;
  setCapabilityDockOpen: (open: boolean) => void;
  setCapabilityPanel: SetCapabilityPanel;
  threadGoal: ThreadGoalView | null;
};

export async function openThreadSettingsPanelAction(
  params: OpenThreadSettingsPanelActionParams,
) {
  const {
    client,
    cwd,
    hasBackendThread,
    isConnected,
    isDemoPreview,
    locale,
    resolveBackendCwd,
    setCapabilityDockOpen,
    setCapabilityPanel,
    threadGoal,
  } = params;

  if (!hasBackendThread && !isDemoPreview) {
    setCapabilityDockOpen(true);
    setCapabilityPanel(threadSettingsMissingThreadPanel(locale));
    return;
  }

  setCapabilityDockOpen(true);
  setCapabilityPanel(
    threadSettingsInitialPanel({
      hasBackendThread,
      isDemoPreview,
      locale,
      threadGoal,
    }),
  );

  if (!isConnected || !hasBackendThread) {
    return;
  }

  const settingsCwd = cwd || (await resolveBackendCwd()) || null;
  const [configResult, requirementsResult, modelsResult] =
    await Promise.allSettled([
      client?.readConfig(settingsCwd),
      client?.readConfigRequirements(),
      client?.listModels(),
    ]);
  const configRead = settledValue(configResult, null);
  const requirements = settledValue(requirementsResult, null);
  const models = settledValue(modelsResult, null);
  const fieldMetadata = buildThreadSettingsFieldMetadata(
    models,
    requirements,
    configRead?.config,
    locale,
  );

  setCapabilityPanel((currentPanel) =>
    threadSettingsMetadataPanel(currentPanel, fieldMetadata, locale),
  );
}
