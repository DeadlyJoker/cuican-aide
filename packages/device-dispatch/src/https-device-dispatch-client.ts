import { Agent, request as httpsRequest } from "node:https";

import {
  DEVICE_DISPATCH_API_VERSION,
  DEVICE_GATEWAY_WORKER_DISPATCH_PATH,
  parseDeviceDispatchApiError,
  parseDeviceDispatchApiRequest,
  parseDeviceDispatchApiResponse,
  type DeviceDispatchOperation,
  type DeviceExecutionCommand,
  type DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import type {
  DeviceDispatchClientPort,
  DeviceDispatchResolution,
} from "./device-tool-runtime.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type DeviceDispatchHttpResponse = Readonly<{
  statusCode: number;
  contentType: string | null;
  body: Uint8Array;
}>;

/** Carries one already-validated API envelope over an authenticated channel. */
export interface DeviceDispatchHttpTransportPort {
  post(
    body: Uint8Array,
    signal: AbortSignal,
  ): Promise<DeviceDispatchHttpResponse>;
  close(): void;
}

export class DeviceDispatchClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly statusCode: number | null;

  constructor(
    code: string,
    options: Readonly<{
      retryable?: boolean;
      statusCode?: number | null;
      cause?: unknown;
    }> = {},
  ) {
    super(code, { cause: options.cause });
    this.name = "DeviceDispatchClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? null;
  }
}

export class DeviceDispatchProtocolClient implements DeviceDispatchClientPort {
  readonly #transport: DeviceDispatchHttpTransportPort;

  constructor(transport: DeviceDispatchHttpTransportPort) {
    this.#transport = transport;
  }

  execute(
    command: DeviceExecutionCommand,
    signal: AbortSignal,
  ): Promise<DeviceDispatchResolution> {
    return this.#invoke("execute", command, signal);
  }

  reconcile(
    command: DeviceExecutionCommand,
    signal: AbortSignal,
  ): Promise<DeviceDispatchResolution> {
    return this.#invoke("reconcile", command, signal);
  }

  cancel(
    command: DeviceExecutionCommand,
    signal: AbortSignal,
  ): Promise<DeviceDispatchResolution> {
    return this.#invoke("cancel", command, signal);
  }

  async close(): Promise<void> {
    this.#transport.close();
  }

  async #invoke(
    operation: DeviceDispatchOperation,
    command: DeviceExecutionCommand,
    signal: AbortSignal,
  ): Promise<DeviceDispatchResolution> {
    if (signal.aborted) {
      throw new DeviceDispatchClientError("device_dispatch_aborted");
    }
    const envelope = parseDeviceDispatchApiRequest({
      schemaVersion: "crewon.device-dispatch-request.v0",
      apiVersion: DEVICE_DISPATCH_API_VERSION,
      operation,
      command,
    });
    const response = await this.#transport.post(
      Buffer.from(JSON.stringify(envelope), "utf8"),
      signal,
    );
    requireJsonResponse(response);
    const decoded = parseJson(response.body);
    if (response.statusCode !== 200) {
      let remote;
      try {
        remote = parseDeviceDispatchApiError(decoded);
      } catch (error) {
        throw new DeviceDispatchClientError(
          "device_dispatch_remote_error_invalid",
          { statusCode: response.statusCode, cause: error },
        );
      }
      throw new DeviceDispatchClientError(remote.code, {
        retryable: remote.retryable,
        statusCode: response.statusCode,
      });
    }
    let success;
    try {
      success = parseDeviceDispatchApiResponse(decoded);
    } catch (error) {
      throw new DeviceDispatchClientError(
        "device_dispatch_remote_response_invalid",
        { statusCode: response.statusCode, cause: error },
      );
    }
    if (success.operation !== operation) {
      throw new DeviceDispatchClientError(
        "device_dispatch_remote_operation_mismatch",
        { statusCode: response.statusCode },
      );
    }
    return providerResolution(success.resolution);
  }
}

export class HttpsDeviceDispatchClient extends DeviceDispatchProtocolClient {
  constructor(config: {
    endpoint: string | URL;
    tls: Readonly<{
      key: string | Buffer;
      cert: string | Buffer;
      ca: string | Buffer | readonly (string | Buffer)[];
      servername?: string;
    }>;
    requestTimeoutMs?: number;
  }) {
    super(new NodeHttpsDeviceDispatchTransport(config));
  }
}

export class NodeHttpsDeviceDispatchTransport
  implements DeviceDispatchHttpTransportPort
{
  readonly #endpoint: URL;
  readonly #agent: Agent;
  readonly #requestTimeoutMs: number;
  #closed = false;

  constructor(config: {
    endpoint: string | URL;
    tls: Readonly<{
      key: string | Buffer;
      cert: string | Buffer;
      ca: string | Buffer | readonly (string | Buffer)[];
      servername?: string;
    }>;
    requestTimeoutMs?: number;
  }) {
    this.#endpoint = validateEndpoint(config.endpoint);
    this.#requestTimeoutMs = boundedInteger(
      config.requestTimeoutMs ?? 35_000,
      1_000,
      24 * 60 * 60 * 1_000,
      "device_dispatch_timeout_invalid",
    );
    requireTlsMaterial(config.tls.key, "device_dispatch_tls_key_invalid");
    requireTlsMaterial(config.tls.cert, "device_dispatch_tls_cert_invalid");
    const authorities = Array.isArray(config.tls.ca)
      ? config.tls.ca
      : [config.tls.ca];
    if (authorities.length < 1 || authorities.length > 32) {
      throw new DeviceDispatchClientError("device_dispatch_tls_ca_invalid");
    }
    for (const authority of authorities) {
      requireTlsMaterial(authority, "device_dispatch_tls_ca_invalid");
    }
    if (
      config.tls.servername !== undefined &&
      (!/^[A-Za-z0-9.-]{1,253}$/.test(config.tls.servername) ||
        config.tls.servername.startsWith(".") ||
        config.tls.servername.endsWith("."))
    ) {
      throw new DeviceDispatchClientError(
        "device_dispatch_tls_servername_invalid",
      );
    }
    this.#agent = new Agent({
      keepAlive: true,
      maxSockets: 64,
      maxFreeSockets: 16,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      key: config.tls.key,
      cert: config.tls.cert,
      ca: [...authorities],
      servername: config.tls.servername,
    });
  }

  post(
    body: Uint8Array,
    signal: AbortSignal,
  ): Promise<DeviceDispatchHttpResponse> {
    if (this.#closed) {
      return Promise.reject(
        new DeviceDispatchClientError("device_dispatch_client_closed"),
      );
    }
    if (signal.aborted) {
      return Promise.reject(
        new DeviceDispatchClientError("device_dispatch_aborted"),
      );
    }
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        this.#endpoint,
        {
          agent: this.#agent,
          method: "POST",
          path: DEVICE_GATEWAY_WORKER_DISPATCH_PATH,
          headers: {
            "accept": "application/json",
            "content-length": String(body.byteLength),
            "content-type": "application/json; charset=utf-8",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              response.destroy(
                new DeviceDispatchClientError(
                  "device_dispatch_response_too_large",
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => {
            cleanup();
            resolve({
              statusCode: response.statusCode ?? 0,
              contentType:
                typeof response.headers["content-type"] === "string"
                  ? response.headers["content-type"]
                  : null,
              body: Buffer.concat(chunks, bytes),
            });
          });
          response.once("error", fail);
        },
      );
      const onAbort = () => {
        request.destroy(
          new DeviceDispatchClientError("device_dispatch_aborted"),
        );
      };
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const fail = (error: unknown) => {
        cleanup();
        reject(
          error instanceof DeviceDispatchClientError
            ? error
            : new DeviceDispatchClientError(
                "device_dispatch_transport_failed",
                {
                  retryable: true,
                  cause: error,
                },
              ),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      request.setTimeout(this.#requestTimeoutMs, () => {
        request.destroy(
          new DeviceDispatchClientError("device_dispatch_transport_timeout", {
            retryable: true,
          }),
        );
      });
      request.once("error", fail);
      request.end(body);
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#agent.destroy();
  }
}

function providerResolution(
  resolution: DeviceGatewayDispatchResolution,
): DeviceDispatchResolution {
  switch (resolution.status) {
    case "completed":
      return {
        status: "completed",
        executionId: resolution.executionId,
        providerReceiptId: resolution.providerReceiptId,
        output:
          resolution.terminal.data.output ??
          resolution.output.map((event) => event.data.chunk).join(""),
        artifactRef: resolution.terminal.data.artifactRef,
      };
    case "failed":
      return {
        status: "failed",
        executionId: resolution.executionId,
        providerReceiptId: resolution.providerReceiptId,
        code: resolution.terminal.data.code,
        retryable: resolution.terminal.data.retryable,
      };
    case "canceled":
      return {
        status: "canceled",
        executionId: resolution.executionId,
        providerReceiptId: resolution.providerReceiptId,
      };
    case "unknownOutcome":
      return {
        status: "unknownOutcome",
        executionId: resolution.executionId,
        providerReceiptId: resolution.providerReceiptId,
      };
  }
}

function requireJsonResponse(response: DeviceDispatchHttpResponse): void {
  if (
    !Number.isSafeInteger(response.statusCode) ||
    response.statusCode < 100 ||
    response.statusCode > 599 ||
    response.contentType === null ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      response.contentType,
    ) ||
    response.body.byteLength < 1 ||
    response.body.byteLength > MAX_RESPONSE_BYTES
  ) {
    throw new DeviceDispatchClientError(
      "device_dispatch_http_response_invalid",
    );
  }
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch (error) {
    throw new DeviceDispatchClientError(
      "device_dispatch_response_json_invalid",
      {
        cause: error,
      },
    );
  }
}

function validateEndpoint(input: string | URL): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(input);
  } catch (error) {
    throw new DeviceDispatchClientError("device_dispatch_endpoint_invalid", {
      cause: error,
    });
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (endpoint.pathname !== "" && endpoint.pathname !== "/")
  ) {
    throw new DeviceDispatchClientError("device_dispatch_endpoint_invalid");
  }
  return new URL(endpoint.origin);
}

function requireTlsMaterial(value: string | Buffer, code: string): void {
  const bytes = Buffer.isBuffer(value)
    ? value.byteLength
    : Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > 4 * 1024 * 1024) {
    throw new DeviceDispatchClientError(code);
  }
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DeviceDispatchClientError(code);
  }
  return value;
}
