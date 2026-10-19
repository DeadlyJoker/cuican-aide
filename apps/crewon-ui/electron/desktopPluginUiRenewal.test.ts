import { createHash } from "node:crypto";
import type { BrowserWindow, IpcMain } from "electron";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopPluginUiAssetBroker } from "./desktopPluginUiAssets.ts";
import { bindDesktopPluginUiIpc } from "./desktopPluginUiProtocol.ts";
import {
  deferred,
  flush,
  uiLease,
} from "./desktopPluginUiAssets.test-support.ts";
import type { CrewonDesktopBridge } from "../src/lib/desktop/desktopBridge.ts";

const wire = vi.hoisted(() => ({
  invoke: vi.fn(),
  expose: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: wire.expose },
  ipcRenderer: { invoke: wire.invoke, on: vi.fn(), removeListener: vi.fn() },
}));

const owners: DesktopPluginUiAssetBroker[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  vi.useRealTimers();
  wire.invoke.mockReset();
});
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function fixture() {
  const bytes = new TextEncoder().encode("export default 'renewal fixture'");
  const original = uiLease();
  const lease: PluginUiLease = {
    ...original,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    descriptor: {
      ...original.descriptor,
      files: original.descriptor.files.map((file, index) =>
        index
          ? file
          : {
              ...file,
              byteLength: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
      ),
    },
  };
  const state = {
    lease,
    generation: 1,
    handler: null as
      | ((url: URL, init: RequestInit) => Response | Promise<Response>)
      | null,
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "DELETE") return json({ closed: true });
    if (state.handler) return state.handler(url, init!);
    if (url.pathname.includes("/assets/"))
      return new Response(bytes, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    if (init?.method === "POST") {
      const request: unknown = JSON.parse(String(init.body));
      expect(request).toEqual({ expectedExpiresAt: state.lease.expiresAt });
      state.lease = {
        ...state.lease,
        expiresAt: new Date(
          Date.parse(state.lease.expiresAt) + 60_000,
        ).toISOString(),
      };
    }
    return json(state.lease);
  });
  const owner = new DesktopPluginUiAssetBroker({
    session: () => ({
      baseUrl: "http://127.0.0.1:12345/",
      origin: "http://crewon.localhost",
      csrfToken: "named-native-csrf",
      sessionToken: "named-native-token",
      generation: state.generation,
    }),
    fetch,
  });
  owners.push(owner);
  return {
    owner,
    state,
    fetch,
    lease,
    bytes,
    adopt: () =>
      owner.adopt({ lease, expectedControlOrigin: "http://127.0.0.1:12345" }),
    posts: () => fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
  };
}

describe("native asset owner lease renewal", () => {
  it("uses the captured native session and CAS, retains binding/asset identity, and replaces only the expiry timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T02:00:00.000Z"));
    const f = fixture(),
      binding = await f.adopt();
    const renewed = await f.owner.renew(binding.bindingRef);
    expect(renewed).toEqual({
      ...f.lease,
      expiresAt: "2026-10-05T02:02:00.000Z",
    });
    const [url, init] = f.posts()[0];
    expect(String(url)).toBe(
      `http://127.0.0.1:12345/api/v1/plugins/ui/mounts/${f.lease.mountRef}/renew`,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedExpiresAt: f.lease.expiresAt,
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer named-native-token",
    );
    expect(new Headers(init?.headers).get("origin")).toBe(
      "http://crewon.localhost",
    );
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe(
      "named-native-csrf",
    );
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(f.owner.usage).toEqual({
      bindings: 1,
      requests: 0,
      operations: 0,
      cleanupRequests: 0,
      reservedBytes: 0,
    });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(f.owner.allows(binding.entryUrl)).toBe(true);
    const asset = await f.owner.read(new Request(binding.entryUrl));
    expect(await asset.text()).toBe("export default 'renewal fixture'");
    await vi.advanceTimersByTimeAsync(59_999);
    await flush();
    expect(f.owner.allows(binding.entryUrl)).toBe(false);
    expect(f.owner.usage.bindings).toBe(0);
    expect(
      f.fetch.mock.calls.filter(([, value]) => value?.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("coalesces renew calls, waits actual old asset completion, and gates new reads until the authenticated new lease is fenced", async () => {
    const f = fixture(),
      binding = await f.adopt();
    const assetEntered = deferred<void>(),
      assetRelease = deferred<void>(),
      postEntered = deferred<void>(),
      postRelease = deferred<void>();
    let assets = 0;
    f.state.handler = async (url, init) => {
      if (url.pathname.includes("/assets/")) {
        if (++assets === 1) {
          assetEntered.resolve();
          await assetRelease.promise;
        }
        return new Response(f.bytes, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      if (init.method === "POST") {
        postEntered.resolve();
        await postRelease.promise;
        f.state.lease = {
          ...f.state.lease,
          expiresAt: new Date(
            Date.parse(f.lease.expiresAt) + 60_000,
          ).toISOString(),
        };
      }
      return json(f.state.lease);
    };
    const oldRead = f.owner.read(new Request(binding.entryUrl));
    await assetEntered.promise;
    const renewal = f.owner.renew(binding.bindingRef);
    expect(f.owner.renew(binding.bindingRef)).toBe(renewal);
    const newRead = f.owner.read(new Request(binding.entryUrl));
    await flush();
    expect(f.posts()).toHaveLength(0);
    expect(assets).toBe(1);
    assetRelease.resolve();
    await oldRead;
    await postEntered.promise;
    expect(f.posts()).toHaveLength(1);
    expect(assets).toBe(1);
    postRelease.resolve();
    await renewal;
    expect(await (await newRead).text()).toBe(
      "export default 'renewal fixture'",
    );
    expect(assets).toBe(2);
    expect(f.owner.usage).toMatchObject({
      bindings: 1,
      operations: 0,
      requests: 0,
      reservedBytes: 0,
    });
  });

  it.each([
    "mount",
    "digest",
    "publisher",
    "revision",
    "assets",
    "contribution",
    "unchanged-expiry",
    "excess-expiry",
  ])("closes rather than publishing a renewed %s mismatch", async (kind) => {
    const f = fixture(),
      binding = await f.adopt();
    f.state.handler = (_url, init) => {
      if (init.method !== "POST") return json(f.lease);
      const renewed = structuredClone({
        ...f.lease,
        expiresAt: new Date(
          Date.parse(f.lease.expiresAt) + 60_000,
        ).toISOString(),
      });
      switch (kind) {
        case "mount":
          return json({ ...renewed, mountRef: uiLease(2).mountRef });
        case "digest":
          return json({
            ...renewed,
            packageDigest: `sha256:${"8".repeat(64)}`,
          });
        case "publisher":
          return json({
            ...renewed,
            descriptor: {
              ...renewed.descriptor,
              publisherId: "foreign.publisher",
            },
          });
        case "revision":
          return json({ ...renewed, selectionRevision: 9 });
        case "assets":
          return json({ ...renewed, publicAssets: ["ui/index.js"] });
        case "contribution":
          return json({ ...renewed, contributionId: "foreign" });
        case "unchanged-expiry":
          return json(f.lease);
        case "excess-expiry":
          return json({
            ...renewed,
            expiresAt: new Date(
              Date.parse(f.lease.expiresAt) + 300_001,
            ).toISOString(),
          });
      }
      throw new Error("fixture_kind_invalid");
    };
    await expect(f.owner.renew(binding.bindingRef)).rejects.toThrow();
    expect(f.owner.allows(binding.entryUrl)).toBe(false);
    expect(f.owner.usage).toMatchObject({
      bindings: 0,
      operations: 0,
      requests: 0,
      reservedBytes: 0,
    });
    expect(f.posts()).toHaveLength(1);
  });

  it.each(["release", "invalidate", "session", "expire"])(
    "does not resurrect a late response after %s and physically joins gated reads",
    async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-05T02:00:00.000Z"));
      const f = fixture(),
        binding = await f.adopt();
      const entered = deferred<void>(),
        held = deferred<Response>();
      f.state.handler = (_url, init) => {
        if (init.method === "POST") {
          entered.resolve();
          return held.promise;
        }
        return json(f.state.lease);
      };
      const renewal = f.owner.renew(binding.bindingRef);
      const renewalFailure = expect(renewal).rejects.toThrow();
      await entered.promise;
      const reading = f.owner.read(new Request(binding.entryUrl));
      const readingFailure = expect(reading).rejects.toThrow();
      let closing: Promise<void> | null = null;
      if (kind === "release") closing = f.owner.release(binding.bindingRef);
      if (kind === "invalidate") closing = f.owner.invalidate();
      if (kind === "session") f.state.generation++;
      if (kind === "expire") await vi.advanceTimersByTimeAsync(60_000);
      const late = {
        ...f.lease,
        expiresAt: new Date(
          Date.parse(f.lease.expiresAt) + 60_000,
        ).toISOString(),
      };
      held.resolve(json(late));
      await renewalFailure;
      await readingFailure;
      if (closing) await closing;
      expect(f.owner.allows(binding.entryUrl)).toBe(false);
      expect(f.owner.usage).toEqual({
        bindings: 0,
        operations: 0,
        requests: 0,
        cleanupRequests: 0,
        reservedBytes: 0,
      });
      await expect(async () =>
        f.owner.renew(binding.bindingRef),
      ).rejects.toThrow("desktop_plugin_ui_binding_unavailable");
    },
  );

  it("rejects expired or renderer-forged references before sending a renewal request", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      binding = await f.adopt();
    for (const input of [
      "bad",
      binding.bindingRef + "/renew",
      { bindingRef: binding.bindingRef, lease: f.lease },
    ])
      await expect(async () => f.owner.renew(input as string)).rejects.toThrow(
        "desktop_plugin_ui_binding_invalid",
      );
    vi.setSystemTime(Date.parse(f.lease.expiresAt));
    await expect(async () => f.owner.renew(binding.bindingRef)).rejects.toThrow(
      "desktop_plugin_ui_scope_changed",
    );
    expect(f.posts()).toHaveLength(0);
    await f.owner.release(binding.bindingRef);
  });

  it.each(["pre-fence", "post-response", "post-fence"])(
    "fails closed at %s without retaining a usable binding",
    async (kind) => {
      const f = fixture(),
        binding = await f.adopt();
      let gets = 0;
      f.state.handler = (_url, init) => {
        if (init.method === "POST") {
          if (kind === "post-response")
            throw new Error("named_loopback_unavailable");
          f.state.lease = {
            ...f.lease,
            expiresAt: new Date(
              Date.parse(f.lease.expiresAt) + 60_000,
            ).toISOString(),
          };
          return json(f.state.lease);
        }
        gets++;
        if (kind === "pre-fence" || (kind === "post-fence" && gets === 2))
          return json({}, 403);
        return json(f.state.lease);
      };
      await expect(f.owner.renew(binding.bindingRef)).rejects.toThrow();
      expect(f.posts()).toHaveLength(kind === "pre-fence" ? 0 : 1);
      expect(f.owner.allows(binding.entryUrl)).toBe(false);
      expect(f.owner.usage).toMatchObject({
        bindings: 0,
        operations: 0,
        requests: 0,
        reservedBytes: 0,
      });
    },
  );
});

describe("authenticated renewal reconciliation", () => {
  it("defers an interrupted preflight only after Control confirms the same unexpired lease, and resumes queued asset reads", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      binding = await f.adopt();
    let first = true;
    f.state.handler = (url, init) => {
      if (first) {
        first = false;
        throw new TypeError("named preflight transport interrupted");
      }
      if (url.pathname.includes("/assets/"))
        return new Response(f.bytes, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      return json(f.state.lease);
    };
    const renewal = f.owner.renewResult(binding.bindingRef);
    await flush();
    const reading = f.owner.read(new Request(binding.entryUrl));
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await renewal).toEqual({ kind: "deferred", lease: f.lease });
    expect(new Uint8Array(await (await reading).arrayBuffer())).toEqual(
      f.bytes,
    );
    expect(f.state.lease.expiresAt).toBe(f.lease.expiresAt);
    expect(f.posts()).toHaveLength(0);
    expect(f.owner.allows(binding.entryUrl)).toBe(true);
    expect(f.owner.usage).toMatchObject({
      bindings: 1,
      requests: 0,
      operations: 0,
      reservedBytes: 0,
    });
  });

  it("reconciles a lost renewal acknowledgement from the authenticated current lease without another POST", async () => {
    const f = fixture(),
      binding = await f.adopt();
    f.state.handler = (_url, init) => {
      if (init.method === "POST") {
        f.state.lease = {
          ...f.state.lease,
          expiresAt: new Date(
            Date.parse(f.lease.expiresAt) + 60_000,
          ).toISOString(),
        };
        throw new TypeError("named response connection lost after CAS");
      }
      return json(f.state.lease);
    };
    expect(await f.owner.renewResult(binding.bindingRef)).toEqual({
      kind: "renewed",
      lease: f.state.lease,
    });
    expect(f.posts()).toHaveLength(1);
    expect(f.owner.allows(binding.entryUrl)).toBe(true);
    expect(f.owner.usage.bindings).toBe(1);
  });

  it("reconciles a body deadline after its reader cancellation physically succeeds", async () => {
    const f = fixture(),
      binding = await f.adopt();
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(deadline.signal);
    let reads = 0;
    f.state.handler = () =>
      ++reads === 1
        ? new Response(new ReadableStream({ cancel() {} }), {
            headers: { "content-type": "application/json" },
          })
        : json(f.lease);
    try {
      const renewal = f.owner.renewResult(binding.bindingRef);
      await flush();
      deadline.abort(new DOMException("fixture deadline", "TimeoutError"));
      expect(await renewal).toEqual({ kind: "deferred", lease: f.lease });
      expect(reads).toBe(2);
      expect(f.posts()).toHaveLength(0);
      expect(f.owner.allows(binding.entryUrl)).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it("never defers a body timeout when cancelling its physical reader fails", async () => {
    const f = fixture(),
      binding = await f.adopt();
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    f.state.handler = () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error("named physical reader cancellation failed");
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    try {
      const refusal = expect(
        f.owner.renewResult(binding.bindingRef),
      ).rejects.toThrow();
      await flush();
      deadline.abort(new DOMException("fixture deadline", "TimeoutError"));
      await refusal;
      expect(f.owner.allows(binding.entryUrl)).toBe(false);
      expect(f.owner.usage.bindings).toBe(1);
      expect(f.posts()).toHaveLength(0);
      await expect(f.owner.close()).rejects.toThrow();
    } finally {
      timeout.mockRestore();
      owners.splice(owners.indexOf(f.owner), 1);
    }
  });

  it("can defer an interrupted pre-renewal validation without sending a POST", async () => {
    const f = fixture(),
      binding = await f.adopt();
    let reads = 0;
    f.state.handler = () => {
      if (++reads === 1)
        throw new TypeError("named validation connection lost");
      return json(f.state.lease);
    };
    expect(await f.owner.renewResult(binding.bindingRef)).toEqual({
      kind: "deferred",
      lease: f.lease,
    });
    expect(reads).toBe(2);
    expect(f.posts()).toHaveLength(0);
    expect(f.owner.allows(binding.entryUrl)).toBe(true);
  });

  for (const refusal of ["permission", "pin", "offline", "session"] as const)
    it(`never defers a transient failure when reconciliation loses ${refusal}`, async () => {
      const f = fixture(),
        binding = await f.adopt();
      let failed = false;
      f.state.handler = (_url, init) => {
        if (init.method === "POST") {
          failed = true;
          if (refusal === "session") f.state.generation++;
          throw new TypeError("named renewal connection lost");
        }
        if (failed) {
          if (refusal === "permission") return json({}, 403);
          if (refusal === "offline")
            throw new TypeError("named reconciliation still offline");
          if (refusal === "pin")
            return json({
              ...f.state.lease,
              selectionRevision: f.lease.selectionRevision + 1,
              expiresAt: new Date(
                Date.parse(f.lease.expiresAt) + 60_000,
              ).toISOString(),
            });
        }
        return json(f.state.lease);
      };
      await expect(f.owner.renewResult(binding.bindingRef)).rejects.toThrow();
      expect(f.posts()).toHaveLength(1);
      expect(f.owner.allows(binding.entryUrl)).toBe(false);
      expect(f.owner.usage.bindings).toBe(0);
    });

  it("retains an abort-ignoring physical renewal until it really settles before reconciling", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      binding = await f.adopt(),
      held = deferred<Response>();
    let reads = 0,
      settled = false;
    f.state.handler = (_url, init) =>
      init.method === "POST" ? held.promise : (reads++, json(f.state.lease));
    const renewal = f.owner.renewResult(binding.bindingRef).finally(() => {
      settled = true;
    });
    const rejected = expect(renewal).rejects.toThrow("renewal_outcome_unknown");
    await flush();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(settled).toBe(false);
    expect(reads).toBe(1);
    expect(f.owner.usage).toMatchObject({ requests: 1, operations: 1 });
    held.reject(new TypeError("named physical transport finally ended"));
    await rejected;
    expect(reads).toBe(2);
    expect(f.posts()).toHaveLength(1);
    expect(f.owner.usage).toMatchObject({
      requests: 0,
      operations: 0,
      bindings: 0,
    });
  });
});

describe("renewal IPC registration and original preload wire", () => {
  it("uses the original file main-frame sender guard and removes the new handler on destruction", async () => {
    const f = fixture(),
      binding = await f.adopt();
    const frame = { url: "file:///named-fixture/index.html" };
    let destroyed: (() => void) | null = null;
    const contents = {
      mainFrame: frame,
      once: (_event: string, listener: () => void) => {
        destroyed = listener;
      },
    };
    type Handler = (event: unknown, ...args: unknown[]) => unknown;
    const handlers = new Map<string, Handler>();
    const ipc = {
      handle: (channel: string, handler: Handler) =>
        handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    };
    bindDesktopPluginUiIpc(
      { webContents: contents } as unknown as BrowserWindow,
      f.owner,
      ipc as unknown as IpcMain,
    );
    const renew = handlers.get("crewon:plugin-ui:renew-v1")!;
    const renewResult = handlers.get("crewon:plugin-ui:renew-result-v1")!;
    for (const handler of [renew, renewResult])
      for (const event of [
        { sender: {}, senderFrame: frame },
        { sender: contents, senderFrame: {} },
      ])
        expect(() => handler(event, binding.bindingRef)).toThrow(
          "desktop_plugin_ui_sender_invalid",
        );
    frame.url = "https://foreign.example/";
    for (const handler of [renew, renewResult])
      expect(() =>
        handler({ sender: contents, senderFrame: frame }, binding.bindingRef),
      ).toThrow("desktop_plugin_ui_sender_invalid");
    expect(f.posts()).toHaveLength(0);
    frame.url = "file:///named-fixture/index.html";
    const renewed = await renew(
      { sender: contents, senderFrame: frame },
      binding.bindingRef,
    );
    expect(renewed).toEqual(f.state.lease);
    expect(f.posts()).toHaveLength(1);
    expect(handlers.size).toBe(5);
    const onDestroyed = destroyed as (() => void) | null;
    expect(onDestroyed).not.toBeNull();
    onDestroyed!();
    expect(handlers.size).toBe(0);
  });

  it("exposes optional version-one renewal through only the binding reference and original invoke channel", async () => {
    await import("./preload.ts");
    const [name, bridge] = wire.expose.mock.calls.at(-1) as [
      string,
      CrewonDesktopBridge,
    ];
    expect(name).toBe("crewonDesktop");
    expect(bridge.pluginUiAssets?.version).toBe(1);
    const lease = uiLease();
    wire.invoke.mockResolvedValueOnce(lease);
    expect(await bridge.pluginUiAssets?.renew?.("a".repeat(64))).toBe(lease);
    expect(wire.invoke).toHaveBeenCalledExactlyOnceWith(
      "crewon:plugin-ui:renew-v1",
      "a".repeat(64),
    );
    wire.invoke.mockClear();
    const deferred = { kind: "deferred", lease } as const;
    wire.invoke.mockResolvedValueOnce(deferred);
    expect(await bridge.pluginUiAssets?.renewResult?.("a".repeat(64))).toBe(
      deferred,
    );
    expect(wire.invoke).toHaveBeenCalledExactlyOnceWith(
      "crewon:plugin-ui:renew-result-v1",
      "a".repeat(64),
    );
  });
});
