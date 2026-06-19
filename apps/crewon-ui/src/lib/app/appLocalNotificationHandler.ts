import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerNotification } from "../app-server/appServer";
import type {
  NoticeState,
  PendingApprovalRequest,
  PendingDynamicToolRequest,
  PendingExternalSecretRequest,
  PendingMcpElicitationRequest,
  PendingUserInputRequest,
} from "./appRuntimeState";
import {
  appWarningNotice,
  fileChangedNotice,
  terminalOutputChunk,
} from "./appNotificationPresentation";
import {
  activeTurnByThreadAfterTurn,
  appendFileChangesToPanel,
  appendTerminalChunkToPanel,
  appendThreadText,
  clearThreadText,
  removeRecordKey,
} from "./appNotificationState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { ActiveFileWatch } from "../file/filePanelActions";
import type { Locale } from "../i18n";
import { handleResolvedServerRequest } from "../server-request/serverRequestHandler";
import { decodeBase64Text } from "../server-request/serverRequestPresentation";
import {
  appendCommandOutputDeltaInThread,
  appendItemInThread,
  appendPlanDeltaInThread,
  removeThreadFromList,
  selectedThreadIdAfterThreadRemoval,
  updateFileChangeItemChangesInThread,
  updateThreadName,
  updateThreadStatus,
  upsertThread,
  upsertTurnInThread,
} from "../thread/threadModel";

type StateSetter<T> = (updater: (current: T) => T) => void;

export type LocalNotificationHandlerParams = {
  locale: Locale;
  notification: AppServerNotification;
  selectedThreadId: string | null;
  terminalProcessId: string | null;
  setActiveFileWatch: StateSetter<ActiveFileWatch | null>;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setCapabilityPanel: StateSetter<CapabilityPanel | null>;
  setNotice: (notice: NoticeState | null) => void;
  setPendingApprovalRequest: StateSetter<PendingApprovalRequest | null>;
  setPendingDynamicToolRequest: StateSetter<PendingDynamicToolRequest | null>;
  setPendingExternalSecretRequest: StateSetter<PendingExternalSecretRequest | null>;
  setPendingMcpElicitationRequest: StateSetter<PendingMcpElicitationRequest | null>;
  setPendingUserInputRequest: StateSetter<PendingUserInputRequest | null>;
  setSelectedThreadId: StateSetter<string | null>;
  setStreamingTextByThread: StateSetter<Record<string, string>>;
  setThreads: StateSetter<Thread[]>;
};

export function handleLocalAppNotification({
  locale,
  notification,
  selectedThreadId,
  terminalProcessId,
  setActiveFileWatch,
  setActiveTurnByThread,
  setCapabilityPanel,
  setNotice,
  setPendingApprovalRequest,
  setPendingDynamicToolRequest,
  setPendingExternalSecretRequest,
  setPendingMcpElicitationRequest,
  setPendingUserInputRequest,
  setSelectedThreadId,
  setStreamingTextByThread,
  setThreads,
}: LocalNotificationHandlerParams): boolean {
  switch (notification.method) {
    case "command/exec/outputDelta": {
      const { processId, stream, deltaBase64, capReached } =
        notification.params;
      if (terminalProcessId !== processId) {
        return true;
      }

      const text = decodeBase64Text(deltaBase64);
      const chunk = terminalOutputChunk(stream, text, capReached);
      setCapabilityPanel((currentPanel) =>
        appendTerminalChunkToPanel(currentPanel, chunk, locale),
      );
      return true;
    }
    case "fs/changed": {
      const { watchId, changedPaths } = notification.params;
      setActiveFileWatch((currentWatch) => {
        if (!currentWatch || currentWatch.id !== watchId) {
          return currentWatch;
        }
        setCapabilityPanel((currentPanel) =>
          appendFileChangesToPanel(currentPanel, changedPaths, locale),
        );
        setNotice(fileChangedNotice(changedPaths, currentWatch.path, locale));
        return currentWatch;
      });
      return true;
    }
    case "error": {
      const { threadId } = notification.params;
      setStreamingTextByThread((current) => clearThreadText(current, threadId));
      setActiveTurnByThread((current) => removeRecordKey(current, threadId));
      return true;
    }
    case "item/agentMessage/delta": {
      const { threadId, delta } = notification.params;
      setStreamingTextByThread((current) =>
        appendThreadText(current, threadId, delta),
      );
      return true;
    }
    case "item/commandExecution/outputDelta": {
      const { threadId, turnId, itemId, delta } = notification.params;
      setThreads((current) =>
        appendCommandOutputDeltaInThread(
          current,
          threadId,
          turnId,
          itemId,
          delta,
        ),
      );
      return true;
    }
    case "item/completed": {
      const { threadId, turnId, item } = notification.params;
      setThreads((current) => appendItemInThread(current, threadId, turnId, item));
      setStreamingTextByThread((current) => clearThreadText(current, threadId));
      return true;
    }
    case "item/fileChange/patchUpdated": {
      const { threadId, turnId, itemId, changes } = notification.params;
      setThreads((current) =>
        updateFileChangeItemChangesInThread(
          current,
          threadId,
          turnId,
          itemId,
          changes,
        ),
      );
      return true;
    }
    case "item/plan/delta": {
      const { threadId, turnId, itemId, delta } = notification.params;
      setThreads((current) =>
        appendPlanDeltaInThread(current, threadId, turnId, itemId, delta),
      );
      return true;
    }
    case "item/started": {
      const { threadId, turnId, item } = notification.params;
      setThreads((current) => appendItemInThread(current, threadId, turnId, item));
      return true;
    }
    case "serverRequest/resolved": {
      handleResolvedServerRequest({
        locale,
        requestId: notification.params.requestId,
        setCapabilityPanel,
        setPendingApprovalRequest,
        setPendingDynamicToolRequest,
        setPendingExternalSecretRequest,
        setPendingMcpElicitationRequest,
        setPendingUserInputRequest,
      });
      return true;
    }
    case "thread/archived":
    case "thread/deleted": {
      const { threadId } = notification.params;
      setThreads((current) => removeThreadFromList(current, threadId));
      setStreamingTextByThread((current) => removeRecordKey(current, threadId));
      setActiveTurnByThread((current) => removeRecordKey(current, threadId));
      setSelectedThreadId((currentThreadId) =>
        selectedThreadIdAfterThreadRemoval(currentThreadId, threadId),
      );
      return true;
    }
    case "thread/name/updated": {
      const { threadId, threadName } = notification.params;
      setThreads((current) =>
        updateThreadName(current, threadId, threadName ?? null),
      );
      return true;
    }
    case "thread/started": {
      const { thread } = notification.params;
      setThreads((current) => upsertThread(current, thread));
      return true;
    }
    case "thread/status/changed": {
      const { threadId, status } = notification.params;
      setThreads((current) => updateThreadStatus(current, threadId, status));
      return true;
    }
    case "turn/started": {
      const { threadId, turn } = notification.params;
      setThreads((current) => upsertTurnInThread(current, threadId, turn));
      setActiveTurnByThread((current) =>
        activeTurnByThreadAfterTurn(current, threadId, turn),
      );
      return true;
    }
    case "warning": {
      const { threadId, message } = notification.params;
      if (!threadId || threadId === selectedThreadId) {
        setNotice(appWarningNotice(message));
      }
      return true;
    }
    default:
      return false;
  }
}
