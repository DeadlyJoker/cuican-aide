import type { PluginUiLease } from "@crewon/contracts/plugins";

export const DESKTOP_PLUGIN_UI_VERSION = 1 as const;
export const DESKTOP_PLUGIN_UI_ORIGIN = "crewon-plugin://ui";

/** A private native binding, never an account, credential or configurable proxy URL. */
export type DesktopPluginUiBinding = Readonly<{
  bindingRef: string;
  entryUrl: string;
  controlOrigin: string;
}>;

/** A deferred renewal confirms the unchanged, still-live lease through Control. */
export type DesktopPluginUiRenewResult =
  | Readonly<{ kind: "renewed"; lease: PluginUiLease }>
  | Readonly<{ kind: "deferred"; lease: PluginUiLease }>;

export interface DesktopPluginUiAssets {
  readonly version: typeof DESKTOP_PLUGIN_UI_VERSION;
  adopt(
    input: Readonly<{ lease: unknown; expectedControlOrigin: string }>,
  ): Promise<DesktopPluginUiBinding>;
  release(bindingRef: string): Promise<void>;
  /** Optional for older version-one preloads; only Main can extend the owned lease. */
  renew?(bindingRef: string): Promise<PluginUiLease>;
  /** Optional on version one; trusted outcomes avoid classifying IPC error strings. */
  renewResult?(bindingRef: string): Promise<DesktopPluginUiRenewResult>;
  invalidate(): Promise<void>;
}

export function desktopPluginUiAssetUrl(
  bindingRef: string,
  path: string,
): string {
  if (
    !/^[a-f0-9]{64}$/u.test(bindingRef) ||
    typeof path !== "string" ||
    new TextEncoder().encode(path).byteLength > 256 ||
    /[\\%:?#\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("desktop_plugin_ui_asset_path_invalid");
  return `${DESKTOP_PLUGIN_UI_ORIGIN}/${bindingRef}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Canonical encoding prevents URL normalization from widening the approved path. */
export function parseDesktopPluginUiAssetUrl(
  input: string,
): Readonly<{ bindingRef: string; path: string }> {
  if (typeof input !== "string" || input.length > 2048)
    throw new Error("desktop_plugin_ui_asset_url_invalid");
  const match = /^crewon-plugin:\/\/ui\/([a-f0-9]{64})\/(.+)$/u.exec(input);
  if (!match) throw new Error("desktop_plugin_ui_asset_url_invalid");
  let path: string;
  try {
    path = match[2].split("/").map(decodeURIComponent).join("/");
  } catch {
    throw new Error("desktop_plugin_ui_asset_url_invalid");
  }
  if (desktopPluginUiAssetUrl(match[1], path) !== input)
    throw new Error("desktop_plugin_ui_asset_url_invalid");
  return Object.freeze({ bindingRef: match[1], path });
}
