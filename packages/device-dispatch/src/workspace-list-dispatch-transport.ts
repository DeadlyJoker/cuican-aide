import {
  Agent,
  request as nodeHttpsRequest,
  type RequestOptions,
} from "node:https";

import {
  DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES,
  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES,
  parseDeviceWorkspaceListDispatchError,
  parseDeviceWorkspaceListDispatchReference,
  parseDeviceWorkspaceListPeerDispatchRequest,
  parseDeviceWorkspaceListWorkerDispatchRequest,
  parseDeviceWorkspaceListWorkerDispatchResponse,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListDispatchResolution,
  type DeviceWorkspaceListPeerDispatchRequest,
  type DeviceWorkspaceListPeerRoute,
  type DeviceWorkspaceListPeerSourceWorker,
  type DeviceWorkspaceListWorkerDispatchRequest,
} from "@crewon/contracts";

import {
  DeviceWorkspaceListDispatchClientError,
  type DeviceWorkspaceListDispatchHttpResponse,
  type DeviceWorkspaceListDispatchHttpTransportPort,
} from "./workspace-list-dispatch-client.ts";

export interface DeviceWorkspaceListHttpsResponsePort {
  readonly statusCode?: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  once(event: "end" | "aborted", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  destroy(error?: Error): void;
}

export interface DeviceWorkspaceListHttpsRequestPort {
  once(event: "error", listener: (error: Error) => void): this;
  setTimeout(timeoutMs: number, callback: () => void): this;
  end(body: Uint8Array): void;
  destroy(error?: Error): void;
}

export type DeviceWorkspaceListHttpsRequestFactory = (
  endpoint: URL,
  options: RequestOptions,
  onResponse: (response: DeviceWorkspaceListHttpsResponsePort) => void,
) => DeviceWorkspaceListHttpsRequestPort;

export interface DeviceWorkspaceListDispatchDeadlineSchedulerPort {
  schedule(delayMs: number, callback: () => void): () => void;
}

export class NodeHttpsDeviceWorkspaceListDispatchTransport
  implements DeviceWorkspaceListDispatchHttpTransportPort
{
  readonly #endpoint: URL;
  readonly #agent: Agent;
  readonly #requestFactory: DeviceWorkspaceListHttpsRequestFactory;
  readonly #deadlineScheduler: DeviceWorkspaceListDispatchDeadlineSchedulerPort;
  #closed = false;

  constructor(config: {
    endpoint: string | URL;
    tls: Readonly<{
      key: string | Buffer;
      cert: string | Buffer;
      ca: string | Buffer | readonly (string | Buffer)[];
      servername?: string;
    }>;
    requestFactory?: DeviceWorkspaceListHttpsRequestFactory;
    deadlineScheduler?: DeviceWorkspaceListDispatchDeadlineSchedulerPort;
  }) {
    this.#endpoint = validateEndpoint(config.endpoint);
    requireTlsMaterial(
      config.tls.key,
      "device_workspace_dispatch_tls_key_invalid",
    );
    requireTlsMaterial(
      config.tls.cert,
      "device_workspace_dispatch_tls_cert_invalid",
    );
    const authorities = Array.isArray(config.tls.ca)
      ? config.tls.ca
      : [config.tls.ca];
    if (authorities.length < 1 || authorities.length > 32) {
      throw clientError("device_workspace_dispatch_tls_ca_invalid", "notSent");
    }
    for (const authority of authorities) {
      requireTlsMaterial(authority, "device_workspace_dispatch_tls_ca_invalid");
    }
    if (
      config.tls.servername !== undefined &&
      (!/^[A-Za-z0-9.-]{1,253}$/u.test(config.tls.servername) ||
        config.tls.servername.startsWith(".") ||
        config.tls.servername.endsWith("."))
    ) {
      throw clientError(
        "device_workspace_dispatch_tls_servername_invalid",
        "notSent",
      );
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
    this.#requestFactory =
      config.requestFactory ??
      ((endpoint, options, onResponse) =>
        nodeHttpsRequest(endpoint, options, (response) =>
          onResponse(response as DeviceWorkspaceListHttpsResponsePort),
        ));
    this.#deadlineScheduler =
      config.deadlineScheduler ?? systemDeadlineScheduler;
  }

  post(
    body: Uint8Array,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<DeviceWorkspaceListDispatchHttpResponse> {
    if (this.#closed) {
      return Promise.reject(
        clientError("device_workspace_dispatch_client_closed", "notSent"),
      );
    }
    if (
      body.byteLength < 1 ||
      body.byteLength > DEVICE_WORKSPACE_LIST_DISPATCH_MAX_REQUEST_BYTES
    ) {
      return Promise.reject(
        clientError("device_workspace_dispatch_request_too_large", "notSent"),
      );
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    ) {
      return Promise.reject(
        clientError("device_workspace_dispatch_timeout_invalid", "notSent"),
      );
    }
    if (signal.aborted) {
      return Promise.reject(
        clientError("device_workspace_dispatch_aborted", "notSent"),
      );
    }
    return new Promise((resolve, reject) => {
      let request: DeviceWorkspaceListHttpsRequestPort | null = null;
      let startedWrite = false;
      let settled = false;
      let cancelDeadline: () => void = () => undefined;
      const certainty = () => (startedWrite ? "possiblySent" : "notSent");
      const cleanup = () => {
        cancelDeadline();
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (
        error: unknown,
        code = "device_workspace_dispatch_transport_failed",
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          error instanceof DeviceWorkspaceListDispatchClientError
            ? error
            : clientError(code, certainty(), {
                retryable: true,
                cause: error,
              }),
        );
      };
      const finish = (response: DeviceWorkspaceListDispatchHttpResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };
      const onAbort = () => {
        const error = clientError(
          "device_workspace_dispatch_aborted",
          certainty(),
          { retryable: startedWrite },
        );
        request?.destroy(error);
        fail(error);
      };
      cancelDeadline = this.#deadlineScheduler.schedule(timeoutMs, () => {
        const error = clientError(
          "device_workspace_dispatch_transport_timeout",
          certainty(),
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
        request = this.#requestFactory(
          this.#endpoint,
          {
            agent: this.#agent,
            method: "POST",
            path: DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
            headers: {
              "accept": "application/json",
              "content-length": String(body.byteLength),
              "content-type": "application/json; charset=utf-8",
            },
          },
          (response) => {
            const contentLength = response.headers["content-length"];
            if (
              typeof contentLength === "string" &&
              (!/^\d+$/u.test(contentLength) ||
                Number(contentLength) >
                  DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES)
            ) {
              const error = clientError(
                "device_workspace_dispatch_response_too_large",
                "possiblySent",
              );
              response.destroy(error);
              fail(error);
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk) => {
              if (settled) return;
              const buffer = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk);
              bytes += buffer.byteLength;
              if (bytes > DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES) {
                const error = clientError(
                  "device_workspace_dispatch_response_too_large",
                  "possiblySent",
                );
                response.destroy(error);
                fail(error);
                return;
              }
              chunks.push(buffer);
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
            response.once("aborted", () =>
              fail(
                new Error("response_aborted"),
                "device_workspace_dispatch_transport_failed",
              ),
            );
            response.once("error", fail);
          },
        );
      } catch (error) {
        fail(error);
        return;
      }
      request.once("error", fail);
      request.setTimeout(timeoutMs, () => {
        const error = clientError(
          "device_workspace_dispatch_transport_timeout",
          certainty(),
          { retryable: true },
        );
        request.destroy(error);
        fail(error);
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        // Calling end crosses the boundary after which the transport can no
        // longer prove that no request bytes reached the peer.
        startedWrite = true;
        request.end(body);
      } catch (error) {
        fail(error);
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#agent.destroy();
  }
}

const systemDeadlineScheduler: DeviceWorkspaceListDispatchDeadlineSchedulerPort =
  {
    schedule(delayMs, callback) {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    },
  };

export function requireJsonResponse(
  response: DeviceWorkspaceListDispatchHttpResponse,
): void {
  if (
    !Number.isSafeInteger(response.statusCode) ||
    response.statusCode < 100 ||
    response.statusCode > 599 ||
    response.contentType === null ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
      response.contentType,
    ) ||
    response.body.byteLength < 1 ||
    response.body.byteLength > DEVICE_WORKSPACE_LIST_DISPATCH_MAX_RESPONSE_BYTES
  ) {
    throw clientError(
      "device_workspace_dispatch_http_response_invalid",
      "possiblySent",
    );
  }
}

export function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch (error) {
    throw clientError(
      "device_workspace_dispatch_response_json_invalid",
      "possiblySent",
      { cause: error },
    );
  }
}

function validateEndpoint(input: string | URL): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(input);
  } catch (error) {
    throw clientError("device_workspace_dispatch_endpoint_invalid", "notSent", {
      cause: error,
    });
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (endpoint.pathname !== "" && endpoint.pathname !== "/")
  ) {
    throw clientError("device_workspace_dispatch_endpoint_invalid", "notSent");
  }
  return new URL(endpoint.origin);
}

function requireTlsMaterial(value: string | Buffer, code: string): void {
  const bytes = Buffer.isBuffer(value)
    ? value.byteLength
    : Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > 4 * 1024 * 1024) {
    throw clientError(code, "notSent");
  }
}

export function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw clientError(code, "notSent");
  }
  return value;
}

export function clientError(
  code: string,
  certainty: "notSent" | "possiblySent",
  options: Readonly<{
    retryable?: boolean;
    statusCode?: number | null;
    cause?: unknown;
  }> = {},
): DeviceWorkspaceListDispatchClientError {
  return new DeviceWorkspaceListDispatchClientError(code, {
    ...options,
    certainty,
  });
}
