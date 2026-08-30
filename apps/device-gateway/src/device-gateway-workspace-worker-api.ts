import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ContractValidationError,
  DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES,
  parseDeviceWorkspaceListWorkerDispatchRequest,
  parseDeviceWorkspaceListWorkerDispatchResponse,
  type DeviceWorkspaceListDispatchError,
  type DeviceWorkspaceListWorkerDispatchRequest,
  type DeviceWorkspaceListWorkerDispatchResponse,
} from "@crewon/contracts";

import type { DeviceGatewayWorkspaceDispatchService } from "./device-gateway-workspace-dispatch-service.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type {
  AuthenticatedWorkerIdentity,
  WorkerIdentityVerifierPort,
} from "./worker-identity.ts";

type WorkspaceDispatchPort = Pick<
  DeviceGatewayWorkspaceDispatchService,
  "execute" | "reconcile" | "cancel"
>;

export class DeviceGatewayWorkspaceWorkerApi {
  readonly #identityVerifier: WorkerIdentityVerifierPort;
  readonly #dispatch: WorkspaceDispatchPort;

  constructor(config: {
    identityVerifier: WorkerIdentityVerifierPort;
    dispatch: WorkspaceDispatchPort;
  }) {
    this.#identityVerifier = config.identityVerifier;
    this.#dispatch = config.dispatch;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (request.url !== DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH) {
      return false;
    }
    if (request.method !== "POST") {
      writeError(response, 405, "workspace_dispatch_method_invalid", false, {
        allow: "POST",
      });
      return true;
    }
    let worker: AuthenticatedWorkerIdentity;
    try {
      worker = await this.#identityVerifier.verify(request);
    } catch {
      writeError(response, 403, "worker_authentication_failed", false);
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
      const body = await readRequestBody(request);
      const input = parseDeviceWorkspaceListWorkerDispatchRequest(
        parseJson(body),
      );
      const resolution = await dispatchOperation(
        this.#dispatch,
        worker,
        input,
        controller.signal,
      );
      const output = parseDeviceWorkspaceListWorkerDispatchResponse(
        {
          schemaVersion: "crewon.device-workspace-list-dispatch-response.v0",
          apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
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
        undefined,
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
  worker: AuthenticatedWorkerIdentity,
  input: DeviceWorkspaceListWorkerDispatchRequest,
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

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES)
  ) {
    throw new DeviceGatewayError("device_workspace_dispatch_request_too_large");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES) {
      throw new DeviceGatewayError(
        "device_workspace_dispatch_request_too_large",
      );
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    throw new DeviceGatewayError("device_workspace_dispatch_request_empty");
  }
  return Buffer.concat(chunks, bytes);
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new DeviceGatewayError("device_workspace_dispatch_json_invalid", {
      cause: error,
    });
  }
}

function requireJsonContentType(value: string | undefined): void {
  if (
    value === undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value)
  ) {
    throw new DeviceGatewayError(
      "device_workspace_dispatch_content_type_invalid",
    );
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
      case "workspace_worker_runtime_unauthorized":
      case "device_authorization_key_unknown":
      case "device_authorization_expired":
      case "device_authorization_signature_invalid":
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
      case "device_unavailable":
      case "device_capability_unavailable":
      case "workspace_dispatch_route_unavailable":
      case "workspace_dispatch_route_stale":
      case "workspace_dispatch_route_expired":
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
        return {
          statusCode: 503,
          code: error.code,
          retryable: true,
          certainty: "possiblySent",
        };
      case "device_session_closed":
      case "device_frame_send_failed":
        return {
          statusCode: 503,
          code: "workspace_dispatch_transport_unknown",
          retryable: true,
          certainty: "possiblySent",
        };
      case "device_workspace_dispatch_request_too_large":
        return {
          statusCode: 413,
          code: error.code,
          retryable: false,
          certainty: "notSent",
        };
      case "device_workspace_dispatch_request_empty":
      case "device_workspace_dispatch_json_invalid":
      case "device_workspace_dispatch_content_type_invalid":
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
    code: "workspace_dispatch_internal",
    retryable: false,
    certainty: "possiblySent",
  };
}

function bindRequestCancellation(
  request: IncomingMessage,
  response: ServerResponse,
  controller: AbortController,
): () => void {
  const abort = () => controller.abort("workspace_worker_disconnected");
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
  extraHeaders: Readonly<Record<string, string>> = {},
  certainty: "notSent" | "possiblySent" = "notSent",
): void {
  const error: DeviceWorkspaceListDispatchError = {
    schemaVersion: "crewon.device-workspace-list-dispatch-error.v0",
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    code,
    retryable,
    certainty,
  };
  writeJson(response, statusCode, error, extraHeaders);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body:
    | DeviceWorkspaceListWorkerDispatchResponse
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
