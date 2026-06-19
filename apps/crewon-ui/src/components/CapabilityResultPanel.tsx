import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../lib/i18n";

function capabilityItemKey(item: CapabilityPanelItem) {
  return `${item.kind ?? item.action?.type ?? "item"}:${
    item.path ??
    (item.action?.type === "app"
      ? item.action.appName
      : item.action?.type === "plugin"
        ? item.action.pluginName
        : item.action?.processId) ??
    item.label
  }`;
}

export function CapabilityResultPanel({
  locale,
  disabled,
  busyToolId,
  commandValue,
  panel,
  onCommandChange,
  onCommandSubmit,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
}: {
  locale: Locale;
  disabled: boolean;
  busyToolId: ToolId | null;
  commandValue: string;
  panel: CapabilityPanel;
  onCommandChange?: (value: string) => void;
  onCommandSubmit?: () => void;
  onPanelAction?: (actionId: string) => void;
  onPanelFieldChange?: (fieldId: string, value: string) => void;
  onPanelItem?: (item: CapabilityPanelItem) => void;
}) {
  return (
    <section className="capability-result" aria-live="polite">
      <div className="capability-result-header">
        <strong>{panel.title}</strong>
        {panel.subtitle ? <span>{panel.subtitle}</span> : null}
      </div>
      {panel.commandInput ? (
        <form
          className="capability-command-form"
          onSubmit={(event) => {
            event.preventDefault();
            onCommandSubmit?.();
          }}
        >
          <input
            aria-label={locale === "zh" ? "终端命令" : "Terminal command"}
            disabled={disabled || busyToolId === "terminal"}
            spellCheck={false}
            value={commandValue}
            onChange={(event) => onCommandChange?.(event.target.value)}
          />
          <button
            type="submit"
            disabled={
              disabled || busyToolId === "terminal" || !commandValue.trim()
            }
          >
            {locale === "zh" ? "运行" : "Run"}
          </button>
        </form>
      ) : null}
      {panel.error ? <p className="capability-result-error">{panel.error}</p> : null}
      {panel.body ? <pre>{panel.body}</pre> : null}
      {panel.fields ? (
        <div className="capability-field-list">
          {panel.fields.map((field) => (
            <label key={field.id}>
              <span>{field.label}</span>
              {field.options ? (
                <select
                  value={field.value}
                  onChange={(event) =>
                    onPanelFieldChange?.(field.id, event.target.value)
                  }
                >
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.secret ? "password" : "text"}
                  value={field.value}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    onPanelFieldChange?.(field.id, event.target.value)
                  }
                />
              )}
            </label>
          ))}
        </div>
      ) : null}
      {panel.actions ? (
        <div className="capability-result-actions">
          {panel.actions.map((action) => (
            <button
              type="button"
              data-tone={action.tone}
              key={action.id}
              onClick={() => onPanelAction?.(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {panel.items ? (
        <ul>
          {panel.items.map((item) => (
            <li key={capabilityItemKey(item)}>
              {item.path || item.action ? (
                <button
                  type="button"
                  className="capability-result-item"
                  onClick={() => onPanelItem?.(item)}
                >
                  {item.label}
                </button>
              ) : (
                item.label
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
