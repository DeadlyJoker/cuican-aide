import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  worktreeSessionActionFailurePanelState,
  worktreeSessionActionInProgressPanelState,
  worktreeSessionCreateFailureMessage,
  worktreeSessionForkSelectionMessage,
  worktreeSessionMissingWorkspaceMessage,
} from "../settings/settingsPanelText";
import { upsertThread } from "../thread/threadModel";

export type WorktreeSessionAction = "create" | "fork";

type WorktreeSessionClient = {
  forkThread(threadId: string): Promise<{ thread: Thread }>;
  startThread(cwd: string, threadSource: string): Promise<Thread>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type WorktreeSessionActionHandlersParams = {
  client: WorktreeSessionClient | null | undefined;
  locale: Locale;
  refreshWorktreesSettingsPanel: () => Promise<void>;
  resolveBackendCwd: () => Promise<string | null | undefined>;
  selectedThreadId: string | null;
  setCapabilityPanel: SetCapabilityPanel;
  setSelectedThreadId: (threadId: string) => void;
  setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => void;
};

export function worktreeSessionActionForActionId(
  actionId: string,
): WorktreeSessionAction | null {
  switch (actionId) {
    case "create-worktree-session":
      return "create";
    case "fork-worktree":
      return "fork";
    default:
      return null;
  }
}

export function createWorktreeSessionActionHandlers(
  params: WorktreeSessionActionHandlersParams,
): Record<WorktreeSessionAction, () => void> {
  return {
    create: () => {
      void runWorktreeSessionAction(params, "create");
    },
    fork: () => {
      void runWorktreeSessionAction(params, "fork");
    },
  };
}

async function runWorktreeSessionAction(
  params: WorktreeSessionActionHandlersParams,
  action: WorktreeSessionAction,
) {
  const {
    client,
    locale,
    refreshWorktreesSettingsPanel,
    resolveBackendCwd,
    selectedThreadId,
    setCapabilityPanel,
    setSelectedThreadId,
    setThreads,
  } = params;

  try {
    const worktreeCwd = await resolveBackendCwd();
    if (!worktreeCwd) {
      throw new Error(worktreeSessionMissingWorkspaceMessage(locale));
    }

    setCapabilityPanel((currentPanel) =>
      worktreeSessionActionInProgressPanelState(currentPanel, {
        action,
        cwd: worktreeCwd,
        locale,
      }),
    );

    let nextThread: Thread | null = null;
    if (action === "fork") {
      if (!selectedThreadId) {
        throw new Error(worktreeSessionForkSelectionMessage(locale));
      }
      const response = await client?.forkThread(selectedThreadId);
      nextThread = response?.thread ?? null;
    } else {
      nextThread = (await client?.startThread(worktreeCwd, "worktree")) ?? null;
    }

    if (!nextThread) {
      throw new Error(worktreeSessionCreateFailureMessage(locale));
    }

    setThreads((current) => upsertThread(current, nextThread));
    setSelectedThreadId(nextThread.id);
    await refreshWorktreesSettingsPanel();
  } catch (error) {
    setCapabilityPanel((currentPanel) =>
      worktreeSessionActionFailurePanelState(currentPanel, {
        error,
        locale,
      }),
    );
  }
}
