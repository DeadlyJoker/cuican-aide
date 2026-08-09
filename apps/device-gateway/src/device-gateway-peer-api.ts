import type { IncomingMessage, ServerResponse } from "node:http";

import {
  DEVICE_DISPATCH_API_VERSION,
  parseDeviceDispatchApiResponse,
  type DeviceDispatchApiError,
  type DeviceDispatchApiResponse,
} from "@crewon/contracts";

import type { DeviceGatewayDispatchRouter } from "./device-gateway-dispatch-router.ts";
import {
  DEVICE_GATEWAY_PEER_DISPATCH_PATH,
  parseDeviceGatewayPeerDispatchRequest,
} from "./device-gateway-peer-contract.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { GatewayIdentityVerifierPort } from "./gateway-identity.ts";

const MAX_REQUEST_BYTES = 192 * 1024;

type ExpectedDispatchPort = Pick<
  DeviceGatewayDispatchRouter,
  "dispatchExpected"
>;

export class DeviceGatewayPeerApi {
  readonly #identityVerifier: GatewayIdentityVerifierPort;
  readonly #dispatch: ExpectedDispatchPort;

  constructor(config: {
    identityVerifier: GatewayIdentityVerifierPort;
    dispatch: ExpectedDispatchPort;
  }) {
    this.#identityVerifier = config.identityVerifier;
    this.#dispatch = config.dispatch;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (request.url !== DEVICE_GATEWAY_PEER_DISPATCH_PATH) {
      return false;
    }
    if (request.method !== "POST") {
      writeError(response, 405, "device_gateway_peer_method_invalid", false, {
        allow: "POST",
      });
      return true;
    }
    let identity;
    try {
      identity = await this.#identityVerifier.verify(request);
    } catch {
      writeError(response, 403, "gateway_authentication_failed", false);
      return true;
    }
    try {
      requireJsonContentType(request.headers["content-type"]);
      const body = await readRequestBody(request);
      const input = parseDeviceGatewayPeerDispatchRequest(parseJson(body));
      if (identity.gatewayId !== input.sourceGatewayId) {
        throw new DeviceGatewayError("gateway_identity_mismatch");
      }
      const resolution = await this.#dispatch.dispatchExpected(
        input.route,
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

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)
  ) {
    throw new DeviceGatewayError("device_gateway_peer_request_too_large");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new DeviceGatewayError("device_gateway_peer_request_too_large");
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    throw new DeviceGatewayError("device_gateway_peer_request_empty");
  }
  return Buffer.concat(chunks, bytes);
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new DeviceGatewayError("device_gateway_peer_request_json_invalid", {
      cause: error,
    });
  }
}

function requireJsonContentType(value: string | undefined): void {
  if (
    value === undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value)
  ) {
    throw new DeviceGatewayError("device_gateway_peer_content_type_invalid");
  }
}

function safeErrorProjection(error: unknown): Readonly<{
  statusCode: number;
  code: string;
  retryable: boolean;
}> {
  if (!(error instanceof DeviceGatewayError)) {
    return {
      statusCode: 500,
      code: "device_gateway_peer_internal",
      retryable: false,
    };
  }
  switch (error.code) {
    case "gateway_identity_mismatch":
      return { statusCode: 403, code: error.code, retryable: false };
    case "device_dispatch_identity_conflict":
    case "device_dispatch_terminal_conflict":
      return { statusCode: 409, code: error.code, retryable: false };
    case "device_connection_route_stale":
    case "device_gateway_peer_unavailable":
    case "device_dispatch_capacity_exceeded":
    case "device_dispatch_store_busy":
      return { statusCode: 503, code: error.code, retryable: true };
    case "device_gateway_peer_request_too_large":
      return { statusCode: 413, code: error.code, retryable: false };
    case "device_gateway_peer_content_type_invalid":
    case "device_gateway_peer_operation_invalid":
    case "device_gateway_peer_request_empty":
    case "device_gateway_peer_request_invalid":
    case "device_gateway_peer_request_json_invalid":
    case "device_gateway_peer_route_mismatch":
      return { statusCode: 400, code: error.code, retryable: false };
    default:
      return {
        statusCode: 500,
        code: "device_gateway_peer_internal",
        retryable: false,
      };
  }
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
