import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import {
  validateToolExecutionCommand,
  type ToolExecutionCommand,
  type ToolExecutionResolution,
} from "@crewon/tool-broker";

export interface BrowserExecutionTransportHost {
  execute(command: ToolExecutionCommand): Promise<ToolExecutionResolution>;
  reconcile(command: ToolExecutionCommand): Promise<ToolExecutionResolution>;
  cancel(command: ToolExecutionCommand): Promise<ToolExecutionResolution>;
  download(
    command: ToolExecutionCommand,
    receiptId: string,
  ): Promise<Uint8Array>;
}
export type BrowserExecutionTransport = Readonly<{
  url: string;
  token: string;
  close(): Promise<void>;
}>;
type Operation = "execute" | "reconcile" | "cancel" | "download";
const MAX_REQUEST_BYTES = 32768;
const MAX_RESPONSE_BYTES = 16384;
const BODY_TIMEOUT_MS = 3000;
const OPERATION_TIMEOUT_MS = 30000;

/** Private main-to-Worker bridge. The browser renderer never receives this bearer. */
export async function startBrowserExecutionTransport(
  host: BrowserExecutionTransportHost,
): Promise<BrowserExecutionTransport> {
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const sockets = new Set<Socket>();
  const pending = new Map<AbortController, () => void>();
  let active = 0;
  let ordinary = 0;
  let closing = false;
  let closed: Promise<void> | undefined;
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 3000,
      requestTimeout: BODY_TIMEOUT_MS,
      connectionsCheckingInterval: 500,
      keepAliveTimeout: 1000,
    },
    (request, response) => {
      void handle(request, response).catch(() => {
        if (!response.destroyed)
          sendError(response, 500, "browser_transport_failed");
      });
    },
  );
  server.maxConnections = 32;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (closing) socket.destroy();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("browser_transport_listen_failed");
  const authority = `127.0.0.1:${address.port}`;

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (closing) return sendError(response, 503, "browser_transport_closed");
    if (
      Object.hasOwn(request.headers, "origin") ||
      request.headers.host !== authority ||
      request.socket.remoteAddress !== "127.0.0.1"
    )
      return sendError(response, 403, "browser_transport_origin_forbidden");
    const bearer = Buffer.from(request.headers.authorization ?? "");
    if (
      bearer.length !== authorization.length ||
      !timingSafeEqual(bearer, authorization)
    )
      return sendError(response, 401, "browser_transport_unauthorized");
    if (request.method !== "POST")
      return sendError(response, 405, "browser_transport_method_invalid");
    const match = /^\/v1\/browser\/(execute|reconcile|cancel|download)$/u.exec(
      request.url ?? "",
    );
    if (!match)
      return sendError(response, 404, "browser_transport_route_unknown");
    const operation = match[1] as Operation;
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
        request.headers["content-type"] ?? "",
      ) ||
      (request.headers["content-encoding"] !== undefined &&
        request.headers["content-encoding"] !== "identity")
    )
      return sendError(response, 415, "browser_transport_media_type_invalid");
    if (Number(request.headers["content-length"]) > MAX_REQUEST_BYTES)
      return sendError(response, 413, "browser_transport_request_too_large");
    // Seven ordinary calls cannot occupy the slot needed to stop an active action.
    if (active >= 8 || (operation !== "cancel" && ordinary >= 7))
      return sendError(response, 429, "browser_transport_capacity");
    active++;
    if (operation !== "cancel") ordinary++;
    const abort = new AbortController();
    let command: ToolExecutionCommand | undefined;
    let dispatched = false;
    let cancellationSent = false;
    const stop = () => {
      if (
        operation === "execute" &&
        command &&
        dispatched &&
        !cancellationSent
      ) {
        cancellationSent = true;
        try {
          void host.cancel(command).catch(() => undefined);
        } catch {
          /* Never redispatch when cancellation loses its reply. */
        }
      }
      abort.abort();
    };
    pending.set(abort, stop);
    const disconnected = () => {
      if (!response.writableFinished) stop();
    };
    response.once("close", disconnected);
    let timer = setTimeout(() => abort.abort(), BODY_TIMEOUT_MS);
    try {
      const body = await readRequest(request, abort.signal);
      const value = object(body);
      exactKeys(
        value,
        operation === "download" ? ["command", "receiptId"] : ["command"],
      );
      command = parseCommand(value.command);
      if (operation === "download") opaque(value.receiptId);
      abort.signal.throwIfAborted();
      clearTimeout(timer);
      timer = setTimeout(stop, OPERATION_TIMEOUT_MS);
      if (operation === "download") {
        const bytes = await withinSignal(
          host.download(command, value.receiptId as string),
          abort.signal,
        );
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > 10485760)
          throw new TransportError(502, "browser_transport_result_invalid");
        if (!response.destroyed)
          await writeResponse(
            response,
            bytes,
            "application/octet-stream",
            abort.signal,
          );
      } else {
        dispatched = operation === "execute";
        const result = await withinSignal(
          host[operation](command),
          abort.signal,
        );
        const encoded = serializeResult(result, command);
        if (!response.destroyed)
          await writeResponse(
            response,
            encoded,
            "application/json",
            abort.signal,
          );
      }
    } catch (error) {
      if (abort.signal.aborted) stop();
      if (!response.destroyed) {
        if (abort.signal.aborted)
          sendError(response, 504, "browser_transport_timeout");
        else if (error instanceof TransportError)
          sendError(response, error.status, error.message);
        else
          sendError(
            response,
            dispatched ? 500 : 400,
            "browser_transport_request_failed",
          );
      }
    } finally {
      clearTimeout(timer);
      pending.delete(abort);
      response.removeListener("close", disconnected);
      active--;
      if (operation !== "cancel") ordinary--;
      if (!request.complete) request.resume();
    }
  }

  return {
    url: `http://${authority}`,
    token,
    close() {
      if (closed) return closed;
      closing = true;
      for (const stop of pending.values()) stop();
      closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
      return closed;
    },
  };
}

async function readRequest(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const consume = async () => {
    // destroyOnReturn=false lets a rejected body receive its bounded error response.
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES)
        throw new TransportError(413, "browser_transport_request_too_large");
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new TransportError(400, "browser_transport_json_invalid");
    }
  };
  return withinSignal(consume(), signal);
}
function parseCommand(input: unknown): ToolExecutionCommand {
  const value = object(input);
  exactKeys(value, [
    "schemaVersion",
    "idempotencyKey",
    "runId",
    "segmentId",
    "callId",
    "kind",
    "name",
    "input",
    "executionId",
    "executionLease",
    "actionDigest",
    "actionIntent",
    "approvalProof",
  ]);
  const command = value as ToolExecutionCommand;
  try {
    validateToolExecutionCommand(command);
  } catch {
    throw new TransportError(400, "browser_transport_command_invalid");
  }
  return command;
}
function serializeResult(
  input: unknown,
  command: ToolExecutionCommand,
): string {
  try {
    const value = object(input);
    if (value.executionId !== command.executionId) throw new Error();
    if (value.status === "completed") {
      exactKeys(value, [
        "status",
        "executionId",
        "providerReceiptId",
        "result",
      ]);
      opaque(value.providerReceiptId);
      const result = object(value.result);
      exactKeys(result, [
        "schemaVersion",
        "callId",
        "output",
        "isError",
        "artifactRef",
      ]);
      if (
        result.schemaVersion !== "crewon.tool-result.v0" ||
        result.callId !== command.callId ||
        typeof result.output !== "string" ||
        Buffer.byteLength(result.output, "utf8") > 9216 ||
        typeof result.isError !== "boolean"
      )
        throw new Error();
      if (result.artifactRef !== null) opaque(result.artifactRef);
    } else {
      exactKeys(value, ["status", "executionId", "providerReceiptId"]);
      if (value.status !== "canceled" && value.status !== "unknownOutcome")
        throw new Error();
      if (value.providerReceiptId !== null) opaque(value.providerReceiptId);
    }
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) throw new Error();
    return encoded;
  } catch {
    throw new TransportError(502, "browser_transport_result_invalid");
  }
}
async function withinSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let reject!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function writeResponse(
  response: ServerResponse,
  body: string | Uint8Array,
  type: string,
  signal: AbortSignal,
): Promise<void> {
  const finished = new Promise<void>((resolve, reject) => {
    response.once("finish", resolve);
    response.once("error", reject);
    response.writeHead(
      200,
      headers(
        type,
        typeof body === "string" ? Buffer.byteLength(body) : body.byteLength,
      ),
    );
    response.end(body);
  });
  await withinSignal(finished, signal);
}
function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TransportError(400, "browser_transport_body_invalid");
  return input as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join() !== [...keys].sort().join())
    throw new TransportError(400, "browser_transport_body_invalid");
}
function opaque(input: unknown): void {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(input)
  )
    throw new TransportError(400, "browser_transport_identity_invalid");
}
function headers(contentType: string, length: number) {
  return {
    "content-type": contentType,
    "content-length": length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}
function sendError(
  response: ServerResponse,
  status: number,
  code: string,
): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code } });
  response.writeHead(status, {
    ...headers("application/json", Buffer.byteLength(body)),
    connection: "close",
  });
  response.end(body);
}
class TransportError extends Error {
  readonly status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}
