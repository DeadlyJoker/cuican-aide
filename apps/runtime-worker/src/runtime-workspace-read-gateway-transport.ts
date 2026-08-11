import {
  Agent,
  request as httpsRequest,
  type RequestOptions,
} from "node:https";

import {
  DEVICE_FILESYSTEM_READ_DISPATCH_MAX_REQUEST_BYTES,
  DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES,
  DEVICE_GATEWAY_WORKER_FILESYSTEM_READ_DISPATCH_PATH,
} from "@crewon/contracts";

export type RuntimeWorkspaceReadGatewayHttpResponse = Readonly<{
  statusCode: number;
  contentType: string | null;
  body: Uint8Array;
}>;
export interface RuntimeWorkspaceReadGatewayTransportPort {
  post(
    body: Uint8Array,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<RuntimeWorkspaceReadGatewayHttpResponse>;
  close(): void;
}
export class RuntimeWorkspaceReadGatewayClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly certainty: "notSent" | "possiblySent";
  constructor(
    code: string,
    options: Readonly<{
      certainty: "notSent" | "possiblySent";
      retryable?: boolean;
      statusCode?: number | null;
      cause?: unknown;
    }>,
  ) {
    super(code, { cause: options.cause });
    this.name = "RuntimeWorkspaceReadGatewayClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? null;
    this.certainty = options.certainty;
  }
}
export interface RuntimeWorkspaceReadHttpsResponsePort {
  readonly statusCode?: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  once(event: "end" | "aborted", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  destroy(error?: Error): void;
}
export interface RuntimeWorkspaceReadHttpsRequestPort {
  once(event: "error", listener: (error: Error) => void): this;
  setTimeout(timeoutMs: number, callback: () => void): this;
  end(body: Uint8Array): void;
  destroy(error?: Error): void;
}
export type RuntimeWorkspaceReadHttpsRequestFactory = (
  endpoint: URL,
  options: RequestOptions,
  onResponse: (response: RuntimeWorkspaceReadHttpsResponsePort) => void,
) => RuntimeWorkspaceReadHttpsRequestPort;
export interface RuntimeWorkspaceReadDeadlineSchedulerPort {
  schedule(delayMs: number, callback: () => void): () => void;
}
export type RuntimeWorkspaceReadHttpsTransportConfig = Readonly<{
  endpoint: string | URL;
  tls: Readonly<{
    key: string | Buffer;
    cert: string | Buffer;
    ca: string | Buffer | readonly (string | Buffer)[];
    servername?: string;
  }>;
  requestFactory?: RuntimeWorkspaceReadHttpsRequestFactory;
  deadlineScheduler?: RuntimeWorkspaceReadDeadlineSchedulerPort;
}>;

/** HTTPS/mTLS transport; the registered certificate is the Worker identity. */
export class RuntimeWorkspaceReadHttpsTransport
  implements RuntimeWorkspaceReadGatewayTransportPort
{
  readonly #endpoint: URL;
  readonly #agent: Agent;
  readonly #factory: RuntimeWorkspaceReadHttpsRequestFactory;
  readonly #scheduler: RuntimeWorkspaceReadDeadlineSchedulerPort;
  #closed = false;

  constructor(config: RuntimeWorkspaceReadHttpsTransportConfig) {
    this.#endpoint = endpointOf(config.endpoint);
    const authorities = Array.isArray(config.tls.ca)
      ? config.tls.ca
      : [config.tls.ca];
    material(config.tls.key, "workspace_read_gateway_tls_key_invalid");
    material(config.tls.cert, "workspace_read_gateway_tls_cert_invalid");
    if (authorities.length < 1 || authorities.length > 32)
      throw failure("workspace_read_gateway_tls_ca_invalid", "notSent");
    authorities.forEach((value) =>
      material(value, "workspace_read_gateway_tls_ca_invalid"),
    );
    if (
      config.tls.servername !== undefined &&
      !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u.test(
        config.tls.servername,
      )
    )
      throw failure("workspace_read_gateway_tls_servername_invalid", "notSent");
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
    this.#factory =
      config.requestFactory ??
      ((endpoint, options, onResponse) =>
        httpsRequest(endpoint, options, (response) =>
          onResponse(response as RuntimeWorkspaceReadHttpsResponsePort),
        ));
    this.#scheduler = config.deadlineScheduler ?? systemScheduler;
  }

  post(body: Uint8Array, signal: AbortSignal, timeoutMs: number) {
    if (this.#closed)
      return Promise.reject(
        failure("workspace_read_gateway_closed", "notSent"),
      );
    if (
      body.byteLength < 1 ||
      body.byteLength > DEVICE_FILESYSTEM_READ_DISPATCH_MAX_REQUEST_BYTES
    )
      return Promise.reject(
        failure("workspace_read_gateway_request_too_large", "notSent"),
      );
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      return Promise.reject(
        failure("workspace_read_gateway_timeout_invalid", "notSent"),
      );
    if (signal.aborted)
      return Promise.reject(
        failure("workspace_read_gateway_aborted", "notSent"),
      );
    return new Promise<RuntimeWorkspaceReadGatewayHttpResponse>(
      (resolve, reject) => {
        let request: RuntimeWorkspaceReadHttpsRequestPort | null = null;
        let possiblySent = false;
        let settled = false;
        let cancelDeadline: () => void = () => undefined;
        const cleanup = () => {
          cancelDeadline();
          signal.removeEventListener("abort", abort);
        };
        const fail = (
          error: unknown,
          code = "workspace_read_gateway_transport_failed",
        ) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            error instanceof RuntimeWorkspaceReadGatewayClientError
              ? error
              : failure(code, possiblySent ? "possiblySent" : "notSent", {
                  retryable: true,
                  cause: error,
                }),
          );
        };
        const abort = () => {
          const error = failure(
            "workspace_read_gateway_aborted",
            possiblySent ? "possiblySent" : "notSent",
            { retryable: possiblySent },
          );
          request?.destroy(error);
          fail(error);
        };
        cancelDeadline = this.#scheduler.schedule(timeoutMs, () => {
          const error = failure(
            "workspace_read_gateway_timeout",
            possiblySent ? "possiblySent" : "notSent",
            { retryable: true },
          );
          request?.destroy(error);
          fail(error);
        });
        if (settled) {
          cancelDeadline();
          return;
        }
        try {
          request = this.#factory(
            this.#endpoint,
            {
              agent: this.#agent,
              method: "POST",
              path: DEVICE_GATEWAY_WORKER_FILESYSTEM_READ_DISPATCH_PATH,
              headers: {
                "accept": "application/json",
                "content-length": String(body.byteLength),
                "content-type": "application/json; charset=utf-8",
              },
            },
            (response) =>
              readResponse(response, fail, (value) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
              }),
          );
        } catch (error) {
          fail(error);
          return;
        }
        request.once("error", fail);
        request.setTimeout(timeoutMs, () => {
          const error = failure(
            "workspace_read_gateway_timeout",
            possiblySent ? "possiblySent" : "notSent",
            { retryable: true },
          );
          request?.destroy(error);
          fail(error);
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) return abort();
        try {
          possiblySent = true;
          request.end(body);
        } catch (error) {
          fail(error);
        }
      },
    );
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#agent.destroy();
  }
}

function readResponse(
  response: RuntimeWorkspaceReadHttpsResponsePort,
  fail: (error: unknown, code?: string) => void,
  finish: (response: RuntimeWorkspaceReadGatewayHttpResponse) => void,
) {
  const length = response.headers["content-length"];
  if (
    typeof length === "string" &&
    (!/^\d+$/u.test(length) ||
      Number(length) > DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES)
  ) {
    const error = failure(
      "workspace_read_gateway_response_too_large",
      "possiblySent",
    );
    response.destroy(error);
    return fail(error);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  response.on("data", (chunk) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > DEVICE_FILESYSTEM_READ_DISPATCH_MAX_RESPONSE_BYTES) {
      const error = failure(
        "workspace_read_gateway_response_too_large",
        "possiblySent",
      );
      response.destroy(error);
      fail(error);
    } else chunks.push(value);
  });
  response.once("end", () =>
    finish({
      statusCode: response.statusCode ?? 0,
      contentType:
        typeof response.headers["content-type"] === "string"
          ? response.headers["content-type"]
          : null,
      body: Buffer.concat(chunks, bytes),
    }),
  );
  response.once("aborted", () => fail(new Error("response_aborted")));
  response.once("error", fail);
}

function endpointOf(value: string | URL) {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (cause) {
    throw failure("workspace_read_gateway_endpoint_invalid", "notSent", {
      cause,
    });
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname)
  )
    throw failure("workspace_read_gateway_endpoint_invalid", "notSent");
  return new URL(endpoint.origin);
}
function material(value: string | Buffer, code: string) {
  const bytes = Buffer.isBuffer(value)
    ? value.byteLength
    : Buffer.byteLength(value);
  if (bytes < 1 || bytes > 4 * 1024 * 1024) throw failure(code, "notSent");
}
export function failure(
  code: string,
  certainty: "notSent" | "possiblySent",
  options: Readonly<{
    retryable?: boolean;
    statusCode?: number | null;
    cause?: unknown;
  }> = {},
) {
  return new RuntimeWorkspaceReadGatewayClientError(code, {
    ...options,
    certainty,
  });
}
const systemScheduler: RuntimeWorkspaceReadDeadlineSchedulerPort = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
