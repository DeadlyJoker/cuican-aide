import type {
  ModelProviderProbeModel,
  ModelProviderProbeResult,
  ModelProviderProbeStatus,
} from "@crewon/application";

import {
  ProviderProbeEgressError,
  ProviderProbeEgressResolver,
  type PinnedProviderProbeEndpoint,
} from "./provider-probe-egress.ts";
import {
  PinnedNodeHttpError,
  PinnedNodeHttpTransport,
} from "./pinned-node-http.ts";

type CatalogResource = "models" | "aicuicanEnabledModels";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MODELS = 100;
const MAX_MODEL_FIELD_BYTES = 256;
const MAX_RETRY_AFTER_MS = 86_400_000;
const MAX_DEADLINE_MS = 10_000;

export type ProviderProbeHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
}>;

export interface ProviderProbeHttpPort {
  request(
    input: Readonly<{
      target: PinnedProviderProbeEndpoint;
      authorization: string | null;
    }>,
    signal: AbortSignal,
  ): Promise<ProviderProbeHttpResponse>;
}

/** Node transport that pins the approved address and never follows redirects. */
export class PinnedNodeProviderProbeHttp implements ProviderProbeHttpPort {
  readonly #transport: PinnedNodeHttpTransport;

  constructor(options: { certificateAuthority?: string } = {}) {
    this.#transport = new PinnedNodeHttpTransport(options);
  }

  request(
    input: Readonly<{
      target: PinnedProviderProbeEndpoint;
      authorization: string | null;
    }>,
    signal: AbortSignal,
  ): Promise<ProviderProbeHttpResponse> {
    return this.#transport
      .request(
        {
          method: "GET",
          target: input.target,
          headers: {
            accept: "application/json",
            ...(input.authorization === null
              ? {}
              : { authorization: input.authorization }),
          },
          maxRequestBytes: 0,
          maxResponseBytes: MAX_BODY_BYTES,
        },
        signal,
      )
      .catch((error: unknown) => {
        if (!(error instanceof PinnedNodeHttpError)) throw error;
        if (
          error.code === "request_aborted" ||
          error.code === "transport_failed"
        ) {
          throw new ProviderProbeTransportError();
        }
        throw new ProviderProbeProtocolError(error.code);
      });
  }
}

/** Performs one bounded OpenAI-compatible `/models` request. */
export class ResponsesProviderConnectivityProbe {
  readonly #tenantId: string;
  readonly #providerId: string;
  readonly #catalogRevision: number;
  readonly #runtimeBindingId: string;
  readonly #endpoint: URL;
  readonly #catalogResource: CatalogResource;
  readonly #secret: string | null;
  readonly #deadlineMs: number;
  readonly #egress: ProviderProbeEgressResolver;
  readonly #http: ProviderProbeHttpPort;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;

  constructor(
    config: {
      tenantId: string;
      providerId: string;
      catalogRevision: number;
      runtimeBindingId: string;
      endpoint: string;
      secret: string | null;
      deadlineMs?: number;
      catalogResource?: CatalogResource;
    },
    dependencies: {
      egress: ProviderProbeEgressResolver;
      http?: ProviderProbeHttpPort;
      now?: () => number;
      schedule?: (callback: () => void, delayMs: number) => () => void;
    },
  ) {
    this.#tenantId = bounded(
      config.tenantId,
      512,
      "provider_probe_tenant_invalid",
    );
    this.#providerId = bounded(
      config.providerId,
      128,
      "provider_probe_provider_invalid",
    );
    this.#catalogRevision = revision(config.catalogRevision);
    this.#runtimeBindingId = bounded(
      config.runtimeBindingId,
      512,
      "provider_probe_runtime_binding_invalid",
    );
    this.#catalogResource = config.catalogResource ?? "models";
    this.#endpoint = modelsEndpoint(config.endpoint, this.#catalogResource);
    this.#secret = secret(config.secret);
    this.#deadlineMs = deadline(config.deadlineMs ?? MAX_DEADLINE_MS);
    this.#egress = dependencies.egress;
    this.#http = dependencies.http ?? new PinnedNodeProviderProbeHttp();
    this.#now = dependencies.now ?? Date.now;
    this.#schedule =
      dependencies.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
  }

  async probe(signal: AbortSignal): Promise<ModelProviderProbeResult> {
    const startedAt = readNow(this.#now);
    const deadline = new AbortController();
    const cancelTimer = this.#schedule(
      () => deadline.abort(new Error("provider_probe_deadline_exceeded")),
      this.#deadlineMs,
    );
    const combined = AbortSignal.any([signal, deadline.signal]);
    try {
      const targets = await this.#egress.resolveAll(
        {
          tenantId: this.#tenantId,
          providerId: this.#providerId,
          endpoint: this.#endpoint,
        },
        combined,
      );
      const response = await this.#requestWithAddressFailover(
        targets,
        combined,
      );
      return projectResponse(
        this.#providerId,
        this.#catalogRevision,
        this.#runtimeBindingId,
        this.#secret,
        this.#catalogResource,
        response,
        latency(readNow(this.#now) - startedAt, this.#deadlineMs),
      );
    } catch (error) {
      if (error instanceof ProviderProbeProtocolError) {
        return emptyResult(
          this.#providerId,
          this.#catalogRevision,
          this.#runtimeBindingId,
          "invalidResponse",
          latency(readNow(this.#now) - startedAt, this.#deadlineMs),
        );
      }
      if (error instanceof ProviderProbeEgressError) {
        return emptyResult(
          this.#providerId,
          this.#catalogRevision,
          this.#runtimeBindingId,
          "unreachable",
          latency(readNow(this.#now) - startedAt, this.#deadlineMs),
        );
      }
      return {
        ...emptyResult(
          this.#providerId,
          this.#catalogRevision,
          this.#runtimeBindingId,
          "unreachable",
          latency(readNow(this.#now) - startedAt, this.#deadlineMs),
        ),
        retryable: !signal.aborted,
      };
    } finally {
      cancelTimer();
    }
  }

  async #requestWithAddressFailover(
    targets: readonly PinnedProviderProbeEndpoint[],
    signal: AbortSignal,
  ): Promise<ProviderProbeHttpResponse> {
    const failoverDelayMs = Math.min(
      250,
      Math.max(1, Math.floor(this.#deadlineMs / targets.length)),
    );
    let lastError: unknown = new ProviderProbeTransportError();
    for (const [index, target] of targets.entries()) {
      const isLastTarget = index === targets.length - 1;
      const attempt = new AbortController();
      const cancelTimer = isLastTarget
        ? () => {}
        : this.#schedule(
            () =>
              attempt.abort(
                new Error("provider_probe_attempt_deadline_exceeded"),
              ),
            failoverDelayMs,
          );
      try {
        return await this.#http.request(
          {
            target,
            authorization:
              this.#secret === null ? null : `Bearer ${this.#secret}`,
          },
          isLastTarget ? signal : AbortSignal.any([signal, attempt.signal]),
        );
      } catch (error) {
        if (signal.aborted || error instanceof ProviderProbeProtocolError) {
          throw error;
        }
        lastError = error;
      } finally {
        cancelTimer();
      }
    }
    throw lastError;
  }
}

function projectResponse(
  providerId: string,
  catalogRevision: number,
  runtimeBindingId: string,
  secretValue: string | null,
  catalogResource: CatalogResource,
  response: ProviderProbeHttpResponse,
  latencyMs: number,
): ModelProviderProbeResult {
  if (response.status === 401 || response.status === 403) {
    return emptyResult(
      providerId,
      catalogRevision,
      runtimeBindingId,
      "authenticationFailed",
      latencyMs,
    );
  }
  if (response.status === 429) {
    return {
      ...emptyResult(
        providerId,
        catalogRevision,
        runtimeBindingId,
        "rateLimited",
        latencyMs,
      ),
      retryable: true,
      retryAfterMs: retryAfterMs(response.headers["retry-after"]),
    };
  }
  if (response.status < 200 || response.status > 299) {
    return {
      ...emptyResult(
        providerId,
        catalogRevision,
        runtimeBindingId,
        "providerError",
        latencyMs,
      ),
      retryable: response.status >= 500,
    };
  }
  if (
    !/^application\/json(?:;|$)/iu.test(
      response.headers["content-type"] ?? "",
    ) ||
    response.body.byteLength > MAX_BODY_BYTES
  ) {
    return emptyResult(
      providerId,
      catalogRevision,
      runtimeBindingId,
      "invalidResponse",
      latencyMs,
    );
  }
  const models = parseModels(response.body, secretValue, catalogResource);
  if (models === null) {
    return emptyResult(
      providerId,
      catalogRevision,
      runtimeBindingId,
      "invalidResponse",
      latencyMs,
    );
  }
  return {
    ...emptyResult(
      providerId,
      catalogRevision,
      runtimeBindingId,
      "ok",
      latencyMs,
    ),
    models,
    modelCount: models.length,
  };
}

function parseModels(
  body: Uint8Array,
  secretValue: string | null,
  catalogResource: CatalogResource,
): readonly ModelProviderProbeModel[] | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (
    !object(value) ||
    (catalogResource === "aicuicanEnabledModels" && value.success !== true)
  )
    return null;
  const items = Array.isArray(value.data)
    ? value.data
    : catalogResource === "models" && Array.isArray(value.models)
      ? value.models
      : null;
  if (items === null || items.length > MAX_MODELS) return null;
  const seen = new Set<string>();
  const models: ModelProviderProbeModel[] = [];
  for (const item of items) {
    const id = object(item)
      ? catalogResource === "aicuicanEnabledModels"
        ? item.model_name
        : item.id
      : null;
    if (
      !object(item) ||
      !boundedModelField(id) ||
      containsSecret(id, secretValue) ||
      seen.has(id)
    ) {
      return null;
    }
    const display = item.display_name ?? item.name ?? null;
    if (
      display !== null &&
      (!boundedModelField(display) || containsSecret(display, secretValue))
    ) {
      return null;
    }
    seen.add(id);
    models.push({ id, displayName: display });
  }
  return models;
}

function emptyResult(
  providerId: string,
  catalogRevision: number,
  runtimeBindingId: string,
  status: ModelProviderProbeStatus,
  latencyMs: number,
): ModelProviderProbeResult {
  return {
    providerId,
    catalogRevision,
    runtimeBindingId,
    status,
    models: null,
    modelCount: null,
    latencyMs,
    retryable: false,
    retryAfterMs: null,
  };
}

function modelsEndpoint(value: string, resource: CatalogResource): URL {
  const endpoint = new URL(value);
  if (
    (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("model_provider_endpoint_invalid");
  }
  if (resource === "aicuicanEnabledModels") {
    if (
      endpoint.origin !== "https://api.aicuican.com" ||
      endpoint.pathname.replace(/\/+$/u, "") !== "/v1"
    )
      throw new Error("model_provider_metadata_endpoint_invalid");
    endpoint.pathname = "/api/pricing";
  } else {
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/models`;
  }
  return endpoint;
}

function retryAfterMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(Math.ceil(seconds * 1_000), MAX_RETRY_AFTER_MS)
    : null;
}

function boundedModelField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= MAX_MODEL_FIELD_BYTES
  );
}

function containsSecret(value: string, secretValue: string | null): boolean {
  return secretValue !== null && value.includes(secretValue);
}

function bounded(value: unknown, maximum: number, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    new TextEncoder().encode(value).byteLength > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function secret(value: string | null): string | null {
  if (value === null) return null;
  if (
    /[\u0000-\u001f\u007f]/u.test(value) ||
    new TextEncoder().encode(value).byteLength > 16 * 1024
  ) {
    throw new Error("provider_probe_secret_invalid");
  }
  return bounded(value, 16 * 1024, "provider_probe_secret_invalid");
}

function deadline(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DEADLINE_MS) {
    throw new Error("provider_probe_deadline_invalid");
  }
  return value;
}

function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("provider_probe_catalog_revision_invalid");
  }
  return value;
}

function latency(value: number, deadlineMs: number): number {
  return Math.min(Math.max(0, Math.round(value)), deadlineMs);
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("provider_probe_clock_invalid");
  }
  return value;
}

function header(
  value: string | readonly string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ProviderProbeProtocolError extends Error {}

class ProviderProbeTransportError extends Error {}
