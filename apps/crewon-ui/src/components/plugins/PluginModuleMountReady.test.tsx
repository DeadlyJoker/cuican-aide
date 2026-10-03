// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginUiProps, PluginUiServices } from "@crewon/plugin-sdk/ui";
import {
  deferred,
  flush,
  uiHarness,
  uiLease,
  uiProps,
} from "../../lib/plugins/pluginUiLoader.test-support";
import { PluginModuleMount } from "./PluginModuleMount";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
async function settle() {
  for (let count = 0; count < 3; count++) await flush();
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await act(async () => {
      root.unmount();
      await settle();
    });
  document.body.replaceChildren();
});
function reactRoot() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  return { root, container };
}

describe("PluginModuleMount completion notification", () => {
  it("does not update an old handle with replacement-owner props or deliver its completion to the new callback", async () => {
    const mounting = deferred<void>();
    const updating = deferred<void>();
    const replacement = deferred<ReturnType<typeof uiLease>>();
    const h = uiHarness();
    let serial = 0;
    h.importModule.mockImplementation(async () => ({
      default: {
        ...h.definition,
        async mount(
          root: HTMLElement,
          props: PluginUiProps,
          services: PluginUiServices,
        ) {
          const instance = await h.definition.mount(root, props, services);
          const first = ++serial === 1;
          if (first) await mounting.promise;
          return {
            async update(next: PluginUiProps) {
              if (first) await updating.promise;
              return instance.update(next);
            },
            dispose: instance.dispose,
          };
        },
      },
    }));
    const mounted = reactRoot();
    const originalCallback = vi.fn();
    const newCallback = vi.fn();
    const onError = vi.fn();
    const originalAcquire = vi.fn(async () => uiLease());
    const replacementAcquire = vi.fn(() => replacement.promise);
    const render = async (
      acquireMount = originalAcquire,
      props = uiProps({ title: "original" }),
      onMounted = originalCallback,
    ) => {
      await act(async () => {
        mounted.root.render(
          <PluginModuleMount
            active
            loader={h.loader}
            acquireMount={acquireMount}
            mountKey="same-key"
            props={props}
            onMounted={onMounted}
            onError={onError}
          />,
        );
        await settle();
      });
    };
    await render();
    await render(originalAcquire, uiProps({ title: "old-current" }));
    mounting.resolve();
    await act(settle);
    expect(
      mounted.container.querySelector("[data-plugin-ui-root]"),
    ).not.toBeNull();
    await render(
      replacementAcquire,
      uiProps({ title: "new-owner", pluginUiReady: false }),
      newCallback,
    );
    updating.resolve();
    await act(settle);
    expect(
      h.instances[0].update.mock.calls.map(([props]) => props.data),
    ).toEqual([{ title: "old-current" }]);
    expect(originalCallback).not.toHaveBeenCalled();
    expect(newCallback).not.toHaveBeenCalled();
    replacement.resolve(uiLease(2));
    await act(settle);
    expect(newCallback).toHaveBeenCalledTimes(1);
    expect(originalCallback).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toContain("new-owner");
  });

  it("notifies the latest host callback only after publication and the awaited current props update", async () => {
    const imported = deferred<unknown>();
    const updating = deferred<void>();
    const h = uiHarness(() => imported.promise);
    const mounted = reactRoot();
    const originalCallback = vi.fn();
    const latestCallback = vi.fn();
    const onError = vi.fn();
    const acquireMount = vi.fn(async () => uiLease());
    const render = async (
      props: PluginUiProps,
      onMounted = originalCallback,
    ) => {
      await act(async () => {
        mounted.root.render(
          <PluginModuleMount
            active={true}
            loader={h.loader}
            acquireMount={acquireMount}
            mountKey="one"
            props={props}
            onMounted={onMounted}
            onError={onError}
          />,
        );
        await settle();
      });
    };
    await render(uiProps({ title: "开始挂载" }));
    await render(uiProps({ title: "最新宿主内容" }), latestCallback);
    imported.resolve({
      default: {
        ...h.definition,
        async mount(
          root: HTMLElement,
          props: PluginUiProps,
          services: PluginUiServices,
        ) {
          const instance = await h.definition.mount(root, props, services);
          return {
            async update(next: PluginUiProps) {
              await updating.promise;
              await instance.update(next);
            },
            dispose: instance.dispose,
          };
        },
      },
    });
    await act(settle);
    expect(
      mounted.container.querySelector("[data-plugin-ui-root]"),
    ).not.toBeNull();
    expect(originalCallback).not.toHaveBeenCalled();
    expect(latestCallback).not.toHaveBeenCalled();
    updating.resolve();
    await act(settle);
    expect(mounted.container.textContent).toContain("最新宿主内容");
    expect(originalCallback).not.toHaveBeenCalled();
    expect(latestCallback).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    await render(uiProps({ title: "之后更新" }), latestCallback);
    expect(mounted.container.textContent).toContain("之后更新");
    expect(latestCallback).toHaveBeenCalledTimes(1);
    expect(acquireMount).toHaveBeenCalledTimes(1);
  });

  it("never notifies for a cancelled asynchronous plugin mount, and disposes its late instance", async () => {
    const returning = deferred<void>();
    const h = uiHarness();
    h.importModule.mockImplementation(async () => ({
      default: {
        ...h.definition,
        async mount(
          root: HTMLElement,
          props: PluginUiProps,
          services: PluginUiServices,
        ) {
          const instance = await h.definition.mount(root, props, services);
          await returning.promise;
          return instance;
        },
      },
    }));
    const mounted = reactRoot();
    const onMounted = vi.fn();
    const onError = vi.fn();
    const acquireMount = vi.fn(async () => uiLease());
    const props = uiProps();
    const render = async (active: boolean) => {
      await act(async () => {
        mounted.root.render(
          <PluginModuleMount
            active={active}
            loader={h.loader}
            acquireMount={acquireMount}
            mountKey="one"
            props={props}
            onMounted={onMounted}
            onError={onError}
          />,
        );
        await settle();
      });
    };
    await render(true);
    expect(h.instances).toHaveLength(1);
    expect(mounted.container.querySelector("[data-plugin-ui-root]")).toBeNull();
    await render(false);
    expect(h.ports.closeMount).toHaveBeenCalledTimes(1);
    returning.resolve();
    await act(settle);
    expect(onMounted).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(h.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(h.loader.pendingCleanupCount).toBe(0);
    expect(mounted.container.querySelector("[data-plugin-ui-root]")).toBeNull();
  });
});
