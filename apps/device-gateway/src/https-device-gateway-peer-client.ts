import { Agent, request as httpsRequest } from "node:https";

import {
  parseDeviceDispatchApiError,
  parseDeviceDispatchApiResponse,
  type DeviceDispatchOperation,
  type DeviceExecutionCommand,
  type DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import type { DeviceConnectionRoute } from "./device-connection-route-store.ts";
import type { GatewayRegistration } from "./device-registry-config.ts";
import type { DeviceGatewayPeerDispatchPort } from "./device-gateway-dispatch-router.ts";
import {
  DEVICE_GATEWAY_PEER_DISPATCH_PATH,
  parseDeviceGatewayPeerDispatchRequest,
} from "./device-gateway-peer-contract.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Sends one route-fenced dispatch to a statically registered Gateway over mTLS. */
export class HttpsDeviceGatewayPeerClient
  implements DeviceGatewayPeerDispatchPort
{
  readonly #sourceGatewayId: string;
  readonly #peers: ReadonlyMap<string, URL>;
  readonly #agent: Agent;
  readonly #requestTimeoutMs: number;
  #closed = false;

  constructor(config: {
    sourceGatewayId: string;
    gateways: readonly GatewayRegistration[];
    tls: Readonly<{
      key: string | Buffer;
      cert: string | Buffer;
      ca: string | Buffer | readonly (string | Buffer)[];
      servername?: string;
    }>;
    requestTimeoutMs?: number;
  }) {
    this.#sourceGatewayId = requireGatewayId(config.sourceGatewayId);
    this.#peers = gatewayEndpoints(config.gateways);
    this.#requestTimeoutMs = boundedInteger(
      config.requestTimeoutMs ?? 10_000,
      1_000,
      60_000,
      "device_gateway_peer_timeout_invalid",
    );
    requireTlsMaterial(config.tls.key, "device_gateway_peer_tls_key_invalid");
    requireTlsMaterial(
      config.tls.cert,
      "device_gateway_peer_tls_certificate_invalid",
    );
    const authorities = Array.isArray(config.tls.ca)
      ? config.tls.ca
      : [config.tls.ca];
    if (authorities.length < 1 || authorities.length > 32) {
      throw new DeviceGatewayError("device_gateway_peer_tls_ca_invalid");
    }
    for (const authority of authorities) {
      requireTlsMaterial(authority, "device_gateway_peer_tls_ca_invalid");
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

  async dispatch(
    route: DeviceConnectionRoute,
    operation: DeviceDispatchOperation,
    command: DeviceExecutionCommand,
  ): Promise<DeviceGatewayDispatchResolution> {
    if (this.#closed) {
      throw new DeviceGatewayError("device_gateway_peer_client_closed");
    }
    if (route.gatewayId === this.#sourceGatewayId) {
      throw new DeviceGatewayError("device_gateway_peer_self_route");
    }
    const endpoint = this.#peers.get(route.gatewayId);
    if (endpoint === undefined) {
      throw new DeviceGatewayError("device_gateway_peer_unavailable");
    }
    const envelope = parseDeviceGatewayPeerDispatchRequest({
      schemaVersion: "crewon.device-peer-dispatch-request.v0",
      sourceGatewayId: this.#sourceGatewayId,
      route,
      operation,
      command,
    });
    const body = Buffer.from(JSON.stringify(envelope), "utf8");
    const response = await this.#post(endpoint, body);
    requireJsonResponse(response);
    const decoded = parseJson(response.body);
    if (response.statusCode !== 200) {
      try {
        const remote = parseDeviceDispatchApiError(decoded);
        throw new DeviceGatewayError(remote.code);
      } catch (error) {
        if (error instanceof DeviceGatewayError) {
          throw error;
        }
        throw new DeviceGatewayError("device_gateway_peer_response_invalid", {
          cause: error,
        });
      }
    }
    let success;
    try {
      success = parseDeviceDispatchApiResponse(decoded);
    } catch (error) {
      throw new DeviceGatewayError("device_gateway_peer_response_invalid", {
        cause: error,
      });
    }
    if (success.operation !== operation) {
      throw new DeviceGatewayError("device_gateway_peer_operation_mismatch");
    }
    return success.resolution;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#agent.destroy();
  }

  #post(
    endpoint: URL,
    body: Buffer,
  ): Promise<
    Readonly<{ statusCode: number; contentType: string | null; body: Buffer }>
  > {
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        endpoint,
        {
          agent: this.#agent,
          method: "POST",
          path: DEVICE_GATEWAY_PEER_DISPATCH_PATH,
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
                new DeviceGatewayError(
                  "device_gateway_peer_response_too_large",
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => {
            resolve({
              statusCode: response.statusCode ?? 0,
              contentType:
                typeof response.headers["content-type"] === "string"
                  ? response.headers["content-type"]
                  : null,
              body: Buffer.concat(chunks, bytes),
            });
          });
          response.once("error", rejectUnavailable);
        },
      );
      const rejectUnavailable = (error: unknown) => {
        reject(
          error instanceof DeviceGatewayError
            ? error
            : new DeviceGatewayError("device_gateway_peer_unavailable", {
                cause: error,
              }),
        );
      };
      request.setTimeout(this.#requestTimeoutMs, () => {
        request.destroy(
          new DeviceGatewayError("device_gateway_peer_unavailable"),
        );
      });
      request.once("error", rejectUnavailable);
      request.end(body);
    });
  }
}

function gatewayEndpoints(
  registrations: readonly GatewayRegistration[],
): ReadonlyMap<string, URL> {
  const peers = new Map<string, URL>();
  for (const registration of registrations) {
    const gatewayId = requireGatewayId(registration.gatewayId);
    const endpoint = new URL(registration.endpoint);
    if (
      peers.has(gatewayId) ||
      endpoint.protocol !== "https:" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.pathname !== "/" ||
      endpoint.search !== "" ||
      endpoint.hash !== "" ||
      endpoint.hostname.length === 0
    ) {
      throw new DeviceGatewayError("device_gateway_peer_registry_invalid");
    }
    peers.set(gatewayId, endpoint);
  }
  return peers;
}

function requireGatewayId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)) {
    throw new DeviceGatewayError("device_gateway_id_invalid");
  }
  return value;
}

function requireTlsMaterial(value: string | Buffer, code: string): void {
  const bytes =
    typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
  if (bytes < 1 || bytes > 4 * 1024 * 1024) {
    throw new DeviceGatewayError(code);
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DeviceGatewayError(code);
  }
  return value;
}

function requireJsonResponse(
  response: Readonly<{
    statusCode: number;
    contentType: string | null;
    body: Buffer;
  }>,
): void {
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
    throw new DeviceGatewayError("device_gateway_peer_response_invalid");
  }
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new DeviceGatewayError("device_gateway_peer_response_invalid", {
      cause: error,
    });
  }
}
