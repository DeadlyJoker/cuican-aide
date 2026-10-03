import {
  parsePluginSelectionView,
  type PluginSelectionView,
} from "@crewon/contracts";

/** A local refresh hint only. Discovery and permission always come from the authenticated API. */
export const INSTALLED_PLUGIN_SELECTION_CHANGED =
  "crewon-installed-plugin-selection-changed";

export function notifyInstalledPluginSelectionChanged(
  input?: Readonly<{ pluginId: string; selection?: PluginSelectionView }>,
): void {
  window.dispatchEvent(
    input === undefined
      ? new Event(INSTALLED_PLUGIN_SELECTION_CHANGED)
      : new CustomEvent(INSTALLED_PLUGIN_SELECTION_CHANGED, {
          detail: Object.freeze({
            pluginId: input.pluginId,
            selection:
              input.selection === undefined
                ? null
                : Object.freeze({ ...input.selection }),
          }),
        }),
  );
}

/** A scoped refresh hint, never evidence of a current selection or permission. */
export function installedPluginSelectionChangePluginId(
  event: Event,
): string | null {
  return installedPluginSelectionChange(event)?.pluginId ?? null;
}

export function installedPluginSelectionChange(event: Event): Readonly<{
  pluginId: string;
  selection: PluginSelectionView | null;
}> | null {
  if (
    !(event instanceof CustomEvent) ||
    event.detail === null ||
    typeof event.detail !== "object"
  )
    return null;
  const descriptor = Object.getOwnPropertyDescriptor(event.detail, "pluginId");
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "string"
  )
    return null;
  const selected = Object.getOwnPropertyDescriptor(event.detail, "selection");
  let selection: PluginSelectionView | null = null;
  if (selected && Object.hasOwn(selected, "value") && selected.value !== null) {
    try {
      selection = parsePluginSelectionView(selected.value);
    } catch {
      /* Unverified hints retain legacy conservative invalidation. */
    }
  }
  return Object.freeze({
    pluginId: descriptor.value,
    selection: selection?.pluginId === descriptor.value ? selection : null,
  });
}
