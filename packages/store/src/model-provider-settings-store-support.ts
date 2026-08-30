import {
  RunStoreError,
  type AbortModelProviderSettingsInput,
  type FinalizeModelProviderSettingsInput,
  type ExpireModelProviderSettingsInput,
  type ModelProviderCredentialKind,
  type ModelProviderSetting,
  type ModelProviderSettingsCatalog,
  type ModelProviderSettingsMutationActor,
  type PendingModelProviderSettings,
  type PrepareModelProviderSettingsInput,
} from "@crewon/application";

const MAX_BINDINGS = 128;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_PREPARE_WINDOW_MS = 5 * 60 * 1_000;

export type StoredModelProviderSettingsOperation = Readonly<{
  pending: PendingModelProviderSettings;
  baseCatalog: ModelProviderSettingsCatalog | null;
  preparedBy: ModelProviderSettingsMutationActor;
}>;

export function modelProviderSettingsOperation(
  pending: PendingModelProviderSettings,
  baseCatalog: ModelProviderSettingsCatalog | null,
  preparedBy: ModelProviderSettingsMutationActor,
): StoredModelProviderSettingsOperation {
  return { pending, baseCatalog, preparedBy };
}

export function parseStoredModelProviderSettingsOperation(
  value: unknown,
  tenantId: string,
): StoredModelProviderSettingsOperation {
  if (!objectWithExactKeys(value, ["baseCatalog", "pending", "preparedBy"])) {
    throw invalidStoredState();
  }
  const pending = parseStoredPendingModelProviderSettings(
    value.pending,
    tenantId,
  );
  const baseCatalog =
    value.baseCatalog === null
      ? null
      : parseStoredModelProviderSettings(value.baseCatalog, tenantId);
  if ((baseCatalog?.revision ?? 0) !== pending.baseRevision) {
    throw invalidStoredState();
  }
  const preparedBy = parseStoredMutationActor(value.preparedBy);
  return { pending, baseCatalog, preparedBy };
}

export function validateFinalizedModelProviderSettingsOperation(
  operation: StoredModelProviderSettingsOperation,
  catalog: ModelProviderSettingsCatalog,
): void {
  if (
    catalog.tenantId !== operation.pending.tenantId ||
    catalog.revision !== operation.pending.baseRevision + 1 ||
    catalog.activeProviderId !== operation.pending.activeProviderId ||
    catalog.runtimeBindingId !== operation.pending.runtimeBindingId ||
    JSON.stringify(catalog.bindings) !==
      JSON.stringify(operation.pending.bindings) ||
    catalog.updatedAt === null ||
    Date.parse(catalog.updatedAt) < Date.parse(operation.pending.preparedAt) ||
    Date.parse(catalog.updatedAt) > Date.parse(operation.pending.expiresAt)
  ) {
    throw invalidStoredState();
  }
}

export function validateAbortedModelProviderSettingsOperation(
  operation: StoredModelProviderSettingsOperation,
  catalog: ModelProviderSettingsCatalog | null,
): void {
  if (JSON.stringify(catalog) !== JSON.stringify(operation.baseCatalog)) {
    throw invalidStoredState();
  }
}

export function validatePrepareModelProviderSettingsInput(
  value: PrepareModelProviderSettingsInput,
): PrepareModelProviderSettingsInput {
  if (
    !objectWithExactKeys(value, [
      "activeProviderId",
      "actor",
      "bindings",
      "coordinatorBinding",
      "expectedRevision",
      "fingerprint",
      "idempotencyKey",
      "operationId",
      "tenantId",
      "ttlMs",
    ]) ||
    !validMutationIdentity(value) ||
    !validMutationActor(value.actor) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    !Number.isSafeInteger(value.ttlMs) ||
    value.ttlMs < 1 ||
    value.ttlMs > MAX_PREPARE_WINDOW_MS ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > MAX_BINDINGS
  ) {
    throw invalidInput();
  }
  const bindings = value.bindings.map(parseInputBinding);
  validateActiveBinding(value.activeProviderId, bindings, invalidInput);
  return {
    tenantId: value.tenantId,
    operationId: value.operationId,
    coordinatorBinding: value.coordinatorBinding,
    expectedRevision: value.expectedRevision,
    activeProviderId: value.activeProviderId,
    bindings,
    idempotencyKey: value.idempotencyKey,
    fingerprint: value.fingerprint,
    actor: parseInputMutationActor(value.actor),
    ttlMs: value.ttlMs,
  };
}

export function validateFinalizeModelProviderSettingsInput(
  value: FinalizeModelProviderSettingsInput,
): FinalizeModelProviderSettingsInput {
  if (
    !objectWithExactKeys(value, [
      "coordinatorBinding",
      "actor",
      "fingerprint",
      "idempotencyKey",
      "operationId",
      "tenantId",
    ]) ||
    !validMutationIdentity(value) ||
    !validMutationActor(value.actor)
  ) {
    throw invalidInput();
  }
  return { ...value };
}

export function validateAbortModelProviderSettingsInput(
  value: AbortModelProviderSettingsInput,
): AbortModelProviderSettingsInput {
  if (
    !objectWithExactKeys(value, [
      "coordinatorBinding",
      "actor",
      "fingerprint",
      "idempotencyKey",
      "operationId",
      "tenantId",
    ]) ||
    !validMutationIdentity(value) ||
    !validMutationActor(value.actor)
  ) {
    throw invalidInput();
  }
  return { ...value };
}

export function validateExpireModelProviderSettingsInput(
  value: ExpireModelProviderSettingsInput,
): ExpireModelProviderSettingsInput {
  if (
    !objectWithExactKeys(value, [
      "fingerprint",
      "actor",
      "idempotencyKey",
      "operationId",
      "recoveryBinding",
      "tenantId",
    ]) ||
    !boundedTrimmed(value.tenantId, 512) ||
    !validMutationActor(value.actor) ||
    !boundedTrimmed(value.operationId, 256) ||
    !boundedTrimmed(value.recoveryBinding, 512) ||
    !boundedTrimmed(value.idempotencyKey, 256) ||
    !FINGERPRINT_PATTERN.test(value.fingerprint)
  ) {
    throw invalidInput();
  }
  return { ...value };
}

export function parseStoredModelProviderSettings(
  value: unknown,
  expectedTenantId: string,
): ModelProviderSettingsCatalog {
  if (
    !objectWithExactKeys(value, [
      "activeProviderId",
      "bindings",
      "revision",
      "runtimeBindingId",
      "tenantId",
      "updatedAt",
    ]) ||
    value.tenantId !== expectedTenantId ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !validTimestamp(value.updatedAt) ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > MAX_BINDINGS
  ) {
    throw invalidStoredState();
  }
  const bindings = value.bindings.map(parseStoredBinding);
  validateActiveBinding(value.activeProviderId, bindings, invalidStoredState);
  validateRuntimeBindingId(
    value.activeProviderId,
    value.runtimeBindingId,
    invalidStoredState,
  );
  return {
    tenantId: expectedTenantId,
    revision: Number(value.revision),
    activeProviderId: value.activeProviderId as string | null,
    runtimeBindingId: value.runtimeBindingId as string | null,
    bindings,
    updatedAt: value.updatedAt,
  };
}

export function parseStoredPendingModelProviderSettings(
  value: unknown,
  expectedTenantId: string,
): PendingModelProviderSettings {
  if (
    !objectWithExactKeys(value, [
      "activeProviderId",
      "baseRevision",
      "bindings",
      "coordinatorBinding",
      "expiresAt",
      "operationId",
      "preparedAt",
      "runtimeBindingId",
      "tenantId",
    ]) ||
    value.tenantId !== expectedTenantId ||
    !boundedTrimmed(value.operationId, 256) ||
    !boundedTrimmed(value.coordinatorBinding, 512) ||
    !Number.isSafeInteger(value.baseRevision) ||
    Number(value.baseRevision) < 0 ||
    !validTimestamp(value.preparedAt) ||
    !validTimestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.preparedAt) ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > MAX_BINDINGS
  ) {
    throw invalidStoredState();
  }
  const bindings = value.bindings.map(parseStoredBinding);
  validateActiveBinding(value.activeProviderId, bindings, invalidStoredState);
  validateRuntimeBindingId(
    value.activeProviderId,
    value.runtimeBindingId,
    invalidStoredState,
  );
  if (
    value.runtimeBindingId !==
    (value.activeProviderId === null ? null : value.coordinatorBinding)
  ) {
    throw invalidStoredState();
  }
  return {
    tenantId: expectedTenantId,
    operationId: value.operationId,
    coordinatorBinding: value.coordinatorBinding,
    baseRevision: Number(value.baseRevision),
    activeProviderId: value.activeProviderId as string | null,
    runtimeBindingId: value.runtimeBindingId as string | null,
    bindings,
    preparedAt: value.preparedAt,
    expiresAt: value.expiresAt,
  };
}

export function providerSettingsReceiptEnvelope(
  phase: "prepare" | "finalize" | "abort" | "expire",
  operationId: string,
  coordinatorBinding: string,
  value: PendingModelProviderSettings | ModelProviderSettingsCatalog | null,
  completedAt: string | null,
  actor: ModelProviderSettingsMutationActor,
): unknown {
  return { phase, operationId, coordinatorBinding, value, completedAt, actor };
}

export function parsePrepareModelProviderSettingsReceipt(
  value: unknown,
  input: PrepareModelProviderSettingsInput,
): PendingModelProviderSettings {
  const { payload, completedAt } = parseReceiptEnvelope(
    value,
    input,
    "prepare",
  );
  if (completedAt !== null) throw invalidStoredState();
  const pending = parseStoredPendingModelProviderSettings(
    payload,
    input.tenantId,
  );
  if (
    pending.baseRevision !== input.expectedRevision ||
    Date.parse(pending.expiresAt) - Date.parse(pending.preparedAt) !==
      input.ttlMs ||
    pending.activeProviderId !== input.activeProviderId ||
    JSON.stringify(pending.bindings) !== JSON.stringify(input.bindings)
  ) {
    throw invalidStoredState();
  }
  return pending;
}

export function parseFinalizeModelProviderSettingsReceipt(
  value: unknown,
  input: FinalizeModelProviderSettingsInput,
): ModelProviderSettingsCatalog {
  const { payload, completedAt } = parseReceiptEnvelope(
    value,
    input,
    "finalize",
  );
  if (!validTimestamp(completedAt)) throw invalidStoredState();
  const catalog = parseStoredModelProviderSettings(payload, input.tenantId);
  if (catalog.updatedAt !== completedAt) throw invalidStoredState();
  return catalog;
}

export function parseAbortModelProviderSettingsReceipt(
  value: unknown,
  input: AbortModelProviderSettingsInput,
): ModelProviderSettingsCatalog | null {
  const { payload, completedAt } = parseReceiptEnvelope(value, input, "abort");
  if (!validTimestamp(completedAt)) throw invalidStoredState();
  return payload === null
    ? null
    : parseStoredModelProviderSettings(payload, input.tenantId);
}

export function parseExpireModelProviderSettingsReceipt(
  value: unknown,
  input: ExpireModelProviderSettingsInput,
): ModelProviderSettingsCatalog | null {
  const { payload, completedAt } = parseReceiptEnvelope(
    value,
    {
      operationId: input.operationId,
      coordinatorBinding: input.recoveryBinding,
      actor: input.actor,
    },
    "expire",
  );
  if (!validTimestamp(completedAt)) throw invalidStoredState();
  return payload === null
    ? null
    : parseStoredModelProviderSettings(payload, input.tenantId);
}

export function validateStoredTerminalModelProviderSettingsOperation(input: {
  operation: StoredModelProviderSettingsOperation;
  status: "finalized" | "aborted" | "expired";
  terminalBinding: string | null;
  completedAt: string | null;
  resultEnvelope: unknown;
}): ModelProviderSettingsCatalog | null {
  const { operation, status, terminalBinding, completedAt, resultEnvelope } =
    input;
  if (terminalBinding === null || !validTimestamp(completedAt)) {
    throw invalidStoredState();
  }
  const expectedBinding =
    status === "expired"
      ? terminalBinding
      : operation.pending.coordinatorBinding;
  if (status !== "expired" && terminalBinding !== expectedBinding) {
    throw invalidStoredState();
  }
  const { payload, completedAt: envelopeCompletedAt } = parseReceiptEnvelope(
    resultEnvelope,
    {
      operationId: operation.pending.operationId,
      coordinatorBinding: expectedBinding,
    },
    status === "finalized"
      ? "finalize"
      : status === "aborted"
        ? "abort"
        : "expire",
  );
  if (
    envelopeCompletedAt !== completedAt ||
    Date.parse(completedAt) < Date.parse(operation.pending.preparedAt) ||
    (status === "expired" &&
      Date.parse(completedAt) < Date.parse(operation.pending.expiresAt))
  ) {
    throw invalidStoredState();
  }
  const catalog =
    payload === null
      ? null
      : parseStoredModelProviderSettings(payload, operation.pending.tenantId);
  if (status === "finalized") {
    if (catalog === null || catalog.updatedAt !== completedAt) {
      throw invalidStoredState();
    }
    validateFinalizedModelProviderSettingsOperation(operation, catalog);
  } else {
    validateAbortedModelProviderSettingsOperation(operation, catalog);
  }
  return catalog;
}

function parseReceiptEnvelope(
  value: unknown,
  input: {
    operationId: string;
    coordinatorBinding: string;
    actor?: ModelProviderSettingsMutationActor;
  },
  phase: "prepare" | "finalize" | "abort" | "expire",
): Readonly<{ payload: unknown; completedAt: string | null }> {
  if (
    !objectWithExactKeys(value, [
      "coordinatorBinding",
      "completedAt",
      "actor",
      "operationId",
      "phase",
      "value",
    ]) ||
    value.phase !== phase ||
    value.operationId !== input.operationId ||
    value.coordinatorBinding !== input.coordinatorBinding
  ) {
    throw invalidStoredState();
  }
  if (
    !validMutationActor(value.actor) ||
    (input.actor !== undefined &&
      (value.actor.principalId !== input.actor.principalId ||
        value.actor.actorId !== input.actor.actorId ||
        value.actor.spaceId !== input.actor.spaceId))
  ) {
    throw invalidStoredState();
  }
  if (value.completedAt !== null && !validTimestamp(value.completedAt)) {
    throw invalidStoredState();
  }
  return { payload: value.value, completedAt: value.completedAt };
}

function validMutationActor(
  value: unknown,
): value is ModelProviderSettingsMutationActor {
  return (
    objectWithExactKeys(value, ["actorId", "principalId", "spaceId"]) &&
    boundedTrimmed(value.principalId, 512) &&
    boundedTrimmed(value.actorId, 512) &&
    boundedTrimmed(value.spaceId, 512)
  );
}

function parseInputMutationActor(
  value: unknown,
): ModelProviderSettingsMutationActor {
  if (!validMutationActor(value)) throw invalidInput();
  return {
    principalId: value.principalId,
    actorId: value.actorId,
    spaceId: value.spaceId,
  };
}

function parseStoredMutationActor(
  value: unknown,
): ModelProviderSettingsMutationActor {
  if (!validMutationActor(value)) throw invalidStoredState();
  return {
    principalId: value.principalId,
    actorId: value.actorId,
    spaceId: value.spaceId,
  };
}

function validMutationIdentity(value: {
  tenantId: unknown;
  operationId: unknown;
  coordinatorBinding: unknown;
  idempotencyKey: unknown;
  fingerprint: unknown;
}): boolean {
  return (
    boundedTrimmed(value.tenantId, 512) &&
    boundedTrimmed(value.operationId, 256) &&
    boundedTrimmed(value.coordinatorBinding, 512) &&
    boundedTrimmed(value.idempotencyKey, 256) &&
    typeof value.fingerprint === "string" &&
    FINGERPRINT_PATTERN.test(value.fingerprint)
  );
}

function parseInputBinding(value: unknown): ModelProviderSetting {
  try {
    return parseBindingValue(value);
  } catch {
    throw invalidInput();
  }
}

function parseStoredBinding(value: unknown): ModelProviderSetting {
  try {
    return parseBindingValue(value);
  } catch {
    throw invalidStoredState();
  }
}

function parseBindingValue(value: unknown): ModelProviderSetting {
  if (
    !objectWithExactKeys(value, [
      "credentialKind",
      "displayName",
      "endpoint",
      "environmentVariable",
      "providerId",
    ]) ||
    !validProviderId(value.providerId) ||
    !boundedTrimmed(value.displayName, 256) ||
    typeof value.endpoint !== "string" ||
    value.endpoint.length > 2_048 ||
    !validEndpoint(value.endpoint) ||
    (value.credentialKind !== "environment" &&
      value.credentialKind !== "keychain" &&
      value.credentialKind !== "none") ||
    !validCredentialEnvironment(value.credentialKind, value.environmentVariable)
  ) {
    throw new Error("invalid");
  }
  return {
    providerId: value.providerId,
    displayName: value.displayName,
    endpoint: value.endpoint,
    credentialKind: value.credentialKind as ModelProviderCredentialKind,
    environmentVariable: value.environmentVariable as string | null,
  };
}

function validCredentialEnvironment(
  credentialKind: unknown,
  environmentVariable: unknown,
): boolean {
  return credentialKind === "environment"
    ? typeof environmentVariable === "string" &&
        environmentVariable.length <= 128 &&
        ENVIRONMENT_VARIABLE_PATTERN.test(environmentVariable)
    : environmentVariable === null;
}

function validateActiveBinding(
  activeProviderId: unknown,
  bindings: readonly ModelProviderSetting[],
  error: () => RunStoreError,
): void {
  const ids = new Set(bindings.map((binding) => binding.providerId));
  if (
    ids.size !== bindings.length ||
    (activeProviderId !== null &&
      (typeof activeProviderId !== "string" || !ids.has(activeProviderId)))
  ) {
    throw error();
  }
}

function validateRuntimeBindingId(
  activeProviderId: unknown,
  runtimeBindingId: unknown,
  invalid: () => RunStoreError,
): void {
  if (
    activeProviderId === null
      ? runtimeBindingId !== null
      : !boundedTrimmed(runtimeBindingId, 512)
  ) {
    throw invalid();
  }
}

function validProviderId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    PROVIDER_ID_PATTERN.test(value)
  );
}

function validEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    const host = endpoint.hostname.toLowerCase();
    const loopback =
      host === "localhost" ||
      host === "[::1]" ||
      host === "::1" ||
      /^127(?:\.\d{1,3}){3}$/u.test(host);
    return (
      (endpoint.protocol === "https:" ||
        (endpoint.protocol === "http:" && loopback)) &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.search === "" &&
      endpoint.hash === ""
    );
  } catch {
    return false;
  }
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    value.endsWith("Z") &&
    Number.isFinite(Date.parse(value))
  );
}

function boundedTrimmed(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function objectWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function invalidInput(): RunStoreError {
  return new RunStoreError("model_provider_settings_input_invalid");
}

function invalidStoredState(): RunStoreError {
  return new RunStoreError("model_provider_settings_stored_state_invalid");
}
