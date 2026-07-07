import { AgentConfigView } from "../agents/AgentConfigView";
import { OfficeWorkspaceView } from "../office/OfficeWorkspaceView";
import type { LibraryPanelActionCallback } from "./LibraryPrimitives";
import type { Locale } from "../../lib/i18n";
import type {
  AgentConfig,
  ArtifactItem,
  LibraryItem,
  LibraryPanel,
  OfficeMember,
  OfficeMemberContextPreview,
  OfficeMemoryListResult,
  OfficeMemoryRecord,
  OfficeMemoryStatus,
  OfficeRunActivity,
  OfficeRunDelegationActivity,
  OfficeRunVerificationCheckActivity,
} from "../../lib/domain/crewonDomain";
import { GenericLibraryPage } from "./GenericLibraryPage";
import { KnowledgeView } from "./KnowledgeView";

type LibraryViewProps = {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onItemAction: (item: LibraryItem) => void;
  onPanelAction: LibraryPanelActionCallback;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onSendOfficeMessage: (text: string) => void | Promise<void>;
  onUpdateAgentConfig: (patch: Partial<AgentConfig>) => void;
  onToggleAgentCapability: (group: "mcp" | "skills", id: string) => void;
  onSaveAgentConfig: () => void;
  onApprovalDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
  onOfficeDelegationDispatch: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void | Promise<void>;
  onOfficeDelegationCancel: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void | Promise<void>;
  onOfficeDelegationRetry: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void | Promise<void>;
  onOfficeDelegationDispatchNext?: (
    run: OfficeRunActivity,
  ) => void | Promise<void>;
  onOfficeVerificationCancel: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => void | Promise<void>;
  onOfficeVerificationRetry: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => void | Promise<void>;
  onOfficeMemoryDecision?: (
    memoryId: string,
    status: OfficeMemoryStatus,
  ) => Promise<OfficeMemoryRecord | null>;
  onOfficeMemoryList?: (
    status: OfficeMemoryStatus,
    cursor?: string | null,
  ) => Promise<OfficeMemoryListResult | null>;
  onOfficeMemberContextPreview?: (
    run: OfficeRunActivity,
    member: OfficeMember,
  ) => Promise<OfficeMemberContextPreview | null>;
  onRecruitableAgentList?: (
    existingMembers: OfficeMember[],
  ) => Promise<AgentConfig[]>;
  onOfficeRunCancel: (run: OfficeRunActivity) => void | Promise<void>;
  onOfficeRunRetry: (run: OfficeRunActivity) => void | Promise<void>;
};

export function LibraryView({
  panel,
  locale,
  onBack,
  onItemAction,
  onPanelAction,
  onPanelFieldChange,
  onSendOfficeMessage,
  onUpdateAgentConfig,
  onToggleAgentCapability,
  onSaveAgentConfig,
  onApprovalDecision,
  onArtifact,
  onOfficeDelegationDispatch,
  onOfficeDelegationCancel,
  onOfficeDelegationRetry,
  onOfficeDelegationDispatchNext,
  onOfficeVerificationCancel,
  onOfficeVerificationRetry,
  onOfficeMemoryDecision,
  onOfficeMemoryList,
  onOfficeMemberContextPreview,
  onRecruitableAgentList,
  onOfficeRunCancel,
  onOfficeRunRetry,
}: LibraryViewProps) {
  if (panel.knowledge) {
    return (
      <KnowledgeView
        panel={panel}
        locale={locale}
        onBack={onBack}
        onPanelAction={onPanelAction}
      />
    );
  }

  if (panel.agentConfig) {
    return (
      <AgentConfigView
        panel={panel}
        locale={locale}
        onBack={onBack}
        onUpdate={onUpdateAgentConfig}
        onToggleCapability={onToggleAgentCapability}
        onSave={onSaveAgentConfig}
        onOpenThread={(threadId) =>
          onPanelAction({
            id: "open-thread",
            label: locale === "zh" ? "打开后端线程" : "Open backend thread",
            threadId,
          })
        }
      />
    );
  }

  if (panel.workspace) {
    return (
      <OfficeWorkspaceView
        panel={panel}
        locale={locale}
        onBack={onBack}
        onPanelAction={onPanelAction}
        onSendMessage={onSendOfficeMessage}
        onDecision={onApprovalDecision}
        onArtifact={onArtifact}
        onDelegationDispatch={onOfficeDelegationDispatch}
        onDelegationCancel={onOfficeDelegationCancel}
        onDelegationRetry={onOfficeDelegationRetry}
        onDelegationDispatchNext={onOfficeDelegationDispatchNext}
        onVerificationCancel={onOfficeVerificationCancel}
        onVerificationRetry={onOfficeVerificationRetry}
        onMemoryDecision={onOfficeMemoryDecision}
        onMemoryList={onOfficeMemoryList}
        onMemberContextPreview={onOfficeMemberContextPreview}
        onRecruitableAgentList={onRecruitableAgentList}
        onRunCancel={onOfficeRunCancel}
        onRunRetry={onOfficeRunRetry}
      />
    );
  }

  return (
    <GenericLibraryPage
      panel={panel}
      locale={locale}
      onBack={onBack}
      onItemAction={onItemAction}
      onPanelAction={onPanelAction}
      onPanelFieldChange={onPanelFieldChange}
    />
  );
}
