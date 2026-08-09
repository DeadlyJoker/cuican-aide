import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { ModelProviderProbeRequest } from "@crewon/application";

import type { RuntimeProviderProbeService } from "./provider-probe-service.ts";

const MAX_REQUEST_BYTES = 1_024;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type RuntimeProviderProbeServer = Readonly<{
  origin: string;
  close(): Promise<void>;
}>;

/** Loopback-only authenticated Control-to-Worker probe transport. */
export async function startRuntimeProviderProbeServer(config: {
  port: number;
  token: string;
  service: Pick<RuntimeProviderProbeService, "probe">;
}): Promise<RuntimeProviderProbeServer> {
  const port = validPort(config.port);
  const token = validToken(config.token);
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, config.service);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("provider_probe_address_invalid");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  service: Pick<RuntimeProviderProbeService, "probe">,
): Promise<void> {
  if (!loopbackPeer(request.socket.remoteAddress)) {
    return writeError(response, 403, "provider_probe_forbidden");
  }
  if (
    request.method !== "POST" ||
    request.url !== "/internal/v1/model-provider-probe" ||
    !authorized(request.headers.authorization, token)
  ) {
    return writeError(response, 401, "provider_probe_unauthorized");
  }
  const abort = new AbortController();
  const disconnected = () => {
    if (!response.writableEnded) {
      abort.abort(new Error("control_disconnected"));
    }
  };
  request.once("aborted", disconnected);
  response.once("close", disconnected);
  request.socket.once("close", disconnected);
  try {
    const input = await readRequest(request);
    if (abort.signal.aborted) throw abort.signal.reason;
    const result = await service.probe(input, abort.signal);
    if (!response.destroyed) writeJson(response, 200, result);
  } catch (error) {
    if (!response.destroyed) {
      writeError(
        response,
        error instanceof InvalidProbeRequest ? 400 : 503,
        error instanceof InvalidProbeRequest
          ? "provider_probe_request_invalid"
          : "provider_probe_unavailable",
      );
    }
  } finally {
    request.off("aborted", disconnected);
    response.off("close", disconnected);
    request.socket.off("close", disconnected);
  }
}

async function readRequest(
  request: IncomingMessage,
): Promise<ModelProviderProbeRequest> {
  if (
    !/^application\/json(?:;|$)/iu.test(request.headers["content-type"] ?? "")
  ) {
    throw new InvalidProbeRequest();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_REQUEST_BYTES) throw new InvalidProbeRequest();
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new InvalidProbeRequest();
  }
  if (
    !object(value) ||
    Object.keys(value).sort().join("\0") !==
      [
        "expectedProviderId",
        "expectedRevision",
        "expectedRuntimeBindingId",
        "tenantId",
      ]
        .sort()
        .join("\0") ||
    typeof value.expectedProviderId !== "string" ||
    value.expectedProviderId.length === 0 ||
    value.expectedProviderId.length > 128 ||
    value.expectedProviderId !== value.expectedProviderId.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value.expectedProviderId) ||
    typeof value.expectedRuntimeBindingId !== "string" ||
    value.expectedRuntimeBindingId.length === 0 ||
    value.expectedRuntimeBindingId.length > 512 ||
    value.expectedRuntimeBindingId !== value.expectedRuntimeBindingId.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value.expectedRuntimeBindingId) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    Number(value.expectedRevision) < 1 ||
    typeof value.tenantId !== "string" ||
    value.tenantId.length === 0 ||
    value.tenantId.length > 512 ||
    value.tenantId !== value.tenantId.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value.tenantId)
  ) {
    throw new InvalidProbeRequest();
  }
  return {
    tenantId: value.tenantId,
    expectedRevision: Number(value.expectedRevision),
    expectedProviderId: value.expectedProviderId,
    expectedRuntimeBindingId: value.expectedRuntimeBindingId,
  };
}

function authorized(value: string | undefined, token: string): boolean {
  if (value?.startsWith("Bearer ") !== true) return false;
  const supplied = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function writeError(
  response: ServerResponse,
  status: number,
  code: string,
): void {
  writeJson(response, status, { code });
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    return writeError(response, 503, "provider_probe_response_invalid");
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function validPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error("provider_probe_port_invalid");
  }
  return value;
}

function validToken(value: string): string {
  if (
    value.length < 32 ||
    value.length > 8_192 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("provider_probe_token_invalid");
  }
  return value;
}

function loopbackPeer(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::ffff:127.0.0.1" || value === "::1";
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class InvalidProbeRequest extends Error {}
