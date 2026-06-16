import { AgentConfigView } from "../agents/AgentConfigView";
import { OfficeWorkspaceView } from "../office/OfficeWorkspaceView";
import type { Locale } from "../../lib/i18n";
import type {
  AgentConfig,
  ArtifactItem,
  LibraryItem,
  LibraryPanel,
  LibraryPanelAction,
} from "../../lib/crewonDomain";
import { GenericLibraryPage } from "./GenericLibraryPage";
import { KnowledgeView } from "./KnowledgeView";

type LibraryViewProps = {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onItemAction: (item: LibraryItem) => void;
  onPanelAction: (action: LibraryPanelAction) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onSendOfficeMessage: (text: string) => void;
  onUpdateAgentConfig: (patch: Partial<AgentConfig>) => void;
  onToggleAgentCapability: (group: "mcp" | "skills", id: string) => void;
  onSaveAgentConfig: () => void;
  onApprovalDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
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
