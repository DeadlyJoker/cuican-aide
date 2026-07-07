import type { AgentConfig, LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  agentCreateCapabilityFallbackError,
  agentCreateErrorMessage,
  agentCreateRecordFallbackError,
  buildAgentCreateLoadingPanel,
  buildAgentCreatePanel,
} from "../agent-config/agentConfigPanel";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

type AgentConfigWriteResult = {
  filePath: string;
  agentId?: string;
} | null;

export type LibraryAgentActionParams = {
  action: LibraryPanelAction;
  createAgentConfig: () => Promise<AgentConfig>;
  defaultAgentConfig: () => AgentConfig;
  locale: Locale;
  setLibraryPanel: LibraryPanelSetter;
  writeAgentConfig: (config: AgentConfig) => Promise<AgentConfigWriteResult>;
};

export async function handleLibraryAgentAction({
  action,
  createAgentConfig,
  defaultAgentConfig,
  locale,
  setLibraryPanel,
  writeAgentConfig,
}: LibraryAgentActionParams): Promise<boolean> {
  if (action.id !== "create-agent") {
    return false;
  }

  setLibraryPanel((currentPanel) =>
    buildAgentCreateLoadingPanel(currentPanel, locale),
  );

  let config: AgentConfig;
  let configError: string | undefined;
  let configPath: string | null = null;
  try {
    config = await createAgentConfig();
  } catch (error) {
    config = defaultAgentConfig();
    configError = agentCreateErrorMessage(
      error,
      agentCreateCapabilityFallbackError(locale),
    );
  }

  try {
    const writeResult = await writeAgentConfig(config);
    if (writeResult) {
      config = {
        ...config,
        agentId: writeResult.agentId ?? config.agentId,
      };
      configPath = writeResult.filePath;
    }
  } catch (error) {
    configError = agentCreateErrorMessage(
      error,
      agentCreateRecordFallbackError(locale),
    );
  }

  setLibraryPanel((currentPanel) =>
    buildAgentCreatePanel(currentPanel, {
      config,
      configError,
      configPath,
      locale,
    }),
  );
  return true;
}
