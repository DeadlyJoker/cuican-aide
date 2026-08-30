export type ModelProviderCredentialKind = "environment" | "keychain" | "none";

export type ModelProviderSetting = Readonly<{
  providerId: string;
  displayName: string;
  endpoint: string;
  credentialKind: ModelProviderCredentialKind;
  environmentVariable: string | null;
}>;

export type ModelProviderSettingsCatalog = Readonly<{
  tenantId: string;
  revision: number;
  activeProviderId: string | null;
  runtimeBindingId: string | null;
  bindings: readonly ModelProviderSetting[];
  updatedAt: string | null;
}>;

export type PendingModelProviderSettings = Readonly<{
  tenantId: string;
  operationId: string;
  coordinatorBinding: string;
  baseRevision: number;
  activeProviderId: string | null;
  runtimeBindingId: string | null;
  bindings: readonly ModelProviderSetting[];
  preparedAt: string;
  expiresAt: string;
}>;

export type ModelProviderSettingsState = Readonly<{
  catalog: ModelProviderSettingsCatalog | null;
  pending: PendingModelProviderSettings | null;
}>;

export type ModelProviderSettingsMutationActor = Readonly<{
  principalId: string;
  actorId: string;
  spaceId: string;
}>;

type ModelProviderSettingsMutationIdentity = Readonly<{
  tenantId: string;
  operationId: string;
  coordinatorBinding: string;
  idempotencyKey: string;
  fingerprint: string;
  actor: ModelProviderSettingsMutationActor;
}>;

export type PrepareModelProviderSettingsInput =
  ModelProviderSettingsMutationIdentity &
    Readonly<{
      expectedRevision: number;
      activeProviderId: string | null;
      bindings: readonly ModelProviderSetting[];
      ttlMs: number;
    }>;

export type FinalizeModelProviderSettingsInput =
  ModelProviderSettingsMutationIdentity;

export type AbortModelProviderSettingsInput =
  ModelProviderSettingsMutationIdentity;

export type ExpireModelProviderSettingsInput = Readonly<{
  tenantId: string;
  operationId: string;
  recoveryBinding: string;
  idempotencyKey: string;
  fingerprint: string;
  actor: ModelProviderSettingsMutationActor;
}>;

export type PrepareModelProviderSettingsResult = Readonly<{
  disposition: "prepared" | "replayed";
  pending: PendingModelProviderSettings;
}>;

export type FinalizeModelProviderSettingsResult = Readonly<{
  disposition: "finalized" | "replayed";
  catalog: ModelProviderSettingsCatalog;
}>;

export type AbortModelProviderSettingsResult = Readonly<{
  disposition: "aborted" | "replayed";
  catalog: ModelProviderSettingsCatalog | null;
}>;

export type ExpireModelProviderSettingsResult = Readonly<{
  disposition: "expired" | "replayed";
  catalog: ModelProviderSettingsCatalog | null;
}>;

/** Durable, tenant-scoped authority for non-secret model Provider settings. */
export interface ModelProviderSettingsStore {
  loadModelProviderSettingsState(input: {
    tenantId: string;
  }): Promise<ModelProviderSettingsState>;

  prepareModelProviderSettings(
    input: PrepareModelProviderSettingsInput,
  ): Promise<PrepareModelProviderSettingsResult>;

  finalizeModelProviderSettings(
    input: FinalizeModelProviderSettingsInput,
  ): Promise<FinalizeModelProviderSettingsResult>;

  abortModelProviderSettings(
    input: AbortModelProviderSettingsInput,
  ): Promise<AbortModelProviderSettingsResult>;

  expireModelProviderSettings(
    input: ExpireModelProviderSettingsInput,
  ): Promise<ExpireModelProviderSettingsResult>;
}
