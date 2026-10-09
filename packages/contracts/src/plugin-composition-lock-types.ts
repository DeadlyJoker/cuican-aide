import type {
  PluginServiceProvision,
  PluginServiceRequirement,
} from "./plugin-package-contract.ts";

export const PLUGIN_COMPOSITION_LOCK_SCHEMA =
  "crewon.plugin-composition-lock.v1";
export const PLUGIN_COMPOSITION_LOCK_LIMITS = Object.freeze({
  bytes: 512 * 1024,
  jsonNodes: 65536,
  plugins: 64,
  hostServices: 1024,
  servicesPerPlugin: 64,
});
export type PluginCompositionScope = Readonly<{
  tenantId: string;
  spaceId: string;
  profileId: string;
  authorityEpoch: string;
}>;
export type PluginCompositionNode = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  hostApi: "crewon.plugin-host.v1";
  selectionRevision: number;
  requires: readonly PluginServiceRequirement[];
  provides: readonly PluginServiceProvision[];
}>;
export type PluginCompositionHostService = Readonly<{
  service: string;
  apiVersion: string;
  implementationId: string;
  implementationRevision: number;
}>;
export type PluginCompositionEdge = Readonly<{
  consumerPluginId: string;
  service: string;
  apiVersion: string;
  provider:
    | Readonly<{ kind: "plugin"; pluginId: string; packageDigest: string }>
    | Readonly<{
        kind: "host";
        implementationId: string;
        implementationRevision: number;
      }>
    | Readonly<{ kind: "absent" }>;
}>;
export type PluginCompositionLockBody = Readonly<{
  schemaVersion: typeof PLUGIN_COMPOSITION_LOCK_SCHEMA;
  scope: PluginCompositionScope;
  revision: number;
  nodes: readonly PluginCompositionNode[];
  hostServices: readonly PluginCompositionHostService[];
  edges: readonly PluginCompositionEdge[];
}>;
export type PluginCompositionLock = PluginCompositionLockBody &
  Readonly<{ lockDigest: string }>;
export type PluginCompositionDigester = Readonly<{
  sha256(canonicalBody: string): string;
}>;
