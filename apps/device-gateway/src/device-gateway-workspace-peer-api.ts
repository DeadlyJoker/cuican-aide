import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ContractValidationError,
  DEVICE_GATEWAY_PEER_WORKSPACE_LIST_DISPATCH_PATH,
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES,
  parseDeviceWorkspaceListPeerDispatchRequest,
  parseDeviceWorkspaceListPeerDispatchResponse,
  type DeviceWorkspaceListDispatchError,
  type DeviceWorkspaceListPeerDispatchRequest,
  type DeviceWorkspaceListPeerDispatchResponse,
} from "@crewon/contracts";

import {
  workspacePeerRoute,
  sameWorkspacePeerRoute,
} from "./device-gateway-workspace-dispatch-router.ts";
import type { DeviceGatewayWorkspaceDispatchService } from "./device-gateway-workspace-dispatch-service.ts";
import type { DeviceConnectionRouteStorePort } from "./device-connection-route-store.ts";
import { validateGatewayId } from "./device-connection-route-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { GatewayIdentityVerifierPort } from "./gateway-identity.ts";
import type {
  GatewayAssertedWorkerIdentity,
  WorkspaceWorkerIdentity,
} from "./worker-identity.ts";
import type { WorkspaceWorkerRuntimeAuthorizerPort } from "./workspace-worker-runtime-authorizer.ts";

type WorkspaceDispatchPort = Pick<
  DeviceGatewayWorkspaceDispatchService,
  "execute" | "reconcile" | "cancel"
>;

/** Authenticates a peer Gateway and dispatches one non-recursive Workspace hop. */
export class DeviceGatewayWorkspacePeerApi {
  readonly #gatewayId: string;
  readonly #identityVerifier: GatewayIdentityVerifierPort;
  readonly #routes: DeviceConnectionRouteStorePort;
  readonly #workerAuthorizer: WorkspaceWorkerRuntimeAuthorizerPort;
  readonly #dispatch: WorkspaceDispatchPort;

  constructor(config: {
    gatewayId: string;
    identityVerifier: GatewayIdentityVerifierPort;
    routes: DeviceConnectionRouteStorePort;
    workerAuthorizer: WorkspaceWorkerRuntimeAuthorizerPort;
    dispatch: WorkspaceDispatchPort;
  }) {
    this.#gatewayId = validateGatewayId(config.gatewayId);
    this.#identityVerifier = config.identityVerifier;
    this.#routes = config.routes;
    this.#workerAuthorizer = config.workerAuthorizer;
    this.#dispatch = config.dispatch;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (request.url !== DEVICE_GATEWAY_PEER_WORKSPACE_LIST_DISPATCH_PATH) {
      return false;
    }
    if (request.method !== "POST") {
      writeError(
        response,
        405,
        "workspace_peer_method_invalid",
        false,
        "notSent",
        {
          allow: "POST",
        },
      );
      return true;
    }
    let peer;
    try {
      peer = await this.#identityVerifier.verify(request);
    } catch {
      writeError(
        response,
        403,
        "gateway_authentication_failed",
        false,
        "notSent",
      );
      return true;
    }
    const controller = new AbortController();
    const cleanupCancellation = bindRequestCancellation(
      request,
      response,
      controller,
    );
    try {
      requireJsonContentType(request.headers["content-type"]);
      const input = parseDeviceWorkspaceListPeerDispatchRequest(
        parseJson(await readRequestBody(request)),
      );
      if (peer.gatewayId !== input.sourceGatewayId) {
        throw new DeviceGatewayError("gateway_identity_mismatch");
      }
      if (input.route.gatewayId !== this.#gatewayId) {
        throw new DeviceGatewayError("workspace_peer_target_mismatch");
      }
      const current = await abortable(
        this.#routes.loadConnection(input.route.deviceId),
        controller.signal,
      );
      if (
        current === null ||
        !sameWorkspacePeerRoute(workspacePeerRoute(current), input.route)
      ) {
        throw new DeviceGatewayError("workspace_dispatch_route_stale");
      }
      const worker = peerWorker(input, peer.gatewayId, peer.authenticatedAt);
      this.#workerAuthorizer.authorize(worker, runtimeBindingId(input));
      const resolution = await dispatchOperation(
        this.#dispatch,
        worker,
        input,
        controller.signal,
      );
      const output = parseDeviceWorkspaceListPeerDispatchResponse(
        {
          schemaVersion:
            "crewon.device-workspace-list-peer-dispatch-response.v0",
          apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
          route: input.route,
          operation: input.operation,
          resolution,
        },
        input,
      );
      writeJson(response, 200, output);
    } catch (error) {
      const projection = safeErrorProjection(error);
      writeError(
        response,
        projection.statusCode,
        projection.code,
        projection.retryable,
        projection.certainty,
      );
    } finally {
      cleanupCancellation();
    }
    return true;
  }
}

function dispatchOperation(
  dispatch: WorkspaceDispatchPort,
  worker: WorkspaceWorkerIdentity,
  input: DeviceWorkspaceListPeerDispatchRequest,
  signal: AbortSignal,
) {
  switch (input.operation) {
    case "execute":
      return dispatch.execute(worker, input.command, signal);
    case "reconcile":
      return dispatch.reconcile(worker, input.reference, signal);
    case "cancel":
      return dispatch.cancel(worker, input.reference, signal);
  }
}

function peerWorker(
  input: DeviceWorkspaceListPeerDispatchRequest,
  assertingGatewayId: string,
  authenticatedAt: string,
): GatewayAssertedWorkerIdentity {
  return {
    workerId: input.sourceWorker.workerId,
    credentialId: input.sourceWorker.credentialId,
    authenticationMethod: "gatewayAssertion",
    assertingGatewayId,
    authenticatedAt,
  };
}

function runtimeBindingId(input: DeviceWorkspaceListPeerDispatchRequest) {
  return input.operation === "execute"
    ? input.command.runtimeBindingId
    : input.reference.runtimeBindingId;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES)
  ) {
    throw new DeviceGatewayError("device_workspace_peer_request_too_large");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES) {
      throw new DeviceGatewayError("device_workspace_peer_request_too_large");
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    throw new DeviceGatewayError("device_workspace_peer_request_empty");
  }
  return Buffer.concat(chunks, bytes);
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new DeviceGatewayError("device_workspace_peer_json_invalid", {
      cause: error,
    });
  }
}

function requireJsonContentType(value: string | undefined): void {
  if (
    value === undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value)
  ) {
    throw new DeviceGatewayError("device_workspace_peer_content_type_invalid");
  }
}

function safeErrorProjection(error: unknown): Readonly<{
  statusCode: number;
  code: string;
  retryable: boolean;
  certainty: "notSent" | "possiblySent";
}> {
  if (error instanceof ContractValidationError) {
    return {
      statusCode: 400,
      code: error.code,
      retryable: false,
      certainty: "notSent",
    };
  }
  if (error instanceof DeviceGatewayError) {
    switch (error.code) {
      case "gateway_identity_mismatch":
      case "workspace_worker_runtime_unauthorized":
        return {
          statusCode: 403,
          code: error.code,
          retryable: false,
          certainty: "notSent",
        };
      case "workspace_dispatch_identity_conflict":
      case "workspace_dispatch_event_conflict":
      case "workspace_dispatch_terminal_conflict":
      case "device_dispatch_kind_conflict":
        return {
          statusCode: 409,
          code: error.code,
          retryable: false,
          certainty: "notSent",
        };
      case "workspace_dispatch_route_stale":
      case "workspace_dispatch_route_unavailable":
      case "device_unavailable":
      case "device_capability_unavailable":
      case "device_dispatch_store_busy":
        return {
          statusCode: 503,
          code: error.code,
          retryable: true,
          certainty: "notSent",
        };
      case "workspace_dispatch_not_sent":
        return {
          statusCode: 503,
          code: error.code,
          retryable: true,
          certainty: "notSent",
        };
      case "workspace_dispatch_possibly_sent":
      case "device_session_closed":
      case "device_frame_send_failed":
        return {
          statusCode: 503,
          code: error.code,
          retryable: true,
          certainty: "possiblySent",
        };
      case "device_workspace_peer_request_too_large":
        return {
          statusCode: 413,
          code: error.code,
          retryable: false,
          certainty: "notSent",
        };
      case "workspace_peer_target_mismatch":
      case "device_workspace_peer_request_empty":
      case "device_workspace_peer_json_invalid":
      case "device_workspace_peer_content_type_invalid":
        return {
          statusCode: 400,
          code: error.code,
          retryable: false,
          certainty: "notSent",
        };
      default:
        break;
    }
  }
  return {
    statusCode: 500,
    code: "workspace_peer_internal",
    retryable: false,
    certainty: "possiblySent",
  };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new DeviceGatewayError("workspace_dispatch_not_sent"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new DeviceGatewayError("workspace_dispatch_not_sent"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function bindRequestCancellation(
  request: IncomingMessage,
  response: ServerResponse,
  controller: AbortController,
): () => void {
  const abort = () => controller.abort("workspace_peer_disconnected");
  const close = () => {
    if (!response.writableEnded) abort();
  };
  request.once("aborted", abort);
  response.once("close", close);
  return () => {
    request.off("aborted", abort);
    response.off("close", close);
  };
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  retryable: boolean,
  certainty: "notSent" | "possiblySent",
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  writeJson(
    response,
    statusCode,
    {
      schemaVersion: "crewon.device-workspace-list-dispatch-error.v0",
      apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
      code,
      retryable,
      certainty,
    },
    extraHeaders,
  );
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body:
    | DeviceWorkspaceListPeerDispatchResponse
    | DeviceWorkspaceListDispatchError,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": String(encoded.byteLength),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(encoded);
}
