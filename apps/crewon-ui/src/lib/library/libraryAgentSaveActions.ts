import type { Thread } from "@crewon-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";

import type { NoticeState } from "../shared/noticeState";
import {
  agentCapabilityCounts,
  agentConfigHistoryPanel,
  agentConfigSavedPanel,
  agentSaveFailureNoticeState,
  agentSaveSuccessNoticeState,
  agentSaveThreadGoal,
  agentSaveTurnSummary,
} from "../agent-config/agentConfigPanel";
import type { AgentConfig, LibraryPanel } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  upsertThread,
  upsertTurn,
  upsertTurnInThread,
} from "../thread/threadModel";

type StateSetter<T> = (updater: (current: T) => T) => void;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

type AgentConfigWriteResult = {
  filePath: string;
  agentId?: string;
} | null;

export type SaveAgentConfigParams = {
  config: AgentConfig | null | undefined;
  isConnected: boolean;
  isMissingThreadError: (error: unknown) => boolean;
  locale: Locale;
  readThread: (threadId: string) => Promise<Thread | null | undefined>;
  renameThread: (threadId: string, name: string) => Promise<void>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreadGoal: (
    threadId: string,
    goal: string,
    tokenBudget: number | null,
  ) => Promise<void>;
  setThreads: StateSetter<Thread[]>;
  startAgentThread: () => Promise<Thread | null>;
  startTurn: (
    threadId: string,
    text: string,
  ) => Promise<TurnStartResponse | null | undefined>;
  threads: Thread[];
  writeAgentConfig: (config: AgentConfig) => Promise<AgentConfigWriteResult>;
};

export async function saveAgentConfigAction({
  config,
  isConnected,
  isMissingThreadError,
  locale,
  readThread,
  renameThread,
  setLibraryPanel,
  setNotice,
  setThreadGoal,
  setThreads,
  startAgentThread,
  startTurn,
  threads,
  writeAgentConfig,
}: SaveAgentConfigParams): Promise<boolean> {
  if (!config) {
    return false;
  }

  const capabilityCounts = agentCapabilityCounts(config);
  try {
    if (isConnected) {
      const writeConfigForThread = async (thread: Thread) => {
        await renameThread(thread.id, config.name);
        await setThreadGoal(thread.id, agentSaveThreadGoal(config, locale), null);
        const draftConfig = { ...config, threadId: thread.id };
        const agentWriteResult = await writeAgentConfig(draftConfig);
        const savedConfig = {
          ...draftConfig,
          agentId: agentWriteResult?.agentId ?? draftConfig.agentId,
        };
        const agentConfigPath = agentWriteResult?.filePath ?? null;
        const response = await startTurn(
          thread.id,
          agentSaveTurnSummary({
            config,
            configPath: agentConfigPath,
            locale,
          }),
        );
        setThreads((current) =>
          upsertThread(current, { ...thread, name: config.name }),
        );
        setLibraryPanel((currentPanel) =>
          agentConfigSavedPanel(currentPanel, {
            agentId: savedConfig.agentId,
            configPath: agentConfigPath,
            locale,
            threadId: thread.id,
          }),
        );

        let latestAgentThread: Thread | null = null;
        if (response) {
          const fallbackThread = upsertTurn(
            { ...thread, name: config.name },
            response.turn,
          );
          setThreads((current) =>
            upsertTurnInThread(current, thread.id, response.turn),
          );
          try {
            latestAgentThread = (await readThread(thread.id)) ?? fallbackThread;
          } catch (error) {
            if (!isMissingThreadError(error)) {
              throw error;
            }
            latestAgentThread = fallbackThread;
          }
        }
        setLibraryPanel((currentPanel) =>
          agentConfigHistoryPanel(currentPanel, latestAgentThread, locale),
        );
      };

      let thread = config.threadId
        ? (threads.find((candidate) => candidate.id === config.threadId) ?? null)
        : null;
      if (!thread && config.threadId) {
        try {
          thread = (await readThread(config.threadId)) ?? null;
        } catch (error) {
          if (!isMissingThreadError(error)) {
            throw error;
          }
        }
      }
      if (!thread) {
        thread = await startAgentThread();
      }
      if (thread) {
        try {
          await writeConfigForThread(thread);
        } catch (error) {
          if (!isMissingThreadError(error)) {
            throw error;
          }
          const replacementThread = await startAgentThread();
          if (replacementThread) {
            await writeConfigForThread(replacementThread);
          }
        }
      }
    }

    setNotice(
      agentSaveSuccessNoticeState({
        config,
        counts: capabilityCounts,
        locale,
      }),
    );
  } catch (error) {
    setNotice(agentSaveFailureNoticeState(error, locale));
  }
  return true;
}
