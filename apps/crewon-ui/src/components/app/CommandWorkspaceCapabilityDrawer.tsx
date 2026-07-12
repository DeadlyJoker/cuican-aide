import { X } from "lucide-react";

import { CapabilityResultPanel } from "../CapabilityResultPanel";
import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../lib/i18n";

export type CommandWorkspaceCapabilityDrawerProps = {
  busyToolId: ToolId | null;
  commandValue: string;
  disabled: boolean;
  locale: Locale;
  open: boolean;
  panel: CapabilityPanel | null;
  onClose: () => void;
  onCommandChange: (value: string) => void;
  onCommandSubmit: () => void;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onPanelItem: (item: CapabilityPanelItem) => void;
};

export function CommandWorkspaceCapabilityDrawer({
  busyToolId,
  commandValue,
  disabled,
  locale,
  open,
  panel,
  onClose,
  onCommandChange,
  onCommandSubmit,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
}: CommandWorkspaceCapabilityDrawerProps) {
  if (!open || !panel) {
    return null;
  }

  return (
    <aside
      aria-label={locale === "zh" ? "任务上下文面板" : "Task context panel"}
      className="command-capability-drawer"
    >
      <button
        aria-label={locale === "zh" ? "关闭上下文面板" : "Close context panel"}
        className="command-capability-drawer-close"
        type="button"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </button>
      <CapabilityResultPanel
        busyToolId={busyToolId}
        commandValue={commandValue}
        disabled={disabled}
        locale={locale}
        panel={panel}
        onCommandChange={onCommandChange}
        onCommandSubmit={onCommandSubmit}
        onPanelAction={onPanelAction}
        onPanelFieldChange={onPanelFieldChange}
        onPanelItem={onPanelItem}
      />
    </aside>
  );
}
