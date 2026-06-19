import type { Thread } from "@crewon-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";

import { activeTurnByThreadAfterTurn } from "../thread/threadRuntimeState";
import type { OfficeRunResponse } from "../app-server/appServer";
import type {
  LibraryPanel,
  OfficeConfig,
  OfficeMessage,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  appendOfficeUserOnlyMessage,
  officeMessageConnectedPanel,
  officeMessageFailurePanel,
  officeMessageTurnPrompt,
  optimisticOfficeBackendStatus,
  optimisticOfficeMessagePanel,
} from "./officeMessagePanel";
import {
  officeRunActiveTurnByThread,
  officeRunResponsePanel,
  officeRunTurnRecord,
  type OfficeRunTurnRecord,
} from "./officeRunPanel";
import { upsertTurnInThread } from "../thread/threadModel";

type StateSetter<T> = (updater: (current: T) => T) => void;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type OfficeMessageRunResult = {
  cwd: string;
  handled: boolean;
  response: OfficeRunResponse | null;
};

export type OfficeMessageActionParams = {
  appendDisconnectedMessage: (
    workspace: OfficeWorkspace,
    text: string,
    locale: Locale,
  ) => OfficeWorkspace;
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspace: OfficeWorkspace,
    forceNew?: boolean,
  ) => Promise<string | null>;
  isConnected: boolean;
  isMissingThreadError: (error: unknown) => boolean;
  locale: Locale;
  panel: LibraryPanel | null;
  persistOfficeMessage: (
    panel: LibraryPanel,
    workspaceBeforeMessage: OfficeWorkspace,
    message: OfficeMessage,
    text: string,
    threadId: string,
    fallbackWorkspace: OfficeWorkspace,
  ) => Promise<OfficeConfig | null>;
  recordOfficeRunTurn: (turnId: string, record: OfficeRunTurnRecord) => void;
  runOfficeMessage: (
    panel: LibraryPanel,
    workspaceBeforeMessage: OfficeWorkspace,
    message: OfficeMessage,
    text: string,
    threadId: string,
    fallbackWorkspace: OfficeWorkspace,
  ) => Promise<OfficeMessageRunResult | null>;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setLibraryPanel: LibraryPanelSetter;
  setThreads: StateSetter<Thread[]>;
  startTurn: (
    threadId: string,
    text: string,
  ) => Promise<TurnStartResponse | null | undefined>;
  text: string;
};

export async function sendOfficeMessageAction({
  appendDisconnectedMessage,
  ensureOfficeThread,
  isConnected,
  isMissingThreadError,
  locale,
  panel,
  persistOfficeMessage,
  recordOfficeRunTurn,
  runOfficeMessage,
  setActiveTurnByThread,
  setLibraryPanel,
  setThreads,
  startTurn,
  text,
}: OfficeMessageActionParams): Promise<boolean> {
  if (!panel?.workspace) {
    return false;
  }
  const workspaceBeforeMessage = panel.workspace;
  const nextWorkspace = isConnected
    ? appendOfficeUserOnlyMessage({
        workspace: workspaceBeforeMessage,
        rawText: text,
        locale,
      })
    : appendDisconnectedMessage(workspaceBeforeMessage, text, locale);
  const message = nextWorkspace.messages[nextWorkspace.messages.length - 1];
  if (!message) {
    return true;
  }

  setLibraryPanel((currentPanel) =>
    optimisticOfficeMessagePanel(currentPanel, {
      workspace: nextWorkspace,
      backendStatus: optimisticOfficeBackendStatus(workspaceBeforeMessage),
    }),
  );

  if (!isConnected) {
    return true;
  }

  try {
    const initialThreadId = await ensureOfficeThread(panel, nextWorkspace);
    if (!initialThreadId) {
      return true;
    }
    let threadId = initialThreadId;

    let runApiHandled = false;
    const runResponse = await runOfficeMessageWithThreadRetry({
      ensureOfficeThread,
      isMissingThreadError,
      message,
      nextWorkspace,
      panel,
      runOfficeMessage,
      setThreadId: (nextThreadId) => {
        threadId = nextThreadId;
      },
      text,
      threadId,
      workspaceBeforeMessage,
    });
    runApiHandled = runResponse.runApiHandled;

    const officeRunResponse = runResponse.response;
    if (officeRunResponse) {
      recordOfficeRunTurn(
        officeRunResponse.turn.id,
        officeRunTurnRecord(runResponse.cwd, officeRunResponse),
      );
      setThreads((current) =>
        upsertTurnInThread(
          current,
          officeRunResponse.threadId,
          officeRunResponse.turn,
        ),
      );
      setActiveTurnByThread((current) =>
        officeRunActiveTurnByThread(current, officeRunResponse),
      );
      setLibraryPanel((currentPanel) =>
        officeRunResponsePanel(currentPanel, officeRunResponse),
      );
      return true;
    }

    const response = await startOfficeTurnWithThreadRetry({
      ensureOfficeThread,
      isMissingThreadError,
      locale,
      nextWorkspace,
      officeTitle: panel.title,
      panel,
      setThreadId: (nextThreadId) => {
        threadId = nextThreadId;
      },
      startTurn,
      text,
      threadId,
    });
    if (response) {
      setThreads((current) =>
        upsertTurnInThread(current, threadId, response.turn),
      );
      setActiveTurnByThread((current) =>
        activeTurnByThreadAfterTurn(current, threadId, response.turn),
      );
    }
    const savedConfig = runApiHandled
      ? null
      : await persistOfficeMessage(
          panel,
          workspaceBeforeMessage,
          message,
          text,
          threadId,
          nextWorkspace,
        );
    setLibraryPanel((currentPanel) =>
      officeMessageConnectedPanel(currentPanel, {
        workspace: savedConfig?.workspace ?? currentPanel?.workspace ?? nextWorkspace,
        threadId,
      }),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      officeMessageFailurePanel(currentPanel, error, locale),
    );
  }
  return true;
}

async function runOfficeMessageWithThreadRetry(params: {
  ensureOfficeThread: OfficeMessageActionParams["ensureOfficeThread"];
  isMissingThreadError: (error: unknown) => boolean;
  message: OfficeMessage;
  nextWorkspace: OfficeWorkspace;
  panel: LibraryPanel;
  runOfficeMessage: OfficeMessageActionParams["runOfficeMessage"];
  setThreadId: (threadId: string) => void;
  text: string;
  threadId: string;
  workspaceBeforeMessage: OfficeWorkspace;
}): Promise<{
  cwd: string;
  response: OfficeRunResponse | null;
  runApiHandled: boolean;
}> {
  const runWithThread = async (targetThreadId: string) => {
    const result = await params.runOfficeMessage(
      params.panel,
      params.workspaceBeforeMessage,
      params.message,
      params.text,
      targetThreadId,
      params.nextWorkspace,
    );
    return {
      cwd: result?.cwd ?? "",
      response: result?.response ?? null,
      runApiHandled: Boolean(result?.handled),
    };
  };

  try {
    return await runWithThread(params.threadId);
  } catch (error) {
    if (!params.isMissingThreadError(error)) {
      throw error;
    }
    const threadId = await params.ensureOfficeThread(
      params.panel,
      params.nextWorkspace,
      true,
    );
    if (!threadId) {
      return { cwd: "", response: null, runApiHandled: false };
    }
    params.setThreadId(threadId);
    return runWithThread(threadId);
  }
}

async function startOfficeTurnWithThreadRetry(params: {
  ensureOfficeThread: OfficeMessageActionParams["ensureOfficeThread"];
  isMissingThreadError: (error: unknown) => boolean;
  locale: Locale;
  nextWorkspace: OfficeWorkspace;
  officeTitle: string;
  panel: LibraryPanel;
  setThreadId: (threadId: string) => void;
  startTurn: OfficeMessageActionParams["startTurn"];
  text: string;
  threadId: string;
}): Promise<TurnStartResponse | null | undefined> {
  const turnInput = (targetThreadId: string) =>
    officeMessageTurnPrompt({
      officeTitle: params.officeTitle,
      text: params.text,
      threadId: targetThreadId,
      locale: params.locale,
    });

  try {
    return await params.startTurn(params.threadId, turnInput(params.threadId));
  } catch (error) {
    if (!params.isMissingThreadError(error)) {
      throw error;
    }
    const threadId = await params.ensureOfficeThread(
      params.panel,
      params.nextWorkspace,
      true,
    );
    if (!threadId) {
      return null;
    }
    params.setThreadId(threadId);
    return params.startTurn(threadId, turnInput(threadId));
  }
}
