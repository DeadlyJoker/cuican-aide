import {
  MAX_PLUGIN_CONTROL_RESPONSE_BYTES,
  MAX_PLUGIN_UI_CATALOG_RESPONSE_BYTES,
  MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES,
  MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES,
  parseClosePluginUiMountResponse,
  parseGetPluginPackageResponse,
  parseGetPluginSelectionResponse,
  parseInstallPluginPackageRequest,
  parseInvokePluginUiActionRequest,
  parseInvokePluginUiActionResponse,
  parseOpenPluginUiMountRequest,
  parseOpenPluginUiMountResponse,
  parseRenewPluginUiMountRequest,
  parseRenewPluginUiMountResponse,
  parsePluginControlIdempotencyKey,
  parsePluginControlMountRef,
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
  parsePluginInstallationResponse,
  parsePluginPackageListQuery,
  parsePluginPackageListResponse,
  parsePluginSelectionListQuery,
  parsePluginSelectionListResponse,
  parsePluginSelectionResponse,
  parsePluginSourceListQuery,
  parsePluginSourceListResponse,
  parsePluginUiCatalogResponse,
  parsePluginUiRecoveryHintsResponse,
  parsePluginUiRecoveryRequest,
  parseStagePluginUiRecoveryResponse,
  parseSelectPluginPackageRequest,
  parseValidatePluginUiMountResponse,
  type InstallPluginPackageRequest,
  type InvokePluginUiActionRequest,
  type OpenPluginUiMountRequest,
  type RenewPluginUiMountRequest,
  type PluginPackageListQuery,
  type PluginSelectionListQuery,
  type PluginSourceListQuery,
  type PluginUiRecoveryRequest,
  type SelectPluginPackageRequest,
} from "@crewon/contracts";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  writePluginSourceUploadPart,
  type PluginSourceUploadPartTransport,
} from "./project-source-upload-control-client.ts";

export type PluginControlRequestOptions = Readonly<{ signal?: AbortSignal }>;
export type PluginPackageQuery = Readonly<{
  pluginId?: string | null;
  afterPackageDigest?: string | null;
  limit?: number;
}>;
export type PluginSelectionQuery = Readonly<{
  afterPluginId?: string | null;
  limit?: number;
}>;
export type PluginSourceQuery = Readonly<{
  afterSourceId?: string | null;
  limit?: number;
}>;
type JsonOptions = PluginControlRequestOptions &
  Readonly<{
    expectedStatuses: readonly number[];
    maximumResponseBytes: number;
    requireCsrf?: boolean;
    requireIdempotency?: boolean;
    idempotencyKey?: string;
    redirect?: "manual";
  }>;
export type PluginControlTransport = PluginSourceUploadPartTransport &
  Readonly<{
    json(
      method: "GET" | "PUT" | "POST" | "DELETE",
      path: string,
      body: unknown,
      options: JsonOptions,
    ): Promise<unknown>;
    protocolError(code: string): Error;
  }>;

const PREFIX = "/api/v1/plugins";

/** Uses only the host's existing authenticated transport. Actor/profile authority never enters these DTOs. */
export class PluginControlClient {
  readonly #transport: PluginControlTransport;
  constructor(transport: PluginControlTransport) {
    this.#transport = transport;
  }

  async listSources(
    query: PluginSourceQuery = {},
    options: PluginControlRequestOptions = {},
  ) {
    const checked = this.#input(() => sourceQuery(query));
    const result = await this.#json(
      "GET",
      `${PREFIX}/sources${search(checked)}`,
      null,
      options,
    );
    return this.#output(() => parsePluginSourceListResponse(result, checked));
  }
  async listPackages(
    query: PluginPackageQuery = {},
    options: PluginControlRequestOptions = {},
  ) {
    const checked = this.#input(() => packageQuery(query));
    const result = await this.#json(
      "GET",
      `${PREFIX}/packages${search(checked)}`,
      null,
      options,
    );
    return this.#output(() => parsePluginPackageListResponse(result, checked));
  }
  async getPackage(
    packageDigest: string,
    options: PluginControlRequestOptions = {},
  ) {
    const checked = this.#input(() =>
      parsePluginControlPackageDigest(packageDigest),
    );
    const result = await this.#json(
      "GET",
      `${PREFIX}/packages/${encodeURIComponent(checked)}`,
      null,
      options,
    );
    return this.#output(() =>
      parseGetPluginPackageResponse(result, { packageDigest: checked }),
    );
  }
  async installPackage(
    request: InstallPluginPackageRequest,
    idempotencyKey: string,
    options: PluginControlRequestOptions = {},
  ) {
    const checked = this.#input(() =>
      parseInstallPluginPackageRequest(request),
    );
    const key = this.#input(() =>
      parsePluginControlIdempotencyKey(idempotencyKey),
    );
    const result = await this.#json(
      "POST",
      `${PREFIX}/installations`,
      checked,
      options,
      {
        expectedStatuses: [200, 201],
        requireIdempotency: true,
        idempotencyKey: key,
      },
    );
    return this.#output(() => parsePluginInstallationResponse(result, checked));
  }
  async listSelections(
    query: PluginSelectionQuery = {},
    options: PluginControlRequestOptions = {},
  ) {
    const checked = this.#input(() => selectionQuery(query));
    const result = await this.#json(
      "GET",
      `${PREFIX}/selections${search(checked)}`,
      null,
      options,
    );
    return this.#output(() =>
      parsePluginSelectionListResponse(result, checked),
    );
  }
  async getSelection(
    pluginId: string,
    options: PluginControlRequestOptions = {},
  ) {
    const checked = this.#input(() => parsePluginControlPluginId(pluginId));
    const result = await this.#json(
      "GET",
      `${PREFIX}/selections/${encodeURIComponent(checked)}`,
      null,
      options,
    );
    return this.#output(() =>
      parseGetPluginSelectionResponse(result, { pluginId: checked }),
    );
  }
  async setSelection(
    pluginId: string,
    request: SelectPluginPackageRequest,
    idempotencyKey: string,
    options: PluginControlRequestOptions = {},
  ) {
    const id = this.#input(() => parsePluginControlPluginId(pluginId));
    const checked = this.#input(() => parseSelectPluginPackageRequest(request));
    const key = this.#input(() =>
      parsePluginControlIdempotencyKey(idempotencyKey),
    );
    const result = await this.#json(
      "PUT",
      `${PREFIX}/selections/${encodeURIComponent(id)}`,
      checked,
      options,
      { requireIdempotency: true, idempotencyKey: key },
    );
    return this.#output(() =>
      parsePluginSelectionResponse(result, { pluginId: id, request: checked }),
    );
  }
  /** A filtered page may be empty with a non-null next; callers must follow the authoritative cursor. */
  async uiCatalog(
    query: PluginSelectionQuery = {},
    options: PluginControlRequestOptions = {},
  ) {
    const checked = this.#input(() => selectionQuery(query));
    const result = await this.#json(
      "GET",
      `${PREFIX}/ui/catalog${search(checked)}`,
      null,
      options,
      { maximumResponseBytes: MAX_PLUGIN_UI_CATALOG_RESPONSE_BYTES },
    );
    return this.#output(() => parsePluginUiCatalogResponse(result, checked));
  }
  async openMount(
    request: OpenPluginUiMountRequest,
    options: PluginControlRequestOptions = {},
  ) {
    const checked = this.#input(() => parseOpenPluginUiMountRequest(request));
    const result = await this.#json(
      "POST",
      `${PREFIX}/ui/mounts`,
      checked,
      options,
      {
        expectedStatuses: [200, 201],
        maximumResponseBytes: MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES,
      },
    );
    return this.#output(() => parseOpenPluginUiMountResponse(result, checked));
  }
  async validateMount(
    mountRef: string,
    options: PluginControlRequestOptions = {},
  ) {
    const checked = this.#input(() => parsePluginControlMountRef(mountRef));
    const result = await this.#json(
      "GET",
      `${PREFIX}/ui/mounts/${checked}`,
      null,
      options,
      { maximumResponseBytes: MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES },
    );
    return this.#output(() =>
      parseValidatePluginUiMountResponse(result, { mountRef: checked }),
    );
  }
  async renewMount(
    mountRef: string,
    request: RenewPluginUiMountRequest,
    options: PluginControlRequestOptions = {},
  ) {
    const ref = this.#input(() => parsePluginControlMountRef(mountRef));
    const checked = this.#input(() => parseRenewPluginUiMountRequest(request));
    const result = await this.#json(
      "POST",
      `${PREFIX}/ui/mounts/${ref}/renew`,
      checked,
      options,
      { maximumResponseBytes: MAX_PLUGIN_UI_LEASE_RESPONSE_BYTES },
    );
    return this.#output(() =>
      parseRenewPluginUiMountResponse(result, { mountRef: ref, ...checked }),
    );
  }
  async closeMount(
    mountRef: string,
    options: PluginControlRequestOptions = {},
  ) {
    const checked = this.#input(() => parsePluginControlMountRef(mountRef));
    const result = await this.#json(
      "DELETE",
      `${PREFIX}/ui/mounts/${checked}`,
      {},
      options,
    );
    return this.#output(() => parseClosePluginUiMountResponse(result));
  }
  async invoke(
    mountRef: string,
    request: InvokePluginUiActionRequest,
    options: PluginControlRequestOptions = {},
  ) {
    const ref = this.#input(() => parsePluginControlMountRef(mountRef));
    const checked = this.#input(() =>
      parseInvokePluginUiActionRequest(request),
    );
    const result = await this.#json(
      "POST",
      `${PREFIX}/ui/mounts/${ref}/actions`,
      checked,
      options,
    );
    return this.#output(() => parseInvokePluginUiActionResponse(result));
  }

  writeSourceUploadPart(
    ...args: Parameters<typeof writePluginSourceUploadPart> extends [
      unknown,
      ...infer A,
    ]
      ? A
      : never
  ) {
    return writePluginSourceUploadPart(this.#transport, ...args);
  }

  /** Read-only account recovery hints; the current mount still owns authorization. */
  async getRecovery(
    mountRef: string,
    options: PluginControlRequestOptions = {},
  ) {
    const ref = this.#input(() => parsePluginControlMountRef(mountRef));
    const result = await this.#json(
      "GET",
      `${PREFIX}/ui/mounts/${ref}/recovery`,
      null,
      options,
      { maximumResponseBytes: MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES },
    );
    return this.#output(() => parsePluginUiRecoveryHintsResponse(result));
  }

  /** A durable staging ACK precedes the separate original business invocation. */
  async stageRecovery(
    mountRef: string,
    request: PluginUiRecoveryRequest,
    options: PluginControlRequestOptions = {},
  ) {
    const ref = this.#input(() => parsePluginControlMountRef(mountRef));
    const checked = this.#input(() => parsePluginUiRecoveryRequest(request));
    const result = await this.#json(
      "POST",
      `${PREFIX}/ui/mounts/${ref}/recovery`,
      checked,
      options,
      {
        expectedStatuses: [200, 201],
        maximumResponseBytes: MAX_PLUGIN_UI_RECOVERY_RESPONSE_BYTES,
      },
    );
    return this.#output(() =>
      parseStagePluginUiRecoveryResponse(result, checked),
    );
  }

  async #json(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body: unknown,
    options: PluginControlRequestOptions,
    extra: Partial<JsonOptions> = {},
  ) {
    options.signal?.throwIfAborted();
    const result = await this.#transport.json(method, path, body, {
      expectedStatuses: [200],
      maximumResponseBytes: MAX_PLUGIN_CONTROL_RESPONSE_BYTES,
      redirect: "manual",
      ...(method === "GET" ? {} : { requireCsrf: true }),
      ...extra,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    return result;
  }
  #input<T>(parse: () => T): T {
    try {
      return parse();
    } catch {
      throw this.#transport.protocolError(
        "control_client_plugin_request_invalid",
      );
    }
  }
  #output<T>(parse: () => T): T {
    try {
      return parse();
    } catch {
      throw this.#transport.protocolError(
        "control_client_plugin_response_invalid",
      );
    }
  }
}

function queryFields(
  input: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const value = parsePluginUiJsonValue(input, { maxBytes: 1024 });
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new TypeError("plugin_query_invalid");
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.hasOwn(record, "limit") && typeof record.limit !== "number")
    throw new TypeError("plugin_query_invalid");
  return record;
}
function packageQuery(input: PluginPackageQuery): PluginPackageListQuery {
  const fields = queryFields(input, [
    "pluginId",
    "afterPackageDigest",
    "limit",
  ]);
  return parsePluginPackageListQuery(rawQuery(fields));
}
function selectionQuery(input: PluginSelectionQuery): PluginSelectionListQuery {
  const fields = queryFields(input, ["afterPluginId", "limit"]);
  return parsePluginSelectionListQuery(rawQuery(fields));
}
function sourceQuery(input: PluginSourceQuery): PluginSourceListQuery {
  const fields = queryFields(input, ["afterSourceId", "limit"]);
  return parsePluginSourceListQuery(rawQuery(fields));
}
function rawQuery(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [key, key === "limit" ? String(value) : value]),
  );
}
function search(
  input:
    | PluginPackageListQuery
    | PluginSelectionListQuery
    | PluginSourceListQuery,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (value !== null) params.set(key, String(value));
  return `?${params.toString()}`;
}
