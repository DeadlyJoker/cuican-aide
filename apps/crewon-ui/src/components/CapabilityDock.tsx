import { BotMessageSquare, FileText, Globe2, ScanSearch, Terminal } from "lucide-react";
import type { Locale, ToolId, ToolOption } from "../lib/i18n";

type CapabilityDockProps = {
  locale: Locale;
  disabled?: boolean;
  busyToolId?: ToolId | null;
  commandValue?: string;
  panel?: CapabilityPanel | null;
  onCommandChange?: (value: string) => void;
  onCommandSubmit?: () => void;
  onFiles?: () => void;
  onPanelAction?: (actionId: string) => void;
  onPanelFieldChange?: (fieldId: string, value: string) => void;
  onPanelItem?: (item: CapabilityPanelItem) => void;
  onWeb?: () => void;
  onReview?: () => void;
  onSideChat?: () => void;
  onTerminal?: () => void;
};

export type CapabilityPanelItem = {
  label: string;
  path?: string;
  kind?: "directory" | "file";
  intent?: "attach-context";
  action?: {
    type: "app";
    appId: string;
    appName: string;
  } | {
    type: "plugin";
    pluginName: string;
    marketplacePath?: string | null;
    remoteMarketplaceName?: string | null;
  } | {
    type: "background-terminal";
    threadId: string;
    processId: string;
  };
};

export type CapabilityPanel = {
  title: string;
  subtitle?: string;
  actions?: Array<{
    id: string;
    label: string;
    tone?: "primary" | "danger";
  }>;
  body?: string;
  commandInput?: boolean;
  fields?: Array<{
    id: string;
    label: string;
    options?: Array<{ label: string; value: string }>;
    placeholder?: string;
    secret?: boolean;
    value: string;
  }>;
  items?: CapabilityPanelItem[];
  error?: string;
};

const shortcuts: Partial<Record<ToolId, string>> = {
  review: "^⇧G",
  web: "⌘T",
  files: "⌘P",
  sidechat: "⌥⌘S",
};

function toolIcon(tool: ToolId) {
  switch (tool) {
    case "review":
      return <ScanSearch size={14} />;
    case "terminal":
      return <Terminal size={14} />;
    case "web":
      return <Globe2 size={14} />;
    case "files":
      return <FileText size={14} />;
    case "sidechat":
      return <BotMessageSquare size={14} />;
  }
}

function capabilityTools(locale: Locale): ToolOption[] {
  return locale === "zh"
    ? [
        { id: "review", label: "审查" },
        { id: "terminal", label: "终端" },
        { id: "web", label: "浏览器" },
        { id: "files", label: "文件" },
        { id: "sidechat", label: "侧边聊天" },
      ]
    : [
        { id: "review", label: "Review" },
        { id: "terminal", label: "Terminal" },
        { id: "web", label: "Browser" },
        { id: "files", label: "Files" },
        { id: "sidechat", label: "Side chat" },
      ];
}

export function CapabilityDock({
  locale,
  disabled = false,
  busyToolId = null,
  commandValue = "",
  panel = null,
  onCommandChange,
  onCommandSubmit,
  onFiles,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
  onWeb,
  onReview,
  onSideChat,
  onTerminal,
}: CapabilityDockProps) {
  const tools = capabilityTools(locale);

  function handleToolClick(toolId: ToolId) {
    if (toolId === "review") {
      onReview?.();
      return;
    }

    if (toolId === "terminal") {
      onTerminal?.();
      return;
    }

    if (toolId === "files") {
      onFiles?.();
      return;
    }

    if (toolId === "web") {
      onWeb?.();
      return;
    }

    if (toolId === "sidechat") {
      onSideChat?.();
      return;
    }
  }

  return (
    <div className="capability-dock" role="toolbar">
      {tools.map((tool) => (
        <button type="button" key={tool.id} disabled={disabled || busyToolId === tool.id} onClick={() => handleToolClick(tool.id)}>
          <span className="capability-label">
            {toolIcon(tool.id)}
            {busyToolId === tool.id ? (locale === "zh" ? "启动中" : "Starting") : tool.label}
          </span>
          {shortcuts[tool.id] ? <kbd>{shortcuts[tool.id]}</kbd> : null}
        </button>
      ))}
      {panel ? (
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
              <button type="submit" disabled={disabled || busyToolId === "terminal" || !commandValue.trim()}>
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
                      onChange={(event) => onPanelFieldChange?.(field.id, event.target.value)}
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
                      onChange={(event) => onPanelFieldChange?.(field.id, event.target.value)}
                    />
                  )}
                </label>
              ))}
            </div>
          ) : null}
          {panel.actions ? (
            <div className="capability-result-actions">
              {panel.actions.map((action) => (
                <button type="button" data-tone={action.tone} key={action.id} onClick={() => onPanelAction?.(action.id)}>
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
          {panel.items ? (
            <ul>
              {panel.items.map((item) => (
                <li
                  key={`${item.kind ?? item.action?.type ?? "item"}:${
                    item.path ??
                    (item.action?.type === "app"
                      ? item.action.appName
                      : item.action?.type === "plugin"
                        ? item.action.pluginName
                        : item.action?.processId) ??
                    item.label
                  }`}
                >
                  {item.path || item.action ? (
                    <button type="button" className="capability-result-item" onClick={() => onPanelItem?.(item)}>
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
      ) : null}
    </div>
  );
}
