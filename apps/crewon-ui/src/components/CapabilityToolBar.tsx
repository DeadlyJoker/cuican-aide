import {
  BotMessageSquare,
  FileText,
  Globe2,
  ScanSearch,
  Terminal,
} from "lucide-react";

import type { Locale, ToolId, ToolOption } from "../lib/i18n";

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

export function CapabilityToolBar({
  locale,
  disabled,
  busyToolId,
  onToolClick,
}: {
  locale: Locale;
  disabled: boolean;
  busyToolId: ToolId | null;
  onToolClick: (toolId: ToolId) => void;
}) {
  const tools = capabilityTools(locale);

  return (
    <>
      {tools.map((tool) => (
        <button
          type="button"
          key={tool.id}
          disabled={disabled || busyToolId === tool.id}
          onClick={() => onToolClick(tool.id)}
        >
          <span className="capability-label">
            {toolIcon(tool.id)}
            {busyToolId === tool.id
              ? locale === "zh"
                ? "启动中"
                : "Starting"
              : tool.label}
          </span>
          {shortcuts[tool.id] ? <kbd>{shortcuts[tool.id]}</kbd> : null}
        </button>
      ))}
    </>
  );
}
