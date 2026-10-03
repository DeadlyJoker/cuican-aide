import {
  INSTALLED_PLUGIN_PEER_PRIVATE_PATH,
  INSTALLED_PLUGIN_PEER_WIRE_LIMITS,
  parseInstalledPluginPeerRequest,
  parseInstalledPluginPeerResponse,
  type InstalledPluginPeerRequest,
  type InstalledPluginPeerResponse,
} from "@crewon/contracts/plugins";

export class InstalledPluginPeerError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "InstalledPluginPeerError";
    this.code = code;
  }
}
export type InstalledPluginPeerClientConfiguration = Readonly<{
  origin: string;
  token: string;
  deadlineMs?: number;
  maximumRequests?: number;
}>;

/** Own descriptors only. Deployment options and request objects never evaluate getters. */
export function installedPeerOwnRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("request_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    fail("request_invalid");
  const names = Reflect.ownKeys(input);
  if (
    names.some(
      (name) =>
        typeof name !== "string" || ![...required, ...optional].includes(name),
    )
  )
    fail("request_invalid");
  const entries = names.map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, name)!;
    if (!("value" in descriptor) || !descriptor.enumerable)
      fail("request_invalid");
    return [name as string, descriptor.value] as const;
  });
  if (required.some((name) => !names.includes(name))) fail("request_invalid");
  return Object.freeze(Object.fromEntries(entries));
}

export function parseInstalledPluginPeerClientConfiguration(
  input: InstalledPluginPeerClientConfiguration,
) {
  const data = installedPeerOwnRecord(
    input,
    ["origin", "token"],
    ["deadlineMs", "maximumRequests"],
  );
  const origin = data.origin;
  if (typeof origin !== "string") fail("origin_invalid");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return fail("origin_invalid");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    Number(url.port) < 1 ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    fail("origin_invalid");
  const token = data.token;
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token) < 32 ||
    Buffer.byteLength(token) > 8192 ||
    /[^\x21-\x7e]/u.test(token)
  )
    fail("token_invalid");
  const deadlineMs = data.deadlineMs === undefined ? 10_000 : data.deadlineMs;
  const maximumRequests =
    data.maximumRequests === undefined ? 128 : data.maximumRequests;
  if (
    typeof deadlineMs !== "number" ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 30_000
  )
    fail("deadline_invalid");
  if (
    typeof maximumRequests !== "number" ||
    !Number.isSafeInteger(maximumRequests) ||
    maximumRequests < 1 ||
    maximumRequests > 128
  )
    fail("capacity_invalid");
  return Object.freeze({ origin, token, deadlineMs, maximumRequests });
}

/** Logical cancellation never releases ownership of a physical fetch or body cancellation. */
export class InstalledPluginPeerTransport {
  readonly #configuration: ReturnType<
    typeof parseInstalledPluginPeerClientConfiguration
  >;
  readonly #url: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #controllers = new Set<AbortController>();
  readonly #pending = new Set<Promise<InstalledPluginPeerResponse>>();
  #closed = false;
  #closing: Promise<void> | null = null;
  constructor(
    input: InstalledPluginPeerClientConfiguration,
    dependencies: Readonly<{ fetch?: typeof globalThis.fetch }> = {},
  ) {
    this.#configuration = parseInstalledPluginPeerClientConfiguration(input);
    this.#url = new URL(
      INSTALLED_PLUGIN_PEER_PRIVATE_PATH,
      this.#configuration.origin,
    );
    const captured = installedPeerOwnRecord(dependencies, [], ["fetch"]);
    if (captured.fetch !== undefined && typeof captured.fetch !== "function")
      fail("transport_invalid");
    this.#fetch =
      captured.fetch === undefined
        ? globalThis.fetch.bind(globalThis)
        : (captured.fetch as typeof globalThis.fetch).bind(dependencies);
  }
  assertOpen(): void {
    if (this.#closed) fail("closed");
  }
  post(
    input: InstalledPluginPeerRequest,
    signal?: AbortSignal,
  ): Promise<InstalledPluginPeerResponse> {
    try {
      this.assertOpen();
      if (signal !== undefined && !(signal instanceof AbortSignal))
        fail("signal_invalid");
      signal?.throwIfAborted();
      const request = parseInstalledPluginPeerRequest(input);
      if (this.#pending.size >= this.#configuration.maximumRequests)
        fail("capacity_exceeded");
      const controller = new AbortController();
      const abort = () =>
        controller.abort(
          new InstalledPluginPeerError("installed_plugin_peer_cancelled"),
        );
      signal?.addEventListener("abort", abort, { once: true });
      this.#controllers.add(controller);
      const timer = setTimeout(
        () =>
          controller.abort(
            new InstalledPluginPeerError(
              "installed_plugin_peer_deadline_exceeded",
            ),
          ),
        this.#configuration.deadlineMs,
      );
      timer.unref();
      // Defer any transport callback until its actual promise is registered with this owner.
      const work = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        let response: Response;
        try {
          response = await this.#fetch(this.#url, {
            method: "POST",
            headers: {
              "accept": "application/json",
              "authorization": `Bearer ${this.#configuration.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
            redirect: "error",
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted) throw controller.signal.reason;
          return fail("unavailable");
        }
        if (controller.signal.aborted) {
          await cancelBody(response);
          throw controller.signal.reason;
        }
        if (response.status !== 200) {
          await cancelBody(response);
          fail(
            response.status === 401 || response.status === 403
              ? "authentication_failed"
              : "unavailable",
          );
        }
        let parsed: InstalledPluginPeerResponse;
        try {
          parsed = parseInstalledPluginPeerResponse(
            await readBoundedJson(response, controller.signal),
          );
        } catch {
          if (controller.signal.aborted) throw controller.signal.reason;
          return fail("response_invalid");
        }
        if (
          parsed.requestId !== request.requestId ||
          parsed.operation !== request.operation ||
          !same(parsed.actor, request.actor) ||
          !same(parsed.scope, request.scope)
        )
          fail("response_invalid");
        controller.signal.throwIfAborted();
        return parsed;
      });
      this.#pending.add(work);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#controllers.delete(controller);
        this.#pending.delete(work);
      };
      void work.then(cleanup, cleanup);
      if (signal?.aborted) abort();
      return abortable(work, controller.signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const controller of this.#controllers)
        controller.abort(
          new InstalledPluginPeerError("installed_plugin_peer_closed"),
        );
    }
    return (this.#closing ??= Promise.allSettled([...this.#pending]).then(
      () => undefined,
    ));
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* Still joined; no token or body diagnostics escape. */
  }
}
async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const maximum = INSTALLED_PLUGIN_PEER_WIRE_LIMITS.messageBytes;
  const length = response.headers.get("content-length");
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
      response.headers.get("content-type") ?? "",
    ) ||
    (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) ||
    response.body === null
  ) {
    await cancelBody(response);
    fail("response_invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0,
    count = 0,
    complete = false;
  let cancelling: Promise<void> | undefined;
  const cancel = () => {
    cancelling ??= reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (
        ++count > INSTALLED_PLUGIN_PEER_WIRE_LIMITS.jsonNodes ||
        (size += next.value.byteLength) > maximum
      )
        fail("response_invalid");
      chunks.push(next.value);
    }
    if (length !== null && Number(length) !== size) fail("response_invalid");
    complete = true;
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      ),
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    await cancelling;
    reader.releaseLock();
  }
}
function same(left: object, right: object): boolean {
  const entries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  return (
    JSON.stringify(entries) ===
    JSON.stringify(Object.entries(right).sort(([a], [b]) => a.localeCompare(b)))
  );
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
function fail(code: string): never {
  throw new InstalledPluginPeerError(`installed_plugin_peer_${code}`);
}
