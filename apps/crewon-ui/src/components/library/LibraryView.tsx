import type { LibraryPanelActionCallback } from "./LibraryPrimitives";
import type { Locale } from "../../lib/i18n";
import type {
  LibraryItem,
  LibraryPanel,
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
};

export function LibraryView({
  panel,
  locale,
  onBack,
  onItemAction,
  onPanelAction,
  onPanelFieldChange,
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
