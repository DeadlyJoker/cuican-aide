import { createHash } from "node:crypto";
import { Agent, request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";

import {
  DEVICE_GATEWAY_PEER_WORKSPACE_LIST_DISPATCH_PATH,
  DEVICE_GATEWAY_PEER_FILESYSTEM_READ_DISPATCH_PATH,
  DEVICE_FILESYSTEM_READ_DISPATCH_API_VERSION,
  DEVICE_FILESYSTEM_READ_DISPATCH_MAX_REQUEST_BYTES,
  DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES,
  DEVICE_FILESYSTEM_READ_DISPATCH_MAX_ERROR_BYTES,
  parseDeviceFilesystemReadDispatchError,
  parseDeviceFilesystemReadPeerDispatchRequest,
  parseDeviceFilesystemReadPeerDispatchResponse,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadDispatchOperation,
  type DeviceFilesystemReadDispatchReference,
  type DeviceFilesystemReadDispatchResolution,
  type DeviceFilesystemReadPeerRoute,
  type DeviceFilesystemReadPeerSourceWorker,
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_ERROR_BYTES,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES,
  parseDeviceWorkspaceListDispatchError,
  parseDeviceWorkspaceListPeerDispatchRequest,
  parseDeviceWorkspaceListPeerDispatchResponse,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListDispatchOperation,
  type DeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListDispatchResolution,
  type DeviceWorkspaceListPeerRoute,
  type DeviceWorkspaceListPeerSourceWorker,
} from "@crewon/contracts";

import type { GatewayRegistration } from "./device-registry-config.ts";
import type { DeviceGatewayWorkspacePeerDispatchPort } from "./device-gateway-workspace-dispatch-router.ts";
import type { DeviceGatewayWorkspaceReadPeerDispatchPort } from "./device-gateway-workspace-read-router.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

type WorkspaceDispatchInput =
  | DeviceWorkspaceListCommand
  | DeviceWorkspaceListDispatchReference;

type WorkspacePeerEndpoint = Readonly<{
  endpoint: URL;
  fingerprint256: string;
}>;

/** Sends one bounded, route-fenced Workspace operation over Gateway mTLS. */
export class HttpsDeviceGatewayWorkspacePeerClient
  implements
    DeviceGatewayWorkspacePeerDispatchPort,
    DeviceGatewayWorkspaceReadPeerDispatchPort
{
  readonly #sourceGatewayId: string;
  readonly #peers: ReadonlyMap<string, WorkspacePeerEndpoint>;
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
      30_000,
      "workspace_peer_timeout_invalid",
    );
    requireTlsMaterial(config.tls.key, "workspace_peer_tls_key_invalid");
    requireTlsMaterial(
      config.tls.cert,
      "workspace_peer_tls_certificate_invalid",
    );
    const authorities = Array.isArray(config.tls.ca)
      ? config.tls.ca
      : [config.tls.ca];
    if (authorities.length < 1 || authorities.length > 32) {
      throw new DeviceGatewayError("workspace_peer_tls_ca_invalid");
    }
    for (const authority of authorities) {
      requireTlsMaterial(authority, "workspace_peer_tls_ca_invalid");
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
    route: DeviceWorkspaceListPeerRoute,
    operation: DeviceWorkspaceListDispatchOperation,
    input: WorkspaceDispatchInput,
    sourceWorker: DeviceWorkspaceListPeerSourceWorker,
    signal: AbortSignal,
  ): Promise<DeviceWorkspaceListDispatchResolution> {
    if (this.#closed) {
      throw new DeviceGatewayError("workspace_peer_client_closed");
    }
    if (signal.aborted) {
      throw new DeviceGatewayError("workspace_dispatch_not_sent");
    }
    if (route.gatewayId === this.#sourceGatewayId) {
      throw new DeviceGatewayError("workspace_peer_self_route");
    }
    const peer = this.#peers.get(route.gatewayId);
    if (peer === undefined) {
      throw new DeviceGatewayError("workspace_dispatch_route_unavailable");
    }
    const requestEnvelope = parseDeviceWorkspaceListPeerDispatchRequest({
      schemaVersion: "crewon.device-workspace-list-peer-dispatch-request.v0",
      apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
      sourceGatewayId: this.#sourceGatewayId,
      sourceWorker,
      route,
      operation,
      ...(operation === "execute" ? { command: input } : { reference: input }),
    });
    const body = Buffer.from(JSON.stringify(requestEnvelope), "utf8");
    if (body.byteLength > DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES) {
      throw new DeviceGatewayError("device_workspace_peer_request_too_large");
    }
    const response = await this.#post(
      peer,
      DEVICE_GATEWAY_PEER_WORKSPACE_LIST_DISPATCH_PATH,
      body,
      signal,
      "workspaceList",
    );
    requireJsonResponse(response);
    const decoded = parseJson(response.body);
    if (response.statusCode !== 200) {
      try {
        const remote = parseDeviceWorkspaceListDispatchError(decoded);
        throw new DeviceGatewayError(
          remote.certainty === "possiblySent"
            ? "workspace_dispatch_possibly_sent"
            : remote.code,
        );
      } catch (error) {
        if (error instanceof DeviceGatewayError) throw error;
        throw new DeviceGatewayError("workspace_peer_response_invalid", {
          cause: error,
        });
      }
    }
    try {
      return parseDeviceWorkspaceListPeerDispatchResponse(
        decoded,
        requestEnvelope,
      ).resolution;
    } catch (error) {
      throw new DeviceGatewayError("workspace_peer_response_invalid", {
        cause: error,
      });
    }
  }

  async dispatchRead(
    route: DeviceFilesystemReadPeerRoute,
    operation: DeviceFilesystemReadDispatchOperation,
    input: DeviceFilesystemReadCommand | DeviceFilesystemReadDispatchReference,
    sourceWorker: DeviceFilesystemReadPeerSourceWorker,
    signal: AbortSignal,
  ): Promise<DeviceFilesystemReadDispatchResolution> {
    if (this.#closed)
      throw new DeviceGatewayError("workspace_read_peer_client_closed");
    if (signal.aborted) throw new DeviceGatewayError("workspace_read_not_sent");
    if (route.gatewayId === this.#sourceGatewayId)
      throw new DeviceGatewayError("workspace_read_peer_self_route");
    const peer = this.#peers.get(route.gatewayId);
    if (peer === undefined)
      throw new DeviceGatewayError("workspace_read_route_unavailable");
    const envelope = parseDeviceFilesystemReadPeerDispatchRequest({
      schemaVersion: "crewon.device-filesystem-read-peer-dispatch-request.v0",
      apiVersion: DEVICE_FILESYSTEM_READ_DISPATCH_API_VERSION,
      sourceGatewayId: this.#sourceGatewayId,
      sourceWorker,
      route,
      operation,
      ...(operation === "execute" ? { command: input } : { reference: input }),
    });
    const body = Buffer.from(JSON.stringify(envelope));
    if (body.length > DEVICE_FILESYSTEM_READ_DISPATCH_MAX_REQUEST_BYTES)
      throw new DeviceGatewayError("device_filesystem_read_dispatch_too_large");
    const response = await this.#post(
      peer,
      DEVICE_GATEWAY_PEER_FILESYSTEM_READ_DISPATCH_PATH,
      body,
      signal,
      "workspaceRead",
    );
    requireJsonResponse(
      response,
      DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES,
      DEVICE_FILESYSTEM_READ_DISPATCH_MAX_ERROR_BYTES,
    );
    const decoded = parseJson(response.body);
    if (response.statusCode !== 200) {
      try {
        const remote = parseDeviceFilesystemReadDispatchError(decoded);
        throw new DeviceGatewayError(
          remote.certainty === "possiblySent"
            ? "workspace_read_possibly_sent"
            : remote.code,
        );
      } catch (error) {
        if (error instanceof DeviceGatewayError) throw error;
        throw new DeviceGatewayError("workspace_read_peer_response_invalid", {
          cause: error,
        });
      }
    }
    try {
      return parseDeviceFilesystemReadPeerDispatchResponse(
        decoded,
        envelope,
        digestUtf8,
      ).resolution;
    } catch (error) {
      throw new DeviceGatewayError("workspace_read_peer_response_invalid", {
        cause: error,
      });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#agent.destroy();
  }

  #post(
    peer: WorkspacePeerEndpoint,
    path: string,
    body: Buffer,
    signal: AbortSignal,
    kind: "workspaceList" | "workspaceRead",
  ): Promise<
    Readonly<{ statusCode: number; contentType: string | null; body: Buffer }>
  > {
    return new Promise((resolve, reject) => {
      let settled = false;
      let sent = false;
      const finish = <T>(continuation: (value: T) => void, value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        continuation(value);
      };
      const fail = (error: unknown) => {
        const projected =
          error instanceof DeviceGatewayError
            ? error
            : new DeviceGatewayError(
                sent ? possiblySentCode(kind) : notSentCode(kind),
                { cause: error },
              );
        finish(reject, projected);
      };
      const request = httpsRequest(
        peer.endpoint,
        {
          agent: this.#agent,
          method: "POST",
          path,
          headers: {
            "accept": "application/json",
            "content-length": String(body.byteLength),
            "content-type": "application/json; charset=utf-8",
          },
        },
        (response) => {
          if (
            !hasExpectedPeerCertificate(response.socket, peer.fingerprint256)
          ) {
            response.destroy(
              new DeviceGatewayError("workspace_peer_server_identity_mismatch"),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            const maximum =
              kind === "workspaceRead"
                ? DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES
                : DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES;
            if (bytes > maximum) {
              response.destroy(
                new DeviceGatewayError("workspace_peer_response_too_large"),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => {
            finish(resolve, {
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
      const abort = () => {
        request.destroy(
          new DeviceGatewayError(
            sent ? possiblySentCode(kind) : notSentCode(kind),
          ),
        );
      };
      const timer = setTimeout(() => {
        request.destroy(
          new DeviceGatewayError(
            sent ? possiblySentCode(kind) : notSentCode(kind),
          ),
        );
      }, this.#requestTimeoutMs);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
      request.once("error", fail);
      sent = true;
      request.end(body);
    });
  }
}

function digestUtf8(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function gatewayEndpoints(
  registrations: readonly GatewayRegistration[],
): ReadonlyMap<string, WorkspacePeerEndpoint> {
  const peers = new Map<string, WorkspacePeerEndpoint>();
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
      throw new DeviceGatewayError("workspace_peer_registry_invalid");
    }
    if (
      !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/u.test(registration.fingerprint256)
    ) {
      throw new DeviceGatewayError("workspace_peer_registry_invalid");
    }
    peers.set(gatewayId, {
      endpoint,
      fingerprint256: registration.fingerprint256,
    });
  }
  return peers;
}

function hasExpectedPeerCertificate(
  socket: unknown,
  expectedFingerprint256: string,
): boolean {
  const certificate = (socket as TLSSocket).getPeerCertificate?.();
  return (
    certificate !== undefined &&
    certificate !== null &&
    certificate.fingerprint256 === expectedFingerprint256
  );
}

function requireJsonResponse(
  response: Readonly<{
    statusCode: number;
    contentType: string | null;
    body: Buffer;
  }>,
  successMaximum = DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES,
  errorMaximum = DEVICE_WORKSPACE_LIST_DISPATCH_MAX_ERROR_BYTES,
): void {
  const maximum = response.statusCode === 200 ? successMaximum : errorMaximum;
  if (
    !Number.isSafeInteger(response.statusCode) ||
    response.statusCode < 100 ||
    response.statusCode > 599 ||
    response.contentType === null ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
      response.contentType,
    ) ||
    response.body.byteLength < 1 ||
    response.body.byteLength > maximum
  ) {
    throw new DeviceGatewayError("workspace_peer_response_invalid");
  }
}

function notSentCode(kind: "workspaceList" | "workspaceRead") {
  return kind === "workspaceRead"
    ? "workspace_read_not_sent"
    : "workspace_dispatch_not_sent";
}

function possiblySentCode(kind: "workspaceList" | "workspaceRead") {
  return kind === "workspaceRead"
    ? "workspace_read_possibly_sent"
    : "workspace_dispatch_possibly_sent";
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new DeviceGatewayError("workspace_peer_response_invalid", {
      cause: error,
    });
  }
}

function requireGatewayId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) {
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
