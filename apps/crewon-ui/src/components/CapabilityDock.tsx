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
      <CapabilityToolBar
        locale={locale}
        disabled={disabled}
        busyToolId={busyToolId}
        onToolClick={handleToolClick}
      />
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
      ) : null}
    </div>
  );
}
