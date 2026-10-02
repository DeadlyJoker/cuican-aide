import type { PluginUiLease } from "@crewon/contracts/plugins";
import type {
  PluginUiJsonValue,
  PluginUiVerifiedPackage,
} from "./plugin-ui-ports.ts";

export type OpenPluginUiMountCommand = Readonly<{
  pluginId: string;
  contributionId: string;
  expectedSelectionRevision: number;
  expectedPackageDigest: string;
}>;
export type PluginUiMountQuery = Readonly<{ mountRef: string }>;
export type ReadPluginUiAssetQuery = Readonly<{
  mountRef: string;
  path: string;
}>;
export type InvokePluginUiActionCommand = Readonly<{
  mountRef: string;
  action: string;
  input: PluginUiJsonValue;
}>;
export type PluginUiCatalogQuery = Readonly<{
  afterPluginId: string | null;
  limit: number;
}>;
export type PluginUiCatalogItem = PluginUiVerifiedPackage &
  Readonly<{ selectionRevision: number; packageDigest: string }>;
export type PluginUiCatalog = Readonly<{
  plugins: readonly PluginUiCatalogItem[];
  next: string | null;
}>;
export type PluginUiAsset = Readonly<{
  bytes: Uint8Array;
  contentType: string;
}>;
export type ValidatedPluginUiMount = PluginUiLease;
