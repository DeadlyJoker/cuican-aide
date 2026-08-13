import type { Thread } from "@crewon-ui-model/v2/Thread";

import {
  createThreadLifecycleActionHandlers,
  threadLifecycleActionForActionId,
  type ThreadLifecycleClient,
} from "../../thread/threadLifecycleActions";
import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../../capability/capabilityPanelTypes";
import type { ConfirmHandler } from "../../shared/confirmHandler";
import type { LibraryPanel } from "../../domain/crewonDomain";
import type { Locale, ToolId } from "../../i18n";
import { updateCapabilityPanelFieldAction } from "../../capability/appCapabilityPanelActions";
import { backendThreadId } from "../appUiState";

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export type AppCapabilityPanelHandlersParams = {
  busyToolId: ToolId | null;
  capabilityPanel: CapabilityPanel | null;
  confirm: ConfirmHandler;
  handleSettingsAction: (actionId: string) => boolean;
  locale: Locale;
  onUnavailable: () => void;
  selectedThreadId: string | null;
  setActiveTurnByThread: (
    updater: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  setBusyToolId: (toolId: ToolId | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setLibraryPanel: (
    updater: (panel: LibraryPanel | null) => LibraryPanel | null,
  ) => void;
  setStreamingTextByThread: (
    updater: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => void;
  threadLifecycleClient: ThreadLifecycleClient | null;
  threadLifecycleConnected: boolean;
};

export type AppCapabilityPanelHandlers = {
  handleCapabilityPanelAction: (actionId: string) => void;
  handleCapabilityPanelFieldChange: (fieldId: string, value: string) => void;
  handleCapabilityPanelItem: (item: CapabilityPanelItem) => Promise<void>;
};

/** Production panel dispatch for the Control-only desktop composition. */
export function createAppCapabilityPanelHandlers(
  params: AppCapabilityPanelHandlersParams,
): AppCapabilityPanelHandlers {
  return {
    handleCapabilityPanelAction: (actionId) => {
      if (params.handleSettingsAction(actionId)) return;

      const lifecycleAction = threadLifecycleActionForActionId(actionId);
      if (lifecycleAction) {
        createThreadLifecycleActionHandlers({
          busyToolId: params.busyToolId,
          client: params.threadLifecycleClient,
          confirm: params.confirm,
          isConnected: params.threadLifecycleConnected,
          isDemo: false,
          locale: params.locale,
          setActiveTurnByThread: params.setActiveTurnByThread,
          setBusyToolId: params.setBusyToolId,
          setCapabilityPanel: params.setCapabilityPanel,
          setStreamingTextByThread: params.setStreamingTextByThread,
          setThreads: params.setThreads,
          threadId: backendThreadId(params.selectedThreadId),
        })[lifecycleAction]();
        return;
      }

      params.onUnavailable();
    },
    handleCapabilityPanelFieldChange: (fieldId, value) => {
      updateCapabilityPanelFieldAction({
        fieldId,
        setCapabilityPanel: params.setCapabilityPanel,
        setLibraryPanel: params.setLibraryPanel,
        value,
      });
    },
    handleCapabilityPanelItem: async () => {
      params.onUnavailable();
    },
  };
}
