// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  deferred,
  flush,
  uiHarness,
  uiLease,
  uiProps,
} from "./pluginUiLoader.test-support";
import { PluginUiModuleCodeCache } from "./pluginUiModuleCodeCache";

describe("approved self-contained UI code reuse", () => {
  it.each([true, false])(
    "keeps cold imports independent until the resource mode is verified (%s)",
    async (declared) => {
      const gate = deferred<unknown>();
      const h = uiHarness();
      h.importModule.mockImplementationOnce(() => gate.promise);
      h.importModule.mockResolvedValue({ default: h.definition });
      const first = uiLease();
      const root = document.createElement("div");
      const a = h.loader.mount({
        root: h.root,
        lease: first,
        props: uiProps(),
      });
      const b = h.loader.mount({
        root,
        lease: { ...first, mountRef: uiLease(2).mountRef },
        props: uiProps(),
      });
      await flush();
      expect(h.importModule).toHaveBeenCalledTimes(2);
      gate.resolve({
        default: h.definition,
        ...(declared ? { crewonUiResourceMode: "self-contained.v1" } : {}),
      });
      const handles = await Promise.all([a, b]);
      expect(h.importModule).toHaveBeenCalledTimes(2);
      expect(h.instances).toHaveLength(2);
      expect(h.ports.validateMount).toHaveBeenCalledTimes(6);
      await Promise.all(handles.map((handle) => handle.stop()));
    },
  );
  it("cancels one cold waiter without canceling the other mount or retaining failed code", async () => {
    const gate = deferred<unknown>();
    const h = uiHarness();
    h.importModule.mockImplementationOnce(() => gate.promise);
    h.importModule.mockImplementationOnce(() => gate.promise);
    const controller = new AbortController();
    const first = uiLease();
    const a = h.loader
      .mount({
        root: h.root,
        lease: first,
        props: uiProps(),
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    const b = h.loader.mount({
      root: document.createElement("div"),
      lease: { ...first, mountRef: uiLease(2).mountRef },
      props: uiProps(),
    });
    await flush();
    controller.abort();
    gate.resolve({
      default: h.definition,
      crewonUiResourceMode: "self-contained.v1",
    });
    expect(await a).toBeInstanceOf(Error);
    const handle = await b;
    expect(h.importModule).toHaveBeenCalledTimes(2);
    expect(h.instances).toHaveLength(1);
    await handle.stop();
    const cache = new PluginUiModuleCodeCache();
    await expect(
      cache.import(first, async () => {
        throw new Error("download failed");
      }),
    ).rejects.toThrow("download failed");
    expect(cache.get(first)).toBeUndefined();
    expect(await cache.import(first, async () => "next result")).toBe(
      "next result",
    );
  });
  it("reuses code while creating separate instances and services under fresh lease fences", async () => {
    const h = uiHarness();
    h.importModule.mockResolvedValue({
      default: h.definition,
      crewonUiResourceMode: "self-contained.v1",
    });
    const first = uiLease();
    const second = { ...first, mountRef: uiLease(2).mountRef };
    const a = await h.loader.mount({
      root: h.root,
      lease: first,
      props: uiProps(),
    });
    const b = await h.loader.mount({
      root: h.root,
      lease: second,
      props: uiProps(),
    });
    expect(h.importModule).toHaveBeenCalledOnce();
    expect(h.ports.validateMount).toHaveBeenCalledTimes(6);
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0].services).not.toBe(h.instances[1].services);
    await expect(
      h.instances[0].services.invoke("query", null, {}),
    ).rejects.toThrow("aborted");
    await h.instances[1].services.invoke("query", null, {});
    expect(h.ports.invoke.mock.calls[0][0].mountRef).toBe(second.mountRef);
    await a.stop();
    await b.stop();
  });
  it("never uses cached code to bypass a revoked lease", async () => {
    const h = uiHarness();
    h.importModule.mockResolvedValue({
      default: h.definition,
      crewonUiResourceMode: "self-contained.v1",
    });
    const lease = uiLease();
    const a = await h.loader.mount({ root: h.root, lease, props: uiProps() });
    h.ports.validateMount.mockRejectedValueOnce(new Error("revoked"));
    await expect(
      h.loader.mount({
        root: h.root,
        lease: { ...lease, mountRef: uiLease(2).mountRef },
        props: uiProps(),
      }),
    ).rejects.toThrow("revoked");
    expect(h.instances).toHaveLength(1);
    expect(h.ports.invoke).not.toHaveBeenCalled();
    await a.stop();
  });
  it("does not reuse mount-relative modules, and a changed package always gets new code", async () => {
    for (const declared of [false, true]) {
      const h = uiHarness();
      h.importModule.mockResolvedValue({
        default: h.definition,
        ...(declared ? { crewonUiResourceMode: "self-contained.v1" } : {}),
      });
      const first = uiLease();
      const a = await h.loader.mount({
        root: h.root,
        lease: first,
        props: uiProps(),
      });
      const b = await h.loader.mount({
        root: h.root,
        lease: declared
          ? uiLease(2)
          : { ...first, mountRef: uiLease(2).mountRef },
        props: uiProps(),
      });
      expect(h.importModule).toHaveBeenCalledTimes(2);
      await a.stop();
      await b.stop();
    }
  });
  it("keeps at most eight code entries and does not invoke a marker getter", () => {
    const cache = new PluginUiModuleCodeCache();
    for (let i = 1; i <= 9; i++)
      cache.remember(uiLease(i), { crewonUiResourceMode: "self-contained.v1" });
    expect(cache.get(uiLease(1))).toBeUndefined();
    expect(cache.get(uiLease(9))).toBeDefined();
    let called = false;
    cache.remember(uiLease(10), {
      get crewonUiResourceMode() {
        called = true;
        return "self-contained.v1";
      },
    });
    expect(called).toBe(false);
    expect(cache.get(uiLease(10))).toBeUndefined();
  });
});
