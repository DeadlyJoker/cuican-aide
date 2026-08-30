import type { AgentReadResponse } from "../app-server/appServer";
import {
  agentConfigHydrateFailurePanel,
  agentConfigHydratedPanel,
  agentConfigPanel,
  buildAgentConfigPanelContent,
} from "./agentConfigPanel";
import type { AgentConfig, LibraryItemAction, LibraryPanel } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

type AgentConfigAction = Extract<LibraryItemAction, { type: "agent-config" }>;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type OpenAgentConfigActionParams = {
  action: AgentConfigAction;
  isConnected: boolean;
  locale: Locale;
  readAgentConfig: (params: {
    agentId?: string | null;
    threadId?: string | null;
    name?: string | null;
  }) => Promise<AgentReadResponse | null | undefined>;
  readThread: (threadId: string) => Promise<Thread | null | undefined>;
  setLibraryPanel: LibraryPanelSetter;
};

export async function openAgentConfigAction({
  action,
  isConnected,
  locale,
  readAgentConfig,
  readThread,
  setLibraryPanel,
}: OpenAgentConfigActionParams): Promise<boolean> {
  const selectedAgent = action.config;
  setLibraryPanel((currentPanel) =>
    agentConfigPanel(
      currentPanel,
      buildAgentConfigPanelContent(action, locale),
    ),
  );

  if (!isConnected) {
    return true;
  }

  try {
    const latestAgentConfig = await readLatestAgentConfig(
      selectedAgent,
      readAgentConfig,
    );
    const agentThreadId = latestAgentConfig.threadId;
    const thread = agentThreadId ? await readThread(agentThreadId) : null;
    setLibraryPanel((currentPanel) =>
      agentConfigHydratedPanel(currentPanel, selectedAgent.name, {
        config: latestAgentConfig,
        locale,
        thread,
      }),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      agentConfigHydrateFailurePanel(
        currentPanel,
        selectedAgent.name,
        error,
        locale,
      ),
    );
  }

  return true;
}

async function readLatestAgentConfig(
  selectedAgent: AgentConfig,
  readAgentConfig: OpenAgentConfigActionParams["readAgentConfig"],
): Promise<AgentConfig> {
  const readResponse = await readAgentConfig({
    agentId: selectedAgent.agentId ?? null,
    threadId: selectedAgent.threadId ?? null,
    name: selectedAgent.name,
  });
  return readResponse?.record?.config ?? selectedAgent;
}
