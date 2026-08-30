import type { CapabilityPanel, CapabilityPanelItem } from "./capabilityPanelTypes";
import type { LibraryPanel } from "../domain/crewonDomain";
import { pathBaseName } from "../shared/pathUtils";
import { trimmedPanelFieldValue, updatePanelFieldValue } from "../shared/panelState";
import type { SettingsSaveAction } from "../settings/settingsActions";
import {
  createSettingsSaveHandlers,
  type SettingsSaveHandlersParams,
} from "../settings/settingsSaveActions";
export { createSettingsRefreshHandlers } from "../settings/settingsRefreshHandlers";

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

export function createAppSettingsSaveHandlers(
  params: Omit<SettingsSaveHandlersParams, "fieldValue"> & {
    capabilityPanel: CapabilityPanel | null;
  },
): Record<SettingsSaveAction, () => void> {
  return createSettingsSaveHandlers({
    ...params,
    fieldValue: (fieldId) =>
      trimmedPanelFieldValue(params.capabilityPanel, fieldId),
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
