import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon/app-server-protocol/v2/TurnStartResponse";

import { activeTurnByThreadAfterTurn } from "../thread/threadRuntimeState";
import type {
  OfficeMessageSubmitResponse,
  OfficeRunResponse,
} from "../app-server/appServer";
import type {
  OfficeMessageSendResult,
  OfficeMessageSubmitDelivery,
} from "../domain/officeMessageDelivery";
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
  officeMessageSubmitResponsePanel,
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
import type { OfficeThreadResolution } from "./officeThreadActions";
import { officeWorkspaceHasNonterminalRun } from "./officeComposerRuntime";
import type { LegacyOfficeIdleConfirmation } from "./officeComposerRuntime";
import type { OfficeIdentity } from "./officeIdentity";
import {
  officeIdentityFromPanel,
  officePanelMatchesIdentity,
  officeResponseMatchesIdentity,
} from "./officeIdentity";

export type { OfficeMessageSendResult } from "../domain/officeMessageDelivery";

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
  clientUserMessageId: string;
  confirmLegacyOfficeIdle: (
    workspace: OfficeWorkspace,
  ) => Promise<LegacyOfficeIdleConfirmation>;
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspace: OfficeWorkspace,
    forceNew?: boolean,
  ) => Promise<OfficeThreadResolution | null>;
  isConnected: boolean;
  isMissingThreadError: (error: unknown) => boolean;
  isUnsupportedRpcError: (error: unknown) => boolean;
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
    clientUserMessageId: string,
  ) => Promise<OfficeMessageRunResult | null>;
  submitOfficeMessage: (
    panel: LibraryPanel,
    workspace: OfficeWorkspace,
    text: string,
    clientUserMessageId: string,
  ) => Promise<{
    cwd: string;
    response: OfficeMessageSubmitResponse;
  } | null>;
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
  clientUserMessageId,
  confirmLegacyOfficeIdle,
  ensureOfficeThread,
  isConnected,
  isMissingThreadError,
  isUnsupportedRpcError,
  locale,
  panel,
  persistOfficeMessage,
  recordOfficeRunTurn,
  runOfficeMessage,
  setActiveTurnByThread,
  setLibraryPanel,
  setThreads,
  startTurn,
  submitOfficeMessage,
  text,
}: OfficeMessageActionParams): Promise<OfficeMessageSendResult> {
  if (!panel?.workspace) {
    return { delivery: null, disposition: "retainOutbox" };
  }
  const expectedIdentity = officeIdentityFromPanel(panel);
  if (!expectedIdentity) {
    throw new Error("Cannot safely identify the target Office");
  }
  if (!isConnected) {
    return { delivery: null, disposition: "retainOutbox" };
  }
  let workspaceBeforeMessage = panel.workspace;
  if (!workspaceBeforeMessage.threadId) {
    try {
      const ensured = await ensureOfficeThread(panel, workspaceBeforeMessage);
      if (!ensured) {
        throw new Error(
          locale === "zh"
            ? "无法创建办公室主控运行线程"
            : "Unable to provision the Office manager runtime",
        );
      }
      workspaceBeforeMessage = ensured.config.workspace;
    } catch (error) {
      setLibraryPanel((currentPanel) =>
        officeMessageFailurePanel(
          currentPanel,
          error,
          locale,
          expectedIdentity,
        ),
      );
      throw error;
    }
  }
  const nextWorkspace = appendOfficeUserOnlyMessage({
    clientUserMessageId,
    workspace: workspaceBeforeMessage,
    rawText: text,
    locale,
  });
  const message = nextWorkspace.messages.find(
    (candidate) =>
      candidate.clientUserMessageId === clientUserMessageId &&
      candidate.kind !== "system",
  );
  if (!message) {
    throw new Error("Unable to resolve the submitted Office user message");
  }

  setLibraryPanel((currentPanel) =>
    optimisticOfficeMessagePanel(currentPanel, {
      workspace: nextWorkspace,
      backendStatus: optimisticOfficeBackendStatus(workspaceBeforeMessage),
      expectedIdentity,
    }),
  );

  try {
    let useLegacyIdleFallback = false;
    try {
      const submitted = await submitOfficeMessage(
        panel,
        workspaceBeforeMessage,
        text,
        clientUserMessageId,
      );
      if (!submitted) {
        throw new Error("Office message submit did not return a response");
      }
      applyOfficeMessageSubmitResponse({
        cwd: submitted.cwd,
        response: submitted.response,
        expectedIdentity,
        recordOfficeRunTurn,
        setActiveTurnByThread,
        setLibraryPanel,
        setThreads,
      });
      return {
        delivery: submitted.response.delivery,
        disposition: officeMessageDeliveryDisposition(
          submitted.response.delivery,
        ),
      };
    } catch (error) {
      if (!isUnsupportedRpcError(error)) {
        throw error;
      }
      if (officeWorkspaceHasNonterminalRun(workspaceBeforeMessage)) {
        throw error;
      }
      const idleConfirmation = await confirmLegacyOfficeIdle(
        workspaceBeforeMessage,
      );
      if (idleConfirmation === "deny") throw error;
      useLegacyIdleFallback = true;
    }

    if (!useLegacyIdleFallback) {
      return { delivery: null, disposition: "retainOutbox" };
    }
    let thread = await ensureOfficeThread(panel, workspaceBeforeMessage);
    if (!thread) {
      return { delivery: null, disposition: "retainOutbox" };
    }

    let runApiHandled = false;
    const runResponse = await runOfficeMessageWithThreadRetry({
      ensureOfficeThread,
      isMissingThreadError,
      message,
      panel,
      runOfficeMessage,
      text,
      thread,
      clientUserMessageId,
    });
    thread = runResponse.thread;
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
        officePanelMatchesIdentity(currentPanel, expectedIdentity)
          ? officeRunResponsePanel(currentPanel, officeRunResponse)
          : currentPanel,
      );
      return {
        delivery: null,
        disposition: "clearOutbox",
      };
    }

    const response = await startOfficeTurnWithThreadRetry({
      ensureOfficeThread,
      isMissingThreadError,
      locale,
      officeTitle: panel.title,
      panel,
      startTurn,
      text,
      thread,
    });
    thread = response.thread;
    const startedTurn = response.response;
    if (startedTurn) {
      setThreads((current) =>
        upsertTurnInThread(
          current,
          thread.threadId,
          startedTurn.turn,
        ),
      );
      setActiveTurnByThread((current) =>
        activeTurnByThreadAfterTurn(
          current,
          thread.threadId,
          startedTurn.turn,
        ),
      );
    }
    const fallbackWorkspace = {
      ...thread.config.workspace,
      messages: [...thread.config.workspace.messages, message],
    };
    const savedConfig = runApiHandled
      ? null
      : await persistOfficeMessage(
          panel,
          thread.config.workspace,
          message,
          text,
          thread.threadId,
          fallbackWorkspace,
        );
    setLibraryPanel((currentPanel) =>
      officeMessageConnectedPanel(currentPanel, {
        expectedIdentity,
        workspace:
          savedConfig?.workspace ?? currentPanel?.workspace ?? fallbackWorkspace,
        threadId: thread.threadId,
      }),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      officeMessageFailurePanel(
        currentPanel,
        error,
        locale,
        expectedIdentity,
      ),
    );
    throw error;
  }
  return { delivery: null, disposition: "clearOutbox" };
}

async function runOfficeMessageWithThreadRetry(params: {
  clientUserMessageId: string;
  ensureOfficeThread: OfficeMessageActionParams["ensureOfficeThread"];
  isMissingThreadError: (error: unknown) => boolean;
  message: OfficeMessage;
  panel: LibraryPanel;
  runOfficeMessage: OfficeMessageActionParams["runOfficeMessage"];
  text: string;
  thread: OfficeThreadResolution;
}): Promise<{
  cwd: string;
  response: OfficeRunResponse | null;
  runApiHandled: boolean;
  thread: OfficeThreadResolution;
}> {
  const runWithThread = async (targetThread: OfficeThreadResolution) => {
    const result = await params.runOfficeMessage(
      params.panel,
      targetThread.config.workspace,
      params.message,
      params.text,
      targetThread.threadId,
      {
        ...targetThread.config.workspace,
        messages: [...targetThread.config.workspace.messages, params.message],
      },
      params.clientUserMessageId,
    );
    return {
      cwd: result?.cwd ?? "",
      response: result?.response ?? null,
      runApiHandled: Boolean(result?.handled),
      thread: targetThread,
    };
  };

  try {
    return await runWithThread(params.thread);
  } catch (error) {
    if (!params.isMissingThreadError(error)) {
      throw error;
    }
    const thread = await params.ensureOfficeThread(
      params.panel,
      params.thread.config.workspace,
      true,
    );
    if (!thread) {
      return {
        cwd: "",
        response: null,
        runApiHandled: false,
        thread: params.thread,
      };
    }
    return runWithThread(thread);
  }
}

function applyOfficeMessageSubmitResponse(params: {
  cwd: string;
  expectedIdentity: OfficeIdentity;
  response: OfficeMessageSubmitResponse;
  recordOfficeRunTurn: OfficeMessageActionParams["recordOfficeRunTurn"];
  setActiveTurnByThread: OfficeMessageActionParams["setActiveTurnByThread"];
  setLibraryPanel: OfficeMessageActionParams["setLibraryPanel"];
  setThreads: OfficeMessageActionParams["setThreads"];
}) {
  const { delivery } = params.response;
  const deliveryThreadId =
    delivery.type === "runStarted" ||
    delivery.type === "steered" ||
    delivery.type === "interactionStarted" ||
    delivery.type === "answered"
      ? delivery.threadId
      : null;
  if (
    !officeResponseMatchesIdentity(
      params.response.config,
      params.response.filePath,
      params.expectedIdentity,
      deliveryThreadId,
      params.cwd,
    )
  ) {
    throw new Error("Office message response identity does not match the target");
  }
  params.setLibraryPanel((currentPanel) =>
    officeMessageSubmitResponsePanel(
      currentPanel,
      params.response,
      params.expectedIdentity,
    ),
  );
  if (delivery.type === "failed") {
    throw new Error(officeMessageSubmitFailureText(delivery));
  }
  if (delivery.type === "runStarted") {
    const runResponse: OfficeRunResponse = {
      filePath: params.response.filePath,
      config: params.response.config,
      threadId: delivery.threadId,
      runId: delivery.runId,
      turn: delivery.turn,
    };
    params.recordOfficeRunTurn(
      delivery.turn.id,
      officeRunTurnRecord(params.cwd, runResponse),
    );
    params.setThreads((current) =>
      upsertTurnInThread(current, delivery.threadId, delivery.turn),
    );
    params.setActiveTurnByThread((current) =>
      officeRunActiveTurnByThread(current, runResponse),
    );
  } else if (delivery.type === "steered") {
    params.setActiveTurnByThread((current) => ({
      ...current,
      [delivery.threadId]: delivery.turnId,
    }));
  } else if (delivery.type === "interactionStarted") {
    params.setThreads((current) =>
      upsertTurnInThread(current, delivery.threadId, delivery.turn),
    );
    params.setActiveTurnByThread((current) =>
      activeTurnByThreadAfterTurn(
        current,
        delivery.threadId,
        delivery.turn,
      ),
    );
  } else if (delivery.type === "answered") {
    params.setActiveTurnByThread((current) => {
      if (current[delivery.threadId] !== delivery.turnId) return current;
      const next = { ...current };
      delete next[delivery.threadId];
      return next;
    });
  }
}

function officeMessageSubmitFailureText(
  delivery: Extract<OfficeMessageSubmitDelivery, { type: "failed" }>,
): string {
  return delivery.message;
}

function officeMessageDeliveryDisposition(
  delivery: OfficeMessageSubmitDelivery,
): OfficeMessageSendResult["disposition"] {
  return delivery.type === "queued" || delivery.type === "processing"
    ? "retainOutbox"
    : "clearOutbox";
}

async function startOfficeTurnWithThreadRetry(params: {
  ensureOfficeThread: OfficeMessageActionParams["ensureOfficeThread"];
  isMissingThreadError: (error: unknown) => boolean;
  locale: Locale;
  officeTitle: string;
  panel: LibraryPanel;
  startTurn: OfficeMessageActionParams["startTurn"];
  text: string;
  thread: OfficeThreadResolution;
}): Promise<{
  response: TurnStartResponse | null | undefined;
  thread: OfficeThreadResolution;
}> {
  const turnInput = (targetThreadId: string) =>
    officeMessageTurnPrompt({
      officeTitle: params.officeTitle,
      text: params.text,
      threadId: targetThreadId,
      locale: params.locale,
    });

  try {
    return {
      response: await params.startTurn(
        params.thread.threadId,
        turnInput(params.thread.threadId),
      ),
      thread: params.thread,
    };
  } catch (error) {
    if (!params.isMissingThreadError(error)) {
      throw error;
    }
    const thread = await params.ensureOfficeThread(
      params.panel,
      params.thread.config.workspace,
      true,
    );
    if (!thread) {
      return { response: null, thread: params.thread };
    }
    return {
      response: await params.startTurn(
        thread.threadId,
        turnInput(thread.threadId),
      ),
      thread,
    };
  }
}
