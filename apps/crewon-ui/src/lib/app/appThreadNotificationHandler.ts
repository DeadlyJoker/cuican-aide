import type { AppServerNotification } from "../app-server/appServer";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import { panelHasField } from "../shared/panelState";

export type ThreadNotificationHandlerParams = {
  capabilityPanel: CapabilityPanel | null;
  notification: AppServerNotification;
  openThreadSettingsPanel: () => void;
  refreshSelectedThreadGoal: (threadId: string) => void;
  refreshThread: (threadId: string) => void;
  reloadThreads: () => void;
  selectedThreadId: string | null;
  setThreadGoal: (goal: null) => void;
};

export function handleThreadAppNotification({
  capabilityPanel,
  notification,
  openThreadSettingsPanel,
  refreshSelectedThreadGoal,
  refreshThread,
  reloadThreads,
  selectedThreadId,
  setThreadGoal,
}: ThreadNotificationHandlerParams): boolean {
  switch (notification.method) {
    case "thread/compacted": {
      refreshThread(notification.params.threadId);
      return true;
    }
    case "thread/goal/cleared": {
      refreshThread(notification.params.threadId);
      if (notification.params.threadId === selectedThreadId) {
        setThreadGoal(null);
      }
      return true;
    }
    case "thread/goal/updated": {
      refreshThread(notification.params.threadId);
      if (notification.params.threadId === selectedThreadId) {
        refreshSelectedThreadGoal(notification.params.threadId);
      }
      return true;
    }
    case "thread/settings/updated": {
      refreshThread(notification.params.threadId);
      if (
        notification.params.threadId === selectedThreadId &&
        panelHasField(capabilityPanel, "thread-goal-objective")
      ) {
        openThreadSettingsPanel();
      }
      return true;
    }
    case "thread/tokenUsage/updated": {
      refreshThread(notification.params.threadId);
      return true;
    }
    case "thread/unarchived": {
      reloadThreads();
      return true;
    }
    case "turn/diff/updated":
    case "turn/plan/updated": {
      refreshThread(notification.params.threadId);
      return true;
    }
    default:
      return false;
  }
}
