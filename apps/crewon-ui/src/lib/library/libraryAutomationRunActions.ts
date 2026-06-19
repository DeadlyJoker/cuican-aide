import type { Thread } from "@crewon-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";

import type { NoticeState } from "../shared/noticeState";
import type {
  AgentConfig,
  AutomationConfig,
  LibraryItem,
  LibraryPanel,
  LibraryPanelAction,
  OfficeConfig,
} from "../domain/crewonDomain";
import {
  automationConfigForRun,
  automationRunErrorNotice,
  automationRunErrorPanel,
  automationRunNoteFromFields,
  automationRunUpdatedPanel,
  automationTurnStartPrompt,
  prepareAutomationRun,
} from "../domain/domainAutomationContent";
import type { Locale } from "../i18n";
import { automationRunHistoryItems } from "../thread/threadHistoryItems";
import { upsertThread, upsertTurnInThread } from "../thread/threadModel";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;
type StateSetter<T> = (updater: (current: T) => T) => void;

export type AutomationRunRecord = { runId: string; filePath: string };

export type LibraryAutomationRunActionParams = {
  action: LibraryPanelAction;
  isMissingThreadError: (error: unknown) => boolean;
  latestAgent: () => Promise<AgentConfig | null | undefined>;
  latestOffice: () => Promise<OfficeConfig | null | undefined>;
  libraryPanel: LibraryPanel | null;
  locale: Locale;
  readAutomationRunItems: (threadId: string) => Promise<LibraryItem[]>;
  readThread: (threadId: string) => Promise<Thread | null | undefined>;
  recordAutomationRunForTurn: (
    turnId: string,
    record: AutomationRunRecord & { threadId: string },
  ) => void;
  renameThread: (threadId: string, title: string) => Promise<void>;
  runAutomationConfig: (
    config: AutomationConfig,
    note: string | null,
    turnId: string | null,
  ) => Promise<{ record: AutomationRunRecord | null; warning: string | null }>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreadGoal: (
    threadId: string,
    goal: string,
    tokenBudget: number | null,
  ) => Promise<void>;
  setThreads: StateSetter<Thread[]>;
  startAutomationThread: () => Promise<Thread | null>;
  startTurn: (
    threadId: string,
    text: string,
  ) => Promise<TurnStartResponse | null | undefined>;
  updateAutomationConfig: (
    filePath: string,
    config: AutomationConfig,
  ) => Promise<string | null | undefined>;
  updateAutomationRun: (
    filePath: string,
    status: string,
    completedAt: number | null,
  ) => Promise<void>;
  writeAutomationConfig: (config: AutomationConfig) => Promise<string | null>;
};

export async function handleLibraryAutomationRunAction({
  action,
  isMissingThreadError,
  latestAgent,
  latestOffice,
  libraryPanel,
  locale,
  readAutomationRunItems,
  readThread,
  recordAutomationRunForTurn,
  renameThread,
  runAutomationConfig,
  setLibraryPanel,
  setNotice,
  setThreadGoal,
  setThreads,
  startAutomationThread,
  startTurn,
  updateAutomationConfig,
  updateAutomationRun,
  writeAutomationConfig,
}: LibraryAutomationRunActionParams): Promise<boolean> {
  if (action.id !== "run-automation") {
    return false;
  }

  const savedAutomationConfig = action.automationConfig;
  const runNote = automationRunNoteFromFields(libraryPanel?.fields);
  const [office, agent] = await Promise.all([latestOffice(), latestAgent()]);
  const runPreparation = prepareAutomationRun({
    action,
    latestAgent: agent,
    latestOffice: office,
    locale,
    runNote,
  });
  if (runPreparation.type === "error") {
    setLibraryPanel((currentPanel) =>
      automationRunErrorPanel(currentPanel, runPreparation.message),
    );
    setNotice(automationRunErrorNotice(runPreparation.message));
    return true;
  }

  const {
    body: automationBody,
    executionAgent,
    initialThreadId,
    prompt: fullAutomationPrompt,
    targetOffice,
    title,
  } = runPreparation;
  let threadId = await validExistingThreadId(
    initialThreadId,
    readThread,
    isMissingThreadError,
  );
  if (!threadId) {
    threadId = await createAutomationThread({
      locale,
      renameThread,
      setThreadGoal,
      setThreads,
      startAutomationThread,
      title,
    });
  }
  if (!threadId) {
    return true;
  }

  const automationConfig = automationConfigForRun({
    baseConfig: savedAutomationConfig,
    threadId,
    title,
    prompt: fullAutomationPrompt,
    targetOffice,
    executionAgent,
    body: automationBody,
    locale,
  });
  let automationConfigPath = await persistAutomationConfigForRun({
    action,
    automationConfig,
    updateAutomationConfig,
    writeAutomationConfig,
  });
  const runAutomationTurn = (targetThreadId: string) =>
    startTurn(
      targetThreadId,
      automationTurnStartPrompt({
        automationConfig,
        configPath: automationConfigPath,
        locale,
        runNote,
        threadId: targetThreadId,
      }),
    );
  let response;
  try {
    response = await runAutomationTurn(threadId);
  } catch (error) {
    if (!isMissingThreadError(error)) {
      throw error;
    }
    const replacementThreadId = await createAutomationThread({
      locale,
      renameThread,
      setThreadGoal,
      setThreads,
      startAutomationThread,
      title,
    });
    if (!replacementThreadId) {
      return true;
    }
    threadId = replacementThreadId;
    const replacementAutomationConfig = {
      ...automationConfig,
      threadId,
    };
    automationConfigPath = await persistAutomationConfigForRun({
      action,
      automationConfig: replacementAutomationConfig,
      updateAutomationConfig,
      writeAutomationConfig,
    });
    response = await runAutomationTurn(threadId);
  }

  const automationRunResult = await runAutomationConfig(
    {
      ...automationConfig,
      threadId,
    },
    runNote || null,
    response?.turn.id ?? null,
  );
  const automationRunRecord = automationRunResult.record;
  if (automationRunRecord && response?.turn.id) {
    let latestTurn = response.turn;
    try {
      const currentThread = await readThread(threadId);
      latestTurn =
        currentThread?.turns.find((turn) => turn.id === response.turn.id) ??
        response.turn;
    } catch (error) {
      if (!isMissingThreadError(error)) {
        throw error;
      }
    }
    if (latestTurn.status === "inProgress") {
      recordAutomationRunForTurn(response.turn.id, {
        filePath: automationRunRecord.filePath,
        runId: automationRunRecord.runId,
        threadId,
      });
    } else {
      await updateAutomationRun(
        automationRunRecord.filePath,
        latestTurn.status ?? "failed",
        latestTurn.completedAt ?? Math.floor(Date.now() / 1000),
      );
    }
  }

  let latestAutomationThread: Thread | null = null;
  if (response) {
    setThreads((current) => upsertTurnInThread(current, threadId, response.turn));
    try {
      latestAutomationThread = (await readThread(threadId)) ?? null;
    } catch (error) {
      if (!isMissingThreadError(error)) {
        throw error;
      }
    }
  }
  const latestRunItems = await readAutomationRunItems(threadId);
  setLibraryPanel((currentPanel) =>
    automationRunUpdatedPanel(currentPanel, {
      automationConfig,
      configPath: automationConfigPath,
      fallbackItems: automationRunRecord
        ? latestRunItems
        : latestAutomationThread
          ? automationRunHistoryItems(latestAutomationThread, locale)
          : undefined,
      locale,
      phase: response?.turn.status === "completed" ? "completed" : "started",
      runFilePath: automationRunRecord?.filePath,
      runId: automationRunRecord?.runId,
      threadId,
      warning: automationRunResult.warning,
    }),
  );
  return true;
}

async function validExistingThreadId(
  threadId: string | undefined,
  readThread: (threadId: string) => Promise<Thread | null | undefined>,
  isMissingThreadError: (error: unknown) => boolean,
): Promise<string | undefined> {
  if (!threadId) {
    return undefined;
  }
  try {
    await readThread(threadId);
    return threadId;
  } catch (error) {
    if (!isMissingThreadError(error)) {
      throw error;
    }
    return undefined;
  }
}

async function createAutomationThread(params: {
  locale: Locale;
  renameThread: (threadId: string, title: string) => Promise<void>;
  setThreadGoal: (
    threadId: string,
    goal: string,
    tokenBudget: number | null,
  ) => Promise<void>;
  setThreads: StateSetter<Thread[]>;
  startAutomationThread: () => Promise<Thread | null>;
  title: string;
}): Promise<string | undefined> {
  const {
    locale,
    renameThread,
    setThreadGoal,
    setThreads,
    startAutomationThread,
    title,
  } = params;
  const createdThread = await startAutomationThread();
  if (!createdThread) {
    return undefined;
  }
  await renameThread(createdThread.id, title);
  await setThreadGoal(
    createdThread.id,
    locale === "zh"
      ? `执行并记录自动化「${title}」的运行结果。`
      : `Run and record automation "${title}".`,
    null,
  );
  setThreads((current) => upsertThread(current, { ...createdThread, name: title }));
  return createdThread.id;
}

async function persistAutomationConfigForRun(params: {
  action: LibraryPanelAction;
  automationConfig: AutomationConfig;
  updateAutomationConfig: (
    filePath: string,
    config: AutomationConfig,
  ) => Promise<string | null | undefined>;
  writeAutomationConfig: (config: AutomationConfig) => Promise<string | null>;
}): Promise<string | null> {
  const {
    action,
    automationConfig,
    updateAutomationConfig,
    writeAutomationConfig,
  } = params;
  if (action.automationConfigPath) {
    return (
      (await updateAutomationConfig(action.automationConfigPath, automationConfig)) ??
      action.automationConfigPath
    );
  }
  return writeAutomationConfig(automationConfig);
}
