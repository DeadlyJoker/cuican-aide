import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  EXTENSION_HOST_PRIVATE_PATH,
  EXTENSION_HOST_WIRE_LIMITS,
  ExtensionHostContractError,
  parseExtensionHostRequest,
  parseExtensionHostResponse,
} from "@crewon/contracts";
import {
  RuntimeExtensionHostError,
  type RuntimeExtensionHostService,
} from "./extension-host-service.ts";

export type RuntimeExtensionHostServer = Readonly<{
  origin: string;
  close(): Promise<void>;
}>;

/** Standalone-only authenticated, bounded private host listener. */
export async function startRuntimeExtensionHostServer(input: {
  port: number;
  token: string;
  service: Pick<RuntimeExtensionHostService, "handle">;
  deadlineMs?: number;
  concurrencyLimit?: number;
  rateLimit?: number;
  rateWindowMs?: number;
}): Promise<RuntimeExtensionHostServer> {
  const port = integer(input.port, 0, 65535);
  const deadlineMs = integer(input.deadlineMs ?? 10000, 1000, 30000);
  const concurrencyLimit = integer(input.concurrencyLimit ?? 4, 1, 32);
  const rateLimit = integer(input.rateLimit ?? 120, 1, 1000);
  const rateWindowMs = integer(input.rateWindowMs ?? 60000, 1000, 60000);
  if (
    Buffer.byteLength(input.token) < 32 ||
    Buffer.byteLength(input.token) > 8192 ||
    /[\u0000-\u0020\u007f]/u.test(input.token)
  )
    throw new Error("extension_host_server_configuration_invalid");
  const token = Buffer.from(`Bearer ${input.token}`);
  const controllers = new Set<AbortController>();
  const physical = new Map<AbortSignal, Promise<unknown>>();
  let closed = false;
  let windowStarted = Date.now();
  let requests = 0;
  const server = createServer((request, response) => {
    if (
      request.method !== "POST" ||
      request.url !== EXTENSION_HOST_PRIVATE_PATH
    ) {
      empty(response, 404);
      return;
    }
    const header = request.headers.authorization;
    const bytes =
      typeof header === "string" && Buffer.byteLength(header) <= 8200
        ? Buffer.from(header)
        : Buffer.alloc(0);
    if (
      request.socket.remoteAddress !== "127.0.0.1" ||
      bytes.length !== token.length ||
      !timingSafeEqual(bytes, token)
    ) {
      empty(response, 401);
      return;
    }
    if (closed) {
      empty(response, 503);
      return;
    }
    const now = Date.now();
    if (now - windowStarted >= rateWindowMs) {
      windowStarted = now;
      requests = 0;
    }
    if (controllers.size >= concurrencyLimit || ++requests > rateLimit) {
      empty(response, 429);
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(
      () =>
        controller.abort(new Error("extension_host_server_deadline_exceeded")),
      deadlineMs,
    );
    timer.unref();
    const disconnected = () => {
      if (!response.writableEnded)
        controller.abort(new Error("extension_host_control_disconnected"));
    };
    request.once("aborted", disconnected);
    response.once("close", disconnected);
    void handle(
      request,
      response,
      input.service,
      controller.signal,
      physical,
    ).finally(() => {
      clearTimeout(timer);
      request.off("aborted", disconnected);
      response.off("close", disconnected);
      const pending = physical.get(controller.signal);
      if (pending === undefined) controllers.delete(controller);
      else
        void pending.then(
          () => controllers.delete(controller),
          () => controllers.delete(controller),
        );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("extension_host_server_address_invalid");
  let closeTask: Promise<void> | null = null;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => {
      closeTask ??= (async () => {
        closed = true;
        for (const controller of controllers)
          controller.abort(new Error("extension_host_server_closed"));
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        await Promise.allSettled([...physical.values()]);
      })();
      return closeTask;
    },
  };
}
async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  service: Pick<RuntimeExtensionHostService, "handle">,
  signal: AbortSignal,
  physical: Map<AbortSignal, Promise<unknown>>,
): Promise<void> {
  try {
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
        request.headers["content-type"] ?? "",
      )
    )
      throw new ExtensionHostContractError();
    const declared = request.headers["content-length"];
    if (
      declared !== undefined &&
      (!/^\d+$/u.test(declared) ||
        Number(declared) > EXTENSION_HOST_WIRE_LIMITS.messageBytes)
    )
      throw new ExtensionHostContractError();
    const chunks: Buffer[] = [];
    let total = 0;
    const iterator = request[Symbol.asyncIterator]();
    for (;;) {
      const next = await abortable(iterator.next(), signal);
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value);
      total += chunk.length;
      if (
        total > EXTENSION_HOST_WIRE_LIMITS.messageBytes ||
        chunks.length > EXTENSION_HOST_WIRE_LIMITS.messageBytes
      )
        throw new ExtensionHostContractError();
      chunks.push(chunk);
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, total),
        ),
      );
    } catch {
      throw new ExtensionHostContractError();
    }
    const parsed = parseExtensionHostRequest(value);
    const execution = service.handle(parsed, signal);
    physical.set(signal, execution);
    void execution.then(
      () => physical.delete(signal),
      () => physical.delete(signal),
    );
    const result = parseExtensionHostResponse(
      await abortable(execution, signal),
    );
    if (
      result.operation !== parsed.operation ||
      JSON.stringify(result.actor) !== JSON.stringify(parsed.actor)
    )
      throw new Error("extension_host_server_response_invalid");
    const encoded = Buffer.from(JSON.stringify(result));
    if (encoded.length > EXTENSION_HOST_WIRE_LIMITS.messageBytes)
      throw new Error("extension_host_server_response_invalid");
    if (!response.destroyed) {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": encoded.length,
      });
      response.end(encoded);
    }
  } catch (error) {
    if (!response.destroyed)
      empty(
        response,
        error instanceof ExtensionHostContractError
          ? 400
          : error instanceof RuntimeExtensionHostError &&
              [
                "extension_host_identity_invalid",
                "extension_host_authorization_denied",
              ].includes(error.code)
            ? 403
            : 503,
      );
  }
}
function empty(response: ServerResponse, status: number) {
  response.writeHead(status, { "content-length": "0" });
  response.end();
}
function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error("extension_host_server_configuration_invalid");
  return value;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
