import {
  MAX_EXTENSION_CATALOG_RESPONSE_BYTES,
  MAX_EXTENSION_READ_RESPONSE_BYTES,
  parseCreateExtensionTaskRequest,
  parseExtensionConfigurationQuery,
  parseExtensionIdempotencyKey,
  parseExtensionPluginId,
  parseExtensionCatalogResponse,
  parseExtensionRuntimeQuery,
  parseExtensionRuntimeResponse,
  parseExtensionRunId,
  parseGetExtensionTaskResponse,
  parseSaveExtensionConfigurationRequest,
  parseSetExtensionActivationRequest,
  type CreateExtensionTaskRequest,
  type ExtensionActivationMutationResponse,
  type ExtensionConfigurationMutationResponse,
  type ExtensionTaskMutationResponse,
  type ExtensionCatalogResponse,
  type ExtensionRuntimeQuery,
  type ExtensionRuntimeResponse,
  type GetExtensionTaskResponse,
  type GetExtensionActivationResponse,
  type GetExtensionConfigurationResponse,
  type SaveExtensionConfigurationRequest,
  type SetExtensionActivationRequest,
} from "@crewon/contracts";

const MAX_EXTENSION_RESPONSE_BYTES = 32 * 1024;
export type ExtensionConfigurationQuery = Readonly<{
  revision?: number | null;
}>;
export type ExtensionControlRequestOptions = Readonly<{ signal?: AbortSignal }>;
type JsonOptions = ExtensionControlRequestOptions &
  Readonly<{
    expectedStatuses: readonly number[];
    maximumResponseBytes: number;
    idempotencyKey?: string;
    requireCsrf?: boolean;
    requireIdempotency?: boolean;
  }>;
export type ExtensionControlTransport = Readonly<{
  json(
    method: "GET" | "PUT" | "POST",
    path: string,
    body: unknown,
    options: JsonOptions,
  ): Promise<unknown>;
  protocolError(code: string): Error;
}>;

/** Extension HTTP capabilities share the caller's authenticated Control transport. */
export class ExtensionControlClient {
  readonly #transport: ExtensionControlTransport;
  constructor(transport: ExtensionControlTransport) {
    this.#transport = transport;
  }

  async list(
    options: ExtensionControlRequestOptions = {},
  ): Promise<ExtensionCatalogResponse> {
    const response = await this.#transport.json(
      "GET",
      "/api/v1/extensions",
      null,
      readOptions(options, MAX_EXTENSION_CATALOG_RESPONSE_BYTES),
    );
    return this.#read(() => parseExtensionCatalogResponse(response), "catalog");
  }

  async getRuntime(
    pluginId: string,
    query: ExtensionRuntimeQuery,
    options: ExtensionControlRequestOptions = {},
  ): Promise<ExtensionRuntimeResponse> {
    const id = parseExtensionPluginId(pluginId);
    const value = record(query, ["agentVersionId", "configurationRevision"]);
    if (
      typeof value.configurationRevision !== "number" ||
      !Number.isSafeInteger(value.configurationRevision)
    )
      invalid();
    const parsed = parseExtensionRuntimeQuery({
      agentVersionId: value.agentVersionId,
      configurationRevision: String(value.configurationRevision),
    });
    const parameters = new URLSearchParams({
      agentVersionId: parsed.agentVersionId,
      configurationRevision: String(parsed.configurationRevision),
    });
    const response = await this.#transport.json(
      "GET",
      `${extensionPath(id)}/runtime?${parameters}`,
      null,
      readOptions(options, MAX_EXTENSION_READ_RESPONSE_BYTES),
    );
    return this.#read(
      () =>
        parseExtensionRuntimeResponse(response, { pluginId: id, ...parsed }),
      "runtime",
    );
  }

  async getTask(
    pluginId: string,
    runId: string,
    options: ExtensionControlRequestOptions = {},
  ): Promise<GetExtensionTaskResponse> {
    const id = parseExtensionPluginId(pluginId);
    const expectedRunId = parseExtensionRunId(runId);
    const response = await this.#transport.json(
      "GET",
      `${extensionPath(id)}/tasks/${encodeURIComponent(expectedRunId)}`,
      null,
      readOptions(options, MAX_EXTENSION_READ_RESPONSE_BYTES),
    );
    return this.#read(
      () =>
        parseGetExtensionTaskResponse(response, {
          pluginId: id,
          runId: expectedRunId,
        }),
      "task",
    );
  }

  async getConfiguration(
    pluginId: string,
    query: ExtensionConfigurationQuery = {},
    options: ExtensionControlRequestOptions = {},
  ): Promise<GetExtensionConfigurationResponse> {
    const id = parseExtensionPluginId(pluginId);
    const revision = configurationRevision(query);
    const response = await this.#transport.json(
      "GET",
      `${extensionPath(id)}/configuration${revision === null ? "" : `?revision=${revision}`}`,
      null,
      readOptions(options),
    );
    return this.#read(() => {
      const value = record(response, ["configuration"]);
      return {
        configuration:
          value.configuration === null
            ? null
            : configuration(value.configuration, id, revision),
      };
    }, "configuration");
  }

  async saveConfiguration(
    pluginId: string,
    body: SaveExtensionConfigurationRequest,
    idempotencyKey: string,
    options: ExtensionControlRequestOptions = {},
  ): Promise<ExtensionConfigurationMutationResponse> {
    const id = parseExtensionPluginId(pluginId);
    const request = parseSaveExtensionConfigurationRequest(body);
    const response = await this.#transport.json(
      "PUT",
      `${extensionPath(id)}/configuration`,
      request,
      mutationOptions(options, idempotencyKey, this.#transport),
    );
    return this.#read(() => {
      const value = record(response, ["disposition", "configuration"]);
      if (value.disposition !== "created" && value.disposition !== "replayed")
        invalid();
      const result = configuration(
        value.configuration,
        id,
        request.expectedRevision + 1,
      );
      if (
        result.pluginVersion !== request.pluginVersion ||
        JSON.stringify(result.parameters) !==
          JSON.stringify(request.parameters) ||
        JSON.stringify(result.credentialBindings) !==
          JSON.stringify(
            [...request.credentialBindings].sort((left, right) =>
              left.slotId < right.slotId
                ? -1
                : left.slotId > right.slotId
                  ? 1
                  : 0,
            ),
          )
      )
        invalid();
      return { disposition: value.disposition, configuration: result };
    }, "configuration");
  }

  async getActivation(
    pluginId: string,
    options: ExtensionControlRequestOptions = {},
  ): Promise<GetExtensionActivationResponse> {
    const id = parseExtensionPluginId(pluginId);
    const response = await this.#transport.json(
      "GET",
      `${extensionPath(id)}/activation`,
      null,
      readOptions(options),
    );
    return this.#read(() => {
      const value = record(response, ["activation"]);
      return {
        activation:
          value.activation === null ? null : activation(value.activation, id),
      };
    }, "activation");
  }

  async setActivation(
    pluginId: string,
    body: SetExtensionActivationRequest,
    idempotencyKey: string,
    options: ExtensionControlRequestOptions = {},
  ): Promise<ExtensionActivationMutationResponse> {
    const id = parseExtensionPluginId(pluginId);
    const request = parseSetExtensionActivationRequest(body);
    const response = await this.#transport.json(
      "PUT",
      `${extensionPath(id)}/activation`,
      request,
      mutationOptions(options, idempotencyKey, this.#transport),
    );
    return this.#read(() => {
      const value = record(response, ["disposition", "activation"]);
      if (value.disposition !== "updated" && value.disposition !== "replayed")
        invalid();
      const result = activation(value.activation, id);
      if (
        result.revision !== request.expectedRevision + 1 ||
        result.configurationRevision !== request.configurationRevision ||
        result.state !== request.state ||
        (result.target?.agentVersionId ?? null) !== request.agentVersionId
      )
        invalid();
      return { disposition: value.disposition, activation: result };
    }, "activation");
  }

  async createTask(
    pluginId: string,
    body: CreateExtensionTaskRequest,
    idempotencyKey: string,
    options: ExtensionControlRequestOptions = {},
  ): Promise<ExtensionTaskMutationResponse> {
    const id = parseExtensionPluginId(pluginId);
    const request = parseCreateExtensionTaskRequest(body);
    const response = await this.#transport.json(
      "POST",
      `${extensionPath(id)}/tasks`,
      request,
      mutationOptions(options, idempotencyKey, this.#transport),
    );
    return this.#read(() => {
      const value = record(response, [
        "disposition",
        "threadId",
        "threadRevision",
        "runId",
        "messageId",
        "configurationRevision",
      ]);
      if (
        (value.disposition !== "committed" &&
          value.disposition !== "replayed") ||
        text(value.threadId) !== request.threadId ||
        revision(value.threadRevision) !== request.expectedThreadRevision + 1
      )
        invalid();
      text(value.runId);
      text(value.messageId);
      revision(value.configurationRevision);
      return value as ExtensionTaskMutationResponse;
    }, "task");
  }

  #read<T>(
    parse: () => T,
    resource: "configuration" | "activation" | "task" | "catalog" | "runtime",
  ): T {
    try {
      return parse();
    } catch {
      throw this.#transport.protocolError(
        `control_client_extension_${resource}_invalid`,
      );
    }
  }
}

function readOptions(
  options: ExtensionControlRequestOptions,
  maximumResponseBytes = MAX_EXTENSION_RESPONSE_BYTES,
): JsonOptions {
  return {
    ...options,
    expectedStatuses: [200],
    maximumResponseBytes,
  };
}
function mutationOptions(
  options: ExtensionControlRequestOptions,
  key: string,
  transport: ExtensionControlTransport,
): JsonOptions {
  let idempotencyKey: string | undefined;
  if (key !== undefined) {
    try {
      idempotencyKey = parseExtensionIdempotencyKey(key);
    } catch {
      throw transport.protocolError("control_client_idempotency_key_invalid");
    }
  }
  return {
    ...readOptions(options),
    idempotencyKey,
    requireCsrf: true,
    requireIdempotency: true,
  };
}
function extensionPath(pluginId: string): string {
  return `/api/v1/extensions/${encodeURIComponent(pluginId)}`;
}
function configurationRevision(
  query: ExtensionConfigurationQuery,
): number | null {
  if (
    query === null ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    Reflect.ownKeys(query).some((key) => key !== "revision") ||
    Object.values(Object.getOwnPropertyDescriptors(query)).some(
      (entry) => !Object.hasOwn(entry, "value"),
    )
  )
    invalid();
  if (query.revision === undefined || query.revision === null) return null;
  if (
    typeof query.revision !== "number" ||
    !Number.isSafeInteger(query.revision)
  )
    invalid();
  return parseExtensionConfigurationQuery({ revision: String(query.revision) })
    .revision;
}
function configuration(
  input: unknown,
  pluginId: string,
  requestedRevision: number | null,
): NonNullable<GetExtensionConfigurationResponse["configuration"]> {
  const value = record(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "pluginId",
    "revision",
    "pluginVersion",
    "manifestDigest",
    "implementationDigest",
    "parameters",
    "credentialBindings",
    "createdByActorId",
    "createdAt",
    "contentDigest",
  ]);
  if (
    value.schemaVersion !== "crewon.extension-configuration.v0" ||
    parseExtensionPluginId(value.pluginId) !== pluginId ||
    (requestedRevision !== null &&
      revision(value.revision) !== requestedRevision)
  )
    invalid();
  revision(value.revision);
  text(value.tenantId);
  text(value.spaceId);
  text(value.createdByActorId);
  timestamp(value.createdAt);
  digest(value.manifestDigest);
  digest(value.implementationDigest);
  digest(value.contentDigest);
  const parsed = parseSaveExtensionConfigurationRequest({
    pluginVersion: value.pluginVersion,
    expectedRevision: 0,
    parameters: value.parameters,
    credentialBindings: value.credentialBindings,
  });
  return {
    ...value,
    parameters: parsed.parameters,
    credentialBindings: parsed.credentialBindings,
  } as NonNullable<GetExtensionConfigurationResponse["configuration"]>;
}
function activation(
  input: unknown,
  pluginId: string,
): NonNullable<GetExtensionActivationResponse["activation"]> {
  const value = record(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "pluginId",
    "revision",
    "configurationRevision",
    "configurationDigest",
    "state",
    "target",
    "updatedByActorId",
    "updatedAt",
  ]);
  if (
    value.schemaVersion !== "crewon.extension-activation.v0" ||
    parseExtensionPluginId(value.pluginId) !== pluginId ||
    !["enabled", "disabled", "revoked"].includes(String(value.state)) ||
    (value.state === "enabled") !== (value.target !== null)
  )
    invalid();
  text(value.tenantId);
  text(value.spaceId);
  text(value.updatedByActorId);
  timestamp(value.updatedAt);
  revision(value.revision);
  revision(value.configurationRevision);
  digest(value.configurationDigest);
  if (value.target !== null) {
    const target = record(value.target, [
      "executionAuthority",
      "agentVersionId",
      "agentVersionContentDigest",
      "materializationDigest",
      "authorityId",
      "runtimeGeneration",
      "policySnapshotId",
      "workspaceBindingId",
    ]);
    if (target.executionAuthority !== "crewonKernel") invalid();
    text(target.agentVersionId);
    text(target.authorityId);
    text(target.runtimeGeneration);
    text(target.policySnapshotId);
    if (target.workspaceBindingId !== null) text(target.workspaceBindingId);
    digest(target.agentVersionContentDigest);
    digest(target.materializationDigest);
  }
  return value as NonNullable<GetExtensionActivationResponse["activation"]>;
}
function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Reflect.ownKeys(input).length !== keys.length ||
    Object.keys(input).sort().join("\0") !== [...keys].sort().join("\0") ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (entry) => !Object.hasOwn(entry, "value"),
    )
  )
    invalid();
  return input as Record<string, unknown>;
}
function text(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input ||
    input !== input.trim() ||
    new TextEncoder().encode(input).byteLength > 128 ||
    /[\u0000-\u001f\u007f]/u.test(input)
  )
    invalid();
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) invalid();
  }
  return input;
}
function revision(input: unknown): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 1 ||
    input > 2_147_483_647
  )
    invalid();
  return input;
}
function digest(input: unknown): void {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    invalid();
}
function timestamp(input: unknown): void {
  if (
    typeof input !== "string" ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  )
    invalid();
}
function invalid(): never {
  throw new TypeError("control_client_extension_response_invalid");
}
