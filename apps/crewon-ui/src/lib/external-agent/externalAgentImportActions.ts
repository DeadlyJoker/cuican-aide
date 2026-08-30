import type { ExternalAgentConfigImportResponse } from "@crewon/app-server-protocol/v2/ExternalAgentConfigImportResponse";
import type { ExternalAgentConfigMigrationItem } from "@crewon/app-server-protocol/v2/ExternalAgentConfigMigrationItem";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon/app-server-protocol/v2/TurnStartResponse";

import type { AgentConfig, LibraryPanel } from "../domain/crewonDomain";
import {
  externalAgentImportFailurePanel,
  externalAgentImportLoadingPanel,
  externalAgentImportNotice,
  externalAgentImportThreadGoal,
  externalAgentImportTurnPrompt,
  importedExternalAgentConfig,
} from "./externalAgentMigrationText";
import type { Locale } from "../i18n";
import type { NoticeState } from "../shared/noticeState";
import { upsertThread, upsertTurn } from "../thread/threadModel";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;
type ThreadListSetter = (updater: (current: Thread[]) => Thread[]) => void;

export type OpenExternalAgentImportActionParams = {
  createBackendAgentConfig: () => Promise<AgentConfig>;
  importExternalAgentConfig: (
    item: ExternalAgentConfigMigrationItem,
  ) => Promise<ExternalAgentConfigImportResponse | null | undefined>;
  item: ExternalAgentConfigMigrationItem;
  locale: Locale;
  openAgentsLibrary: () => Promise<void>;
  renameThread: (threadId: string, name: string) => Promise<void>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreadGoal: (
    threadId: string,
    goal: string,
    tokenBudget: number | null,
  ) => Promise<void>;
  setThreads: ThreadListSetter;
  startAgentThread: (
    cwd: string | undefined,
    source: "agent",
  ) => Promise<Thread | null | undefined>;
  startTurn: (
    threadId: string,
    text: string,
  ) => Promise<TurnStartResponse | null | undefined>;
  writeAgentConfig: (
    config: AgentConfig,
  ) => Promise<{ filePath: string; agentId?: string } | null>;
};

export async function openExternalAgentImportAction({
  createBackendAgentConfig,
  importExternalAgentConfig,
  item,
  locale,
  openAgentsLibrary,
  renameThread,
  setLibraryPanel,
  setNotice,
  setThreadGoal,
  setThreads,
  startAgentThread,
  startTurn,
  writeAgentConfig,
}: OpenExternalAgentImportActionParams): Promise<boolean> {
  setLibraryPanel((currentPanel) =>
    externalAgentImportLoadingPanel(currentPanel, locale),
  );

  try {
    await importExternalAgentConfig(item);
    const importedConfigBase = await createBackendAgentConfig();
    const importedConfig = importedExternalAgentConfig({
      baseConfig: importedConfigBase,
      item,
      locale,
    });
    const thread = (await startAgentThread(item.cwd ?? undefined, "agent")) ?? null;
    if (thread) {
      await renameThread(thread.id, importedConfig.name);
      await setThreadGoal(
        thread.id,
        externalAgentImportThreadGoal(item, locale),
        null,
      );
      const payloadConfig = { ...importedConfig, threadId: thread.id };
      const agentWriteResult = await writeAgentConfig(payloadConfig);
      const savedPayloadConfig = {
        ...payloadConfig,
        agentId: agentWriteResult?.agentId ?? payloadConfig.agentId,
      };
      const response = await startTurn(
        thread.id,
        externalAgentImportTurnPrompt({
          agentConfigPath: agentWriteResult?.filePath ?? null,
          config: savedPayloadConfig,
          item,
          locale,
        }),
      );
      setThreads((current) =>
        upsertThread(current, { ...thread, name: importedConfig.name }),
      );
      if (response) {
        setThreads((current) =>
          current.map((candidate) =>
            candidate.id === thread.id
              ? upsertTurn(candidate, response.turn)
              : candidate,
          ),
        );
      }
    }
    await openAgentsLibrary();
    setNotice(
      externalAgentImportNotice({
        config: importedConfig,
        locale,
        threadCreated: Boolean(thread),
      }),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      externalAgentImportFailurePanel(currentPanel, error, locale),
    );
  }

  return true;
}
