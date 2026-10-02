import type { PluginUiTheme } from "@crewon/plugin-sdk/ui";
import type { Theme } from "../../lib/theme";

const HOST_THEME_TOKENS = [
  "--bg",
  "--surface",
  "--surface-raised",
  "--border",
  "--border-strong",
  "--text",
  "--text-muted",
  "--text-faint",
  "--accent",
  "--accent-soft",
  "--focus",
  "--warning",
  "--success",
  "--danger",
  "--radius-md",
  "--radius-lg",
  "--control-h-md",
  "--user-ui-font",
  "--user-ui-font-size",
] as const;

/** Reads the appearance already painted by the host. No plugin changes the document's theme. */
export function readPluginUiTheme(
  root: HTMLElement,
  fallback: Theme,
): PluginUiTheme {
  const painted = root.dataset.theme;
  const style = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const name of HOST_THEME_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value.length > 0 && value.length <= 2048) tokens[name] = value;
  }
  return Object.freeze({
    mode: painted === "light" || painted === "dark" ? painted : fallback,
    tokens: Object.freeze(tokens),
  });
}
