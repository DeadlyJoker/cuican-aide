import { ApplicationError } from "./application-error.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type {
  ModelProviderSetting,
  ModelProviderSettingsCatalog,
  ModelProviderSettingsState,
  ModelProviderSettingsStore,
} from "./model-provider-settings-store-port.ts";
import { RunStoreError } from "./run-store-port.ts";

const MAX_BINDINGS = 128;
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_PREPARE_WINDOW_MS = 5 * 60 * 1_000;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type PrepareModelProviderSettingsCommand = Readonly<{
  expectedRevision: number;
  activeProviderId: string | null;
  bindings: readonly ModelProviderSetting[];
}>;

export type ModelProviderSettingsCoordination = Readonly<{
  operationId: string;
  coordinatorBinding: string;
  ttlMs: number;
}>;

export type CompleteModelProviderSettingsCommand = Readonly<{
  operationId: string;
  coordinatorBinding: string;
}>;

export type ExpireModelProviderSettingsCommand = Readonly<{
  operationId: string;
  recoveryBinding: string;
}>;

export type ModelProviderSettingsView = Readonly<{
  catalog: ModelProviderSettingsCatalog;
  pending: ModelProviderSettingsState["pending"];
}>;

/** Authorized command/query boundary for the non-secret Provider catalog. */
export class ModelProviderSettingsApplicationService {
  readonly #store: ModelProviderSettingsStore;
  readonly #authorization: AuthorizationPort;
  readonly #digester: ContentDigester;

  constructor(dependencies: {
    store: ModelProviderSettingsStore;
    authorization: AuthorizationPort;
    digester: ContentDigester;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#digester = dependencies.digester;
  }

  async get(actor: ActorContext): Promise<ModelProviderSettingsView> {
    validateActor(actor);
    await this.#authorize(actor, "modelProviderSettings:read");
    return this.#mapStoreError(() => this.#loadView(actor.tenantId));
  }

  async prepare(
    actor: ActorContext,
    command: PrepareModelProviderSettingsCommand,
    coordination: ModelProviderSettingsCoordination,
    idempotencyKey: string,
  ) {
    validateActor(actor);
    validateMutationIdentity(coordination, idempotencyKey);
    const normalized = validatePrepareCommand(command);
    const mutationActor = providerMutationActor(actor);
    await this.#authorize(actor, "modelProviderSettings:write");
    const fingerprint = this.#fingerprint("prepare", actor.tenantId, {
      actor: mutationActor,
      command: normalized,
      coordination,
    });
    return this.#mapStoreError(() =>
      this.#store.prepareModelProviderSettings({
        tenantId: actor.tenantId,
        ...normalized,
        ...coordination,
        idempotencyKey,
        fingerprint,
        actor: mutationActor,
      }),
    );
  }

  async finalize(
    actor: ActorContext,
    command: CompleteModelProviderSettingsCommand,
    idempotencyKey: string,
  ) {
    validateActor(actor);
    validateCompleteCommand(command, idempotencyKey);
    await this.#authorize(actor, "modelProviderSettings:write");
    const mutationActor = providerMutationActor(actor);
    const fingerprint = this.#fingerprint("finalize", actor.tenantId, {
      actor: mutationActor,
      command,
    });
    return this.#mapStoreError(() =>
      this.#store.finalizeModelProviderSettings({
        tenantId: actor.tenantId,
        ...command,
        idempotencyKey,
        fingerprint,
        actor: mutationActor,
      }),
    );
  }

  async abort(
    actor: ActorContext,
    command: CompleteModelProviderSettingsCommand,
    idempotencyKey: string,
  ) {
    validateActor(actor);
    validateCompleteCommand(command, idempotencyKey);
    await this.#authorize(actor, "modelProviderSettings:write");
    const mutationActor = providerMutationActor(actor);
    const fingerprint = this.#fingerprint("abort", actor.tenantId, {
      actor: mutationActor,
      command,
    });
    return this.#mapStoreError(() =>
      this.#store.abortModelProviderSettings({
        tenantId: actor.tenantId,
        ...command,
        idempotencyKey,
        fingerprint,
        actor: mutationActor,
      }),
    );
  }

  async expire(
    actor: ActorContext,
    command: ExpireModelProviderSettingsCommand,
    idempotencyKey: string,
  ) {
    validateActor(actor);
    if (
      !exactKeys(command, ["operationId", "recoveryBinding"]) ||
      !boundedTrimmed(command.operationId, 256) ||
      !boundedTrimmed(command.recoveryBinding, 512) ||
      !boundedTrimmed(idempotencyKey, 256)
    ) {
      throw invalidSettings();
    }
    await this.#authorize(actor, "modelProviderSettings:write");
    const mutationActor = providerMutationActor(actor);
    const fingerprint = this.#fingerprint("expire", actor.tenantId, {
      actor: mutationActor,
      command,
    });
    return this.#mapStoreError(() =>
      this.#store.expireModelProviderSettings({
        tenantId: actor.tenantId,
        ...command,
        idempotencyKey,
        fingerprint,
        actor: mutationActor,
      }),
    );
  }

  async authorizeProbe(
    actor: ActorContext,
  ): Promise<ModelProviderSettingsCatalog> {
    validateActor(actor);
    await this.#authorize(actor, "modelProviderSettings:probe");
    const state = await this.#mapStoreError(() =>
      this.#store.loadModelProviderSettingsState({
        tenantId: actor.tenantId,
      }),
    );
    if (
      state.pending !== null ||
      state.catalog === null ||
      state.catalog.activeProviderId === null ||
      state.catalog.runtimeBindingId === null
    ) {
      throw new ApplicationError(
        "conflict",
        state.pending === null
          ? "model_provider_settings_active_binding_missing"
          : "model_provider_settings_switch_pending",
      );
    }
    return state.catalog;
  }

  async #loadView(tenantId: string): Promise<ModelProviderSettingsView> {
    const state = await this.#store.loadModelProviderSettingsState({
      tenantId,
    });
    return {
      catalog: state.catalog ?? emptyCatalog(tenantId),
      pending: state.pending,
    };
  }

  #fingerprint(phase: string, tenantId: string, value: unknown): string {
    return this.#digester.sha256(canonicalJson({ phase, tenantId, value }));
  }

  async #mapStoreError<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RunStoreError) {
        const category = providerSettingsStoreErrorCategory(error.code);
        throw new ApplicationError(category, error.code, { cause: error });
      }
      throw error;
    }
  }

  async #authorize(
    actor: ActorContext,
    action:
      | "modelProviderSettings:read"
      | "modelProviderSettings:write"
      | "modelProviderSettings:probe",
  ): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action,
        resource: {
          kind: "modelProviderSettings",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
        },
      });
      if (decision.outcome !== "allow") {
        throw new ApplicationError("authorization", "authorization_denied");
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }
}

function providerSettingsStoreErrorCategory(
  code: string,
): ApplicationError["category"] {
  switch (code) {
    case "model_provider_settings_input_invalid":
      return "validation";
    case "model_provider_settings_active_run":
    case "model_provider_settings_idempotency_conflict":
    case "model_provider_settings_operation_expired":
    case "model_provider_settings_operation_mismatch":
    case "model_provider_settings_operation_not_expired":
    case "model_provider_settings_pending":
    case "model_provider_settings_revision_conflict":
    case "model_provider_settings_switch_pending":
      return "conflict";
    case "model_provider_settings_stored_state_invalid":
    default:
      return "internal";
  }
}

function providerMutationActor(actor: ActorContext) {
  return {
    principalId: actor.principalId,
    actorId: actor.actorId,
    spaceId: actor.spaceId,
  };
}

function validatePrepareCommand(
  command: PrepareModelProviderSettingsCommand,
): PrepareModelProviderSettingsCommand {
  if (
    !exactKeys(command, ["activeProviderId", "bindings", "expectedRevision"]) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 0 ||
    !Array.isArray(command.bindings) ||
    command.bindings.length > MAX_BINDINGS
  ) {
    throw invalidSettings();
  }
  const bindings = command.bindings.map(validateBinding);
  const ids = new Set(bindings.map((binding) => binding.providerId));
  if (
    ids.size !== bindings.length ||
    (command.activeProviderId !== null &&
      (!validProviderId(command.activeProviderId) ||
        !ids.has(command.activeProviderId)))
  ) {
    throw invalidSettings();
  }
  return {
    expectedRevision: command.expectedRevision,
    activeProviderId: command.activeProviderId,
    bindings,
  };
}

function validateBinding(binding: ModelProviderSetting): ModelProviderSetting {
  if (
    !binding ||
    typeof binding !== "object" ||
    !exactKeys(binding, [
      "credentialKind",
      "displayName",
      "endpoint",
      "environmentVariable",
      "providerId",
    ]) ||
    !validProviderId(binding.providerId) ||
    !boundedTrimmed(binding.displayName, MAX_DISPLAY_NAME_LENGTH) ||
    typeof binding.endpoint !== "string" ||
    binding.endpoint.length > MAX_ENDPOINT_LENGTH ||
    !validEndpoint(binding.endpoint) ||
    (binding.credentialKind !== "environment" &&
      binding.credentialKind !== "keychain" &&
      binding.credentialKind !== "none") ||
    !validCredentialEnvironment(
      binding.credentialKind,
      binding.environmentVariable,
    )
  ) {
    throw invalidSettings();
  }
  return {
    providerId: binding.providerId,
    displayName: binding.displayName,
    endpoint: binding.endpoint,
    credentialKind: binding.credentialKind,
    environmentVariable: binding.environmentVariable,
  };
}

function validCredentialEnvironment(
  credentialKind: ModelProviderSetting["credentialKind"],
  environmentVariable: unknown,
): boolean {
  return credentialKind === "environment"
    ? typeof environmentVariable === "string" &&
        environmentVariable.length <= 128 &&
        ENVIRONMENT_VARIABLE_PATTERN.test(environmentVariable)
    : environmentVariable === null;
}

function validateMutationIdentity(
  coordination: ModelProviderSettingsCoordination,
  idempotencyKey: string,
): void {
  if (
    !exactKeys(coordination, ["coordinatorBinding", "operationId", "ttlMs"]) ||
    !boundedTrimmed(coordination.operationId, 256) ||
    !boundedTrimmed(coordination.coordinatorBinding, 512) ||
    !boundedTrimmed(idempotencyKey, 256) ||
    !Number.isSafeInteger(coordination.ttlMs) ||
    coordination.ttlMs < 1 ||
    coordination.ttlMs > MAX_PREPARE_WINDOW_MS
  ) {
    throw invalidSettings();
  }
}

function validateCompleteCommand(
  command: CompleteModelProviderSettingsCommand,
  idempotencyKey: string,
): void {
  if (
    !exactKeys(command, ["coordinatorBinding", "operationId"]) ||
    !boundedTrimmed(command.operationId, 256) ||
    !boundedTrimmed(command.coordinatorBinding, 512) ||
    !boundedTrimmed(idempotencyKey, 256)
  ) {
    throw invalidSettings();
  }
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

function validProviderId(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length <= MAX_PROVIDER_ID_LENGTH &&
    PROVIDER_ID_PATTERN.test(value)
  );
}

function boundedTrimmed(value: string, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return (
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function validateActor(actor: ActorContext): void {
  if (
    [actor.principalId, actor.actorId, actor.tenantId, actor.spaceId].some(
      (value) => !boundedTrimmed(value, 512),
    )
  ) {
    throw new ApplicationError("validation", "actor_invalid");
  }
}

function emptyCatalog(tenantId: string): ModelProviderSettingsCatalog {
  return {
    tenantId,
    revision: 0,
    activeProviderId: null,
    runtimeBindingId: null,
    bindings: [],
    updatedAt: null,
  };
}

function invalidSettings(): ApplicationError {
  return new ApplicationError("validation", "model_provider_settings_invalid");
}
