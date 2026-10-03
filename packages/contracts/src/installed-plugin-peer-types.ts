/** Private transport data only. Parsing these DTOs never grants execution authority. */
export const INSTALLED_PLUGIN_PEER_PRIVATE_PATH =
  "/private/v1/installed-plugins";
export const INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL =
  "crewon.installed-plugin-peer-request.v1";
export const INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL =
  "crewon.installed-plugin-peer-response.v1";
export const INSTALLED_PLUGIN_PEER_WIRE_LIMITS = Object.freeze({
  messageBytes: 512 * 1024,
  configurationBytes: 16 * 1024,
  manifestBytes: 64 * 1024,
  sourceBytes: 64 * 1024,
  targetBytes: 4 * 1024,
  entries: 32,
  jsonNodes: 16384,
  jsonDepth: 24,
});

export type InstalledPluginPeerJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly InstalledPluginPeerJsonValue[]
  | InstalledPluginPeerJsonObject;
export type InstalledPluginPeerJsonObject = Readonly<{
  [key: string]: InstalledPluginPeerJsonValue;
}>;
export type InstalledPluginPeerActor = Readonly<{
  principalId: string;
  actorId: string;
  tenantId: string;
  spaceId: string;
}>;
export type InstalledPluginPeerScope = Readonly<{
  tenantId: string;
  spaceId: string;
  profileId: string;
}>;
export type InstalledPluginPeerIdentity = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  manifestDigest: string;
  implementationDigest: string;
}>;
export type InstalledPluginPeerExpectedSource = Readonly<{
  admission: InstalledPluginPeerJsonObject;
  binding: InstalledPluginPeerJsonObject;
  operationId: string;
}>;
export type InstalledPluginPeerRegistration = Readonly<{
  identity: InstalledPluginPeerIdentity;
  manifest: InstalledPluginPeerJsonObject;
}>;
export type InstalledPluginPeerCatalogEntry = InstalledPluginPeerRegistration &
  Readonly<{
    configuration: InstalledPluginPeerJsonObject;
    configuredTarget: InstalledPluginPeerJsonObject;
  }>;
export type InstalledPluginPeerUnavailableReason =
  | "extension_runtime_unavailable"
  | "extension_implementation_unavailable"
  | "extension_credential_unavailable"
  | "extension_execution_authority_unsupported";
export type InstalledPluginPeerReadinessResult =
  | Readonly<{
      outcome: "ready";
      target: InstalledPluginPeerJsonObject;
    }>
  | Readonly<{
      outcome: "unavailable";
      reasonCode: InstalledPluginPeerUnavailableReason;
    }>;
type Common = Readonly<{
  requestId: string;
  actor: InstalledPluginPeerActor;
  scope: InstalledPluginPeerScope;
}>;
type ConfigurationRequest = Readonly<{
  identity: InstalledPluginPeerIdentity;
  configuration: InstalledPluginPeerJsonObject;
}>;
type ReadinessRequest = ConfigurationRequest &
  Readonly<{ expectedTarget: InstalledPluginPeerJsonObject }>;
export type InstalledPluginPeerRequest = Common &
  Readonly<{ protocol: typeof INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL }> &
  (
    | Readonly<{ operation: "catalog" }>
    | (ConfigurationRequest & Readonly<{ operation: "validateConfiguration" }>)
    | (ReadinessRequest & Readonly<{ operation: "readiness" }>)
    | Readonly<{
        operation: "queryResolveRegistration";
        expectedSource: InstalledPluginPeerExpectedSource;
      }>
    | (ReadinessRequest &
        Readonly<{
          operation: "queryReadiness";
          expectedSource: InstalledPluginPeerExpectedSource;
        }>)
  );
type ConfigurationResponse = Readonly<{
  identity: InstalledPluginPeerIdentity;
  configurationDigest: string;
}>;
type ReadinessResponse = ConfigurationResponse &
  Readonly<{
    expectedTarget: InstalledPluginPeerJsonObject;
    result: InstalledPluginPeerReadinessResult;
  }>;
export type InstalledPluginPeerResponse = Common &
  Readonly<{ protocol: typeof INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL }> &
  (
    | Readonly<{
        operation: "catalog";
        entries: readonly InstalledPluginPeerCatalogEntry[];
      }>
    | (ConfigurationResponse & Readonly<{ operation: "validateConfiguration" }>)
    | (ReadinessResponse & Readonly<{ operation: "readiness" }>)
    | Readonly<{
        operation: "queryResolveRegistration";
        expectedSource: InstalledPluginPeerExpectedSource;
        registration: InstalledPluginPeerRegistration | null;
      }>
    | (ReadinessResponse &
        Readonly<{
          operation: "queryReadiness";
          expectedSource: InstalledPluginPeerExpectedSource;
        }>)
  );
