import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { installProcessShutdown } from "@crewon/process-lifecycle";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { createWebIdentityRuntime } from "./web-identity-runtime.ts";
import { createWebBff } from "./web-bff.ts";

const MAX_INCOMING_BODY_BYTES = 64 * 1024;

const publicOrigin = requiredEnvironment("CREWON_WEB_PUBLIC_ORIGIN");
const identityRuntime = await createWebIdentityRuntime(process.env);
let bff: ReturnType<typeof createWebBff>;
try {
  bff = createWebBff({
    publicOrigin,
    controlTarget: environmentOr(
      "CREWON_CONTROL_TARGET",
      "http://127.0.0.1:3210",
    ),
    controlBffToken: requiredEnvironment("CREWON_CONTROL_BFF_TOKEN"),
    controlCsrfToken: requiredEnvironment("CREWON_CONTROL_CSRF_TOKEN"),
    csrfSecret: requiredEnvironment("CREWON_WEB_CSRF_SECRET"),
    identity: identityRuntime.identity,
    ...(identityRuntime.accountExchange === undefined
      ? {}
      : { accountExchange: identityRuntime.accountExchange }),
  });
} catch (error) {
  await identityRuntime.close();
  throw error;
}

const server = createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  const abortUpstream = () => controller.abort();
  incoming.once("aborted", abortUpstream);
  outgoing.once("close", abortUpstream);
  try {
    const request = await toFetchRequest(
      incoming,
      publicOrigin,
      controller.signal,
    );
    await writeFetchResponse(
      outgoing,
      (await identityRuntime.authority?.handle(request)) ??
        (await bff.handle(request, { rawTarget: incoming.url ?? "/" })),
    );
  } catch (error) {
    const bodyTooLarge = error instanceof RequestBodyTooLargeError;
    writeJsonError(
      outgoing,
      bodyTooLarge ? 413 : 500,
      bodyTooLarge ? "request_body_too_large" : "web_bff_internal_error",
    );
  } finally {
    incoming.removeListener("aborted", abortUpstream);
    outgoing.removeListener("close", abortUpstream);
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

const port = parsePort(process.env.CREWON_WEB_BFF_PORT ?? "3211");
const shutdown = installProcessShutdown({
  host: process,
  close: async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    } finally {
      await identityRuntime.close();
    }
  },
  reportFailure: () => {
    process.stderr.write("CrewON Web BFF shutdown failed\n");
  },
});
server.once("error", () => {
  void identityRuntime.close().finally(() => {
    process.stderr.write("CrewON Web BFF listener unavailable\n");
    process.exitCode = 1;
  });
});
server.listen(port, "127.0.0.1", () => {
  if (shutdown.isRequested()) return;
  process.stdout.write(`CrewON Web BFF listening on 127.0.0.1:${port}\n`);
});

async function toFetchRequest(
  incoming: IncomingMessage,
  origin: string,
  signal: AbortSignal,
): Promise<Request> {
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  for (const [name, values] of Object.entries(incoming.headersDistinct)) {
    if (values === undefined) {
      continue;
    }
    for (const value of values) {
      headers.append(name, value);
    }
  }
  const body =
    method === "GET" || method === "HEAD"
      ? null
      : await readIncomingBody(incoming);
  return new Request(new URL(incoming.url ?? "/", origin), {
    method,
    headers,
    signal,
    ...(body === null ? {} : { body }),
  });
}

async function readIncomingBody(
  incoming: IncomingMessage,
): Promise<ArrayBuffer> {
  const declaredLength = incoming.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < 0 ||
      parsed > MAX_INCOMING_BODY_BYTES
    ) {
      throw new RequestBodyTooLargeError();
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of incoming) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > MAX_INCOMING_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

async function writeFetchResponse(
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) {
    outgoing.setHeader(name, value);
  }
  const body = response.body;
  if (body === null) {
    outgoing.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(
      body as unknown as NodeReadableStream<Uint8Array>,
    );
    stream.once("error", reject);
    outgoing.once("error", reject);
    outgoing.once("finish", resolve);
    stream.pipe(outgoing);
  });
}

function writeJsonError(
  response: ServerResponse,
  status: number,
  code: string,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify({ error: { code } }));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name}_required`);
  }
  return value;
}

function environmentOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CREWON_WEB_BFF_PORT_invalid");
  }
  return port;
}

class RequestBodyTooLargeError extends Error {}
