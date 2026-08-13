import type {
  AutomationReadResponse,
  AutomationRunsListResponse,
} from "../app-server/appServer";
import {
  automationDetailPanel,
  buildAutomationDetailPanel,
  matchingAutomationDetailFailurePanel,
  matchingAutomationDetailItemsPanel,
  matchingAutomationDetailPanel,
} from "./automationDetailPanel";
import type {
  LibraryItem,
  LibraryItemAction,
  LibraryPanel,
} from "../domain/crewonDomain";
import { automationConfigRecordToLibraryItem } from "../domain/domainLibraryItems";
import {
  automationRunRecordItems,
  emptyAutomationRunItems,
} from "../domain/domainAutomationBackend";
import type { Locale } from "../i18n";

type AutomationDetailAction = Extract<
  LibraryItemAction,
  { type: "automation-detail" }
>;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type OpenAutomationDetailActionParams = {
  action: AutomationDetailAction;
  isConnected: boolean;
  listAutomationRuns: (
    threadId: string,
  ) => Promise<AutomationRunsListResponse | null | undefined>;
  locale: Locale;
  readAutomationConfig: (params: {
    filePath?: string | null;
    threadId?: string | null;
    title?: string | null;
  }) => Promise<AutomationReadResponse | null | undefined>;
  readAutomationRunItems: (threadId: string) => Promise<LibraryItem[]>;
  setLibraryPanel: LibraryPanelSetter;
};

export async function openAutomationDetailAction({
  action,
  isConnected,
  listAutomationRuns,
  locale,
  readAutomationConfig,
  readAutomationRunItems,
  setLibraryPanel,
}: OpenAutomationDetailActionParams): Promise<boolean> {
  const automationPanel = buildAutomationDetailPanel(action, locale);
  setLibraryPanel((currentPanel) =>
    automationDetailPanel(currentPanel, automationPanel),
  );

  if (action.controlAutomationId) {
    return true;
  }

  if (!isConnected) {
    return true;
  }

  try {
    let latestAction = action;
    let latestThreadId = action.threadId;
    let latestItems = automationPanel.items ?? [];
    const readResponse = await readAutomationConfig({
      filePath: action.configPath ?? null,
      threadId: action.threadId ?? null,
      title: action.title,
    });
    const latestRecord = readResponse?.record ?? null;
    if (latestRecord) {
      latestThreadId = latestRecord.config.threadId;
      latestItems = latestRecord.config.threadId
        ? await readAutomationRunItems(latestRecord.config.threadId)
        : emptyAutomationRunItems(locale);
      const latestItem = automationConfigRecordToLibraryItem(
        latestRecord,
        locale,
        latestItems,
      );
      if (latestItem.action?.type === "automation-detail") {
        latestAction = latestItem.action;
        setLibraryPanel((currentPanel) =>
          matchingAutomationDetailPanel(
            currentPanel,
            [action.title, latestAction.title],
            buildAutomationDetailPanel(latestAction, locale, latestItems),
          ),
        );
      }
    }

    if (latestThreadId) {
      const runsResponse = await listAutomationRuns(latestThreadId);
      if (runsResponse?.data.length) {
        setLibraryPanel((currentPanel) =>
          matchingAutomationDetailItemsPanel(
            currentPanel,
            [action.title, latestAction.title],
            automationRunRecordItems(runsResponse.data, locale),
          ),
        );
        return true;
      }
    }

    setLibraryPanel((currentPanel) =>
      matchingAutomationDetailItemsPanel(
        currentPanel,
        [action.title, latestAction.title],
        emptyAutomationRunItems(locale),
      ),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      matchingAutomationDetailFailurePanel(
        currentPanel,
        [action.title],
        error,
        locale,
      ),
    );
  }
  return true;
}
