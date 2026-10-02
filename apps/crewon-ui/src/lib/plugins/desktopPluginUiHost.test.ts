// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import { createDesktopPluginUiHost } from "./desktopPluginUiHost";
import {
  controlUiItem,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import {
  uiLease,
  uiHarness,
  uiProps,
  deferred,
  flush,
} from "./pluginUiLoader.test-support";
import { desktopPluginUiAssetUrl } from "../desktop/desktopPluginUiProtocol";
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function fixture() {
  vi.stubGlobal("location", { protocol: "file:", origin: "null" });
  const lease = uiLease(),
    h = uiHarness();
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    controlUiResponse(init?.method === "DELETE" ? { closed: true } : lease),
  );
  const client = new ControlApiClient({
    baseUrl: "http://127.0.0.1:32100",
    accessToken: "actual-fixture-native-session",
    csrfToken: "actual-fixture-csrf",
    fetch,
  });
  const binding = {
    bindingRef: "c".repeat(64),
    entryUrl: desktopPluginUiAssetUrl("c".repeat(64), "ui/index.js"),
    controlOrigin: client.requestOrigin,
  };
  const assets = {
    version: 1 as const,
    adopt: vi.fn(async () => binding),
    release: vi.fn(async () => {}),
    invalidate: vi.fn(async () => {}),
  };
  let current = true;
  const assertCurrent = () => {
    if (!current) throw new Error("actual_scope_changed");
  };
  const importer = vi.fn(async () => ({ default: h.definition }));
  const host = createDesktopPluginUiHost({
    client,
    assets,
    importer,
    assertCurrent,
    onDiagnostic: vi.fn(),
  });
  return {
    lease,
    h,
    assets,
    host,
    fetch,
    importer,
    binding,
    revoke: () => {
      current = false;
    },
  };
}
describe("file renderer installed UI adapter", () => {
  it("adopts a fully checked Control mount and imports only its exact native entry URI; native owner closes once", async () => {
    const f = fixture();
    const lease = await f.host.acquireMount(
      controlUiItem(f.lease),
      "workbench",
      new AbortController().signal,
    );
    expect(f.assets.adopt).toHaveBeenCalledWith({
      lease,
      expectedControlOrigin: "http://127.0.0.1:32100",
    });
    const handle = await f.host.loader.mount({
      root: f.h.root,
      lease,
      props: uiProps(),
    });
    expect(f.importer).toHaveBeenCalledWith(f.binding.entryUrl);
    expect(f.h.root.textContent).toContain("初始内容");
    await handle.stop();
    expect(f.assets.release).toHaveBeenCalledExactlyOnceWith(
      f.binding.bindingRef,
    );
    expect(
      f.fetch.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it("observes and closes an adopted lease that arrives after account scope changes, without importing", async () => {
    const f = fixture(),
      late = deferred<typeof f.binding>();
    f.assets.adopt.mockImplementation(() => late.promise);
    const acquire = f.host.acquireMount(
      controlUiItem(f.lease),
      "workbench",
      new AbortController().signal,
    );
    void acquire.catch(() => {});
    await flush();
    f.revoke();
    late.resolve(f.binding);
    await expect(acquire).rejects.toThrow("actual_scope_changed");
    expect(f.assets.release).toHaveBeenCalledExactlyOnceWith(
      f.binding.bindingRef,
    );
    expect(f.importer).not.toHaveBeenCalled();
  });

  it("rejects malformed native bindings and actively cleans the unobservable allocation", async () => {
    const f = fixture();
    f.assets.adopt.mockResolvedValue({
      ...f.binding,
      entryUrl: "https://foreign.example/ui.js",
    });
    await expect(
      f.host.acquireMount(
        controlUiItem(f.lease),
        "workbench",
        new AbortController().signal,
      ),
    ).rejects.toThrow("plugin_ui_native_binding_invalid");
    expect(f.assets.invalidate).toHaveBeenCalledTimes(1);
    expect(f.importer).not.toHaveBeenCalled();
  });
});
