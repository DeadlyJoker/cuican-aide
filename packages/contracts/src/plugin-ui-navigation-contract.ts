import {
  parsePluginUiJsonValue,
  pluginUiFailure,
  type PluginUiJsonValue,
} from "./plugin-ui-json.ts";

export const PLUGIN_UI_NAVIGATION_SERVICE = "crewon.plugin-navigation";
export const PLUGIN_UI_NAVIGATION_API_VERSION = "1";
export const PLUGIN_UI_NAVIGATION_ACTIONS = Object.freeze({
  openPage: "crewon.plugin-navigation.open-page",
  activatePage: "crewon.plugin-navigation.activate-page",
  closePage: "crewon.plugin-navigation.close-page",
  toggleWorkbench: "crewon.plugin-navigation.toggle-workbench",
  listPages: "crewon.plugin-navigation.list-pages",
} as const);
export type PluginUiNavigationRequest =
  | Readonly<{
      action: typeof PLUGIN_UI_NAVIGATION_ACTIONS.openPage;
      input: Readonly<{
        contributionId: string;
        key: string;
        title: string;
        mode: "reuse" | "new";
        context: PluginUiJsonValue;
      }>;
    }>
  | Readonly<{
      action:
        | typeof PLUGIN_UI_NAVIGATION_ACTIONS.activatePage
        | typeof PLUGIN_UI_NAVIGATION_ACTIONS.closePage;
      input: Readonly<{ pageId: string }>;
    }>
  | Readonly<{
      action: typeof PLUGIN_UI_NAVIGATION_ACTIONS.toggleWorkbench;
      input: Readonly<{ state: "open" | "closed" }>;
    }>
  | Readonly<{
      action: typeof PLUGIN_UI_NAVIGATION_ACTIONS.listPages;
      input: Readonly<Record<string, never>>;
    }>;

/** Presentation only. Package/profile identity is supplied by the genuine mounted host, never by this request. */
export function parsePluginUiNavigationRequest(
  action: unknown,
  input: unknown,
): PluginUiNavigationRequest {
  const value = record(parsePluginUiJsonValue(input, { maxBytes: 16384 }));
  switch (action) {
    case PLUGIN_UI_NAVIGATION_ACTIONS.openPage:
      exact(value, ["contributionId", "key", "title", "mode", "context"]);
      if (value.mode !== "reuse" && value.mode !== "new") invalid();
      return Object.freeze({
        action,
        input: Object.freeze({
          contributionId: id(value.contributionId),
          key: id(value.key),
          title: title(value.title),
          mode: value.mode,
          context: parsePluginUiJsonValue(value.context, { maxBytes: 8192 }),
        }),
      });
    case PLUGIN_UI_NAVIGATION_ACTIONS.activatePage:
    case PLUGIN_UI_NAVIGATION_ACTIONS.closePage:
      exact(value, ["pageId"]);
      return Object.freeze({
        action,
        input: Object.freeze({ pageId: id(value.pageId) }),
      });
    case PLUGIN_UI_NAVIGATION_ACTIONS.toggleWorkbench:
      exact(value, ["state"]);
      if (value.state !== "open" && value.state !== "closed") invalid();
      return Object.freeze({
        action,
        input: Object.freeze({ state: value.state }),
      });
    case PLUGIN_UI_NAVIGATION_ACTIONS.listPages:
      exact(value, []);
      return Object.freeze({ action, input: Object.freeze({}) });
    default:
      invalid();
  }
}
export function isPluginUiNavigationAction(action: string): boolean {
  return action.startsWith("crewon.plugin-navigation.");
}
function record(
  value: PluginUiJsonValue,
): Readonly<Record<string, PluginUiJsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  return value as Readonly<Record<string, PluginUiJsonValue>>;
}
function exact(
  value: Readonly<Record<string, PluginUiJsonValue>>,
  keys: readonly string[],
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  )
    invalid();
}
function id(value: PluginUiJsonValue): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  )
    invalid();
  return value;
}
function title(value: PluginUiJsonValue): string {
  const v = id(value);
  if (Array.from(v).length > 160) invalid();
  return v;
}
function invalid(): never {
  return pluginUiFailure("plugin_ui_navigation_request_invalid");
}
