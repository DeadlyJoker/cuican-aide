import { createHash } from "node:crypto";

import {
  DEVICE_FILESYSTEM_READ_DISPATCH_API_VERSION,
  DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES,
  parseDeviceFilesystemReadDispatchError,
  parseDeviceFilesystemReadDispatchReference,
  parseDeviceFilesystemReadWorkerDispatchRequest,
  parseDeviceFilesystemReadWorkerDispatchResponse,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadDispatchReference,
  type DeviceFilesystemReadDispatchResolution,
  type DeviceFilesystemReadRouteIntent,
  type DeviceFilesystemReadWorkerDispatchRequest,
} from "@crewon/contracts";

import {
  RuntimeWorkspaceReadGatewayClientError,
  RuntimeWorkspaceReadHttpsTransport,
  failure,
  type RuntimeWorkspaceReadDeadlineSchedulerPort,
  type RuntimeWorkspaceReadGatewayHttpResponse,
  type RuntimeWorkspaceReadGatewayTransportPort,
  type RuntimeWorkspaceReadHttpsRequestFactory,
} from "./runtime-workspace-read-gateway-transport.ts";

export * from "./runtime-workspace-read-gateway-transport.ts";

export interface RuntimeWorkspaceReadGatewayClientPort {
  execute(
    intent: DeviceFilesystemReadRouteIntent,
    command: DeviceFilesystemReadCommand,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadDispatchResolution>;
  reconcile(
    intent: DeviceFilesystemReadRouteIntent,
    reference: DeviceFilesystemReadDispatchReference,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadDispatchResolution>;
  cancel(
    intent: DeviceFilesystemReadRouteIntent,
    reference: DeviceFilesystemReadDispatchReference,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadDispatchResolution>;
  close(): Promise<void>;
}

type Intent =
  | Readonly<{
      operation: "execute";
      routeIntent: DeviceFilesystemReadRouteIntent;
      command: DeviceFilesystemReadCommand;
    }>
  | Readonly<{
      operation: "reconcile" | "cancel";
      routeIntent: DeviceFilesystemReadRouteIntent;
      reference: DeviceFilesystemReadDispatchReference;
    }>;

/** Strict protocol client for the private Runtime Worker-to-Gateway read API. */
export class RuntimeWorkspaceReadGatewayProtocolClient
  implements RuntimeWorkspaceReadGatewayClientPort
{
  readonly #transport: RuntimeWorkspaceReadGatewayTransportPort;
  readonly #requestTimeoutMs: number;
  readonly #now: () => Date;

  constructor(
    transport: RuntimeWorkspaceReadGatewayTransportPort,
    options: Readonly<{ requestTimeoutMs?: number; now?: () => Date }> = {},
  ) {
    this.#transport = transport;
    this.#requestTimeoutMs = integer(options.requestTimeoutMs ?? 35_000);
    this.#now = options.now ?? (() => new Date());
  }

  execute(
    routeIntent: DeviceFilesystemReadRouteIntent,
    command: DeviceFilesystemReadCommand,
    signal: AbortSignal,
  ) {
    return this.#invoke({ operation: "execute", routeIntent, command }, signal);
  }
  reconcile(
    routeIntent: DeviceFilesystemReadRouteIntent,
    reference: DeviceFilesystemReadDispatchReference,
    signal: AbortSignal,
  ) {
    return this.#invoke(
      { operation: "reconcile", routeIntent, reference },
      signal,
    );
  }
  cancel(
    routeIntent: DeviceFilesystemReadRouteIntent,
    reference: DeviceFilesystemReadDispatchReference,
    signal: AbortSignal,
  ) {
    return this.#invoke(
      { operation: "cancel", routeIntent, reference },
      signal,
    );
  }
  async close(): Promise<void> {
    this.#transport.close();
  }

  async #invoke(intent: Intent, signal: AbortSignal) {
    const request = requestOf(intent);
    if (signal.aborted)
      throw failure("workspace_read_gateway_aborted", "notSent");
    const now = this.#now().getTime();
    if (!Number.isFinite(now))
      throw failure("workspace_read_gateway_clock_invalid", "notSent");
    const timeoutMs =
      request.operation === "execute"
        ? Math.min(
            this.#requestTimeoutMs,
            Date.parse(request.command.expiresAt) - now,
          )
        : this.#requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw failure("workspace_read_gateway_deadline_exceeded", "notSent");
    let response: RuntimeWorkspaceReadGatewayHttpResponse;
    try {
      response = await this.#transport.post(
        Buffer.from(JSON.stringify(request), "utf8"),
        signal,
        timeoutMs,
      );
    } catch (error) {
      throw error instanceof RuntimeWorkspaceReadGatewayClientError
        ? error
        : failure("workspace_read_gateway_transport_failed", "possiblySent", {
            retryable: true,
            cause: error,
          });
    }
    requireJsonResponse(response);
    const decoded = decode(response.body);
    if (response.statusCode !== 200) {
      try {
        const remote = parseDeviceFilesystemReadDispatchError(decoded);
        throw failure(remote.code, remote.certainty, {
          retryable: remote.retryable,
          statusCode: response.statusCode,
        });
      } catch (error) {
        if (error instanceof RuntimeWorkspaceReadGatewayClientError)
          throw error;
        throw failure("workspace_read_gateway_error_invalid", "possiblySent", {
          statusCode: response.statusCode,
          cause: error,
        });
      }
    }
    try {
      return parseDeviceFilesystemReadWorkerDispatchResponse(
        decoded,
        request,
        digestUtf8,
      ).resolution;
    } catch (error) {
      throw failure("workspace_read_gateway_response_invalid", "possiblySent", {
        statusCode: response.statusCode,
        cause: error,
      });
    }
  }
}

/** Production HTTPS/mTLS construction for the registered Worker identity. */
export class HttpsRuntimeWorkspaceReadGatewayClient extends RuntimeWorkspaceReadGatewayProtocolClient {
  constructor(config: {
    endpoint: string | URL;
    tls: Readonly<{
      key: string | Buffer;
      cert: string | Buffer;
      ca: string | Buffer | readonly (string | Buffer)[];
      servername?: string;
    }>;
    requestTimeoutMs?: number;
    now?: () => Date;
    requestFactory?: RuntimeWorkspaceReadHttpsRequestFactory;
    deadlineScheduler?: RuntimeWorkspaceReadDeadlineSchedulerPort;
  }) {
    super(new RuntimeWorkspaceReadHttpsTransport(config), config);
  }
}

function requestOf(intent: Intent): DeviceFilesystemReadWorkerDispatchRequest {
  return parseDeviceFilesystemReadWorkerDispatchRequest(
    intent.operation === "execute"
      ? {
          schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0",
          apiVersion: DEVICE_FILESYSTEM_READ_DISPATCH_API_VERSION,
          ...intent,
        }
      : {
          schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0",
          apiVersion: DEVICE_FILESYSTEM_READ_DISPATCH_API_VERSION,
          ...intent,
          reference: parseDeviceFilesystemReadDispatchReference(
            intent.reference,
          ),
        },
  );
}
function requireJsonResponse(
  response: RuntimeWorkspaceReadGatewayHttpResponse,
) {
  if (
    !Number.isSafeInteger(response.statusCode) ||
    response.statusCode < 100 ||
    response.statusCode > 599 ||
    response.contentType === null ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
      response.contentType,
    ) ||
    response.body.byteLength < 1 ||
    response.body.byteLength >
      DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES
  )
    throw failure(
      "workspace_read_gateway_http_response_invalid",
      "possiblySent",
    );
}
function decode(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch (cause) {
    throw failure(
      "workspace_read_gateway_response_json_invalid",
      "possiblySent",
      { cause },
    );
  }
}
function digestUtf8(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function integer(value: number) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60_000)
    throw failure("workspace_read_gateway_timeout_invalid", "notSent");
  return value;
}
