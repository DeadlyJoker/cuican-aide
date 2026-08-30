import {
  Agent,
  request as nodeHttpsRequest,
  type RequestOptions,
} from "node:https";

import {
  DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES,
  parseDeviceWorkspaceListDispatchError,
  parseDeviceWorkspaceListDispatchReference,
  parseDeviceWorkspaceListPeerDispatchRequest,
  parseDeviceWorkspaceListWorkerDispatchRequest,
  parseDeviceWorkspaceListWorkerDispatchResponse,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListDispatchResolution,
  type DeviceWorkspaceListPeerDispatchRequest,
  type DeviceWorkspaceListPeerRoute,
  type DeviceWorkspaceListPeerSourceWorker,
  type DeviceWorkspaceListWorkerDispatchRequest,
} from "@crewon/contracts";

export type DeviceWorkspaceListDispatchHttpResponse = Readonly<{
  statusCode: number;
  contentType: string | null;
  body: Uint8Array;
}>;

/** Bounded transport for the private Worker-to-Gateway Workspace endpoint. */
export interface DeviceWorkspaceListDispatchHttpTransportPort {
  post(
    body: Uint8Array,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<DeviceWorkspaceListDispatchHttpResponse>;
  close(): void;
}

export interface DeviceWorkspaceListDispatchClientPort {
  execute(
    command: DeviceWorkspaceListCommand,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution>;
  reconcile(
    reference: DeviceWorkspaceListDispatchReference,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution>;
  cancel(
    reference: DeviceWorkspaceListDispatchReference,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution>;
  close(): Promise<void>;
}

export class DeviceWorkspaceListDispatchClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly certainty: "notSent" | "possiblySent";

  constructor(
    code: string,
    options: Readonly<{
      retryable?: boolean;
      statusCode?: number | null;
      certainty: "notSent" | "possiblySent";
      cause?: unknown;
    }>,
  ) {
    super(code, { cause: options.cause });
    this.name = "DeviceWorkspaceListDispatchClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? null;
    this.certainty = options.certainty;
  }
}

export type DeviceWorkspaceListDispatchRequestIntent =
  | Readonly<{
      operation: "execute";
      command: DeviceWorkspaceListCommand;
    }>
  | Readonly<{
      operation: "reconcile" | "cancel";
      reference: DeviceWorkspaceListDispatchReference;
    }>;

/** Builds only the provider-neutral private protocol envelope. */
export function createDeviceWorkspaceListDispatchRequest(
  input: DeviceWorkspaceListDispatchRequestIntent,
): DeviceWorkspaceListWorkerDispatchRequest {
  return parseDeviceWorkspaceListWorkerDispatchRequest(
    input.operation === "execute"
      ? {
          schemaVersion: "crewon.device-workspace-list-dispatch-request.v0",
          apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
          operation: input.operation,
          command: input.command,
        }
      : {
          schemaVersion: "crewon.device-workspace-list-dispatch-request.v0",
          apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
          operation: input.operation,
          reference: parseDeviceWorkspaceListDispatchReference(input.reference),
        },
  );
}

/**
 * Builds a peer envelope after the source Gateway has authenticated the Worker.
 * `sourceWorker` must come from that mTLS-backed registry decision, never caller
 * headers or browser input.
 */
export function createDeviceWorkspaceListPeerDispatchRequest(
  input: Readonly<{
    sourceGatewayId: string;
    sourceWorker: DeviceWorkspaceListPeerSourceWorker;
    route: DeviceWorkspaceListPeerRoute;
    intent: DeviceWorkspaceListDispatchRequestIntent;
  }>,
): DeviceWorkspaceListPeerDispatchRequest {
  const common = {
    schemaVersion:
      "crewon.device-workspace-list-peer-dispatch-request.v0" as const,
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    sourceGatewayId: input.sourceGatewayId,
    sourceWorker: input.sourceWorker,
    route: input.route,
  };
  return parseDeviceWorkspaceListPeerDispatchRequest(
    input.intent.operation === "execute"
      ? {
          ...common,
          operation: input.intent.operation,
          command: input.intent.command,
        }
      : {
          ...common,
          operation: input.intent.operation,
          reference: input.intent.reference,
        },
  );
}

export class DeviceWorkspaceListDispatchProtocolClient
  implements DeviceWorkspaceListDispatchClientPort
{
  readonly #transport: DeviceWorkspaceListDispatchHttpTransportPort;
  readonly #requestTimeoutMs: number;
  readonly #now: () => Date;

  constructor(
    transport: DeviceWorkspaceListDispatchHttpTransportPort,
    options: Readonly<{
      requestTimeoutMs?: number;
      now?: () => Date;
    }> = {},
  ) {
    this.#transport = transport;
    this.#requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? 35_000,
      1_000,
      60_000,
      "device_workspace_dispatch_timeout_invalid",
    );
    this.#now = options.now ?? (() => new Date());
  }

  execute(
    command: DeviceWorkspaceListCommand,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    return this.#invoke({ operation: "execute", command }, signal);
  }

  reconcile(
    reference: DeviceWorkspaceListDispatchReference,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    return this.#invoke({ operation: "reconcile", reference }, signal);
  }

  cancel(
    reference: DeviceWorkspaceListDispatchReference,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    return this.#invoke({ operation: "cancel", reference }, signal);
  }

  async close(): Promise<void> {
    this.#transport.close();
  }

  async #invoke(
    intent: DeviceWorkspaceListDispatchRequestIntent,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    const request = createDeviceWorkspaceListDispatchRequest(intent);
    if (signal.aborted) {
      throw clientError("device_workspace_dispatch_aborted", "notSent");
    }
    const nowMs = this.#now().getTime();
    if (!Number.isFinite(nowMs)) {
      throw clientError("device_workspace_dispatch_clock_invalid", "notSent");
    }
    const timeoutMs =
      request.operation === "execute"
        ? Math.min(
            this.#requestTimeoutMs,
            Date.parse(request.command.expiresAt) - nowMs,
          )
        : this.#requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw clientError(
        "device_workspace_dispatch_deadline_exceeded",
        "notSent",
      );
    }
    const body = Buffer.from(JSON.stringify(request), "utf8");
    let response: DeviceWorkspaceListDispatchHttpResponse;
    try {
      response = await this.#transport.post(body, signal, timeoutMs);
    } catch (error) {
      throw error instanceof DeviceWorkspaceListDispatchClientError
        ? error
        : clientError(
            "device_workspace_dispatch_transport_failed",
            "possiblySent",
            { retryable: true, cause: error },
          );
    }
    requireJsonResponse(response);
    const decoded = parseJson(response.body);
    if (response.statusCode !== 200) {
      let remote;
      try {
        remote = parseDeviceWorkspaceListDispatchError(decoded);
      } catch (error) {
        throw clientError(
          "device_workspace_dispatch_remote_error_invalid",
          "possiblySent",
          { statusCode: response.statusCode, cause: error },
        );
      }
      throw clientError(remote.code, remote.certainty, {
        retryable: remote.retryable,
        statusCode: response.statusCode,
      });
    }
    try {
      return parseDeviceWorkspaceListWorkerDispatchResponse(decoded, request)
        .resolution;
    } catch (error) {
      throw clientError(
        "device_workspace_dispatch_remote_response_invalid",
        "possiblySent",
        { statusCode: response.statusCode, cause: error },
      );
    }
  }
}

export class HttpsDeviceWorkspaceListDispatchClient extends DeviceWorkspaceListDispatchProtocolClient {
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
    requestFactory?: DeviceWorkspaceListHttpsRequestFactory;
    deadlineScheduler?: DeviceWorkspaceListDispatchDeadlineSchedulerPort;
  }) {
    super(new NodeHttpsDeviceWorkspaceListDispatchTransport(config), {
      requestTimeoutMs: config.requestTimeoutMs,
      now: config.now,
    });
  }
}

import {
  NodeHttpsDeviceWorkspaceListDispatchTransport,
  boundedInteger,
  clientError,
  parseJson,
  requireJsonResponse,
  type DeviceWorkspaceListDispatchDeadlineSchedulerPort,
  type DeviceWorkspaceListHttpsRequestFactory,
} from "./workspace-list-dispatch-transport.ts";
export { NodeHttpsDeviceWorkspaceListDispatchTransport } from "./workspace-list-dispatch-transport.ts";
export type {
  DeviceWorkspaceListDispatchDeadlineSchedulerPort,
  DeviceWorkspaceListHttpsRequestFactory,
  DeviceWorkspaceListHttpsRequestPort,
  DeviceWorkspaceListHttpsResponsePort,
} from "./workspace-list-dispatch-transport.ts";
