import { CapabilityDock } from "../CapabilityDock";
import type { AppView } from "../../lib/shared/appView";
import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../lib/i18n";

type AppWorkspaceSidePanelsProps = {
  appView: AppView;
  busyToolId: ToolId | null;
  capabilityDockOpen: boolean;
  capabilityPanel: CapabilityPanel | null;
  disabled: boolean;
  locale: Locale;
  onPanelAction: (actionId: string) => void;
  onPanelFieldChange: (fieldId: string, value: string) => void;
  onPanelItem: (item: CapabilityPanelItem) => void;
};

export function AppWorkspaceSidePanels({
  appView,
  busyToolId,
  capabilityDockOpen,
  capabilityPanel,
  disabled,
  locale,
  onPanelAction,
  onPanelFieldChange,
  onPanelItem,
}: AppWorkspaceSidePanelsProps) {
  const showCapabilityDock =
    capabilityDockOpen && capabilityPanel && appView !== "settings";

  return (
    <>
      {showCapabilityDock ? (
        <aside
          className="right-sidebar"
          aria-label={locale === "zh" ? "右栏" : "Right sidebar"}
        >
          <CapabilityDock
            locale={locale}
            disabled={disabled}
            busyToolId={busyToolId}
            panel={capabilityPanel}
            onPanelAction={onPanelAction}
            onPanelFieldChange={onPanelFieldChange}
            onPanelItem={onPanelItem}
          />
        </aside>
      ) : null}
    </>
  );
}
