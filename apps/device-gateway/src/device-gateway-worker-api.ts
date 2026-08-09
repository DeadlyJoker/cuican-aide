import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ContractValidationError,
  DEVICE_DISPATCH_API_VERSION,
  DEVICE_GATEWAY_WORKER_DISPATCH_PATH,
  parseDeviceDispatchApiRequest,
  parseDeviceDispatchApiResponse,
  type DeviceDispatchApiError,
  type DeviceDispatchApiResponse,
  type DeviceDispatchOperation,
  type DeviceExecutionCommand,
  type DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import type { DeviceGatewayDispatchService } from "./device-gateway-dispatch-service.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { WorkerIdentityVerifierPort } from "./worker-identity.ts";

const MAX_REQUEST_BYTES = 160 * 1024;

type DispatchPort = Pick<
  DeviceGatewayDispatchService,
  "execute" | "reconcile" | "cancel"
>;

export class DeviceGatewayWorkerApi {
  readonly #identityVerifier: WorkerIdentityVerifierPort;
  readonly #dispatch: DispatchPort;

  constructor(config: {
    identityVerifier: WorkerIdentityVerifierPort;
    dispatch: DispatchPort;
  }) {
    this.#identityVerifier = config.identityVerifier;
    this.#dispatch = config.dispatch;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (request.url !== DEVICE_GATEWAY_WORKER_DISPATCH_PATH) {
      return false;
    }
    if (request.method !== "POST") {
      writeError(response, 405, "device_dispatch_method_invalid", false, {
        allow: "POST",
      });
      return true;
    }
    try {
      await this.#identityVerifier.verify(request);
    } catch {
      writeError(response, 403, "worker_authentication_failed", false);
      return true;
    }
    try {
      requireJsonContentType(request.headers["content-type"]);
      const body = await readRequestBody(request);
      const input = parseDeviceDispatchApiRequest(parseJson(body));
      const resolution = await dispatchOperation(
        this.#dispatch,
        input.operation,
        input.command,
      );
      const output = parseDeviceDispatchApiResponse({
        schemaVersion: "crewon.device-dispatch-response.v0",
        apiVersion: DEVICE_DISPATCH_API_VERSION,
        operation: input.operation,
        resolution,
      } satisfies DeviceDispatchApiResponse);
      writeJson(response, 200, output);
    } catch (error) {
      const projection = safeErrorProjection(error);
      writeError(
        response,
        projection.statusCode,
        projection.code,
        projection.retryable,
      );
    }
    return true;
  }
}

function dispatchOperation(
  dispatch: DispatchPort,
  operation: DeviceDispatchOperation,
  command: DeviceExecutionCommand,
): Promise<DeviceGatewayDispatchResolution> {
  switch (operation) {
    case "execute":
      return dispatch.execute(command);
    case "reconcile":
      return dispatch.reconcile(command);
    case "cancel":
      return dispatch.cancel(command);
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)
  ) {
    throw new DeviceGatewayError("device_dispatch_request_too_large");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new DeviceGatewayError("device_dispatch_request_too_large");
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    throw new DeviceGatewayError("device_dispatch_request_empty");
  }
  return Buffer.concat(chunks, bytes);
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new DeviceGatewayError("device_dispatch_request_json_invalid", {
      cause: error,
    });
  }
}

function requireJsonContentType(value: string | undefined): void {
  if (
    value === undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value)
  ) {
    throw new DeviceGatewayError("device_dispatch_content_type_invalid");
  }
}

function safeErrorProjection(error: unknown): Readonly<{
  statusCode: number;
  code: string;
  retryable: boolean;
}> {
  if (error instanceof ContractValidationError) {
    return { statusCode: 400, code: error.code, retryable: false };
  }
  if (error instanceof DeviceGatewayError) {
    switch (error.code) {
      case "device_dispatch_request_too_large":
        return { statusCode: 413, code: error.code, retryable: false };
      case "device_dispatch_identity_conflict":
      case "device_dispatch_terminal_conflict":
        return { statusCode: 409, code: error.code, retryable: false };
      case "device_unavailable":
      case "device_connection_route_stale":
      case "device_gateway_peer_unavailable":
      case "device_dispatch_capacity_exceeded":
      case "device_dispatch_store_busy":
        return { statusCode: 503, code: error.code, retryable: true };
      case "device_dispatch_content_type_invalid":
      case "device_dispatch_request_empty":
      case "device_dispatch_request_json_invalid":
        return { statusCode: 400, code: error.code, retryable: false };
      default:
        return {
          statusCode: 500,
          code: "device_dispatch_internal",
          retryable: false,
        };
    }
  }
  return {
    statusCode: 500,
    code: "device_dispatch_internal",
    retryable: false,
  };
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  retryable: boolean,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const error: DeviceDispatchApiError = {
    schemaVersion: "crewon.device-dispatch-error.v0",
    apiVersion: DEVICE_DISPATCH_API_VERSION,
    code,
    retryable,
  };
  writeJson(response, statusCode, error, extraHeaders);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: DeviceDispatchApiResponse | DeviceDispatchApiError,
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
