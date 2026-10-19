// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import type {
  PluginUiDefinition,
  PluginUiServices,
} from "@crewon/plugin-sdk/ui";
import { createControlPluginUiHost } from "../../lib/plugins/controlPluginUiHost";
import { createDesktopPluginUiHost } from "../../lib/plugins/desktopPluginUiHost";
import {
  controlUiItem,
  controlUiResponse,
} from "../../lib/plugins/controlPluginUi.test-support";
import {
  desktopPluginUiAssetUrl,
  type DesktopPluginUiAssets,
} from "../../lib/desktop/desktopPluginUiProtocol";
import {
  deferred,
  flush,
  uiLease,
} from "../../lib/plugins/pluginUiLoader.test-support";
import { InstalledPluginModule } from "./InstalledPluginModule";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
type NativeBroker = Required<Omit<DesktopPluginUiAssets, "version">> & {
  close(): Promise<void>;
  allows(url: string): boolean;
  readonly usage: Readonly<{ bindings: number }>;
};
// Load the real Main implementation at test runtime without adding Node dependencies
// to the browser TypeScript project. Its separate Main project checks its own types.
const nativeBrokerModule = "../../../electron/desktopPluginUiAssets.ts";
const { DesktopPluginUiAssetBroker } = (await import(nativeBrokerModule)) as {
  DesktopPluginUiAssetBroker: new (
    input: Readonly<{
      session(): Readonly<{
        baseUrl: string;
        origin: string;
        sessionToken: string;
        csrfToken: string;
        generation: number;
      }>;
      fetch: typeof globalThis.fetch;
    }>,
  ) => NativeBroker;
};
const brokers: NativeBroker[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T00:00:00.000Z"));
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await act(async () => {
      root.unmount();
      await flush();
    });
  for (const broker of brokers.splice(0)) await broker.close();
  expect(vi.getTimerCount()).toBe(0);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture(
  native: boolean,
  renewalProtocol: "v2" | "v1" | "none" = "v2",
) {
  vi.stubGlobal(
    "location",
    native
      ? { protocol: "file:", origin: "null" }
      : { protocol: "http:", origin: "http://127.0.0.1:32100" },
  );
  let lease: PluginUiLease = {
    ...uiLease(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  let revoked = false;
  let unavailable = false;
  let renewalGate: ReturnType<typeof deferred<PluginUiLease>> | null = null;
  const renew = vi.fn(async () => {
    const next = {
      ...lease,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    if (renewalGate) lease = await renewalGate.promise;
    else lease = next;
    return lease;
  });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "DELETE") return controlUiResponse({ closed: true });
    if (unavailable)
      return controlUiResponse(
        {
          error: {
            category: "providerUnavailable",
            code: "control_api_unavailable",
            requestId: "test-service-outage",
          },
        },
        503,
      );
    if (url.pathname.endsWith("/renew")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        expectedExpiresAt: lease.expiresAt,
      });
      return controlUiResponse(await renew());
    }
    if (url.pathname.endsWith("/actions"))
      return controlUiResponse({ output: { accepted: true } });
    if (revoked)
      return controlUiResponse(
        {
          error: {
            category: "conflict",
            code: "plugin_ui_mount_unavailable",
            message: "Revoked",
          },
        },
        409,
      );
    return controlUiResponse(lease);
  });
  const client = new ControlApiClient({
    baseUrl: "http://127.0.0.1:32100",
    accessToken: "named-lease-session",
    csrfToken: "named-lease-csrf",
    fetch,
  });
  let deferNativeRenewal = false;
  let failNativeRead = true;
  let nativePreflightGate: ReturnType<typeof deferred<void>> | null = null;
  const nativeFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (deferNativeRenewal && init?.method === "GET") {
        if (failNativeRead) {
          failNativeRead = false;
          if (nativePreflightGate) await nativePreflightGate.promise;
          throw new TypeError("named pre-renewal transient transport failure");
        }
        failNativeRead = true;
      }
      return fetch(input, init);
    },
  );
  const broker = native
    ? new DesktopPluginUiAssetBroker({
        session: () => ({
          baseUrl: "http://127.0.0.1:32100/",
          origin: "http://crewon.localhost",
          sessionToken: "named-native-lease-session",
          csrfToken: "named-native-lease-csrf",
          generation: 1,
        }),
        fetch: nativeFetch,
      })
    : null;
  if (broker) brokers.push(broker);
  let bindingRef = "e".repeat(64);
  const assets = {
    version: 1 as const,
    adopt: vi.fn(
      async (
        input: Readonly<{ lease: unknown; expectedControlOrigin: string }>,
      ) => {
        if (broker) {
          const binding = await broker.adopt(input);
          bindingRef = binding.bindingRef;
          return binding;
        }
        return {
          bindingRef,
          entryUrl: desktopPluginUiAssetUrl(bindingRef, "ui/index.js"),
          controlOrigin: client.requestOrigin,
        };
      },
    ),
    ...(renewalProtocol !== "none"
      ? {
          renew: vi.fn(async (ref: string) => {
            expect(ref).toBe(bindingRef);
            return broker ? broker.renew(ref) : renew();
          }),
        }
      : {}),
    ...(broker && renewalProtocol === "v2"
      ? { renewResult: vi.fn((ref: string) => broker.renewResult(ref)) }
      : {}),
    release: vi.fn(async (ref: string) => {
      await broker?.release(ref);
    }),
    invalidate: vi.fn(async () => {
      await broker?.invalidate();
    }),
  };
  let services!: PluginUiServices;
  const dispose = vi.fn(async () => {});
  const update = vi.fn(
    async (_props: import("@crewon/plugin-sdk/ui").PluginUiProps) => {},
  );
  const mount = vi.fn<PluginUiDefinition["mount"]>((element, _props, ports) => {
    services = ports;
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "未保存草稿");
    element.append(input);
    return { update, dispose };
  });
  const importer = vi.fn(async () => ({
    default: {
      apiVersion: "crewon.plugin-ui.v1",
      pluginId: lease.descriptor.pluginId,
      mount,
    },
  }));
  const diagnostic = vi.fn();
  const host = native
    ? createDesktopPluginUiHost({
        client,
        assets,
        importer,
        assertCurrent() {},
        onDiagnostic: diagnostic,
      })
    : createControlPluginUiHost({
        client,
        importer,
        assertCurrent() {},
        onDiagnostic: diagnostic,
      });
  const module = {
    key: "named-lease-module",
    mountKey: "named-fixed-pin",
    title: "工作台",
    contributionId: lease.contributionId,
    plugin: controlUiItem(lease),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (active: boolean, mode: "light" | "dark" = "light") =>
    act(async () => {
      root.render(
        <InstalledPluginModule
          host={host}
          module={module}
          active={active}
          theme={{ mode, tokens: {} }}
          locale="zh"
          onDiagnostic={diagnostic}
        />,
      );
      for (let i = 0; i < 5; i++) await flush();
    });
  return {
    container,
    render,
    mount,
    dispose,
    update,
    importer,
    diagnostic,
    renew,
    assets,
    fetch,
    nativeFetch,
    broker,
    bindingRef: () => bindingRef,
    deferNativeRenewal: (value: boolean) => {
      deferNativeRenewal = value;
    },
    gateNativePreflight: () => {
      nativePreflightGate = deferred<void>();
      return nativePreflightGate;
    },
    services: () => services,
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
    revoke: () => {
      revoked = true;
    },
    gateRenewal: () => {
      renewalGate = deferred<PluginUiLease>();
      return renewalGate;
    },
    lease: () => lease,
  };
}

describe.each([false, true])(
  "installed module authenticated renewal native=%s",
  (native) => {
    it("keeps the unsaved form through a transient outage but withdraws at the finite lease deadline", async () => {
      const f = fixture(native);
      await f.render(true);
      const draft = f.container.querySelector("textarea")!;
      draft.value = "保留草稿";
      f.setUnavailable(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
        await flush();
      });
      expect(f.container.querySelector("textarea")).toBe(draft);
      expect(f.dispose).not.toHaveBeenCalled();
      f.setUnavailable(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await flush();
      });
      expect(f.mount).toHaveBeenCalledTimes(1);
      expect(draft.value).toBe("保留草稿");
      f.setUnavailable(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(285_000);
        await flush();
      });
      expect(f.container.querySelector("textarea")).toBeNull();
      expect(f.dispose).toHaveBeenCalledTimes(1);
    });
    it("renews the same live form, immediately rejects revoked actions, and withdraws at the next authority check", async () => {
      const f = fixture(native);
      await f.render(true);
      const draft = f.container.querySelector("textarea")!;
      draft.value = "这个草稿尚未保存";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(330_000);
        await flush();
      });
      expect(f.container.querySelector("textarea")).toBe(draft);
      expect(draft.value).toBe("这个草稿尚未保存");
      expect(f.mount).toHaveBeenCalledTimes(1);
      expect(f.importer).toHaveBeenCalledTimes(1);
      expect(f.renew).toHaveBeenCalledTimes(1);
      expect(f.dispose).not.toHaveBeenCalled();
      expect(f.diagnostic).not.toHaveBeenCalled();
      await expect(
        f.services().invoke("query", { existing: "original" }, {}),
      ).resolves.toEqual({ accepted: true });
      expect(
        f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/actions")),
      ).toHaveLength(1);
      f.revoke();
      await expect(
        f.services().invoke("query", { mustNotRun: true }, {}),
      ).rejects.toThrow();
      expect(
        f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/actions")),
      ).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150_000);
        await flush();
      });
      expect(f.container.textContent).toContain("模块暂时不可用");
      expect(f.container.querySelector("textarea")).toBeNull();
      expect(f.dispose).toHaveBeenCalledTimes(1);
      expect(f.renew).toHaveBeenCalledTimes(1);
      expect(f.mount).toHaveBeenCalledTimes(1);
      if (native) expect(f.assets.release).toHaveBeenCalledTimes(1);
      else
        expect(
          f.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE"),
        ).toHaveLength(1);
    });

    it("does not restore a disposed module when a renewal response arrives late", async () => {
      const f = fixture(native);
      await f.render(true);
      const pending = f.gateRenewal();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(240_000);
        await flush();
      });
      expect(f.renew).toHaveBeenCalledTimes(1);
      await f.render(false);
      pending.resolve({
        ...f.lease(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      await act(async () => {
        for (let i = 0; i < 5; i++) await flush();
      });
      expect(f.container.querySelector("textarea")).toBeNull();
      expect(f.mount).toHaveBeenCalledTimes(1);
      expect(f.dispose).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("withdraws at the original TTL even while the renewal request has not physically settled and rejects its late result", async () => {
      const f = fixture(native);
      await f.render(true);
      const original = f.lease();
      const pending = f.gateRenewal();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(240_000);
        await flush();
      });
      expect(f.renew).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();
      });
      expect(f.container.querySelector("textarea")).toBeNull();
      expect(f.dispose).toHaveBeenCalledTimes(1);
      expect(f.mount).toHaveBeenCalledTimes(1);
      pending.resolve({
        ...original,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      await act(async () => {
        for (let i = 0; i < 5; i++) await flush();
      });
      expect(f.container.querySelector("textarea")).toBeNull();
      expect(f.mount).toHaveBeenCalledTimes(1);
      expect(f.renew).toHaveBeenCalledTimes(1);
      expect(
        f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/actions")),
      ).toHaveLength(0);
    });
  },
);

describe("native broker, renderer host and installed view renewal boundary", () => {
  it("delivers only the latest props deferred during renewal after a later confirmed renewal commits", async () => {
    const f = fixture(true);
    await f.render(true);
    const draft = f.container.querySelector("textarea")!;
    draft.value = "并发续租期间的草稿";
    draft.focus();
    const gate = f.gateNativePreflight();
    f.deferNativeRenewal(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
      await flush();
    });
    await f.render(true, "dark");
    await act(async () => {
      gate.resolve();
      for (let i = 0; i < 5; i++) await flush();
    });
    expect(f.dispose).not.toHaveBeenCalled();
    expect(
      f.update.mock.calls.some(([props]) => props.theme.mode === "dark"),
    ).toBe(false);
    f.deferNativeRenewal(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      for (let i = 0; i < 5; i++) await flush();
    });
    expect(f.update.mock.calls.at(-1)?.[0].theme.mode).toBe("dark");
    expect(f.container.querySelector("textarea")).toBe(draft);
    expect(draft.value).toBe("并发续租期间的草稿");
    expect(document.activeElement).toBe(draft);
    expect(f.mount).toHaveBeenCalledTimes(1);
    expect(f.dispose).not.toHaveBeenCalled();
    expect(
      f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/actions")),
    ).toHaveLength(0);
  });

  it("keeps older Native renew-v1 hosts compatible without remounting", async () => {
    const f = fixture(true, "v1");
    await f.render(true);
    const draft = f.container.querySelector("textarea")!;
    draft.value = "旧宿主兼容草稿";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(330_000);
      await flush();
    });
    expect(f.assets.renew).toHaveBeenCalledTimes(1);
    expect(f.container.querySelector("textarea")).toBe(draft);
    expect(draft.value).toBe("旧宿主兼容草稿");
    expect(f.mount).toHaveBeenCalledTimes(1);
  });

  it("does not poll or renew when an older Native host has no renewal capability, and still expires on time", async () => {
    const f = fixture(true, "none");
    await f.render(true);
    const requests = f.fetch.mock.calls.length;
    const nativeRequests = f.nativeFetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299_999);
      await flush();
    });
    expect(f.fetch).toHaveBeenCalledTimes(requests);
    expect(f.nativeFetch).toHaveBeenCalledTimes(nativeRequests);
    expect(f.container.querySelector("textarea")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flush();
    });
    expect(f.container.querySelector("textarea")).toBeNull();
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.renew).not.toHaveBeenCalled();
  });

  it("does no idle network polling, preserves the instance/input/focus after a confirmed pre-POST deferral, and never extends its original TTL", async () => {
    const f = fixture(true);
    await f.render(true);
    const draft = f.container.querySelector("textarea")!;
    draft.value = "未提交的九十秒剧本";
    draft.focus();
    draft.setSelectionRange(2, 6);
    const originalLease = f.lease();
    const idleRequests = f.fetch.mock.calls.length;
    const nativeRequests = f.nativeFetch.mock.calls.length;
    f.deferNativeRenewal(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(239_999);
      await flush();
    });
    expect(f.fetch).toHaveBeenCalledTimes(idleRequests);
    expect(f.nativeFetch).toHaveBeenCalledTimes(nativeRequests);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flush();
    });
    expect(f.assets.renewResult).toHaveBeenCalledTimes(1);
    expect(f.diagnostic.mock.calls).toEqual([]);
    expect(f.renew).not.toHaveBeenCalled();
    expect(f.lease()).toEqual(originalLease);
    expect(
      f.broker!.allows(desktopPluginUiAssetUrl(f.bindingRef(), "ui/index.js")),
    ).toBe(true);
    expect(f.container.querySelector("textarea")).toBe(draft);
    expect(document.activeElement).toBe(draft);
    expect([draft.value, draft.selectionStart, draft.selectionEnd]).toEqual([
      "未提交的九十秒剧本",
      2,
      6,
    ]);
    expect(f.dispose).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
      await flush();
    });
    expect(f.lease()).toEqual(originalLease);
    expect(f.mount).toHaveBeenCalledTimes(1);
    expect(f.importer).toHaveBeenCalledTimes(1);
    expect(f.container.querySelector("textarea")).toBe(draft);
    f.revoke();
    await expect(
      f.services().invoke("query", { forbiddenWrite: true }, {}),
    ).rejects.toThrow();
    expect(
      f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/actions")),
    ).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flush();
    });
    expect(f.container.querySelector("textarea")).toBeNull();
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.broker!.usage.bindings).toBe(0);
    expect(f.renew).not.toHaveBeenCalled();
    expect(f.assets.renewResult!.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it("retries only the deferred renewal and commits a real new expiry without remounting or replaying business work", async () => {
    const f = fixture(true);
    await f.render(true);
    const draft = f.container.querySelector("textarea")!;
    draft.value = "确认后再保存";
    draft.focus();
    f.deferNativeRenewal(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
      await flush();
    });
    expect(f.renew).not.toHaveBeenCalled();
    f.deferNativeRenewal(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
      await flush();
    });
    expect(f.renew).toHaveBeenCalledTimes(1);
    expect(Date.parse(f.lease().expiresAt)).toBe(
      Date.parse("2026-10-05T00:09:05.000Z"),
    );
    expect(f.container.querySelector("textarea")).toBe(draft);
    expect(draft.value).toBe("确认后再保存");
    expect(document.activeElement).toBe(draft);
    expect(f.mount).toHaveBeenCalledTimes(1);
    expect(f.dispose).not.toHaveBeenCalled();
    expect(
      f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/actions")),
    ).toHaveLength(0);
    expect(f.assets.renew).not.toHaveBeenCalled();
  });
});
