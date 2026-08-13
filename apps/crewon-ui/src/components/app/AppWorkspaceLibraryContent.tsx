import { LoaderCircle } from "lucide-react";
import { Suspense, lazy } from "react";

import type { LibraryItem, LibraryPanel } from "../../lib/domain/crewonDomain";
import type { LibraryPanelActionCallback } from "../library/LibraryPrimitives";
import { translate, type Locale } from "../../lib/i18n";

const LibraryView = lazy(() =>
  import("../library/LibraryView").then((module) => ({
    default: module.LibraryView,
  })),
);

export function AppWorkspaceLibraryContent({
  libraryPanel,
  locale,
  onBackLibrary,
  onItemAction,
  onLibraryPanelAction,
  onPanelFieldChange,
}: {
  libraryPanel: LibraryPanel;
  locale: Locale;
  onBackLibrary: () => void;
  onItemAction: (item: LibraryItem) => void;
  onLibraryPanelAction: LibraryPanelActionCallback;
  onPanelFieldChange: (fieldId: string, value: string) => void;
}) {
  const t = translate(locale);

  return (
    <Suspense
      fallback={
        <section className="library-page" aria-label={libraryPanel.title}>
          <div className="route-loading-state" role="status" aria-live="polite">
            <LoaderCircle aria-hidden="true" size={18} />
            <strong>{t.loadingThreads}</strong>
            <small>{t.loadingRouteHint}</small>
          </div>
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
      />
    </Suspense>
  );
}
