import type { NoticeState } from "../shared/noticeState";
import type { BackgroundTerminal } from "../app-server/appServer";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  backgroundTerminalsEmptyPanel,
  backgroundTerminalsErrorPanel,
  backgroundTerminalsLoadingPanel,
  backgroundTerminalsPanel,
} from "../capability/capabilityPanelText";
import type { Locale } from "../i18n";
import {
  backgroundTerminalActionFailurePanel,
  backgroundTerminalTerminateFailurePanel,
  backgroundTerminalTerminateNotice,
  backgroundTerminalsDemoPanel,
} from "./terminalActionPresentation";

export type BackgroundTerminalAction = "clean" | "refresh";

type BackgroundTerminalClient = {
  cleanBackgroundTerminals(threadId: string): Promise<void>;
  listBackgroundTerminals(threadId: string): Promise<{ data: BackgroundTerminal[] }>;
  terminateBackgroundTerminal(
    threadId: string,
    processId: string,
  ): Promise<boolean>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

type SetCapabilityPanelValue = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export type BackgroundTerminalActionHandlersParams = {
  client: BackgroundTerminalClient | null | undefined;
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  setBusyToolId: (toolId: "terminal" | null) => void;
  setCapabilityPanel: SetCapabilityPanelValue;
  threadId: string | null;
};

export type TerminateBackgroundTerminalParams = {
  client: BackgroundTerminalClient | null | undefined;
  locale: Locale;
  processId: string;
  setBusyToolId: (toolId: "terminal" | null) => void;
  setCapabilityPanel: SetCapabilityPanelValue;
  setNotice: (notice: NoticeState) => void;
  threadId: string;
};

export function backgroundTerminalActionForActionId(
  actionId: string,
): BackgroundTerminalAction | null {
  switch (actionId) {
    case "clean-background-terminals":
      return "clean";
    case "refresh-background-terminals":
      return "refresh";
    default:
      return null;
  }
}

export function createBackgroundTerminalActionHandlers(
  params: BackgroundTerminalActionHandlersParams,
): Record<BackgroundTerminalAction, () => void> {
  return {
    clean: () => refreshBackgroundTerminals(params, true),
    refresh: () => refreshBackgroundTerminals(params, false),
  };
}

function refreshBackgroundTerminals(
  params: BackgroundTerminalActionHandlersParams,
  cleanFirst: boolean,
) {
  const {
    isConnected,
    isDemo,
    locale,
    setCapabilityPanel,
    threadId,
  } = params;

  if (isDemo) {
    setCapabilityPanel((currentPanel) =>
      backgroundTerminalsDemoPanel(currentPanel, locale),
    );
    return;
  }

  if (!isConnected || !threadId) {
    setCapabilityPanel(backgroundTerminalsEmptyPanel(locale));
    return;
  }

  void refreshBackgroundTerminalsWithBackend(params, cleanFirst, threadId);
}

async function refreshBackgroundTerminalsWithBackend(
  params: BackgroundTerminalActionHandlersParams,
  cleanFirst: boolean,
  threadId: string,
) {
  const { client, locale, setCapabilityPanel } = params;

  try {
    if (cleanFirst) {
      await client?.cleanBackgroundTerminals(threadId);
    }
    await showBackgroundTerminalsPanel(params, threadId);
  } catch (error) {
    setCapabilityPanel((currentPanel) =>
      backgroundTerminalActionFailurePanel(currentPanel, error, locale),
    );
  }
}

export async function showBackgroundTerminalsPanel(
  params: {
    client: BackgroundTerminalClient | null | undefined;
    locale: Locale;
    setBusyToolId: (toolId: "terminal" | null) => void;
    setCapabilityPanel: SetCapabilityPanelValue;
  },
  threadId: string,
) {
  const { client, locale, setBusyToolId, setCapabilityPanel } = params;

  setBusyToolId("terminal");
  setCapabilityPanel(backgroundTerminalsLoadingPanel(threadId, locale));

  try {
    const response = await client?.listBackgroundTerminals(threadId);
    const terminals = response?.data ?? [];
    setCapabilityPanel(
      backgroundTerminalsPanel({ locale, terminals, threadId }),
    );
  } catch (error) {
    setCapabilityPanel(
      backgroundTerminalsErrorPanel({ error, locale, threadId }),
    );
  } finally {
    setBusyToolId(null);
  }
}

export async function terminateBackgroundTerminal(
  params: TerminateBackgroundTerminalParams,
) {
  const {
    client,
    locale,
    processId,
    setBusyToolId,
    setCapabilityPanel,
    setNotice,
    threadId,
  } = params;

  setBusyToolId("terminal");
  try {
    const terminated = await client?.terminateBackgroundTerminal(
      threadId,
      processId,
    );
    setNotice(backgroundTerminalTerminateNotice(terminated, locale));
    await showBackgroundTerminalsPanel(params, threadId);
  } catch (error) {
    (setCapabilityPanel as SetCapabilityPanel)((currentPanel) =>
      backgroundTerminalTerminateFailurePanel(currentPanel, error, locale),
    );
  } finally {
    setBusyToolId(null);
  }
}
