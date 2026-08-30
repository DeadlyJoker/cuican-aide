import type {
  ActorContext,
  ModelProviderProbeModel,
  ModelProviderProbeRequest,
  ModelProviderProbeResult,
  ModelProviderProbeWorkerPort,
  ModelProviderSettingsApplicationService,
} from "@crewon/application";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_MODELS = 100;
const MAX_FIELD_BYTES = 256;
const STATUSES = new Set([
  "ok",
  "credentialMissing",
  "authenticationFailed",
  "rateLimited",
  "providerError",
  "unreachable",
  "invalidResponse",
  "bindingMismatch",
]);

/** Authenticated bounded client for one private Worker probe endpoint. */
export class HttpProviderProbeWorkerClient
  implements ModelProviderProbeWorkerPort
{
  readonly #url: URL;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(
    config: { origin: string; token: string; timeoutMs?: number },
    dependencies: { fetch?: typeof globalThis.fetch } = {},
  ) {
    this.#url = workerUrl(config.origin);
    this.#token = boundedSecret(config.token);
    this.#timeoutMs = positiveInteger(config.timeoutMs ?? 12_000, 30_000);
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async probe(
    input: ModelProviderProbeRequest,
    signal: AbortSignal,
  ): Promise<ModelProviderProbeResult> {
    validateRequest(input);
    try {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "authorization": `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ProviderProbeWorkerError(
          response.status === 401 || response.status === 403
            ? "provider_probe_worker_authentication_failed"
            : "provider_probe_worker_unavailable",
          {
            certainty:
              response.status === 401 || response.status === 403
                ? "notSent"
                : "possiblySent",
          },
        );
      }
      const result = parseResponse(await readBoundedJson(response));
      if (
        result.providerId !== input.expectedProviderId ||
        result.catalogRevision !== input.expectedRevision ||
        result.runtimeBindingId !== input.expectedRuntimeBindingId
      ) {
        throw new ProviderProbeWorkerError(
          "provider_probe_worker_response_mismatch",
        );
      }
      return result;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ProviderProbeWorkerError) throw error;
      throw new ProviderProbeWorkerError("provider_probe_worker_unavailable", {
        cause: error,
        certainty: "possiblySent",
      });
    }
  }
}

/** Registry is server-owned and routes by verified tenant plus runtime generation. */
export interface TenantProviderProbeWorkerRegistry {
  resolve(
    input: Readonly<{ tenantId: string; runtimeBindingId: string }>,
  ):
    | ModelProviderProbeWorkerPort
    | null
    | Promise<ModelProviderProbeWorkerPort | null>;
}

export class TenantRoutedProviderProbeWorker
  implements ModelProviderProbeWorkerPort
{
  readonly #registry: TenantProviderProbeWorkerRegistry;

  constructor(registry: TenantProviderProbeWorkerRegistry) {
    this.#registry = registry;
  }

  async probe(
    input: ModelProviderProbeRequest,
    signal: AbortSignal,
  ): Promise<ModelProviderProbeResult> {
    validateRequest(input);
    const worker = await abortable(
      Promise.resolve(
        this.#registry.resolve({
          tenantId: input.tenantId,
          runtimeBindingId: input.expectedRuntimeBindingId,
        }),
      ),
      signal,
    );
    if (worker === null) {
      throw new ProviderProbeWorkerError("provider_probe_worker_unavailable");
    }
    return worker.probe(input, signal);
  }
}

export class UnavailableTenantProviderProbeWorkerRegistry
  implements TenantProviderProbeWorkerRegistry
{
  resolve(): null {
    return null;
  }
}

/** Fixed loopback route for the one verified packaged-desktop tenant. */
export class SingleTenantProviderProbeWorkerRegistry
  implements TenantProviderProbeWorkerRegistry
{
  readonly #tenantId: string;
  readonly #worker: ModelProviderProbeWorkerPort;

  constructor(input: {
    tenantId: string;
    worker: ModelProviderProbeWorkerPort;
  }) {
    if (!boundedField(input.tenantId, 512)) {
      throw new ProviderProbeWorkerError(
        "provider_probe_worker_registry_invalid",
      );
    }
    this.#tenantId = input.tenantId;
    this.#worker = input.worker;
  }

  resolve(input: Readonly<{ tenantId: string; runtimeBindingId: string }>) {
    return input.tenantId === this.#tenantId ? this.#worker : null;
  }
}

/** Internal coordinator; a later public route can supply only its verified actor. */
export class ControlProviderProbeService {
  readonly #settings: Pick<
    ModelProviderSettingsApplicationService,
    "authorizeProbe"
  >;
  readonly #workers: ModelProviderProbeWorkerPort;
  readonly #deadlineMs: number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;

  constructor(
    dependencies: {
      settings: Pick<ModelProviderSettingsApplicationService, "authorizeProbe">;
      workers: ModelProviderProbeWorkerPort;
    },
    options: {
      deadlineMs?: number;
      schedule?: (callback: () => void, delayMs: number) => () => void;
    } = {},
  ) {
    this.#settings = dependencies.settings;
    this.#workers = dependencies.workers;
    this.#deadlineMs = positiveInteger(options.deadlineMs ?? 12_000, 30_000);
    this.#schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
  }

  async probe(
    actor: ActorContext,
    signal: AbortSignal,
  ): Promise<ModelProviderProbeResult> {
    const deadline = new AbortController();
    const cancelDeadline = this.#schedule(
      () =>
        deadline.abort(
          new ProviderProbeWorkerError("provider_probe_worker_unavailable"),
        ),
      this.#deadlineMs,
    );
    const combined = AbortSignal.any([signal, deadline.signal]);
    try {
      const catalog = await abortable(
        this.#settings.authorizeProbe(actor),
        combined,
      );
      const result = await abortable(
        this.#workers.probe(
          {
            tenantId: actor.tenantId,
            expectedRevision: catalog.revision,
            expectedProviderId: catalog.activeProviderId!,
            expectedRuntimeBindingId: catalog.runtimeBindingId!,
          },
          combined,
        ),
        combined,
      );
      if (
        result.providerId !== catalog.activeProviderId ||
        result.catalogRevision !== catalog.revision ||
        result.runtimeBindingId !== catalog.runtimeBindingId
      ) {
        throw new ProviderProbeWorkerError(
          "provider_probe_worker_response_mismatch",
        );
      }
      return result;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (deadline.signal.aborted) throw deadline.signal.reason;
      throw error;
    } finally {
      cancelDeadline();
    }
  }
}

export class ProviderProbeWorkerError extends Error {
  readonly code: string;
  readonly certainty: "notSent" | "possiblySent";

  constructor(
    code: string,
    options: ErrorOptions & {
      certainty?: "notSent" | "possiblySent";
    } = {},
  ) {
    super(code, options);
    this.name = "ProviderProbeWorkerError";
    this.code = code;
    this.certainty = options.certainty ?? "notSent";
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (
    !/^application\/json(?:;|$)/iu.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    throw invalidResponse();
  }
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)
  ) {
    throw invalidResponse();
  }
  if (response.body === null) throw invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw invalidResponse();
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw invalidResponse(error);
  }
}

function parseResponse(value: unknown): ModelProviderProbeResult {
  if (
    !object(value) ||
    Object.keys(value).sort().join("\0") !==
      [
        "latencyMs",
        "catalogRevision",
        "modelCount",
        "models",
        "providerId",
        "runtimeBindingId",
        "retryAfterMs",
        "retryable",
        "status",
      ]
        .sort()
        .join("\0") ||
    !boundedField(value.providerId, 128) ||
    !Number.isSafeInteger(value.catalogRevision) ||
    Number(value.catalogRevision) < 1 ||
    !boundedField(value.runtimeBindingId, 512) ||
    typeof value.status !== "string" ||
    !STATUSES.has(value.status) ||
    !Number.isSafeInteger(value.latencyMs) ||
    Number(value.latencyMs) < 0 ||
    Number(value.latencyMs) > 10_000 ||
    typeof value.retryable !== "boolean" ||
    (value.modelCount !== null &&
      (!Number.isSafeInteger(value.modelCount) ||
        Number(value.modelCount) < 0 ||
        Number(value.modelCount) > MAX_MODELS)) ||
    (value.retryAfterMs !== null &&
      (!Number.isSafeInteger(value.retryAfterMs) ||
        Number(value.retryAfterMs) < 0 ||
        Number(value.retryAfterMs) > 86_400_000))
  ) {
    throw invalidResponse();
  }
  const models = parseModels(value.models);
  if (
    (models === null) !== (value.modelCount === null) ||
    (models !== null && models.length !== value.modelCount) ||
    (value.status === "ok") !== (models !== null)
  ) {
    throw invalidResponse();
  }
  if (
    (value.status === "ok" &&
      (value.retryAfterMs !== null || value.retryable !== false)) ||
    (value.status === "rateLimited" && value.retryable !== true) ||
    (value.status !== "rateLimited" && value.retryAfterMs !== null) ||
    ((value.status === "credentialMissing" ||
      value.status === "authenticationFailed" ||
      value.status === "bindingMismatch" ||
      value.status === "invalidResponse") &&
      value.retryable !== false)
  ) {
    throw invalidResponse();
  }
  return {
    providerId: value.providerId,
    catalogRevision: Number(value.catalogRevision),
    runtimeBindingId: value.runtimeBindingId,
    status: value.status as ModelProviderProbeResult["status"],
    models,
    modelCount: value.modelCount as number | null,
    latencyMs: Number(value.latencyMs),
    retryable: value.retryable,
    retryAfterMs: value.retryAfterMs as number | null,
  };
}

function parseModels(
  value: unknown,
): readonly ModelProviderProbeModel[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_MODELS) {
    throw invalidResponse();
  }
  const seen = new Set<string>();
  return value.map((model) => {
    if (
      !object(model) ||
      Object.keys(model).sort().join("\0") !==
        ["displayName", "id"].sort().join("\0") ||
      !boundedField(model.id, MAX_FIELD_BYTES) ||
      (model.displayName !== null &&
        !boundedField(model.displayName, MAX_FIELD_BYTES)) ||
      seen.has(model.id)
    ) {
      throw invalidResponse();
    }
    seen.add(model.id);
    return { id: model.id, displayName: model.displayName as string | null };
  });
}

function workerUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ProviderProbeWorkerError("provider_probe_worker_url_invalid");
  }
  url.pathname = "/internal/v1/model-provider-probe";
  return url;
}

function validateRequest(value: ModelProviderProbeRequest): void {
  if (
    !object(value) ||
    Object.keys(value).sort().join("\0") !==
      [
        "expectedProviderId",
        "expectedRevision",
        "expectedRuntimeBindingId",
        "tenantId",
      ]
        .sort()
        .join("\0") ||
    !boundedField(value.tenantId, 512) ||
    !boundedField(value.expectedProviderId, 128) ||
    !boundedField(value.expectedRuntimeBindingId, 512) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 1
  ) {
    throw new ProviderProbeWorkerError("provider_probe_request_invalid");
  }
}

function boundedSecret(value: string): string {
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (
    byteLength < 32 ||
    byteLength > 8_192 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ProviderProbeWorkerError("provider_probe_worker_token_invalid");
  }
  return value;
}

function boundedField(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function positiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ProviderProbeWorkerError("provider_probe_worker_timeout_invalid");
  }
  return value;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(cause?: unknown): ProviderProbeWorkerError {
  return new ProviderProbeWorkerError(
    "provider_probe_worker_response_invalid",
    {
      cause,
    },
  );
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
