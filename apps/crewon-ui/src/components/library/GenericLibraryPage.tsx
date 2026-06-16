import type { Locale } from "../../lib/i18n";
import type {
  LibraryItem,
  LibraryPanel,
  LibraryPanelAction,
} from "../../lib/crewonDomain";
import { LibraryCard } from "./LibraryCard";
import {
  LibraryActions,
  LibraryEmpty,
  LibraryError,
  LibraryPageHeader,
  LibrarySectionItem,
} from "./LibraryPrimitives";

export function GenericLibraryPage({
  panel,
  locale,
  onBack,
  onItemAction,
  onPanelAction,
  onPanelFieldChange,
}: {
  panel: LibraryPanel;
  locale: Locale;
  onBack: () => void;
  onItemAction: (item: LibraryItem) => void;
  onPanelAction: (action: LibraryPanelAction) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
}) {
  return (
    <main className="library-page" aria-label={panel.title}>
      <LibraryPageHeader
        title={panel.title}
        subtitle={panel.subtitle}
        locale={locale}
        onBack={onBack}
      />
      <LibraryError error={panel.error} />
      {panel.body ? <pre>{panel.body}</pre> : null}
      {panel.fields ? (
        <div className="library-fields">
          {panel.fields.map((field) => (
            <label key={field.id}>
              <span>{field.label}</span>
              <textarea
                spellCheck={false}
                value={field.value}
                placeholder={field.placeholder}
                onChange={(event) =>
                  onPanelFieldChange(field.id, event.target.value)
                }
              />
            </label>
          ))}
        </div>
      ) : null}
      <LibraryActions
        actions={panel.actions}
        onPanelAction={onPanelAction}
      />
      <section className="library-list">
        {panel.items.length > 0 ? (
          panel.items.map((item) =>
            item.section ? (
              <LibrarySectionItem
                item={item}
                key={`${item.title}:${item.meta}`}
              />
            ) : (
              <LibraryCard
                item={item}
                key={`${item.title}:${item.meta}`}
                onItemAction={onItemAction}
              />
            ),
          )
        ) : (
          <LibraryEmpty locale={locale} />
        )}
      </section>
    </main>
  );
}
