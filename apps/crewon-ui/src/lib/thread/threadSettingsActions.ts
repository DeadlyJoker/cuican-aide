import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  buildThreadSettingsPatch,
  hasThreadSettingsPatch,
  realThreadRequiredPanel,
  threadSettingsMissingSelectionPanel,
  threadSettingsSaveFailurePanel,
  threadSettingsSaveProgressPanel,
  threadSettingsSaveSuccessPanel,
} from "../settings/settingsSavePayloads";
import {
  threadHistoryDemoRefreshPanel,
  threadHistoryRefreshFailurePanel,
  threadHistoryRefreshInProgressPanel,
  threadHistoryRefreshSuccessPanel,
} from "./threadHistoryItems";
import { updateThreadTurns } from "./threadModel";

export type ThreadSettingsAction = "refreshHistory" | "saveSettings";

type ThreadSettingsClient = {
  listThreadTurns(threadId: string): Promise<Turn[]>;
  updateThreadSettings(
    threadId: string,
    settings: {
      approvalPolicy?: string | null;
      model?: string | null;
      sandboxMode?: string | null;
    },
  ): Promise<void>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type ThreadSettingsActionHandlersParams = {
  busyToolId: string | null;
  client: ThreadSettingsClient | null | undefined;
  fieldValue: (fieldId: string) => string;
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  selectedThread: Thread | null | undefined;
  setBusyToolId: (toolId: "sidechat" | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => void;
  threadId: string | null;
};

export function threadSettingsActionForActionId(
  actionId: string,
): ThreadSettingsAction | null {
  switch (actionId) {
    case "save-thread-settings":
      return "saveSettings";
    case "refresh-thread-history":
      return "refreshHistory";
    default:
      return null;
  }
}

export function createThreadSettingsActionHandlers(
  params: ThreadSettingsActionHandlersParams,
): Record<ThreadSettingsAction, () => void> {
  return {
    refreshHistory: () => refreshThreadHistory(params),
    saveSettings: () => saveThreadSettings(params),
  };
}

function saveThreadSettings(params: ThreadSettingsActionHandlersParams) {
  const {
    busyToolId,
    client,
    fieldValue,
    isConnected,
    locale,
    setBusyToolId,
    setCapabilityPanel,
    threadId,
  } = params;
  const settingsPatch = buildThreadSettingsPatch(fieldValue);

  if (!hasThreadSettingsPatch(settingsPatch)) {
    setCapabilityPanel((currentPanel) =>
      threadSettingsMissingSelectionPanel(currentPanel, locale),
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
      threadSettingsSaveProgressPanel(currentPanel, locale),
    );

    try {
      await client?.updateThreadSettings(threadId, settingsPatch);
      setCapabilityPanel((currentPanel) =>
        threadSettingsSaveSuccessPanel(currentPanel, settingsPatch, locale),
      );
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        threadSettingsSaveFailurePanel(currentPanel, error, locale),
      );
    } finally {
      setBusyToolId(null);
    }
  })();
}

function refreshThreadHistory(params: ThreadSettingsActionHandlersParams) {
  const {
    busyToolId,
    client,
    isConnected,
    isDemo,
    locale,
    selectedThread,
    setBusyToolId,
    setCapabilityPanel,
    setThreads,
    threadId,
  } = params;

  if (isDemo) {
    setCapabilityPanel((currentPanel) =>
      threadHistoryDemoRefreshPanel(currentPanel, locale),
    );
    return;
  }

  if (busyToolId || !isConnected || !threadId || !selectedThread) {
    setCapabilityPanel((currentPanel) =>
      realThreadRequiredPanel(currentPanel, locale),
    );
    return;
  }

  void (async () => {
    setBusyToolId("sidechat");
    setCapabilityPanel((currentPanel) =>
      threadHistoryRefreshInProgressPanel(currentPanel, locale),
    );

    try {
      const turns = await client?.listThreadTurns(threadId);
      if (!turns) {
        return;
      }
      setThreads((current) => updateThreadTurns(current, threadId, turns));
      setCapabilityPanel((currentPanel) =>
        threadHistoryRefreshSuccessPanel(currentPanel, turns.length, locale),
      );
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        threadHistoryRefreshFailurePanel(currentPanel, error, locale),
      );
    } finally {
      setBusyToolId(null);
    }
  })();
}
