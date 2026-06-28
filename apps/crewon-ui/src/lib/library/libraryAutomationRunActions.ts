import type { Thread } from "@crewon-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";

import type { OfficeRunResponse } from "../app-server/appServer";
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
import {
  officeRunTurnRecord,
  type OfficeRunTurnRecord,
} from "../office/officeRunPanel";
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
  recordOfficeRunTurn?: (turnId: string, record: OfficeRunTurnRecord) => void;
  renameThread: (threadId: string, title: string) => Promise<void>;
  runOfficeAutomation?: (
    config: AutomationConfig,
    text: string,
  ) => Promise<{ cwd: string; response: OfficeRunResponse | null } | null>;
  runAutomationConfig: (
    config: AutomationConfig,
    note: string | null,
    turnId: string | null,
  ) => Promise<{ record: AutomationRunRecord | null; warning: string | null }>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
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
  recordOfficeRunTurn,
  renameThread,
  runOfficeAutomation,
  runAutomationConfig,
  setLibraryPanel,
  setNotice,
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
  const officeThreadId = targetOffice.workspace.threadId?.trim();
  if (runOfficeAutomation && officeThreadId) {
    const automationConfig = automationConfigForRun({
      baseConfig: savedAutomationConfig,
      threadId: officeThreadId,
      title,
      prompt: fullAutomationPrompt,
      targetOffice,
      executionAgent,
      body: automationBody,
      locale,
    });
    const automationConfigPath = await persistAutomationConfigForRun({
      action,
      automationConfig,
      updateAutomationConfig,
      writeAutomationConfig,
    });
    const officeRunText = automationTurnStartPrompt({
      automationConfig,
      configPath: automationConfigPath,
      locale,
      runNote,
      threadId: officeThreadId,
    });
    const officeRunResult = await runOfficeAutomation(
      automationConfig,
      officeRunText,
    );
    const officeRunResponse = officeRunResult?.response ?? null;
    if (officeRunResult && officeRunResponse) {
      const automationRunResult = await runAutomationConfig(
        automationConfig,
        runNote || null,
        officeRunResponse.turn.id,
      );
      const automationRunRecord = automationRunResult.record;
      recordOfficeRunTurn?.(
        officeRunResponse.turn.id,
        officeRunTurnRecord(officeRunResult.cwd, officeRunResponse),
      );
      setThreads((current) =>
        upsertTurnInThread(
          current,
          officeRunResponse.threadId,
          officeRunResponse.turn,
        ),
      );
      if (automationRunRecord) {
        if (officeRunResponse.turn.status === "inProgress") {
          recordAutomationRunForTurn(officeRunResponse.turn.id, {
            filePath: automationRunRecord.filePath,
            runId: automationRunRecord.runId,
            threadId: officeRunResponse.threadId,
          });
          scheduleAutomationRunCompletionSync({
            automationConfig,
            automationConfigPath,
            automationRunRecord,
            locale,
            readAutomationRunItems,
            readThread,
            responseTurnId: officeRunResponse.turn.id,
            setLibraryPanel,
            threadId: officeRunResponse.threadId,
            updateAutomationRun,
          });
        } else {
          await updateAutomationRun(
            automationRunRecord.filePath,
            officeRunResponse.turn.status ?? "failed",
            officeRunResponse.turn.completedAt ?? Math.floor(Date.now() / 1000),
          );
        }
      }
      const latestRunItems = await readAutomationRunItems(
        officeRunResponse.threadId,
      );
      setLibraryPanel((currentPanel) =>
        automationRunUpdatedPanel(currentPanel, {
          automationConfig,
          configPath: automationConfigPath,
          fallbackItems: latestRunItems,
          locale,
          phase:
            officeRunResponse.turn.status === "completed"
              ? "completed"
              : "started",
          runFilePath: automationRunRecord?.filePath,
          runId: automationRunRecord?.runId,
          threadId: officeRunResponse.threadId,
          warning: automationRunResult.warning,
        }),
      );
      return true;
    }
  }

  let threadId = await validExistingThreadId(
    initialThreadId,
    readThread,
    isMissingThreadError,
  );
  if (!threadId) {
    threadId = await createAutomationThread({
      renameThread,
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
      renameThread,
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
      scheduleAutomationRunCompletionSync({
        automationConfig: {
          ...automationConfig,
          threadId,
        },
        automationConfigPath,
        automationRunRecord,
        locale,
        readAutomationRunItems,
        readThread,
        responseTurnId: response.turn.id,
        setLibraryPanel,
        threadId,
        updateAutomationRun,
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

function scheduleAutomationRunCompletionSync(params: {
  automationConfig: AutomationConfig;
  automationConfigPath: string | null;
  automationRunRecord: AutomationRunRecord;
  locale: Locale;
  readAutomationRunItems: (threadId: string) => Promise<LibraryItem[]>;
  readThread: (threadId: string) => Promise<Thread | null | undefined>;
  responseTurnId: string;
  setLibraryPanel: LibraryPanelSetter;
  threadId: string;
  updateAutomationRun: (
    filePath: string,
    status: string,
    completedAt: number | null,
  ) => Promise<void>;
}): void {
  void (async () => {
    try {
      for (const delayMs of [100, 300, 700, 1500]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const thread = await params.readThread(params.threadId).catch(() => null);
        const latestTurn = thread?.turns.find(
          (turn) => turn.id === params.responseTurnId,
        );
        if (!latestTurn || latestTurn.status === "inProgress") {
          continue;
        }

        await params.updateAutomationRun(
          params.automationRunRecord.filePath,
          latestTurn.status ?? "failed",
          latestTurn.completedAt ?? Math.floor(Date.now() / 1000),
        );
        const latestRunItems = await params.readAutomationRunItems(params.threadId);
        params.setLibraryPanel((currentPanel) =>
          automationRunUpdatedPanel(currentPanel, {
            automationConfig: params.automationConfig,
            configPath: params.automationConfigPath,
            fallbackItems: latestRunItems,
            locale: params.locale,
            phase: "completed",
            runFilePath: params.automationRunRecord.filePath,
            runId: params.automationRunRecord.runId,
            threadId: params.threadId,
          }),
        );
        return;
      }
    } catch {
      // Best-effort fallback for the turn/completed race; the notification path
      // still handles normal completion sync and surfaces its own failures.
    }
  })();
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
  renameThread: (threadId: string, title: string) => Promise<void>;
  setThreads: StateSetter<Thread[]>;
  startAutomationThread: () => Promise<Thread | null>;
  title: string;
}): Promise<string | undefined> {
  const { renameThread, setThreads, startAutomationThread, title } = params;
  const createdThread = await startAutomationThread();
  if (!createdThread) {
    return undefined;
  }
  await renameThread(createdThread.id, title);
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
