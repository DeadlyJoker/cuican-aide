import type { Thread } from "@crewon-ui-model/v2/Thread";

import { removeRecordKey } from "../shared/recordState";
import type { ConfirmHandler } from "../shared/confirmHandler";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import { realThreadRequiredPanel } from "../settings/settingsSavePayloads";
import {
  threadCompactDemoPanel,
  threadCompactFailurePanel,
  threadCompactProgressPanel,
  threadCompactSuccessPanel,
  threadMemoryDemoPanel,
  threadMemoryFailurePanel,
  threadMemoryProgressPanel,
  threadMemorySuccessPanel,
  threadRollbackConfirmMessage,
  threadRollbackDemoPanel,
  threadRollbackFailurePanel,
  threadRollbackProgressPanel,
  threadRollbackSuccessPanel,
} from "./threadSettingsPanel";
import { upsertThread } from "./threadModel";

export type ThreadLifecycleAction =
  | "compact"
  | "memoryDisabled"
  | "memoryEnabled"
  | "rollback";

type ThreadMemoryMode = "disabled" | "enabled";

export type ThreadLifecycleClient = {
  compactThread(threadId: string): Promise<void>;
  readThread(threadId: string): Promise<Thread>;
  rollbackThread(threadId: string, numTurns?: number): Promise<Thread>;
  setThreadMemoryMode?(threadId: string, mode: ThreadMemoryMode): Promise<void>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type ThreadLifecycleActionHandlersParams = {
  busyToolId: string | null;
  client: ThreadLifecycleClient | null | undefined;
  confirm: ConfirmHandler;
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  setActiveTurnByThread: (
    updater: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  setBusyToolId: (toolId: "sidechat" | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setStreamingTextByThread: (
    updater: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => void;
  threadId: string | null;
};

export function threadLifecycleActionForActionId(
  actionId: string,
): ThreadLifecycleAction | null {
  switch (actionId) {
    case "compact-thread":
      return "compact";
    case "disable-thread-memory":
      return "memoryDisabled";
    case "enable-thread-memory":
      return "memoryEnabled";
    case "rollback-thread":
      return "rollback";
    default:
      return null;
  }
}

export function createThreadLifecycleActionHandlers(
  params: ThreadLifecycleActionHandlersParams,
): Record<ThreadLifecycleAction, () => void> {
  return {
    compact: () => compactThread(params),
    memoryDisabled: () => setThreadMemory(params, "disabled"),
    memoryEnabled: () => setThreadMemory(params, "enabled"),
    rollback: () => rollbackThread(params),
  };
}

function compactThread(params: ThreadLifecycleActionHandlersParams) {
  const {
    busyToolId,
    client,
    isConnected,
    isDemo,
    locale,
    setBusyToolId,
    setCapabilityPanel,
    setThreads,
    threadId,
  } = params;

  if (isDemo) {
    setCapabilityPanel((currentPanel) =>
      threadCompactDemoPanel(currentPanel, locale),
    );
    return;
  }

  if (busyToolId || !isConnected || !threadId) {
    return;
  }

  void (async () => {
    setBusyToolId("sidechat");
    setCapabilityPanel((currentPanel) =>
      threadCompactProgressPanel(currentPanel, locale),
    );

    try {
      if (!client) throw new Error("thread_compaction_unavailable");
      await client.compactThread(threadId);
      const thread = await client.readThread(threadId);
      if (thread) {
        setThreads((current) => upsertThread(current, thread));
      }
      setCapabilityPanel((currentPanel) =>
        threadCompactSuccessPanel(currentPanel, locale),
      );
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        threadCompactFailurePanel(currentPanel, error, locale),
      );
    } finally {
      setBusyToolId(null);
    }
  })();
}

function rollbackThread(params: ThreadLifecycleActionHandlersParams) {
  const {
    busyToolId,
    client,
    confirm,
    isConnected,
    isDemo,
    locale,
    setActiveTurnByThread,
    setBusyToolId,
    setCapabilityPanel,
    setStreamingTextByThread,
    setThreads,
    threadId,
  } = params;

  if (isDemo) {
    setCapabilityPanel((currentPanel) =>
      threadRollbackDemoPanel(currentPanel, locale),
    );
    return;
  }

  if (busyToolId || !isConnected || !threadId) {
    return;
  }

  void (async () => {
    if (!(await confirm(threadRollbackConfirmMessage(locale)))) {
      return;
    }

    setBusyToolId("sidechat");
    setCapabilityPanel((currentPanel) =>
      threadRollbackProgressPanel(currentPanel, locale),
    );

    try {
      if (!client) throw new Error("thread_rollback_unavailable");
      const thread = await client.rollbackThread(threadId, 1);
      if (thread) {
        setThreads((current) => upsertThread(current, thread));
      }
      setActiveTurnByThread((current) => removeRecordKey(current, threadId));
      setStreamingTextByThread((current) => removeRecordKey(current, threadId));
      setCapabilityPanel((currentPanel) =>
        threadRollbackSuccessPanel(currentPanel, locale),
      );
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        threadRollbackFailurePanel(currentPanel, error, locale),
      );
    } finally {
      setBusyToolId(null);
    }
  })();
}

function setThreadMemory(
  params: ThreadLifecycleActionHandlersParams,
  mode: ThreadMemoryMode,
) {
  const {
    busyToolId,
    client,
    isConnected,
    isDemo,
    locale,
    setBusyToolId,
    setCapabilityPanel,
    threadId,
  } = params;

  if (isDemo) {
    setCapabilityPanel((currentPanel) =>
      threadMemoryDemoPanel(currentPanel, mode, locale),
    );
    return;
  }

  if (busyToolId || !isConnected || !threadId) {
    setCapabilityPanel((currentPanel) =>
      realThreadRequiredPanel(currentPanel, locale),
    );
    return;
  }

  void (async () => {
    setBusyToolId("sidechat");
    setCapabilityPanel((currentPanel) =>
      threadMemoryProgressPanel(currentPanel, locale),
    );

    try {
      if (!client?.setThreadMemoryMode) {
        throw new Error("thread_memory_mode_not_supported");
      }
      await client.setThreadMemoryMode(threadId, mode);
      setCapabilityPanel((currentPanel) =>
        threadMemorySuccessPanel(currentPanel, mode, locale),
      );
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        threadMemoryFailurePanel(currentPanel, error, locale),
      );
    } finally {
      setBusyToolId(null);
    }
  })();
}
