import type { AgentConfig, LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  agentCreateCapabilityFallbackError,
  agentCreateErrorMessage,
  buildAgentCreateLoadingPanel,
  buildAgentCreatePanel,
} from "../agent-config/agentConfigPanel";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type LibraryAgentActionParams = {
  action: LibraryPanelAction;
  createAgentConfig: () => Promise<AgentConfig>;
  defaultAgentConfig: () => AgentConfig;
  locale: Locale;
  setLibraryPanel: LibraryPanelSetter;
};

export async function handleLibraryAgentAction({
  action,
  createAgentConfig,
  defaultAgentConfig,
  locale,
  setLibraryPanel,
}: LibraryAgentActionParams): Promise<boolean> {
  if (action.id !== "create-agent") {
    return false;
  }

  setLibraryPanel((currentPanel) =>
    buildAgentCreateLoadingPanel(currentPanel, locale),
  );

  let config: AgentConfig;
  let configError: string | undefined;
  try {
    config = await createAgentConfig();
  } catch (error) {
    config = defaultAgentConfig();
    configError = agentCreateErrorMessage(
      error,
      agentCreateCapabilityFallbackError(locale),
    );
  }

  setLibraryPanel((currentPanel) =>
    buildAgentCreatePanel(currentPanel, {
      config,
      configError,
      configPath: null,
      locale,
    }),
  );
  return true;
}
