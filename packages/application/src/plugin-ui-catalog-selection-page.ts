import type { PluginProfileScope } from "@crewon/domain";
import {
  uiOutput,
  uiRecord,
  uiSelection,
  type uiCatalogQuery,
} from "./plugin-ui-application-support.ts";

/** Bounded, ordered selection page validation; no execution or UI authority. */
export function uiCatalogSelectionPage(
  raw: unknown,
  scope: PluginProfileScope,
  query: ReturnType<typeof uiCatalogQuery>,
) {
  return uiOutput(() => {
    const value = uiRecord(raw, ["selections", "next"]);
    if (
      !Array.isArray(value.selections) ||
      Object.getPrototypeOf(value.selections) !== Array.prototype ||
      value.selections.length > query.limit ||
      Reflect.ownKeys(value.selections).length !== value.selections.length + 1
    )
      throw new Error("plugin_ui_page_invalid");
    const selections = Array.from(
      { length: value.selections.length },
      (_, index) => {
        const item = Object.getOwnPropertyDescriptor(
          value.selections,
          String(index),
        );
        if (!item || !Object.hasOwn(item, "value") || !item.enumerable)
          throw new Error("plugin_ui_page_invalid");
        const parsed = uiSelection(
          item.value,
          scope,
          uiOutput(() => {
            const id = Object.getOwnPropertyDescriptor(item.value, "pluginId");
            if (!id || !Object.hasOwn(id, "value"))
              throw new Error("plugin_ui_page_invalid");
            return id.value;
          }),
        );
        return parsed;
      },
    );
    let previous = query.afterPluginId;
    for (const selection of selections) {
      if (previous !== null && selection.pluginId <= previous)
        throw new Error("plugin_ui_page_order_invalid");
      previous = selection.pluginId;
    }
    if (
      value.next !== null &&
      (selections.length !== query.limit || value.next !== previous)
    )
      throw new Error("plugin_ui_page_cursor_invalid");
    return { selections, next: value.next as string | null };
  });
}
