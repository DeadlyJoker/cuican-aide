import { Suspense, lazy } from "react";

import type {
  AgentConfig,
  ArtifactItem,
  LibraryItem,
  LibraryPanel,
  LibraryPanelAction,
  OfficeRunActivity,
} from "../../lib/domain/crewonDomain";
import { translate, type Locale } from "../../lib/i18n";

const LibraryView = lazy(() =>
  import("../library/LibraryView").then((module) => ({
    default: module.LibraryView,
  })),
);

export function AppWorkspaceLibraryContent({
  libraryPanel,
  locale,
  onApprovalDecision,
  onArtifact,
  onBackLibrary,
  onItemAction,
  onLibraryPanelAction,
  onOfficeRunCancel,
  onOfficeRunRetry,
  onPanelFieldChange,
  onSaveAgentConfig,
  onSendOfficeMessage,
  onToggleAgentCapability,
  onUpdateAgentConfig,
}: {
  libraryPanel: LibraryPanel;
  locale: Locale;
  onApprovalDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
  onBackLibrary: () => void;
  onItemAction: (item: LibraryItem) => void;
  onLibraryPanelAction: (action: LibraryPanelAction) => void;
  onOfficeRunCancel: (run: OfficeRunActivity) => void;
  onOfficeRunRetry: (run: OfficeRunActivity) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onSaveAgentConfig: () => void;
  onSendOfficeMessage: (text: string) => void;
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
        onOfficeRunCancel={onOfficeRunCancel}
        onOfficeRunRetry={onOfficeRunRetry}
      />
    </Suspense>
  );
}
