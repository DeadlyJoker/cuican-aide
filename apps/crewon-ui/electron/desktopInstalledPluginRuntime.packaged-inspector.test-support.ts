/** External test-only inspector; the packaged product remains the sole Main entry. */
import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_DISCOVERY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const ORIGINAL_PACKAGE_MAIN = "dist-electron/main.mjs";
type ObjectValue = Record<string, unknown>;
type Pending = {
  resolve(value: ObjectValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export type PackagedMainIdentity = Readonly<{
  processId: number;
  executable: string;
  resourcesPath: string;
  userData: string;
  appPath: string;
  packageMain: string;
}>;
export type VerifiedPackagedMain = PackagedMainIdentity &
  Readonly<{ isPackaged: true; defaultApp: false; nodeVersion: string }>;

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("packaged_inspector_object_invalid");
  return value as ObjectValue;
}
function timeout(value = DEFAULT_TIMEOUT_MS): number {
  assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 30_000);
  return value;
}
function portNumber(value: number): number {
  assert.ok(Number.isSafeInteger(value) && value >= 1024 && value <= 65_535);
  return value;
}
function text(value: unknown): string {
  assert.ok(
    typeof value === "string" && value.length > 0 && value.length <= 4096,
  );
  assert.ok(!/[\u0000-\u001f\u007f]/u.test(value));
  return value;
}

/** Releases the temporary loopback listener before the caller launches its owned .app. */
export async function ownedPackagedInspectorPort(): Promise<number> {
  const server = createServer();
  server.unref();
  try {
    return await new Promise<number>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string")
          reject(new Error("packaged_inspector_port_missing"));
        else accept(portNumber(address.port));
      });
    });
  } finally {
    if (server.listening)
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
  }
}

async function discoveryBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("packaged_inspector_discovery_empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_DISCOVERY_BYTES)
        throw new Error("packaged_inspector_discovery_limit");
      chunks.push(part.value);
    }
    const value = Buffer.concat(chunks);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function inspectorEndpoint(options: {
  port: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const remaining = Math.max(1, deadline - Date.now());
    const attempt = AbortSignal.timeout(Math.min(1000, remaining));
    try {
      const response = await fetch(
        `http://127.0.0.1:${options.port}/json/list`,
        {
          redirect: "error",
          signal: options.signal
            ? AbortSignal.any([options.signal, attempt])
            : attempt,
        },
      );
      if (response.status === 200) {
        const targets = await discoveryBody(response);
        assert.ok(
          Array.isArray(targets) && targets.length === 1,
          "packaged_inspector_target_count_invalid",
        );
        const target = object(targets[0]);
        assert.ok(
          target.type === "node",
          "packaged_inspector_target_type_invalid",
        );
        const endpoint = new URL(text(target.webSocketDebuggerUrl));
        assert.ok(
          endpoint.protocol === "ws:" &&
            endpoint.hostname === "127.0.0.1" &&
            endpoint.port === String(options.port) &&
            endpoint.username +
              endpoint.password +
              endpoint.search +
              endpoint.hash ===
              "" &&
            /^\/[a-zA-Z0-9-]{1,128}$/u.test(endpoint.pathname),
          "packaged_inspector_endpoint_invalid",
        );
        return endpoint.href;
      }
      await response.body?.cancel();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof assert.AssertionError) throw error;
      if (
        error instanceof Error &&
        error.message.startsWith("packaged_inspector_")
      )
        throw error;
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, {
      signal: options.signal,
    });
  }
  throw new Error("packaged_inspector_discovery_timeout");
}

class PackagedMainInspector {
  readonly #socket: WebSocket;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #verified = false;
  #observerStarted = false;

  constructor(socket: WebSocket, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.addEventListener("message", (event) => this.#message(event.data));
    socket.addEventListener("error", () =>
      this.#fail("packaged_inspector_socket_error"),
    );
    socket.addEventListener("close", () =>
      this.#fail("packaged_inspector_socket_closed"),
    );
  }

  #fail(code: string): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.#pending.clear();
  }

  #message(data: unknown): void {
    try {
      if (
        typeof data !== "string" ||
        Buffer.byteLength(data) > MAX_MESSAGE_BYTES
      )
        throw new Error("packaged_inspector_message_limit");
      const message = object(JSON.parse(data));
      if (message.id === undefined) return; // Inspector events are neither retained nor logged.
      assert.ok(Number.isSafeInteger(message.id));
      const pending = this.#pending.get(message.id as number);
      if (!pending) return;
      const result =
        message.error === undefined ? object(message.result) : null;
      this.#pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (result === null)
        pending.reject(new Error("packaged_inspector_protocol_error"));
      else pending.resolve(result);
    } catch {
      this.#fail("packaged_inspector_message_invalid");
      this.#socket.close();
    }
  }

  #evaluate(expression: string, awaitPromise: boolean): Promise<ObjectValue> {
    assert.ok(!this.#closed && this.#socket.readyState === WebSocket.OPEN);
    assert.ok(this.#pending.size < 8 && this.#nextId < Number.MAX_SAFE_INTEGER);
    const id = this.#nextId++;
    return new Promise<ObjectValue>((accept, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("packaged_inspector_request_timeout"));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve: accept, reject, timer });
      try {
        this.#socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise, returnByValue: awaitPromise },
          }),
        );
      } catch {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new Error("packaged_inspector_request_send_failed"));
      }
    });
  }

  async verifyMain(
    expected: PackagedMainIdentity,
  ): Promise<VerifiedPackagedMain> {
    assert.ok(!this.#verified && !this.#observerStarted);
    assert.ok(
      Number.isSafeInteger(expected.processId) && expected.processId > 0,
    );
    assert.equal(expected.packageMain, ORIGINAL_PACKAGE_MAIN);
    for (const path of [
      expected.executable,
      expected.resourcesPath,
      expected.userData,
      expected.appPath,
    ])
      assert.ok(isAbsolute(text(path)));
    assert.equal(
      resolve(expected.appPath),
      join(resolve(expected.resourcesPath), "app.asar"),
    );
    const result = await this.#evaluate(
      `(() => {
      const require = process.getBuiltinModule("node:module").createRequire(process.execPath);
      const { app } = require("electron");
      const fs = process.getBuiltinModule("node:fs");
      const path = process.getBuiltinModule("node:path");
      return app.whenReady().then(() => {
      const appPath = app.getAppPath();
      const manifestText = fs.readFileSync(path.join(appPath, "package.json"), "utf8");
      if (Buffer.byteLength(manifestText) > 131072) throw new Error("packaged_manifest_limit");
      return {
        processId: process.pid, executable: process.execPath,
        resourcesPath: process.resourcesPath, userData: app.getPath("userData"),
        appPath, packageMain: JSON.parse(manifestText).main,
        isPackaged: app.isPackaged, defaultApp: process.defaultApp === true,
        forcedPackaged: Object.hasOwn(process.env, "ELECTRON_FORCE_IS_PACKAGED"),
        nodeVersion: process.versions.node
      };
      });
    })()`,
      true,
    );
    assert.ok(
      result.exceptionDetails === undefined,
      "packaged_inspector_main_probe_failed",
    );
    const value = object(object(result.result).value);
    // This probe contains only public runtime metadata and owned paths, never credentials.
    console.log("Packaged Main observed identity:", JSON.stringify(value));
    assert.equal(value.processId, expected.processId);
    assert.equal(value.isPackaged, true);
    assert.equal(value.defaultApp, false);
    assert.equal(value.forcedPackaged, false);
    assert.equal(value.packageMain, ORIGINAL_PACKAGE_MAIN);
    assert.match(text(value.nodeVersion), /^24\./u);
    for (const key of [
      "executable",
      "resourcesPath",
      "userData",
      "appPath",
    ] as const)
      assert.equal(
        await realpath(text(value[key])),
        await realpath(expected[key]),
        `packaged_inspector_${key}_mismatch`,
      );
    this.#verified = true;
    return Object.freeze({
      processId: expected.processId,
      executable: text(value.executable),
      resourcesPath: text(value.resourcesPath),
      userData: text(value.userData),
      appPath: text(value.appPath),
      packageMain: text(value.packageMain),
      isPackaged: true,
      defaultApp: false,
      nodeVersion: text(value.nodeVersion),
    });
  }

  async observeOriginalPackagedApp(
    options: Readonly<{ observerPath: string; configPath: string }>,
  ): Promise<void> {
    assert.ok(this.#verified && !this.#observerStarted);
    for (const path of [options.observerPath, options.configPath]) {
      assert.ok(isAbsolute(text(path)));
      const stat = await lstat(path);
      assert.ok(stat.isFile() && stat.uid === process.getuid?.());
    }
    const config = await realpath(options.configPath);
    this.#observerStarted = true;
    const result = await this.#evaluate(
      `(() => {
      const require = process.getBuiltinModule("node:module").createRequire(process.execPath);
      const module = require(${JSON.stringify(await realpath(options.observerPath))});
      if (typeof module.observeOriginalPackagedApp !== "function")
        throw new Error("packaged_observer_export_missing");
      void module.observeOriginalPackagedApp(${JSON.stringify(config)}).catch(() => {
      console.error("CREWON_PACKAGED_REPORT_OBSERVER_FAILED");
      const { app } = require("electron");
      app.quit();
      });
      return "observer-dispatched";
    })()`,
      false,
    );
    assert.ok(
      result.exceptionDetails === undefined,
      "packaged_inspector_observer_dispatch_failed",
    );
  }

  async close(): Promise<void> {
    this.#fail("packaged_inspector_closed");
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((accept, reject) => {
      const closed = () => {
        clearTimeout(timer);
        accept();
      };
      const timer = setTimeout(() => {
        this.#socket.removeEventListener("close", closed);
        reject(new Error("packaged_inspector_detach_timeout"));
      }, 1000);
      this.#socket.addEventListener("close", closed, { once: true });
      try {
        this.#socket.close();
      } catch {
        clearTimeout(timer);
        this.#socket.removeEventListener("close", closed);
        reject(new Error("packaged_inspector_detach_failed"));
      }
    });
  }
}

export async function connectPackagedMainInspector(
  options: Readonly<{
    port: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }>,
): Promise<PackagedMainInspector> {
  assert.match(process.version, /^v24\./u);
  const timeoutMs = timeout(options.timeoutMs);
  const endpoint = await inspectorEndpoint({
    ...options,
    port: portNumber(options.port),
    timeoutMs,
  });
  options.signal?.throwIfAborted();
  const socket = new WebSocket(endpoint);
  const inspector = new PackagedMainInspector(socket, timeoutMs);
  try {
    await new Promise<void>((accept, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        options.signal?.removeEventListener("abort", aborted);
        error ? reject(error) : accept();
      };
      const opened = () => finish();
      const failed = () =>
        finish(new Error("packaged_inspector_connect_failed"));
      const aborted = () =>
        finish(new Error("packaged_inspector_connect_aborted"));
      const timer = setTimeout(
        () => finish(new Error("packaged_inspector_connect_timeout")),
        timeoutMs,
      );
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) aborted();
    });
    return inspector;
  } catch (error) {
    await inspector.close().catch(() => {});
    throw error;
  }
}
