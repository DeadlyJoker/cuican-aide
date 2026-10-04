import { createHash, randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  parsePluginUiLease,
  parseRenewPluginUiMountResponse,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import {
  desktopPluginUiAssetUrl,
  parseDesktopPluginUiAssetUrl,
  type DesktopPluginUiBinding,
} from "../src/lib/desktop/desktopPluginUiProtocol.ts";

type NativeSession = Readonly<{
  baseUrl: string;
  origin: string;
  csrfToken: string;
  sessionToken: string;
  /** Main-process lifecycle identity; never supplied by the renderer. */
  generation: number;
}>;
type Entry = {
  readonly bindingRef: string;
  lease: PluginUiLease;
  identity: string;
  readonly session: NativeSession;
  readonly controlOwner: ChildProcess | null;
  readonly generation: number;
  readonly abort: AbortController;
  readonly pending: Set<Promise<unknown>>;
  readonly operations: Set<Promise<unknown>>;
  readonly uncertainReaders: Set<ReadableStreamDefaultReader<Uint8Array>>;
  state: "adopting" | "active" | "closing";
  failure: unknown | null;
  closing: Promise<void> | null;
  expiry: ReturnType<typeof setTimeout> | null;
  renewal: Readonly<{
    operation: Promise<PluginUiLease>;
    result: Promise<PluginUiLease>;
  }> | null;
};
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_RESERVED_BYTES = 128 * 1024 * 1024;
const JSON_BYTES = 512 * 1024;
const DEADLINE_MS = 5_000;
const mimeTypes: Readonly<Record<string, string>> = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
});
function failure(code: string): never {
  throw new Error(code);
}
function adoptionInput(
  input: unknown,
): Readonly<{ lease: unknown; expectedControlOrigin: string }> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    failure("desktop_plugin_ui_adoption_input_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    failure("desktop_plugin_ui_adoption_input_invalid");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 2 ||
    !keys.includes("lease") ||
    !keys.includes("expectedControlOrigin")
  )
    failure("desktop_plugin_ui_adoption_input_invalid");
  const lease = Object.getOwnPropertyDescriptor(input, "lease"),
    origin = Object.getOwnPropertyDescriptor(input, "expectedControlOrigin");
  if (
    !lease?.enumerable ||
    !("value" in lease) ||
    !origin?.enumerable ||
    !("value" in origin) ||
    typeof origin.value !== "string"
  )
    failure("desktop_plugin_ui_adoption_input_invalid");
  return Object.freeze({
    lease: lease.value,
    expectedControlOrigin: origin.value,
  });
}
function mime(path: string) {
  return (
    mimeTypes[path.slice(path.lastIndexOf(".")).toLowerCase()] ??
    "application/octet-stream"
  );
}
function sessionIdentity(value: NativeSession) {
  return JSON.stringify(value);
}
function captureSession(value: NativeSession): NativeSession {
  const base = new URL(value.baseUrl);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    typeof value.origin !== "string" ||
    new URL(value.origin).origin !== value.origin ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    [value.csrfToken, value.sessionToken].some(
      (v) =>
        typeof v !== "string" || !v || v.length > 8192 || /[\r\n]/u.test(v),
    )
  )
    failure("desktop_plugin_ui_session_invalid");
  return Object.freeze({
    baseUrl: base.href,
    origin: value.origin,
    csrfToken: value.csrfToken,
    sessionToken: value.sessionToken,
    generation: value.generation,
  });
}

/** Owns authenticated finite reads and adopted leases. It never imports Node code or serves filesystem paths. */
export class DesktopPluginUiAssetBroker {
  readonly #session: () => NativeSession;
  readonly #fetch: typeof globalThis.fetch;
  readonly #diagnostic: (code: string) => void;
  readonly #controlOwner: (() => ChildProcess) | null;
  readonly #entries = new Map<string, Entry>();
  #generation = 0;
  #closed = false;
  #reservedBytes = 0;
  #requests = 0;
  #operations = 0;
  #assetBytes = 0;
  #cleanupRequests = 0;

  constructor(
    input: Readonly<{
      session(): NativeSession;
      fetch?: typeof globalThis.fetch;
      onDiagnostic?(code: string): void;
      /** Actual managed Control process from the native supervisor, never an IPC receipt. */
      controlOwner?(): ChildProcess;
    }>,
  ) {
    if (
      typeof input.session !== "function" ||
      (input.fetch !== undefined && typeof input.fetch !== "function") ||
      (input.controlOwner !== undefined &&
        typeof input.controlOwner !== "function")
    )
      failure("desktop_plugin_ui_configuration_invalid");
    this.#session = input.session.bind(input);
    this.#fetch = input.fetch?.bind(input) ?? globalThis.fetch.bind(globalThis);
    this.#diagnostic = input.onDiagnostic?.bind(input) ?? (() => {});
    this.#controlOwner = input.controlOwner?.bind(input) ?? null;
  }

  get usage() {
    return Object.freeze({
      bindings: this.#entries.size,
      requests: this.#requests,
      operations: this.#operations,
      cleanupRequests: this.#cleanupRequests,
      reservedBytes:
        this.#reservedBytes +
        this.#assetBytes +
        this.#cleanupRequests * JSON_BYTES,
    });
  }

  async adopt(
    input: Readonly<{ lease: unknown; expectedControlOrigin: string }>,
  ): Promise<DesktopPluginUiBinding> {
    // This input crosses structured-clone IPC; the public contract parser also rejects accessors/unknown fields.
    const captured = adoptionInput(input);
    const lease = parsePluginUiLease(captured.lease);
    const session = captureSession(this.#session());
    if (captured.expectedControlOrigin !== new URL(session.baseUrl).origin)
      failure("desktop_plugin_ui_control_origin_changed");
    if (this.#closed) failure("desktop_plugin_ui_closed");
    if (this.#entries.size >= 32) failure("desktop_plugin_ui_binding_limit");
    if (this.#operations >= 16) failure("desktop_plugin_ui_operation_limit");
    if (
      [...this.#entries.values()].some(
        (v) => v.lease.mountRef === lease.mountRef,
      )
    )
      failure("desktop_plugin_ui_mount_already_adopted");
    const ui = lease.descriptor.entrypoints.ui;
    const contribution = lease.descriptor.contributions.find(
      (v) => v.id === lease.contributionId,
    );
    if (
      ui?.mode !== "trustedModule" ||
      !lease.publicAssets.includes(ui.path) ||
      mime(ui.path) !== "text/javascript; charset=utf-8" ||
      contribution?.kind !== "module" ||
      contribution.slot !== "main.content" ||
      Date.parse(lease.expiresAt) <= Date.now()
    )
      failure("desktop_plugin_ui_lease_invalid");
    const bindingRef = randomBytes(32).toString("hex");
    const entry: Entry = {
      bindingRef,
      lease,
      identity: JSON.stringify(lease),
      session,
      controlOwner: this.#controlOwner?.() ?? null,
      generation: this.#generation,
      abort: new AbortController(),
      pending: new Set(),
      operations: new Set(),
      uncertainReaders: new Set(),
      state: "adopting",
      failure: null,
      closing: null,
      expiry: null,
      renewal: null,
    };
    this.#entries.set(bindingRef, entry);
    try {
      return await this.#operation(entry, async () => {
        await this.#fresh(entry);
        this.#assertCurrent(entry);
        entry.state = "active";
        this.#armExpiry(entry);
        return Object.freeze({
          bindingRef,
          entryUrl: desktopPluginUiAssetUrl(bindingRef, ui.path),
          controlOrigin: new URL(session.baseUrl).origin,
        });
      });
    } catch (error) {
      try {
        await this.release(bindingRef);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "desktop_plugin_ui_adoption_cleanup_failed",
        );
      }
      throw error;
    }
  }

  /** Extends only this live native owner; the renderer never supplies a lease, session or mount reference. */
  renew(bindingRef: string): Promise<PluginUiLease> {
    if (typeof bindingRef !== "string" || !/^[a-f0-9]{64}$/u.test(bindingRef))
      failure("desktop_plugin_ui_binding_invalid");
    const entry = this.#entries.get(bindingRef);
    if (!entry || entry.state !== "active")
      failure("desktop_plugin_ui_binding_unavailable");
    this.#assertCurrent(entry);
    if (entry.renewal) return entry.renewal.result;
    // Take this snapshot before registering the renewal. New asset operations wait
    // for its inner flight; disposal never depends on its own public cleanup result.
    const previous = [...entry.operations];
    const operation = this.#trackOperation(entry, async () => {
      const settled = await Promise.allSettled(previous);
      this.#assertCurrent(entry);
      if (settled.some((result) => result.status === "rejected"))
        failure("desktop_plugin_ui_prior_operation_failed");
      await this.#fresh(entry);
      const lease = entry.lease;
      const response = await this.#request(
        entry,
        "POST",
        "/renew",
        JSON_BYTES,
        undefined,
        JSON.stringify({ expectedExpiresAt: lease.expiresAt }),
      );
      if (
        response.contentType !== "application/json; charset=utf-8" &&
        response.contentType !== "application/json"
      )
        failure("desktop_plugin_ui_lease_response_invalid");
      const renewed = parseRenewPluginUiMountResponse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(response.bytes),
        ),
        lease,
      );
      this.#assertCurrent(entry);
      // The authenticated CAS response alone may update expiry. All other pinned
      // fields, the Entry object, binding reference and asset URL remain unchanged.
      entry.lease = renewed;
      entry.identity = JSON.stringify(renewed);
      this.#armExpiry(entry);
      await this.#fresh(entry);
      this.#assertCurrent(entry);
      return renewed;
    });
    const result = operation.catch(async (error: unknown) => {
      try {
        await this.release(bindingRef);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "desktop_plugin_ui_renewal_cleanup_failed",
        );
      }
      throw error;
    });
    const renewal = Object.freeze({ operation, result });
    entry.renewal = renewal;
    void result
      .finally(() => {
        if (entry.renewal === renewal) entry.renewal = null;
      })
      .catch(() => {});
    return result;
  }

  /** Called by the genuine Electron Session request gate, before any asset egress. */
  allows(url: string): boolean {
    try {
      const { bindingRef, path } = parseDesktopPluginUiAssetUrl(url);
      const entry = this.#entries.get(bindingRef);
      if (
        !entry ||
        entry.state !== "active" ||
        !entry.lease.publicAssets.includes(path)
      )
        return false;
      this.#assertCurrent(entry);
      return true;
    } catch {
      return false;
    }
  }

  read(request: Request): Promise<Response> {
    if (request.method !== "GET") failure("desktop_plugin_ui_method_invalid");
    const { bindingRef, path } = parseDesktopPluginUiAssetUrl(request.url);
    const entry = this.#entries.get(bindingRef);
    if (!entry || entry.state !== "active" || !this.allows(request.url))
      failure("desktop_plugin_ui_binding_unavailable");
    const file = entry.lease.descriptor.files.find((v) => v.path === path);
    if (!file || file.byteLength > MAX_ASSET_BYTES)
      failure("desktop_plugin_ui_asset_limit");
    // Retain both the verified bytes and finite Response copy budget through the post-read authority fence.
    const reserved = 2 * file.byteLength;
    if (this.#reservedBytes + this.#assetBytes + reserved > MAX_RESERVED_BYTES)
      failure("desktop_plugin_ui_request_limit");
    this.#assetBytes += reserved;
    try {
      return this.#operation(entry, async () => {
        await this.#fresh(entry, request.signal);
        const result = await this.#request(
          entry,
          "GET",
          `/assets/${path.split("/").map(encodeURIComponent).join("/")}`,
          file.byteLength,
          request.signal,
        );
        if (
          result.contentType !== mime(path) ||
          result.bytes.byteLength !== file.byteLength ||
          createHash("sha256").update(result.bytes).digest("hex") !==
            file.sha256
        )
          failure("desktop_plugin_ui_asset_integrity_invalid");
        await this.#fresh(entry, request.signal);
        this.#assertCurrent(entry);
        if (request.signal.aborted)
          failure("desktop_plugin_ui_request_aborted");
        return new Response(result.bytes, {
          headers: {
            "content-type": mime(path),
            "content-length": String(result.bytes.byteLength),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "access-control-allow-origin": "null",
            "referrer-policy": "no-referrer",
          },
        });
      }).finally(() => {
        // A queued read can be rejected by renewal before its body starts.
        this.#assetBytes -= reserved;
      });
    } catch (error) {
      this.#assetBytes -= reserved;
      throw error;
    }
  }

  release(bindingRef: string): Promise<void> {
    if (typeof bindingRef !== "string" || !/^[a-f0-9]{64}$/u.test(bindingRef))
      failure("desktop_plugin_ui_binding_invalid");
    const entry = this.#entries.get(bindingRef);
    if (!entry) return Promise.resolve();
    if (entry.failure !== null && this.#canRetireTerminatedControl(entry)) {
      this.#entries.delete(bindingRef);
      return Promise.resolve();
    }
    if (entry.closing) return entry.closing;
    entry.state = "closing";
    entry.abort.abort();
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.expiry = null;
    const closing = this.#dispose(entry);
    entry.closing = closing;
    void closing.catch(() => {});
    return closing;
  }

  async invalidate(): Promise<void> {
    this.#generation++;
    const results = await Promise.allSettled(
      [...this.#entries.keys()].map((ref) => this.release(ref)),
    );
    const failures = results.flatMap((v) =>
      v.status === "rejected" ? [v.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "desktop_plugin_ui_cleanup_failed");
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.invalidate();
  }

  async #dispose(entry: Entry): Promise<void> {
    await Promise.allSettled([...entry.operations]);
    await Promise.allSettled([...entry.pending]);
    if (entry.failure !== null) failure("desktop_plugin_ui_cleanup_uncertain");
    if (this.#canRetireTerminatedControl(entry)) {
      this.#entries.delete(entry.bindingRef);
      return;
    }
    try {
      const result = await this.#request(entry, "DELETE", "", JSON_BYTES);
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
      );
      if (
        result.contentType !== "application/json; charset=utf-8" &&
        result.contentType !== "application/json"
      )
        failure("desktop_plugin_ui_cleanup_response_invalid");
      if (
        !value ||
        typeof value !== "object" ||
        Reflect.ownKeys(value).length !== 1 ||
        !("closed" in value) ||
        value.closed !== true
      )
        failure("desktop_plugin_ui_cleanup_response_invalid");
      this.#entries.delete(entry.bindingRef);
    } catch (error) {
      if (this.#canRetireTerminatedControl(entry)) {
        this.#entries.delete(entry.bindingRef);
        return;
      }
      entry.failure = error;
      throw error;
    }
  }

  #assertCurrent(entry: Entry) {
    if (
      this.#closed ||
      entry.state === "closing" ||
      entry.abort.signal.aborted ||
      entry.generation !== this.#generation ||
      Date.parse(entry.lease.expiresAt) <= Date.now() ||
      sessionIdentity(captureSession(this.#session())) !==
        sessionIdentity(entry.session)
    )
      failure("desktop_plugin_ui_scope_changed");
  }

  #canRetireTerminatedControl(entry: Entry): boolean {
    return (
      entry.controlOwner !== null &&
      (entry.controlOwner.exitCode !== null ||
        entry.controlOwner.signalCode !== null) &&
      entry.pending.size === 0 &&
      entry.operations.size === 0 &&
      entry.uncertainReaders.size === 0
    );
  }

  #armExpiry(entry: Entry): void {
    if (entry.expiry) clearTimeout(entry.expiry);
    const timer = setTimeout(
      () => {
        if (entry.expiry !== timer) return;
        entry.expiry = null;
        void this.release(entry.bindingRef).catch(() =>
          this.#diagnostic("desktop_plugin_ui_cleanup_failed"),
        );
      },
      Math.min(2_147_483_647, Date.parse(entry.lease.expiresAt) - Date.now()),
    );
    entry.expiry = timer;
    timer.unref();
  }

  async #fresh(entry: Entry, signal?: AbortSignal) {
    this.#assertCurrent(entry);
    const result = await this.#request(entry, "GET", "", JSON_BYTES, signal);
    if (
      result.contentType !== "application/json; charset=utf-8" &&
      result.contentType !== "application/json"
    )
      failure("desktop_plugin_ui_lease_response_invalid");
    const lease = parsePluginUiLease(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
      ),
    );
    this.#assertCurrent(entry);
    if (JSON.stringify(lease) !== entry.identity)
      failure("desktop_plugin_ui_lease_changed");
  }

  #request(
    entry: Entry,
    method: "GET" | "POST" | "DELETE",
    suffix: string,
    maximumBytes: number,
    callerSignal?: AbortSignal,
    body?: string,
  ) {
    // At most 32 lease owners exist. Cleanup has its own bounded 32 x 512KiB allowance, never competes with asset slots.
    if (
      method !== "DELETE" &&
      (this.#requests >= 16 ||
        this.#reservedBytes + this.#assetBytes + maximumBytes >
          MAX_RESERVED_BYTES)
    )
      failure("desktop_plugin_ui_request_limit");
    if (method !== "DELETE") {
      this.#requests++;
      this.#reservedBytes += maximumBytes;
    } else this.#cleanupRequests++;
    const task = this.#readFinite(
      entry,
      method,
      suffix,
      maximumBytes,
      callerSignal,
      body,
    );
    entry.pending.add(task);
    void task
      .finally(() => {
        entry.pending.delete(task);
        if (method !== "DELETE") {
          this.#requests--;
          this.#reservedBytes -= maximumBytes;
        } else this.#cleanupRequests--;
      })
      .catch(() => {});
    return task;
  }

  #operation<T>(entry: Entry, run: () => Promise<T>): Promise<T> {
    const renewal = entry.renewal;
    return this.#trackOperation(
      entry,
      renewal
        ? async () => {
            await renewal.operation;
            this.#assertCurrent(entry);
            return run();
          }
        : run,
    );
  }

  #trackOperation<T>(entry: Entry, run: () => Promise<T>): Promise<T> {
    if (this.#operations >= 16) failure("desktop_plugin_ui_operation_limit");
    this.#operations++;
    const task = run();
    entry.operations.add(task);
    void task
      .finally(() => {
        entry.operations.delete(task);
        this.#operations--;
      })
      .catch(() => {});
    return task;
  }

  async #readFinite(
    entry: Entry,
    method: "GET" | "POST" | "DELETE",
    suffix: string,
    maximumBytes: number,
    callerSignal?: AbortSignal,
    body?: string,
  ) {
    const deadline = AbortSignal.timeout(DEADLINE_MS);
    const signal = AbortSignal.any([
      deadline,
      ...(method !== "DELETE" ? [entry.abort.signal] : []),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    const headers = new Headers({
      authorization: `Bearer ${entry.session.sessionToken}`,
      origin: entry.session.origin,
    });
    if (method !== "GET") headers.set("x-csrf-token", entry.session.csrfToken);
    if (method === "POST") headers.set("content-type", "application/json");
    const url = new URL(
      `/api/v1/plugins/ui/mounts/${entry.lease.mountRef}${suffix}`,
      entry.session.baseUrl,
    );
    signal.throwIfAborted();
    const response = await this.#fetch(url, {
      method,
      headers,
      signal,
      redirect: "error",
      cache: "no-store",
      ...(body === undefined ? {} : { body }),
    });
    const reader = response.body?.getReader();
    let cancellation: Promise<void> | null = null;
    const cancel = () => {
      if (reader && !cancellation) {
        cancellation = reader.cancel().catch((error) => {
          entry.failure = error;
          entry.uncertainReaders.add(reader);
          throw error;
        });
        void cancellation.catch(() => {});
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    let complete = false;
    try {
      if (signal.aborted) {
        cancel();
        failure("desktop_plugin_ui_request_aborted");
      }
      if (response.status !== 200 || response.redirected || !reader)
        failure("desktop_plugin_ui_http_invalid");
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        (!/^(0|[1-9][0-9]*)$/u.test(declared) ||
          !Number.isSafeInteger(Number(declared)) ||
          Number(declared) > maximumBytes)
      )
        failure("desktop_plugin_ui_asset_limit");
      const bytes = new Uint8Array(maximumBytes);
      let length = 0;
      while (true) {
        const next = await reader.read();
        if (signal.aborted) failure("desktop_plugin_ui_request_aborted");
        if (next.done) {
          complete = true;
          break;
        }
        if (
          !(next.value instanceof Uint8Array) ||
          length + next.value.byteLength > maximumBytes
        )
          failure("desktop_plugin_ui_asset_limit");
        bytes.set(next.value, length);
        length += next.value.byteLength;
      }
      if (declared !== null && Number(declared) !== length)
        failure("desktop_plugin_ui_asset_length_invalid");
      return {
        bytes: bytes.subarray(0, length),
        contentType: response.headers.get("content-type"),
      };
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!complete) cancel();
      if (cancellation) await cancellation;
      reader?.releaseLock();
    }
  }
}
