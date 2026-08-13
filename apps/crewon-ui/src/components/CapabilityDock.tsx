import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../lib/i18n";
import { CapabilityResultPanel } from "./CapabilityResultPanel";

type CapabilityDockProps = {
  locale: Locale;
  disabled?: boolean;
  busyToolId?: ToolId | null;
  panel?: CapabilityPanel | null;
  onPanelAction?: (actionId: string) => void;
  onPanelFieldChange?: (fieldId: string, value: string) => void;
  onPanelItem?: (item: CapabilityPanelItem) => void;
};

export function CapabilityDock({
  locale,
  disabled = false,
  busyToolId = null,
  panel = null,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
}: CapabilityDockProps) {
  const visiblePanel =
    panel &&
    !panel.commandInput &&
    !panel.items?.some((item) => item.action?.type === "background-terminal") &&
    !/终端|terminal/i.test(panel.title)
      ? panel
      : null;

  return (
    <div className="capability-dock">
      <div className="capability-dock-content">
        {visiblePanel ? (
          <CapabilityResultPanel
            locale={locale}
            disabled={disabled}
            busyToolId={busyToolId}
            commandValue=""
            panel={visiblePanel}
            onPanelAction={onPanelAction}
            onPanelFieldChange={onPanelFieldChange}
            onPanelItem={onPanelItem}
          />
        ) : (
          <div className="command-capability-sidebar-empty">
            <strong>
              {locale === "zh"
                ? "没有可用面板"
                : "No available panel"}
            </strong>
            <p>
              {locale === "zh"
                ? "此处只显示当前可操作的请求。"
                : "Only actionable requests appear here."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
