import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  buildThreadGoalDraft,
  threadGoalActionFailurePanel,
  threadGoalActionProgressPanel,
  threadGoalClearedDemoPanel,
  threadGoalClearedPanel,
  threadGoalSavedDemoPanel,
  threadGoalSavedPanel,
  threadGoalValidationMessage,
  threadGoalValidationPanel,
  validateThreadGoalDraft,
} from "./threadGoalPanel";

export type ThreadGoalAction = "clear" | "save";

type ThreadGoalClient = {
  clearThreadGoal(threadId: string): Promise<void>;
  setThreadGoal(
    threadId: string,
    objective: string,
    tokenBudget: number | null,
  ): Promise<{ goal: ThreadGoal | null }>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type ThreadGoalActionHandlersParams = {
  busyToolId: string | null;
  client: ThreadGoalClient | null | undefined;
  createThread: (initialPrompt?: string) => Promise<Thread | null>;
  fieldValue: (fieldId: string) => string;
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  openThreadSettingsPanel: () => void;
  setBusyToolId: (toolId: "sidechat" | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setThreadGoal: (goal: ThreadGoal | null) => void;
  threadId: string | null;
};

export function threadGoalActionForActionId(
  actionId: string,
): ThreadGoalAction | null {
  switch (actionId) {
    case "clear-thread-goal":
      return "clear";
    case "save-thread-goal":
      return "save";
    default:
      return null;
  }
}

export function createThreadGoalActionHandlers(
  params: ThreadGoalActionHandlersParams,
): Record<ThreadGoalAction, () => void> {
  return {
    clear: () => runThreadGoalAction(params, "clear"),
    save: () => runThreadGoalAction(params, "save"),
  };
}

function runThreadGoalAction(
  params: ThreadGoalActionHandlersParams,
  action: ThreadGoalAction,
) {
  const {
    busyToolId,
    fieldValue,
    isConnected,
    isDemo,
    locale,
    setCapabilityPanel,
    setThreadGoal,
  } = params;

  if (isDemo) {
    const draft = buildThreadGoalDraft(fieldValue);
    if (action === "clear") {
      setThreadGoal(null);
      setCapabilityPanel(() => threadGoalClearedDemoPanel(locale));
      return;
    }
    setCapabilityPanel(() => threadGoalSavedDemoPanel(draft, locale));
    return;
  }

  if (busyToolId || !isConnected) {
    return;
  }

  void runBackendThreadGoalAction(params, action);
}

async function runBackendThreadGoalAction(
  params: ThreadGoalActionHandlersParams,
  action: ThreadGoalAction,
) {
  const {
    client,
    createThread,
    fieldValue,
    locale,
    openThreadSettingsPanel,
    setBusyToolId,
    setCapabilityPanel,
    setThreadGoal,
  } = params;
  let threadId = params.threadId;

  setBusyToolId("sidechat");
  setCapabilityPanel((currentPanel) =>
    threadGoalActionProgressPanel(currentPanel, action, locale),
  );

  try {
    if (action === "clear") {
      if (!threadId) {
        setThreadGoal(null);
        openThreadSettingsPanel();
        return;
      }
      await client?.clearThreadGoal(threadId);
      setThreadGoal(null);
      setCapabilityPanel((currentPanel) =>
        threadGoalClearedPanel(currentPanel, locale),
      );
      return;
    }

    const draft = buildThreadGoalDraft(fieldValue);
    const validationMessage = threadGoalValidationMessage(
      validateThreadGoalDraft(draft),
      locale,
    );
    if (validationMessage) {
      setCapabilityPanel((currentPanel) =>
        threadGoalValidationPanel(currentPanel, validationMessage),
      );
      return;
    }

    if (!threadId) {
      const thread = await createThread(draft.objective);
      threadId = thread?.id ?? null;
    }

    if (!threadId) {
      return;
    }

    const response = await client?.setThreadGoal(
      threadId,
      draft.objective,
      draft.tokenBudget,
    );
    setThreadGoal(response?.goal ?? null);
    setCapabilityPanel((currentPanel) =>
      threadGoalSavedPanel(currentPanel, locale),
    );
  } catch (error) {
    setCapabilityPanel((currentPanel) =>
      threadGoalActionFailurePanel(currentPanel, error, locale),
    );
  } finally {
    setBusyToolId(null);
  }
}
