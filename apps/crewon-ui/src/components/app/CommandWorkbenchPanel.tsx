import { SlidersHorizontal } from "lucide-react";

import { CapabilityResultPanel } from "../CapabilityResultPanel";
import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../lib/i18n";

/**
 * Renders panels that do not belong to a dedicated workbench tool: approval
 * requests, thread settings, goals, account, model providers, MCP and plugin
 * detail. Without this surface their actions and fields never reach the user.
 */
export function CommandWorkbenchPanel({
  busyToolId,
  commandValue,
  disabled,
  locale,
  panel,
  onCommandChange,
  onCommandSubmit,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
}: {
  busyToolId: ToolId | null;
  commandValue: string;
  disabled: boolean;
  locale: Locale;
  panel: CapabilityPanel | null;
  onCommandChange: (value: string) => void;
  onCommandSubmit: () => void;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onPanelItem: (item: CapabilityPanelItem) => void;
}) {
  if (!panel) {
    return (
      <div className="command-workbench-generic-surface">
        <div className="command-file-empty">
          <SlidersHorizontal aria-hidden="true" />
          <strong>{locale === "zh" ? "没有面板" : "No panel"}</strong>
          <span>
            {locale === "zh"
              ? "后端请求与设置面板会显示在这里"
              : "Backend requests and settings panels appear here"}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="command-workbench-generic-surface">
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
    </div>
  );
}
