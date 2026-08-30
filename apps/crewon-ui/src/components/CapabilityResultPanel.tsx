import {
  AppWindow,
  File,
  Folder,
  Plug,
  SquareTerminal,
} from "lucide-react";

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

function capabilityItemLabel(label: string): string {
  return label.replace(/^\s*>\s*/, "").trimStart();
}

function capabilityItemIcon(item: CapabilityPanelItem) {
  if (item.kind === "directory") {
    return <Folder aria-hidden="true" />;
  }
  if (item.kind === "file") {
    return <File aria-hidden="true" />;
  }
  if (item.action?.type === "app") {
    return <AppWindow aria-hidden="true" />;
  }
  if (item.action?.type === "plugin") {
    return <Plug aria-hidden="true" />;
  }
  if (item.action?.type === "background-terminal") {
    return <SquareTerminal aria-hidden="true" />;
  }
  return null;
}

function capabilityPanelKind(panel: CapabilityPanel): string {
  if (
    panel.commandInput ||
    panel.items?.some((item) => item.action?.type === "background-terminal") ||
    /终端|terminal/i.test(panel.title)
  ) {
    return "terminal";
  }
  if (
    panel.items?.some(
      (item) => item.kind === "directory" || item.kind === "file",
    )
  ) {
    return "files";
  }
  if (/审查|改动|review|changes/i.test(panel.title)) {
    return "review";
  }
  if (/浏览器|browser|应用与 hooks/i.test(panel.title)) {
    return "web";
  }
  if (/侧边聊天|side chat/i.test(panel.title)) {
    return "sidechat";
  }
  return "generic";
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
  const panelKind = capabilityPanelKind(panel);

  return (
    <section
      className="capability-result"
      data-panel-kind={panelKind}
      aria-live="polite"
    >
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
            {busyToolId === "terminal"
              ? locale === "zh"
                ? "运行中"
                : "Running"
              : locale === "zh"
                ? "运行"
                : "Run"}
          </button>
        </form>
      ) : null}
      {panel.error ? <p className="capability-result-error">{panel.error}</p> : null}
      {panel.body ? (
        panelKind === "terminal" || panelKind === "review" ? (
          <pre className="capability-result-output">{panel.body}</pre>
        ) : (
          <p className="capability-result-summary">{panel.body}</p>
        )
      ) : null}
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
              ) : field.multiline ? (
                <textarea
                  placeholder={field.placeholder}
                  rows={field.rows ?? 4}
                  value={field.value}
                  onChange={(event) =>
                    onPanelFieldChange?.(field.id, event.target.value)
                  }
                />
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
        <ul className="capability-result-list">
          {panel.items.map((item) => {
            const icon = capabilityItemIcon(item);
            return (
              <li key={capabilityItemKey(item)}>
                {item.path || item.action ? (
                  <button
                    type="button"
                    className="capability-result-item"
                    data-has-icon={icon ? "true" : undefined}
                    title={item.path ?? item.label}
                    onClick={() => onPanelItem?.(item)}
                  >
                    {icon ? (
                      <span className="capability-result-item-icon">
                        {icon}
                      </span>
                    ) : null}
                    <span className="capability-result-item-label">
                      {capabilityItemLabel(item.label)}
                    </span>
                  </button>
                ) : (
                  <div
                    className="capability-result-item is-static"
                    data-has-icon={icon ? "true" : undefined}
                  >
                    {icon ? (
                      <span className="capability-result-item-icon">
                        {icon}
                      </span>
                    ) : null}
                    <span className="capability-result-item-label">
                      {capabilityItemLabel(item.label)}
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
