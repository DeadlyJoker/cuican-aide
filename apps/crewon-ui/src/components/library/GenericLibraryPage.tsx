import type { Locale } from "../../lib/i18n";
import type {
  LibraryItem,
  LibraryPanel,
  LibraryPanelAction,
} from "../../lib/crewonDomain";
import { LibraryCard } from "./LibraryCard";

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
      <header className="library-heading">
        <button type="button" onClick={onBack}>
          {locale === "zh" ? "返回对话" : "Back to chat"}
        </button>
        <div>
          <h1>{panel.title}</h1>
          <p>{panel.subtitle}</p>
        </div>
      </header>
      {panel.error ? <p className="library-error">{panel.error}</p> : null}
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
      {panel.actions ? (
        <div className="library-actions">
          {panel.actions.map((action) => (
            <button
              type="button"
              data-tone={action.tone}
              key={`${action.id}:${action.pluginId ?? action.pluginName ?? action.label}`}
              onClick={() => onPanelAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      <section className="library-list">
        {panel.items.length > 0 ? (
          panel.items.map((item) =>
            item.section ? (
              <div
                className="library-section"
                key={`${item.title}:${item.meta}`}
              >
                <strong>{item.title}</strong>
                <span>{item.meta}</span>
                {item.description ? <p>{item.description}</p> : null}
              </div>
            ) : (
              <LibraryCard
                item={item}
                key={`${item.title}:${item.meta}`}
                onItemAction={onItemAction}
              />
            ),
          )
        ) : (
          <div className="library-empty">
            {locale === "zh" ? "暂无数据" : "No data"}
          </div>
        )}
      </section>
    </main>
  );
}
