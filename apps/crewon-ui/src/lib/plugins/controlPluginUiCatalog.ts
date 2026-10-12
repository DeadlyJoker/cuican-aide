import type { ControlApiClient } from "@crewon/control-client";
import {
  parsePluginUiCatalogResponse,
  type PluginUiCatalogItem,
} from "@crewon/contracts";
import type {
  PluginNavigationIcon,
  PluginUiSurface,
} from "@crewon/contracts/plugins";
import { uiFailure } from "./pluginUiValidation";
import {
  assertPluginUiCurrent,
  pluginUiControlRequest,
  type PluginUiCurrentScope,
} from "./controlPluginUiSupport";

export const CONTROL_PLUGIN_UI_CATALOG_LIMITS = Object.freeze({
  pages: 16,
  plugins: 128,
  modules: 256,
  bytes: 16 * 1024 * 1024,
});
export type ControlPluginUiModule = Readonly<{
  key: string;
  mountKey: string;
  title: string;
  icon?: PluginNavigationIcon;
  surfaces?: readonly PluginUiSurface[];
  contributionId: string;
  plugin: PluginUiCatalogItem;
}>;
export type ControlPluginUiCatalog = Readonly<{
  plugins: readonly PluginUiCatalogItem[];
  modules: readonly ControlPluginUiModule[];
  fingerprint: string;
}>;

/** One bounded snapshot. The host owns refresh scheduling and immediately withdraws it when its client/session changes. */
export async function readControlPluginUiCatalog(
  options: Readonly<{
    client: ControlApiClient;
    assertCurrent: PluginUiCurrentScope;
    signal: AbortSignal;
  }>,
): Promise<ControlPluginUiCatalog> {
  const plugins: PluginUiCatalogItem[] = [];
  const modules: ControlPluginUiModule[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let afterPluginId: string | null = null;
  let bytes = 0;
  for (
    let pageIndex = 0;
    pageIndex < CONTROL_PLUGIN_UI_CATALOG_LIMITS.pages;
    pageIndex++
  ) {
    assertPluginUiCurrent(options.assertCurrent, options.signal);
    const query = { afterPluginId, limit: 50 };
    const response = await pluginUiControlRequest(
      (signal) => options.client.plugins.uiCatalog(query, { signal }),
      options.signal,
    );
    assertPluginUiCurrent(options.assertCurrent, options.signal);
    const page = parsePluginUiCatalogResponse(response, query);
    bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
    if (bytes > CONTROL_PLUGIN_UI_CATALOG_LIMITS.bytes)
      uiFailure("plugin_ui_catalog_byte_limit");
    for (const plugin of page.plugins) {
      const pluginId = plugin.descriptor.pluginId;
      if (ids.has(pluginId)) uiFailure("plugin_ui_catalog_identity_duplicate");
      ids.add(pluginId);
      plugins.push(plugin);
      if (plugins.length > CONTROL_PLUGIN_UI_CATALOG_LIMITS.plugins)
        uiFailure("plugin_ui_catalog_plugin_limit");
      for (const contribution of plugin.descriptor.contributions) {
        if (
          contribution.kind !== "module" ||
          contribution.slot !== "main.content"
        )
          continue;
        const key = JSON.stringify([pluginId, contribution.id]);
        modules.push(
          Object.freeze({
            key,
            mountKey: JSON.stringify([
              pluginId,
              contribution.id,
              plugin.selectionRevision,
              plugin.packageDigest,
            ]),
            title: contribution.title,
            ...(contribution.icon ? { icon: contribution.icon } : {}),
            ...(contribution.surfaces
              ? { surfaces: contribution.surfaces }
              : {}),
            contributionId: contribution.id,
            plugin,
          }),
        );
        if (modules.length > CONTROL_PLUGIN_UI_CATALOG_LIMITS.modules)
          uiFailure("plugin_ui_catalog_module_limit");
      }
    }
    if (page.next === null) {
      assertPluginUiCurrent(options.assertCurrent, options.signal);
      return Object.freeze({
        plugins: Object.freeze(plugins),
        modules: Object.freeze(modules),
        fingerprint: JSON.stringify(plugins),
      });
    }
    if (cursors.has(page.next)) uiFailure("plugin_ui_catalog_cursor_duplicate");
    cursors.add(page.next);
    afterPluginId = page.next;
  }
  return uiFailure("plugin_ui_catalog_page_limit");
}
