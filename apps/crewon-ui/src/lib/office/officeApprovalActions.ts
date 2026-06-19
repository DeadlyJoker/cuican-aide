import type { NoticeState } from "../shared/noticeState";
import type {
  LibraryPanel,
  OfficeConfig,
  OfficeMessage,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  officeApprovalDecisionNotice,
  officeApprovalFailureNotice,
  officeApprovalLocalDecisionPanel,
  officeApprovalOptimisticPanel,
  officeApprovalSavedPanel,
  officeApprovalSystemMessage,
} from "./officeDetailPanel";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type OfficeApprovalDecision = "approved" | "denied";

export type OfficeApprovalDecisionActionParams = {
  decideOfficeApproval: (
    panel: LibraryPanel,
    workspace: OfficeWorkspace,
    threadId: string,
    approvalId: string,
    decision: OfficeApprovalDecision,
    message: OfficeMessage,
  ) => Promise<OfficeConfig | null>;
  decision: OfficeApprovalDecision;
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspace: OfficeWorkspace,
  ) => Promise<string | null>;
  id: string;
  isConnected: boolean;
  locale: Locale;
  panel: LibraryPanel | null;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
};

export async function handleOfficeApprovalDecisionAction({
  decideOfficeApproval,
  decision,
  ensureOfficeThread,
  id,
  isConnected,
  locale,
  panel,
  setLibraryPanel,
  setNotice,
}: OfficeApprovalDecisionActionParams): Promise<boolean> {
  const selectedApproval =
    panel?.workspace?.activity?.approvals.find((request) => request.id === id) ??
    null;
  setLibraryPanel((currentPanel) =>
    officeApprovalLocalDecisionPanel(currentPanel, {
      decision,
      requestId: id,
    }),
  );
  setNotice(
    officeApprovalDecisionNotice({
      approval: selectedApproval,
      decision,
      locale,
    }),
  );

  if (!isConnected || !panel?.workspace || !selectedApproval) {
    return true;
  }

  const baseWorkspace = panel.workspace;
  const systemMessage = officeApprovalSystemMessage({
    approval: selectedApproval,
    decision,
    locale,
  });
  setLibraryPanel((currentPanel) =>
    officeApprovalOptimisticPanel(currentPanel, {
      decision,
      message: systemMessage,
      requestId: id,
      workspace: baseWorkspace,
    }),
  );

  try {
    const threadId = await ensureOfficeThread(panel, baseWorkspace);
    if (!threadId) {
      return true;
    }
    const savedConfig = await decideOfficeApproval(
      panel,
      baseWorkspace,
      threadId,
      id,
      decision,
      systemMessage,
    );
    if (!savedConfig) {
      return true;
    }
    setLibraryPanel((currentPanel) =>
      officeApprovalSavedPanel(currentPanel, {
        config: savedConfig,
        threadId,
      }),
    );
  } catch (error) {
    setNotice(officeApprovalFailureNotice(error, locale));
  }
  return true;
}
