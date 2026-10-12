import {
  parsePluginUiNavigationRequest,
  PLUGIN_UI_NAVIGATION_ACTIONS,
} from "./contracts.js";
import type { PluginJsonValue } from "./sdk-types.js";
import type {
  PluginUiServices,
  PluginUiInvocationOptions,
} from "./ui-types.js";

/** Routes display requests through the current leased UI transport; it exposes no host session or workspace authority. */
export function createPluginUiNavigationClient(services: PluginUiServices) {
  const invoke = (
    action: string,
    input: PluginJsonValue,
    options: PluginUiInvocationOptions = {},
  ) => {
    options.signal?.throwIfAborted();
    const parsed = parsePluginUiNavigationRequest(action, input);
    return services.invoke(
      parsed.action,
      parsed.input as PluginJsonValue,
      options,
    );
  };
  return Object.freeze({
    openPage(
      input: Readonly<{
        contributionId: string;
        key: string;
        title: string;
        mode: "reuse" | "new";
        context: PluginJsonValue;
      }>,
      options?: PluginUiInvocationOptions,
    ) {
      return invoke(PLUGIN_UI_NAVIGATION_ACTIONS.openPage, input, options);
    },
    activatePage(pageId: string, options?: PluginUiInvocationOptions) {
      return invoke(
        PLUGIN_UI_NAVIGATION_ACTIONS.activatePage,
        { pageId },
        options,
      );
    },
    closePage(pageId: string, options?: PluginUiInvocationOptions) {
      return invoke(
        PLUGIN_UI_NAVIGATION_ACTIONS.closePage,
        { pageId },
        options,
      );
    },
    toggleWorkbench(
      state: "open" | "closed",
      options?: PluginUiInvocationOptions,
    ) {
      return invoke(
        PLUGIN_UI_NAVIGATION_ACTIONS.toggleWorkbench,
        { state },
        options,
      );
    },
    listPages(options?: PluginUiInvocationOptions) {
      return invoke(PLUGIN_UI_NAVIGATION_ACTIONS.listPages, {}, options);
    },
  });
}
