import { Suspense, lazy } from "react";

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
import type { LibraryPanelActionCallback } from "../library/LibraryPrimitives";
import { translate, type Locale } from "../../lib/i18n";
import type { OfficeMessageSendResult } from "../../lib/office/officeMessageActions";

const LibraryView = lazy(() =>
  import("../library/LibraryView").then((module) => ({
    default: module.LibraryView,
  })),
);

export function AppWorkspaceLibraryContent({
  activeTurnByThread = {},
  libraryPanel,
  locale,
  onApprovalDecision,
  onArtifact,
  onBackLibrary,
  onItemAction,
  onLibraryPanelAction,
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
  onPanelFieldChange,
  onSaveAgentConfig,
  onSendOfficeMessage,
  onToggleAgentCapability,
  onUpdateAgentConfig,
}: {
  activeTurnByThread?: Record<string, string>;
  libraryPanel: LibraryPanel;
  locale: Locale;
  onApprovalDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
  onBackLibrary: () => void;
  onItemAction: (item: LibraryItem) => void;
  onLibraryPanelAction: LibraryPanelActionCallback;
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
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onSaveAgentConfig: () => void;
  onSendOfficeMessage: (
    text: string,
    clientUserMessageId: string,
  ) => OfficeMessageSendResult | Promise<OfficeMessageSendResult>;
  onToggleAgentCapability: (group: "mcp" | "skills", id: string) => void;
  onUpdateAgentConfig: (patch: Partial<AgentConfig>) => void;
}) {
  const t = translate(locale);

  return (
    <Suspense
      fallback={
        <section className="library-page" aria-label={libraryPanel.title}>
          <p className="library-loading">{t.loadingThreads}</p>
        </section>
      }
    >
      <LibraryView
        activeTurnByThread={activeTurnByThread}
        panel={libraryPanel}
        locale={locale}
        onBack={onBackLibrary}
        onItemAction={onItemAction}
        onPanelAction={onLibraryPanelAction}
        onPanelFieldChange={onPanelFieldChange}
        onSendOfficeMessage={onSendOfficeMessage}
        onUpdateAgentConfig={onUpdateAgentConfig}
        onToggleAgentCapability={onToggleAgentCapability}
        onSaveAgentConfig={onSaveAgentConfig}
        onApprovalDecision={onApprovalDecision}
        onArtifact={onArtifact}
        onOfficeDelegationDispatch={onOfficeDelegationDispatch}
        onOfficeDelegationCancel={onOfficeDelegationCancel}
        onOfficeDelegationRetry={onOfficeDelegationRetry}
        onOfficeDelegationDispatchNext={onOfficeDelegationDispatchNext}
        onOfficeVerificationCancel={onOfficeVerificationCancel}
        onOfficeVerificationRetry={onOfficeVerificationRetry}
        onOfficeMemoryDecision={onOfficeMemoryDecision}
        onOfficeMemoryList={onOfficeMemoryList}
        onOfficeMemberContextPreview={onOfficeMemberContextPreview}
        onRecruitableAgentList={onRecruitableAgentList}
        onOfficeRunCancel={onOfficeRunCancel}
        onOfficeRunRetry={onOfficeRunRetry}
      />
    </Suspense>
  );
}
