/** A local refresh hint only. Discovery and permission always come from the authenticated API. */
export const INSTALLED_PLUGIN_SELECTION_CHANGED =
  "crewon-installed-plugin-selection-changed";

export function notifyInstalledPluginSelectionChanged(): void {
  window.dispatchEvent(new Event(INSTALLED_PLUGIN_SELECTION_CHANGED));
}
