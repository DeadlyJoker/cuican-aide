import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  terminalInputFailurePanel,
  terminalInputSentPanel,
  terminalMissingThreadPanel,
  terminalSendConfirmMessage,
  terminalSendToThreadFailurePanel,
  terminalSentToThreadDemoPanel,
  terminalSentToThreadNotice,
  terminalSentToThreadPanel,
  terminalStopFailurePanel,
  terminalStoppingPanel,
} from "./terminalActionPresentation";

export type TerminalAction = "sendInput" | "sendToThread" | "stop";

type TerminalClient = {
  runThreadShellCommand(threadId: string, command: string): Promise<unknown>;
  terminateCommand(processId: string): Promise<unknown>;
  writeCommandInput(processId: string, input: string): Promise<unknown>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type TerminalActionHandlersParams = {
  busyToolId: string | null;
  client: TerminalClient | null | undefined;
  command: string;
  confirm: (message: string) => boolean;
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  processId: string | null;
  setCapabilityPanel: SetCapabilityPanel;
  setNotice: (notice: NoticeState) => void;
  stdinValue: string;
  threadId: string | null;
};

export function terminalActionForActionId(
  actionId: string,
): TerminalAction | null {
  switch (actionId) {
    case "send-terminal-input":
      return "sendInput";
    case "send-terminal-to-thread":
      return "sendToThread";
    case "stop-terminal":
      return "stop";
    default:
      return null;
  }
}

export function createTerminalActionHandlers(
  params: TerminalActionHandlersParams,
): Record<TerminalAction, () => void> {
  return {
    sendInput: () => sendTerminalInput(params),
    sendToThread: () => sendTerminalToThread(params),
    stop: () => stopTerminal(params),
  };
}

function sendTerminalInput(params: TerminalActionHandlersParams) {
  const { client, locale, processId, setCapabilityPanel, stdinValue } = params;
  if (!processId || !stdinValue) {
    return;
  }

  void client
    ?.writeCommandInput(processId, stdinValue.replace(/\\n/g, "\n"))
    .then(() => {
      setCapabilityPanel((currentPanel) =>
        terminalInputSentPanel(currentPanel, locale),
      );
    })
    .catch((error) => {
      setCapabilityPanel((currentPanel) =>
        terminalInputFailurePanel(currentPanel, error, locale),
      );
    });
}

function sendTerminalToThread(params: TerminalActionHandlersParams) {
  const {
    busyToolId,
    client,
    command,
    confirm,
    isConnected,
    isDemo,
    locale,
    setCapabilityPanel,
    setNotice,
    threadId,
  } = params;
  const trimmedCommand = command.trim();

  if (!trimmedCommand) {
    return;
  }

  if (isDemo) {
    setCapabilityPanel((currentPanel) =>
      terminalSentToThreadDemoPanel(currentPanel, locale),
    );
    return;
  }

  if (busyToolId || !isConnected || !threadId) {
    setCapabilityPanel((currentPanel) =>
      terminalMissingThreadPanel(currentPanel, locale),
    );
    return;
  }

  if (!confirm(terminalSendConfirmMessage(trimmedCommand, locale))) {
    return;
  }

  void client
    ?.runThreadShellCommand(threadId, trimmedCommand)
    .then(() => {
      setCapabilityPanel((currentPanel) =>
        terminalSentToThreadPanel(currentPanel, trimmedCommand, locale),
      );
      setNotice(terminalSentToThreadNotice(locale));
    })
    .catch((error) => {
      setCapabilityPanel((currentPanel) =>
        terminalSendToThreadFailurePanel(currentPanel, error, locale),
      );
    });
}

function stopTerminal(params: TerminalActionHandlersParams) {
  const { client, locale, processId, setCapabilityPanel } = params;
  if (!processId) {
    return;
  }

  void client?.terminateCommand(processId).catch((error) => {
    setCapabilityPanel((currentPanel) =>
      terminalStopFailurePanel(currentPanel, error, locale),
    );
  });
  setCapabilityPanel((currentPanel) => terminalStoppingPanel(currentPanel, locale));
}
