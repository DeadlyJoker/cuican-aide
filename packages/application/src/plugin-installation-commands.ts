import type { PluginSelectionResult } from "./plugin-installation-store-port.ts";

export type InstallPluginPackageCommand = Readonly<{
  sourceId: string;
  expectedPluginId: string;
  expectedPackageDigest: string;
  expectedSelectionRevision: number | null;
  idempotencyKey: string;
}>;
export type SelectPluginPackageCommand = Readonly<{
  pluginId: string;
  state: "enabled" | "disabled" | "uninstalled";
  selectedPackageDigest: string | null;
  expectedSelectionRevision: number;
  idempotencyKey: string;
}>;
export type GetInstalledPluginPackageQuery = Readonly<{
  packageDigest: string;
}>;
export type GetPluginSelectionQuery = Readonly<{ pluginId: string }>;
export type ListInstalledPluginPackagesQuery = Readonly<{
  pluginId: string | null;
  afterPackageDigest: string | null;
  limit: number;
}>;
export type ListPluginSelectionsQuery = Readonly<{
  afterPluginId: string | null;
  limit: number;
}>;
export type PluginInstallationProjection =
  | Readonly<{ outcome: "applied" | "unchanged" }>
  | Readonly<{ outcome: "pending"; reasonCode: "plugin_projection_pending" }>;
export type SelectPluginPackageResult = Readonly<{
  mutation: PluginSelectionResult;
  projection: PluginInstallationProjection;
}>;
