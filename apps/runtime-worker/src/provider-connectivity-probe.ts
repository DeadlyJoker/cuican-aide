import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";

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
  readonly #certificateAuthority: string | undefined;

  constructor(options: { certificateAuthority?: string } = {}) {
    this.#certificateAuthority = options.certificateAuthority;
  }

  request(
    input: Readonly<{
      target: PinnedProviderProbeEndpoint;
      authorization: string | null;
    }>,
    signal: AbortSignal,
  ): Promise<ProviderProbeHttpResponse> {
    return new Promise((resolve, reject) => {
      const options: RequestOptions = {
        method: "GET",
        agent: false,
        headers: {
          accept: "application/json",
          ...(input.authorization === null
            ? {}
            : { authorization: input.authorization }),
        },
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all === true) {
            callback(null, [
              {
                address: input.target.address,
                family: input.target.family,
              },
            ]);
            return;
          }
          callback(null, input.target.address, input.target.family);
        },
        signal,
      };
      if (input.target.endpoint.protocol === "https:") {
        options.servername =
          isIP(input.target.endpoint.hostname) === 0
            ? input.target.endpoint.hostname
            : undefined;
        options.ca = this.#certificateAuthority;
      }
      const request = (input.target.endpoint.protocol === "https:"
        ? httpsRequest
        : httpRequest)(input.target.endpoint, options);
      request.once("response", (response) => {
        if (
          !sameRemoteAddress(
            response.socket.remoteAddress,
            input.target.address,
            input.target.family,
          )
        ) {
          response.destroy(
            new ProviderProbeProtocolError("remote_address_mismatch"),
          );
          return;
        }
        const declared = response.headers["content-length"];
        if (
          typeof declared === "string" &&
          (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)
        ) {
          response.destroy(new ProviderProbeProtocolError("body_too_large"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > MAX_BODY_BYTES) {
            response.destroy(new ProviderProbeProtocolError("body_too_large"));
            return;
          }
          chunks.push(bytes);
        });
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              "content-type": header(response.headers["content-type"]),
              "retry-after": header(response.headers["retry-after"]),
            },
            body: Buffer.concat(chunks, total),
          });
        });
        response.once("error", reject);
      });
      request.once("error", reject);
      request.end();
    });
  }
}

function sameRemoteAddress(
  remoteAddress: string | undefined,
  approvedAddress: string,
  family: 4 | 6,
): boolean {
  if (remoteAddress === approvedAddress) return true;
  return (
    family === 4 && remoteAddress === `::ffff:${approvedAddress.toLowerCase()}`
  );
}

/** Performs one bounded OpenAI-compatible `/models` request. */
export class ResponsesProviderConnectivityProbe {
  readonly #tenantId: string;
  readonly #providerId: string;
  readonly #catalogRevision: number;
  readonly #runtimeBindingId: string;
  readonly #endpoint: URL;
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
    },
    dependencies: {
      egress: ProviderProbeEgressResolver;
      http?: ProviderProbeHttpPort;
      now?: () => number;
      schedule?: (callback: () => void, delayMs: number) => () => void;
    },
  ) {
    this.#tenantId = bounded(config.tenantId, 512, "provider_probe_tenant_invalid");
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
    this.#endpoint = modelsEndpoint(config.endpoint);
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
      const target = await this.#egress.resolve(
        {
          tenantId: this.#tenantId,
          providerId: this.#providerId,
          endpoint: this.#endpoint,
        },
        combined,
      );
      const response = await this.#http.request(
        {
          target,
          authorization:
            this.#secret === null ? null : `Bearer ${this.#secret}`,
        },
        combined,
      );
      return projectResponse(
        this.#providerId,
        this.#catalogRevision,
        this.#runtimeBindingId,
        this.#secret,
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
}

function projectResponse(
  providerId: string,
  catalogRevision: number,
  runtimeBindingId: string,
  secretValue: string | null,
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
  const models = parseModels(response.body, secretValue);
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
): readonly ModelProviderProbeModel[] | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!object(value)) return null;
  const items = Array.isArray(value.data)
    ? value.data
    : Array.isArray(value.models)
      ? value.models
      : null;
  if (items === null || items.length > MAX_MODELS) return null;
  const seen = new Set<string>();
  const models: ModelProviderProbeModel[] = [];
  for (const item of items) {
    if (
      !object(item) ||
      !boundedModelField(item.id) ||
      containsSecret(item.id, secretValue) ||
      seen.has(item.id)
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
    seen.add(item.id);
    models.push({ id: item.id, displayName: display });
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

function modelsEndpoint(value: string): URL {
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
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/models`;
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

function header(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ProviderProbeProtocolError extends Error {}
