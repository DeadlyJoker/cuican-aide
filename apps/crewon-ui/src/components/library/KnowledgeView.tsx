import type {
  LibraryPanel,
  LibraryPanelAction,
} from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";
import {
  LibraryActions,
  LibraryError,
  LibraryPageHeader,
  libraryLabel,
} from "./LibraryPrimitives";
import { KnowledgeMemoryList } from "./KnowledgeMemoryList";
import { KnowledgeSourceList } from "./KnowledgeSourceList";

export function KnowledgeView({
  panel,
  locale,
  onBack,
  onPanelAction,
}: {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onPanelAction: (action: LibraryPanelAction) => void;
}) {
  const data = panel.knowledge;
  if (!data) return null;
  const isZh = locale === "zh";
  const actions: LibraryPanelAction[] = [
    {
      id: "create-knowledge-memory",
      label: libraryLabel(locale, "写入记忆", "Write memory"),
      tone: "primary",
    },
    {
      id: "refresh-knowledge",
      label: libraryLabel(locale, "刷新知识库", "Refresh knowledge"),
    },
    {
      id: "reset-memory",
      label: libraryLabel(locale, "重置全局记忆", "Reset global memory"),
      tone: "danger",
    },
  ];

  return (
    <main className="library-page knowledge-page" aria-label={panel.title}>
      <LibraryPageHeader
        title={panel.title}
        subtitle={panel.subtitle}
        locale={locale}
        onBack={onBack}
      />
      <LibraryError error={panel.error} />
      <LibraryActions
        actions={actions}
        className="knowledge-actions"
        onPanelAction={onPanelAction}
      />

      <div className="knowledge-grid">
        <KnowledgeMemoryList
          isZh={isZh}
          memories={data.memories}
          onPanelAction={onPanelAction}
        />
        <KnowledgeSourceList
          isZh={isZh}
          locale={locale}
          sources={data.sources}
          onPanelAction={onPanelAction}
        />
      </div>
    </main>
  );
}
