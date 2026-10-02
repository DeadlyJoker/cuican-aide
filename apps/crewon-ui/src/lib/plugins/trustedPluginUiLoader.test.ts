// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import type { PluginUiProps, PluginUiServices } from "@crewon/plugin-sdk/ui";
import {
  TrustedPluginUiLoader,
  type PluginUiMountHandle,
} from "./trustedPluginUiLoader";
import { copyPluginUiJson, pluginUiAssetUrl } from "./pluginUiValidation";
import {
  deferred,
  flush,
  uiHarness,
  uiLease,
  uiProps,
} from "./pluginUiLoader.test-support";

const handles: PluginUiMountHandle[] = [];
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  document.body.replaceChildren();
  vi.useRealTimers();
});
async function mount(harness: ReturnType<typeof uiHarness>, lease = uiLease()) {
  const handle = await harness.loader.mount({
    root: harness.root,
    lease,
    props: uiProps(),
  });
  handles.push(handle);
  return handle;
}

describe("trusted UI loader (explicit importer unit tests)", () => {
  it("keeps stop idempotent when an abort listener synchronously re-enters cleanup", async () => {
    const h = uiHarness();
    const handle = await mount(h);
    const gate = deferred<PluginJsonValue>();
    let repeated!: Promise<void>;
    h.ports.invoke.mockImplementationOnce(async (_lease, input) => {
      input.signal.addEventListener("abort", () => {
        repeated = handle.stop();
      });
      return gate.promise;
    });
    const action = h.instances[0].services.invoke("query", null, {});
    void action.catch(() => undefined);
    await flush();
    const stopped = handle.stop();
    expect(repeated).toBe(stopped);
    await stopped;
    expect(h.ports.closeMount).toHaveBeenCalledTimes(1);
    expect(h.instances[0].dispose).toHaveBeenCalledTimes(1);
    await expect(action).rejects.toThrow("plugin_ui_operation_aborted");
    gate.resolve(null);
    await flush();
  });
  it("accepts the structural SDK instance ABI without reading private getters", async () => {
    const h = uiHarness();
    const privateGetter = vi.fn();
    class Instance {
      readonly child: HTMLElement;
      constructor(child: HTMLElement) {
        this.child = child;
      }
      get privateState() {
        privateGetter();
        return "private";
      }
      update(props: PluginUiProps) {
        this.child.textContent = JSON.stringify(props.data);
      }
      dispose() {
        this.child.replaceChildren();
      }
    }
    h.importModule.mockImplementationOnce(async () => ({
      default: {
        ...h.definition,
        mount(root: HTMLElement) {
          return new Instance(root);
        },
      },
    }));
    const handle = await mount(h);
    await handle.update(uiProps({ title: "类实例" }));
    expect(h.root.textContent).toContain("类实例");
    await handle.stop();
    expect(privateGetter).not.toHaveBeenCalled();
  });

  it("fails closed on malformed lifecycle methods and retains unavailable cleanup diagnostics", async () => {
    const h = uiHarness();
    const getter = vi.fn();
    h.importModule.mockImplementationOnce(async () => ({
      default: {
        ...h.definition,
        mount() {
          return Object.defineProperty({ update() {} }, "dispose", {
            get: getter,
          });
        },
      },
    }));
    await expect(mount(h)).rejects.toThrow("plugin_ui_instance_invalid");
    await flush();
    expect(getter).not.toHaveBeenCalled();
    expect(h.loader.pendingCleanupCount).toBe(1);
    expect(h.ports.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "plugin_ui_instance_cleanup_unavailable",
      }),
    );
  });

  it("rejects invalid theme/projection and action/output bounds without disclosing live objects", async () => {
    const h = uiHarness();
    const handle = await mount(h);
    for (const props of [
      { ...uiProps(), extra: "private" },
      {
        ...uiProps(),
        theme: {
          ...uiProps().theme,
          tokens: Object.fromEntries(
            Array.from({ length: 65 }, (_, i) => [`--token${i}`, "1"]),
          ),
        },
      },
      uiProps({ long: "a".repeat(65536) }),
    ])
      await expect(handle.update(props)).rejects.toThrow();
    expect(h.instances[0].update).not.toHaveBeenCalled();
    await expect(
      h.instances[0].services.invoke("save", { text: "a".repeat(24576) }, {}),
    ).rejects.toThrow();
    await expect(
      h.instances[0].services.invoke("save", null, { actor: "other" } as never),
    ).rejects.toThrow("plugin_ui_invocation_options_invalid");
    expect(h.ports.invoke).not.toHaveBeenCalled();
    h.ports.invoke.mockResolvedValueOnce({ output: "a".repeat(65536) });
    await expect(
      h.instances[0].services.invoke("query", null, {}),
    ).rejects.toThrow("plugin_ui_json_bytes_exceeded");
    const result = { nested: { value: 1 } };
    h.ports.invoke.mockResolvedValueOnce(result);
    const detached = await h.instances[0].services.invoke("query", null, {});
    result.nested.value = 2;
    expect(detached).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen(detached)).toBe(true);
  });

  it("aborts all in-flight actions on stop and rejects their late results", async () => {
    const h = uiHarness();
    const handle = await mount(h);
    const gate = deferred<PluginJsonValue>();
    h.ports.invoke.mockImplementation(() => gate.promise);
    const actions = [
      h.instances[0].services.invoke("query", 1, {}),
      h.instances[0].services.invoke("query", 2, {}),
    ];
    for (const action of actions) void action.catch(() => undefined);
    await flush();
    await handle.stop();
    for (const action of actions)
      await expect(action).rejects.toThrow("plugin_ui_operation_aborted");
    expect(
      h.ports.invoke.mock.calls.every(([, input]) => input.signal.aborted),
    ).toBe(true);
    gate.resolve({ secret: "late result" });
    await flush();
    expect(h.root.childNodes).toHaveLength(0);
  });

  it("rejects a revoked update before calling plugin code and tracks a failed unused-lease close", async () => {
    const h = uiHarness();
    const handle = await mount(h);
    h.ports.validateMount.mockRejectedValueOnce(new Error("not current"));
    await expect(handle.update(uiProps({ title: "deny" }))).rejects.toThrow(
      "not current",
    );
    await flush();
    expect(h.instances[0].update).not.toHaveBeenCalled();
    expect(h.root.childNodes).toHaveLength(0);
    h.ports.closeMount.mockRejectedValueOnce(new Error("close failed"));
    await expect(h.loader.closeUnusedMount(uiLease(2))).rejects.toThrow(
      "close failed",
    );
    expect(h.loader.pendingCleanupCount).toBe(1);
    expect(h.ports.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ message: "close failed" }),
    );
  });
  it("uses only the host base and pinned lease entry, with detached frozen values", async () => {
    const h = uiHarness();
    const lease = uiLease();
    const handle = await mount(h, lease);
    expect(h.importModule).toHaveBeenCalledWith(
      `/api/plugin-ui/assets/${lease.mountRef}/ui/index.js`,
    );
    expect(h.ports.validateMount).toHaveBeenCalledTimes(3);
    expect(handle.identity).toEqual({
      pluginId: lease.descriptor.pluginId,
      version: lease.descriptor.version,
      packageDigest: lease.packageDigest,
    });
    expect(Object.isFrozen(h.instances[0].props.data)).toBe(true);
    expect(Object.isFrozen(h.ports.validateMount.mock.calls[0][0])).toBe(true);
    expect(h.instances[0].root.parentNode).toBe(h.root);
    expect(Object.keys(h.instances[0].services)).toEqual(["invoke"]);
    expect(
      pluginUiAssetUrl(
        "/api/plugin-ui/assets",
        lease.mountRef,
        "assets/封面.png",
      ),
    ).toContain("assets/%E5%B0%81%E9%9D%A2.png");
  });

  it("rejects foreign and development asset bases and never falls back from isolated Web", async () => {
    const h = uiHarness();
    for (const assetBasePath of [
      "https://foreign.test/a",
      "//foreign.test/a",
      "blob:code",
      "data:code",
      "/@fs/a",
      "/src",
      "/api/../src",
      "/api?url=x",
    ])
      expect(
        () => new TrustedPluginUiLoader({ ports: h.ports, assetBasePath }),
      ).toThrow("plugin_ui_asset_base_invalid");
    const lease = uiLease();
    const invalid = {
      ...lease,
      descriptor: {
        ...lease.descriptor,
        files: [
          ...lease.descriptor.files,
          { path: "ui/index.html", byteLength: 100, sha256: "d".repeat(64) },
        ],
        entrypoints: {
          node: null,
          ui: { path: "ui/index.html", mode: "isolatedWeb" },
        },
      },
    };
    await expect(
      h.loader.mount({
        root: h.root,
        lease: invalid as PluginUiLease,
        props: uiProps(),
      }),
    ).rejects.toThrow("plugin_ui_mode_unsupported");
    expect(h.importModule).not.toHaveBeenCalled();
  });

  it("supports the exact Control mounted-assets route without changing the default route", () => {
    const lease = uiLease();
    expect(
      pluginUiAssetUrl(
        "/api/v1/plugins/ui/mounts",
        lease.mountRef,
        "assets/封面.png",
        "control-mount-assets",
      ),
    ).toBe(
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/assets/%E5%B0%81%E9%9D%A2.png`,
    );
    expect(
      pluginUiAssetUrl("/api/plugin-ui/assets", lease.mountRef, "ui/index.js"),
    ).toBe(`/api/plugin-ui/assets/${lease.mountRef}/ui/index.js`);
    expect(() =>
      pluginUiAssetUrl(
        "/api/v1/plugins/ui/mounts",
        lease.mountRef,
        "ui/index.js",
        "unknown" as never,
      ),
    ).toThrow("plugin_ui_asset_route_invalid");
    const h = uiHarness();
    expect(
      () =>
        new TrustedPluginUiLoader({
          ports: h.ports,
          assetBasePath: "/api/v1/plugins/ui/mounts",
          routeStyle: "unknown" as never,
        }),
    ).toThrow("plugin_ui_asset_route_invalid");
    expect(
      () =>
        new TrustedPluginUiLoader({
          ports: h.ports,
          assetBasePath: "/api/v1/plugins/ui/mounts",
          routeStyle: null as never,
        }),
    ).toThrow("plugin_ui_asset_route_invalid");
  });

  it("closes a valid acquired lease even when props fail before importing", async () => {
    const h = uiHarness();
    await expect(
      h.loader.mount({
        root: h.root,
        lease: uiLease(),
        props: { ...uiProps(), contributionId: "another" },
      }),
    ).rejects.toThrow("plugin_ui_props_identity_invalid");
    await flush();
    expect(h.ports.closeMount).toHaveBeenCalledTimes(1);
    expect(h.importModule).not.toHaveBeenCalled();
  });

  it("rejects ABI mismatch and invokes no accessors", async () => {
    const getter = vi.fn();
    for (const imported of [
      {
        default: {
          apiVersion: "crewon.plugin-ui.v1",
          pluginId: "other.plugin",
          mount: vi.fn(),
        },
      },
      Object.defineProperty({}, "default", { enumerable: true, get: getter }),
      {
        default: {
          apiVersion: "unknown",
          pluginId: "example.workbench",
          mount: vi.fn(),
        },
      },
    ]) {
      const h = uiHarness(async () => imported);
      await expect(mount(h)).rejects.toThrow();
      await flush();
      expect(h.root.childNodes).toHaveLength(0);
      expect(h.ports.closeMount).toHaveBeenCalledTimes(1);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps the original DOM and lease when replacement preflight or mount fails", async () => {
    const h = uiHarness();
    await mount(h);
    const original = h.root.firstChild;
    h.importModule.mockRejectedValueOnce(new Error("bad upgrade"));
    await expect(mount(h, uiLease(2))).rejects.toThrow("bad upgrade");
    await flush();
    expect(h.root.firstChild).toBe(original);
    expect(h.instances[0].dispose).not.toHaveBeenCalled();
    expect(
      h.ports.closeMount.mock.calls.map(([lease]) => lease.mountRef),
    ).toEqual([uiLease(2).mountRef]);
    expect(
      await h.instances[0].services.invoke("read", { value: 1 }, {}),
    ).toEqual({ echoed: { value: 1 } });
  });

  it("swaps only after a detached candidate is ready and cleanup cannot erase the new root", async () => {
    const h = uiHarness();
    await mount(h);
    const delayed = deferred<void>();
    h.instances[0].dispose.mockImplementation(async () => {
      await delayed.promise;
      h.instances[0].root.replaceChildren();
    });
    const ready = deferred<void>();
    h.importModule.mockImplementationOnce(async () => ({
      default: {
        ...h.definition,
        async mount(
          root: HTMLElement,
          props: PluginUiProps,
          services: PluginUiServices,
        ) {
          expect(root.parentNode).toBeNull();
          await ready.promise;
          return h.definition.mount(root, props, services);
        },
      },
    }));
    const candidate = mount(h, uiLease(2));
    await flush();
    expect(h.root.firstChild).toBe(h.instances[0].root);
    ready.resolve();
    await candidate;
    expect(h.root.firstChild).toBe(h.instances[1].root);
    delayed.resolve();
    await flush();
    expect(h.root.firstChild).toBe(h.instances[1].root);
    expect(h.instances[0].dispose).toHaveBeenCalledTimes(1);
    await expect(
      h.instances[0].services.invoke("read", null, {}),
    ).rejects.toThrow("plugin_ui_operation_aborted");
  });

  it("rechecks the host fence after import and refuses mounting a revoked candidate", async () => {
    const imported = deferred<unknown>();
    const h = uiHarness(() => imported.promise);
    const pending = mount(h);
    await flush();
    h.ports.validateMount.mockRejectedValueOnce(new Error("selection changed"));
    imported.resolve({ default: h.definition });
    await expect(pending).rejects.toThrow("selection changed");
    expect(h.instances).toHaveLength(0);
    expect(h.root.childNodes).toHaveLength(0);
  });

  it("cancels native-import waiting and closes the ref, without mounting the late module", async () => {
    const imported = deferred<unknown>();
    const h = uiHarness(() => imported.promise);
    const controller = new AbortController();
    const pending = h.loader.mount({
      root: h.root,
      lease: uiLease(),
      props: uiProps(),
      signal: controller.signal,
    });
    await flush();
    controller.abort();
    await expect(pending).rejects.toThrow("plugin_ui_operation_aborted");
    imported.resolve({ default: h.definition });
    await flush();
    expect(h.instances).toHaveLength(0);
    expect(h.ports.closeMount).toHaveBeenCalledTimes(1);
    expect(h.loader.pendingCleanupCount).toBe(0);
  });

  it("disposes a late cancelled mount only on its own detached root", async () => {
    const h = uiHarness();
    const gate = deferred<void>();
    h.importModule.mockImplementationOnce(async () => ({
      default: {
        ...h.definition,
        async mount(
          root: HTMLElement,
          props: PluginUiProps,
          services: PluginUiServices,
        ) {
          await gate.promise;
          return h.definition.mount(root, props, services);
        },
      },
    }));
    const old = mount(h);
    await flush();
    const next = await mount(h, uiLease(2));
    await expect(old).rejects.toThrow("plugin_ui_operation_aborted");
    const currentRoot = h.root.firstChild;
    gate.resolve();
    await flush();
    expect(h.root.firstChild).toBe(currentRoot);
    expect(h.instances[1].dispose).toHaveBeenCalledTimes(1);
    await next.update(uiProps({ title: "继续" }));
    expect(h.root.textContent).toContain("继续");
  });

  it("denies action calls while staged and fences active actions before and after the host await", async () => {
    const h = uiHarness();
    let staged!: Promise<PluginJsonValue>;
    h.importModule.mockImplementationOnce(async () => ({
      default: {
        ...h.definition,
        mount(
          root: HTMLElement,
          props: PluginUiProps,
          services: PluginUiServices,
        ) {
          staged = services.invoke("write", null, {});
          void staged.catch(() => undefined);
          return h.definition.mount(root, props, services);
        },
      },
    }));
    await mount(h);
    await expect(staged).rejects.toThrow("plugin_ui_operation_aborted");
    const gate = deferred<PluginJsonValue>();
    h.ports.invoke.mockImplementationOnce(() => gate.promise);
    const action = h.instances[0].services.invoke(
      "saveBrief",
      { text: "行\n".repeat(2048) },
      {},
    );
    await flush();
    h.ports.validateMount.mockRejectedValueOnce(
      new Error("revoked after action"),
    );
    gate.resolve({ ok: true });
    await expect(action).rejects.toThrow("revoked after action");
    expect(h.ports.invoke).toHaveBeenCalledTimes(1);
    const [lease, request] = h.ports.invoke.mock.calls[0];
    expect(lease.mountRef).toBe(uiLease().mountRef);
    expect(Object.keys(request).sort()).toEqual(["action", "input", "signal"]);
    expect(Object.isFrozen(request.input)).toBe(true);
  });

  it("aborts one action independently and bounds even host work that ignores cancellation", async () => {
    const h = uiHarness();
    await mount(h);
    const gate = deferred<PluginJsonValue>();
    h.ports.invoke.mockImplementation(() => gate.promise);
    const controller = new AbortController();
    const actions = Array.from({ length: 16 }, (_, i) =>
      h.instances[0].services.invoke(
        "query",
        i,
        i === 0 ? { signal: controller.signal } : {},
      ),
    );
    for (const action of actions) void action.catch(() => undefined);
    await flush();
    controller.abort();
    await expect(actions[0]).rejects.toThrow("plugin_ui_operation_aborted");
    await expect(
      h.instances[0].services.invoke("query", 17, {}),
    ).rejects.toThrow("plugin_ui_inflight_limit");
    expect(h.ports.invoke.mock.calls[0][1].signal.aborted).toBe(true);
    expect(h.ports.invoke.mock.calls[1][1].signal.aborted).toBe(false);
    gate.resolve({ ok: true });
    await Promise.all(actions.slice(1));
    expect(await h.instances[0].services.invoke("query", 18, {})).toEqual({
      ok: true,
    });
  });

  it("serializes updates and keeps only the latest queued props", async () => {
    const h = uiHarness();
    const handle = await mount(h);
    const gate = deferred<void>();
    h.instances[0].update.mockImplementationOnce(() => gate.promise);
    const first = handle.update(uiProps({ value: 1 }));
    await flush();
    const second = handle.update(uiProps({ value: 2 }));
    const secondRejected = expect(second).rejects.toThrow(
      "plugin_ui_update_superseded",
    );
    const third = handle.update(uiProps({ value: 3 }));
    await secondRejected;
    expect(h.instances[0].update).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([first, third]);
    expect(h.instances[0].update).toHaveBeenCalledTimes(2);
    expect(h.instances[0].update.mock.calls[1][0].data).toEqual({ value: 3 });
  });

  it("revokes immediately on stop, waits for its own update, and closes/disposes once", async () => {
    const h = uiHarness();
    const handle = await mount(h);
    const gate = deferred<void>();
    h.instances[0].update.mockImplementationOnce(() => gate.promise);
    const update = handle.update(uiProps({ value: 1 }));
    await flush();
    const stopped = handle.stop();
    await expect(update).rejects.toThrow("plugin_ui_operation_aborted");
    expect(h.root.childNodes).toHaveLength(0);
    expect(h.instances[0].dispose).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([stopped, handle.stop()]);
    expect(h.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(h.ports.closeMount).toHaveBeenCalledTimes(1);
    expect(h.loader.pendingCleanupCount).toBe(0);
  });

  it("reports disposal failures and retains their cleanup ownership", async () => {
    const h = uiHarness();
    const handle = await mount(h);
    h.instances[0].dispose.mockRejectedValueOnce(new Error("dispose failed"));
    await expect(handle.stop()).rejects.toThrow("plugin_ui_cleanup_failed");
    expect(h.ports.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dispose failed" }),
    );
    expect(h.loader.pendingCleanupCount).toBe(1);
    await expect(handle.stop()).rejects.toThrow("plugin_ui_cleanup_failed");
    expect(h.instances[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("bounds hanging cleanup while retaining and later disposing a late instance", async () => {
    vi.useFakeTimers();
    const h = uiHarness();
    const handle = await mount(h);
    const gate = deferred<void>();
    h.instances[0].dispose.mockImplementationOnce(() => gate.promise);
    const result = expect(handle.stop()).rejects.toThrow(
      "plugin_ui_cleanup_pending",
    );
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(h.loader.pendingCleanupCount).toBe(1);
    gate.resolve();
    await flush();
    expect(h.loader.pendingCleanupCount).toBe(0);
  });

  it("rejects oversized, non-JSON and accessor inputs without running getters", () => {
    const getter = vi.fn();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const deep = Array.from({ length: 17 }).reduce((value) => ({ value }), {});
    const customArray = Object.setPrototypeOf([], null);
    for (const input of [
      NaN,
      Infinity,
      undefined,
      new Date(),
      cycle,
      deep,
      customArray,
      "\ud800",
      { [Symbol("secret")]: 1 },
      Object.defineProperty({}, "secret", { enumerable: true, get: getter }),
      "a".repeat(24577),
    ])
      expect(() => copyPluginUiJson(input, 24 * 1024)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(
      Object.isFrozen(
        copyPluginUiJson({ brief: "x\n".repeat(4096) }, 24 * 1024),
      ),
    ).toBe(true);
  });
});
