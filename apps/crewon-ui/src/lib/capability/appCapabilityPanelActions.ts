import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "./capabilityPanelTypes";
import type { LibraryPanel } from "../domain/crewonDomain";
import { pathBaseName } from "../shared/pathUtils";
import { updatePanelFieldValue } from "../shared/panelState";

export function openPluginPathFromPanelAction(params: {
  openCapabilityPanelItem: (item: CapabilityPanelItem) => void | Promise<void>;
  path: string;
}): void {
  void params.openCapabilityPanelItem({
    label: pathBaseName(params.path),
    path: params.path,
    kind: "directory",
  });
}

type PanelFieldUpdater<Panel extends object> = (
  updater: (currentPanel: Panel | null) => Panel | null,
) => void;

export function updateCapabilityPanelFieldAction(params: {
  fieldId: string;
  setCapabilityPanel: PanelFieldUpdater<CapabilityPanel>;
  setLibraryPanel: PanelFieldUpdater<LibraryPanel>;
  value: string;
}): void {
  params.setCapabilityPanel((currentPanel) =>
    updatePanelFieldValue(currentPanel, params.fieldId, params.value),
  );
  params.setLibraryPanel((currentPanel) =>
    updatePanelFieldValue(currentPanel, params.fieldId, params.value),
  );
}
