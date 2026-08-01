import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../lib/i18n";
import { CapabilityResultPanel } from "./CapabilityResultPanel";
import { CapabilityToolBar } from "./CapabilityToolBar";

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

function capabilityPanelToolId(panel: CapabilityPanel | null): ToolId | null {
  if (!panel) {
    return null;
  }
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
    ) ||
    /文件|上下文|files?/i.test(panel.title)
  ) {
    return "files";
  }
  if (
    panel.items?.some(
      (item) => item.action?.type === "app" || item.action?.type === "plugin",
    ) ||
    /浏览器|browser|应用与 hooks/i.test(panel.title)
  ) {
    return "web";
  }
  if (/侧边聊天|side chat/i.test(panel.title)) {
    return "sidechat";
  }
  if (/审查|改动|review|changes/i.test(panel.title)) {
    return "review";
  }
  return null;
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
  const activeToolId = capabilityPanelToolId(panel);

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
    <div className="capability-dock">
      <div
        aria-label={locale === "zh" ? "工作区工具" : "Workspace tools"}
        className="capability-tool-tabs"
        role="toolbar"
      >
        <CapabilityToolBar
          activeToolId={activeToolId}
          locale={locale}
          disabled={disabled}
          busyToolId={busyToolId}
          onToolClick={handleToolClick}
        />
      </div>
      <div className="capability-dock-content">
        {panel ? (
          <CapabilityResultPanel
            locale={locale}
            disabled={disabled}
            busyToolId={busyToolId}
            commandValue={commandValue}
            panel={panel}
            onCommandChange={onCommandChange}
            onCommandSubmit={onCommandSubmit}
            onPanelAction={onPanelAction}
            onPanelFieldChange={onPanelFieldChange}
            onPanelItem={onPanelItem}
          />
        ) : (
          <div className="command-capability-sidebar-empty">
            <strong>
              {locale === "zh"
                ? "选择一个工作区工具"
                : "Choose a workspace tool"}
            </strong>
            <p>
              {locale === "zh"
                ? "审查改动、运行命令、浏览文件，或打开浏览器与侧边聊天。"
                : "Review changes, run commands, browse files, or open browser and side chat."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
