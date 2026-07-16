import { useState } from "react";

import type {
  LibraryItem,
  LibraryPanelAction,
} from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

export type LibraryPanelActionCallback = (
  action: LibraryPanelAction,
) => boolean | void | Promise<boolean | void>;

export function libraryLabel(locale: Locale, zh: string, en: string) {
  return locale === "zh" ? zh : en;
}

export function LibraryPageHeader({
  title,
  subtitle,
  locale,
  onBack,
}: {
  title: string;
  subtitle: string;
  locale: Locale;
  onBack: () => void;
}) {
  return (
    <header className="library-heading">
      <button type="button" onClick={onBack}>
        {libraryLabel(locale, "返回对话", "Back to chat")}
      </button>
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </header>
  );
}

export function LibraryError({ error }: { error?: string }) {
  return error ? <p className="library-error">{error}</p> : null;
}

export function LibraryActions({
  actions,
  className,
  onPanelAction,
}: {
  actions?: LibraryPanelAction[];
  className?: string;
  onPanelAction: LibraryPanelActionCallback;
}) {
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);

  if (!actions || actions.length === 0) return null;

  return (
    <div className={["library-actions", className].filter(Boolean).join(" ")}>
      {actions.map((action) => {
        const actionKey = `${action.id}:${action.pluginId ?? action.pluginName ?? action.label}`;
        const isPending = pendingActionKey === actionKey;
        return (
          <button
            type="button"
            aria-busy={isPending}
            data-tone={action.tone}
            key={actionKey}
            disabled={pendingActionKey !== null}
            onClick={async () => {
              setPendingActionKey(actionKey);
              try {
                await onPanelAction(action);
              } finally {
                setPendingActionKey(null);
              }
            }}
          >
            {isPending ? `${action.label}…` : action.label}
          </button>
        );
      })}
    </div>
  );
}

export function LibraryEmpty({ locale }: { locale: Locale }) {
  return (
    <div className="library-empty">
      {libraryLabel(locale, "暂无数据", "No data")}
    </div>
  );
}

export function LibrarySectionItem({ item }: { item: LibraryItem }) {
  return (
    <div className="library-section">
      <strong>{item.title}</strong>
      <span>{item.meta}</span>
      {item.description ? <p>{item.description}</p> : null}
    </div>
  );
}
