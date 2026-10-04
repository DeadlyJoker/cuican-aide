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
import { desktopPluginUiAssetUrl } from "../../lib/desktop/desktopPluginUiProtocol";
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
  expect(vi.getTimerCount()).toBe(0);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture(native: boolean) {
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
  const bindingRef = "e".repeat(64);
  const assets = {
    version: 1 as const,
    adopt: vi.fn(async () => ({
      bindingRef,
      entryUrl: desktopPluginUiAssetUrl(bindingRef, "ui/index.js"),
      controlOrigin: client.requestOrigin,
    })),
    renew: vi.fn(async (ref: string) => {
      expect(ref).toBe(bindingRef);
      return renew();
    }),
    release: vi.fn(async () => {}),
    invalidate: vi.fn(async () => {}),
  };
  let services!: PluginUiServices;
  const dispose = vi.fn(async () => {});
  const mount = vi.fn<PluginUiDefinition["mount"]>((element, _props, ports) => {
    services = ports;
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "未保存草稿");
    element.append(input);
    return { update: async () => {}, dispose };
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
  const render = async (active: boolean) =>
    act(async () => {
      root.render(
        <InstalledPluginModule
          host={host}
          module={module}
          active={active}
          theme={{ mode: "light", tokens: {} }}
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
    importer,
    diagnostic,
    renew,
    assets,
    fetch,
    services: () => services,
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
    it("preserves the same live form past the original five minutes and still withdraws on revocation", async () => {
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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
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
  },
);
