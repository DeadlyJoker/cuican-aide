import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ContractValidationError,
  DEVICE_FILESYSTEM_READ_DISPATCH_API_VERSION,
  DEVICE_FILESYSTEM_READ_DISPATCH_MAX_REQUEST_BYTES,
  DEVICE_GATEWAY_PEER_FILESYSTEM_READ_DISPATCH_PATH,
  DEVICE_GATEWAY_WORKER_FILESYSTEM_READ_DISPATCH_PATH,
  parseDeviceFilesystemReadPeerDispatchRequest,
  parseDeviceFilesystemReadPeerDispatchResponse,
  parseDeviceFilesystemReadWorkerDispatchRequest,
  parseDeviceFilesystemReadWorkerDispatchResponse,
  type DeviceFilesystemReadPeerDispatchRequest,
  type DeviceFilesystemReadDispatchReference,
  type DeviceFilesystemReadDispatchResolution,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadRouteIntent,
  type DeviceFilesystemReadWorkerDispatchRequest,
} from "@crewon/contracts";

import type { DeviceConnectionRouteStorePort } from "./device-connection-route-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { WorkspaceReadSessionRegistryPort } from "./device-gateway-workspace-read-service.ts";
import type { GatewayIdentityVerifierPort } from "./gateway-identity.ts";
import type {
  WorkerIdentityVerifierPort,
  WorkspaceWorkerIdentity,
} from "./worker-identity.ts";
import type { WorkspaceWorkerRuntimeAuthorizerPort } from "./workspace-worker-runtime-authorizer.ts";

export interface WorkspaceReadApiDispatchPort {
  execute(
    worker: WorkspaceWorkerIdentity,
    intent: DeviceFilesystemReadRouteIntent,
    command: DeviceFilesystemReadCommand,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadDispatchResolution>;
  reconcile(
    worker: WorkspaceWorkerIdentity,
    intent: DeviceFilesystemReadRouteIntent,
    reference: DeviceFilesystemReadDispatchReference,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadDispatchResolution>;
  cancel(
    worker: WorkspaceWorkerIdentity,
    intent: DeviceFilesystemReadRouteIntent,
    reference: DeviceFilesystemReadDispatchReference,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadDispatchResolution>;
}

export class DeviceGatewayWorkspaceReadWorkerApi {
  readonly #config: {
    identityVerifier: WorkerIdentityVerifierPort;
    dispatch: WorkspaceReadApiDispatchPort;
  };
  constructor(config: {
    identityVerifier: WorkerIdentityVerifierPort;
    dispatch: WorkspaceReadApiDispatchPort;
  }) {
    this.#config = config;
  }
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (request.url !== DEVICE_GATEWAY_WORKER_FILESYSTEM_READ_DISPATCH_PATH)
      return false;
    return handle(request, response, async (signal) => {
      const worker = await this.#config.identityVerifier
        .verify(request)
        .catch(() => {
          throw new DeviceGatewayError("worker_authentication_failed");
        });
      const input = parseDeviceFilesystemReadWorkerDispatchRequest(
        await body(request),
      );
      const resolution = await dispatch(
        this.#config.dispatch,
        worker,
        input,
        signal,
      );
      return parseDeviceFilesystemReadWorkerDispatchResponse(
        {
          schemaVersion: "crewon.device-filesystem-read-dispatch-response.v0",
          apiVersion: DEVICE_FILESYSTEM_READ_DISPATCH_API_VERSION,
          operation: input.operation,
          resolution,
        },
        input,
        digestUtf8,
      );
    });
  }
}

export class DeviceGatewayWorkspaceReadPeerApi {
  readonly #config: {
    gatewayId: string;
    identityVerifier: GatewayIdentityVerifierPort;
    routes: DeviceConnectionRouteStorePort;
    sessions: WorkspaceReadSessionRegistryPort;
    workerAuthorizer: WorkspaceWorkerRuntimeAuthorizerPort;
    dispatch: WorkspaceReadApiDispatchPort;
    now?: () => Date;
  };
  constructor(config: {
    gatewayId: string;
    identityVerifier: GatewayIdentityVerifierPort;
    routes: DeviceConnectionRouteStorePort;
    sessions: WorkspaceReadSessionRegistryPort;
    workerAuthorizer: WorkspaceWorkerRuntimeAuthorizerPort;
    dispatch: WorkspaceReadApiDispatchPort;
    now?: () => Date;
  }) {
    this.#config = config;
  }
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (request.url !== DEVICE_GATEWAY_PEER_FILESYSTEM_READ_DISPATCH_PATH)
      return false;
    return handle(request, response, async (signal) => {
      const peer = await this.#config.identityVerifier
        .verify(request)
        .catch(() => {
          throw new DeviceGatewayError("gateway_authentication_failed");
        });
      const input = parseDeviceFilesystemReadPeerDispatchRequest(
        await body(request),
      );
      if (
        input.sourceGatewayId !== peer.gatewayId ||
        input.route.gatewayId !== this.#config.gatewayId
      )
        throw new DeviceGatewayError("gateway_identity_mismatch");
      const current = await this.#config.routes.loadConnection(
        input.route.deviceId,
      );
      const intent = {
        deviceBindingId: input.route.deviceBindingId,
        runtimeBindingId: input.route.runtimeBindingId,
      };
      const target = this.#config.sessions.workspaceReadSession(
        input.route.deviceId,
        intent,
      );
      const now = (this.#config.now ?? (() => new Date()))().getTime();
      if (
        current === null ||
        target === null ||
        current.gatewayId !== input.route.gatewayId ||
        current.connectionId !== input.route.connectionId ||
        current.epoch !== input.route.connectionEpoch ||
        Date.parse(input.route.leaseExpiresAt) <= now ||
        Date.parse(current.leaseExpiresAt) <
          Date.parse(input.route.leaseExpiresAt) ||
        !sameWorkspaceReadPeerRoute(target.route, input.route)
      )
        throw new DeviceGatewayError("workspace_read_route_stale");
      const worker = {
        workerId: input.sourceWorker.workerId,
        credentialId: input.sourceWorker.credentialId,
        authenticationMethod: "gatewayAssertion" as const,
        assertingGatewayId: peer.gatewayId,
        authenticatedAt: peer.authenticatedAt,
      };
      this.#config.workerAuthorizer.authorize(
        worker,
        input.route.runtimeBindingId,
      );
      const workerInput = peerToWorker(input);
      const resolution = await dispatch(
        this.#config.dispatch,
        worker,
        workerInput,
        signal,
      );
      return parseDeviceFilesystemReadPeerDispatchResponse(
        {
          schemaVersion:
            "crewon.device-filesystem-read-peer-dispatch-response.v0",
          apiVersion: DEVICE_FILESYSTEM_READ_DISPATCH_API_VERSION,
          route: input.route,
          operation: input.operation,
          resolution,
        },
        input,
        digestUtf8,
      );
    });
  }
}

function peerToWorker(
  input: DeviceFilesystemReadPeerDispatchRequest,
): DeviceFilesystemReadWorkerDispatchRequest {
  const common = {
    schemaVersion: "crewon.device-filesystem-read-dispatch-request.v0" as const,
    apiVersion: 1 as const,
    routeIntent: {
      deviceBindingId: input.route.deviceBindingId,
      runtimeBindingId: input.route.runtimeBindingId,
    },
  };
  return input.operation === "execute"
    ? { ...common, operation: input.operation, command: input.command }
    : { ...common, operation: input.operation, reference: input.reference };
}
function dispatch(
  port: WorkspaceReadApiDispatchPort,
  worker: WorkspaceWorkerIdentity,
  input: DeviceFilesystemReadWorkerDispatchRequest,
  signal: AbortSignal,
) {
  if (input.operation === "execute")
    return port.execute(worker, input.routeIntent, input.command, signal);
  return port[input.operation](
    worker,
    input.routeIntent,
    input.reference,
    signal,
  );
}
async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  action: (signal: AbortSignal) => Promise<unknown>,
): Promise<true> {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return true;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once("aborted", abort);
  try {
    write(response, 200, await action(controller.signal));
  } catch (error) {
    const projected = project(error);
    write(response, projected.status, {
      schemaVersion: "crewon.device-filesystem-read-dispatch-error.v0",
      apiVersion: 1,
      code: projected.code,
      retryable: projected.retryable,
      certainty: projected.certainty,
    });
  } finally {
    request.off("aborted", abort);
  }
  return true;
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
      request.headers["content-type"] ?? "",
    )
  )
    throw new DeviceGatewayError("device_filesystem_read_content_type_invalid");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > DEVICE_FILESYSTEM_READ_DISPATCH_MAX_REQUEST_BYTES)
      throw new DeviceGatewayError("device_filesystem_read_dispatch_too_large");
    chunks.push(value);
  }
  if (bytes === 0)
    throw new DeviceGatewayError("device_filesystem_read_dispatch_empty");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DeviceGatewayError("device_filesystem_read_json_invalid");
  }
}
function write(response: ServerResponse, status: number, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(body.length),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}
function project(error: unknown) {
  if (error instanceof ContractValidationError)
    return {
      status: 400,
      code: error.code,
      retryable: false,
      certainty: "notSent" as const,
    };
  const code =
    error instanceof DeviceGatewayError
      ? error.code
      : "workspace_read_internal";
  if (
    code === "worker_authentication_failed" ||
    code === "gateway_authentication_failed" ||
    code === "workspace_worker_runtime_unauthorized"
  )
    return {
      status: 403,
      code,
      retryable: false,
      certainty: "notSent" as const,
    };
  if (
    code.includes("identity_conflict") ||
    code === "gateway_identity_mismatch"
  )
    return {
      status: 409,
      code,
      retryable: false,
      certainty: "notSent" as const,
    };
  const possiblySent =
    code === "workspace_read_possibly_sent" ||
    code === "device_frame_send_failed";
  return {
    status: 503,
    code: possiblySent ? "workspace_read_possibly_sent" : code,
    retryable: true,
    certainty: possiblySent ? ("possiblySent" as const) : ("notSent" as const),
  };
}
function digestUtf8(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
export function sameWorkspaceReadPeerRoute(
  left: DeviceFilesystemReadPeerDispatchRequest["route"],
  right: DeviceFilesystemReadPeerDispatchRequest["route"],
) {
  return (
    left.deviceId === right.deviceId &&
    left.gatewayId === right.gatewayId &&
    left.connectionId === right.connectionId &&
    left.connectionEpoch === right.connectionEpoch &&
    left.deviceBindingId === right.deviceBindingId &&
    left.runtimeBindingId === right.runtimeBindingId &&
    left.capability === right.capability &&
    Date.parse(left.leaseExpiresAt) >= Date.parse(right.leaseExpiresAt)
  );
}
