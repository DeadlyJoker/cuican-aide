// @vitest-environment happy-dom
import type { PluginUiProps, PluginUiServices } from "@crewon/plugin-sdk/ui";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginUiLease } from "@crewon/contracts/plugins";
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
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  await flush();
  document.body.replaceChildren();
});
function reactRoot() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  return { root, container };
}

describe("PluginModuleMount host composition", () => {
  it("does not acquire or import a hidden slot, stops on leaving, and reacquires on reopening", async () => {
    const h = uiHarness();
    let serial = 0;
    const acquireMount = vi.fn(async () => uiLease(++serial));
    const mounted = reactRoot();
    const render = (active: boolean, props = uiProps()) => (
      <PluginModuleMount
        active={active}
        loader={h.loader}
        acquireMount={acquireMount}
        mountKey="one"
        props={props}
      />
    );
    await act(async () => {
      mounted.root.render(render(false));
      await flush();
    });
    await act(async () => {
      mounted.root.render(render(false, uiProps({ title: "隐藏时更新" })));
      await flush();
    });
    expect(acquireMount).not.toHaveBeenCalled();
    expect(h.importModule).not.toHaveBeenCalled();
    await act(async () => {
      mounted.root.render(render(true));
      await flush();
    });
    expect(h.instances).toHaveLength(1);
    const oldServices = h.instances[0].services;
    await act(async () => {
      mounted.root.render(render(false));
      await flush();
    });
    await expect(oldServices.invoke("save", null, {})).rejects.toThrow(
      "plugin_ui_operation_aborted",
    );
    expect(mounted.container.querySelector("[data-plugin-ui-root]")).toBeNull();
    expect(h.ports.closeMount).toHaveBeenCalledTimes(1);
    expect(h.instances[0].dispose).toHaveBeenCalledTimes(1);
    await act(async () => {
      mounted.root.render(render(true));
      await flush();
    });
    expect(acquireMount).toHaveBeenCalledTimes(2);
    expect(h.instances).toHaveLength(2);
    expect(h.ports.validateMount.mock.calls.at(-1)?.[0].mountRef).toBe(
      uiLease(2).mountRef,
    );
  });

  it("closes an acquire arriving after the slot became inactive without importing it", async () => {
    const h = uiHarness();
    const late = deferred<PluginUiLease>();
    const acquireMount = vi.fn(() => late.promise);
    const mounted = reactRoot();
    const render = (active: boolean) => (
      <PluginModuleMount
        active={active}
        loader={h.loader}
        acquireMount={acquireMount}
        mountKey="one"
        props={uiProps()}
      />
    );
    await act(async () => {
      mounted.root.render(render(true));
      await flush();
    });
    await act(async () => {
      mounted.root.render(render(false));
      await flush();
    });
    late.resolve(uiLease());
    await act(flush);
    expect(h.importModule).not.toHaveBeenCalled();
    expect(h.ports.closeMount).toHaveBeenCalledTimes(1);
  });
  it("renders only an empty content slot inheriting the existing host theme", () => {
    const h = uiHarness();
    const acquireMount = vi.fn(async () => uiLease());
    const markup = renderToStaticMarkup(
      <PluginModuleMount
        active={true}
        loader={h.loader}
        acquireMount={acquireMount}
        mountKey="package-1"
        props={uiProps()}
        className="host-pane"
      />,
    );
    expect(markup).toMatchSnapshot();
    expect(markup).not.toContain("style=");
    expect(acquireMount).not.toHaveBeenCalled();
    expect(h.importModule).not.toHaveBeenCalled();
  });

  it("mounts once, routes real DOM events through the captured bridge and updates without reacquiring", async () => {
    const h = uiHarness();
    h.importModule.mockImplementationOnce(async () => ({
      default: {
        ...h.definition,
        mount(
          root: HTMLElement,
          props: PluginUiProps,
          services: PluginUiServices,
        ) {
          const instance = h.definition.mount(root, props, services);
          const button = document.createElement("button");
          button.textContent = "保存需求";
          button.onclick = () => {
            void services.invoke("saveBrief", { text: "需求内容" }, {});
          };
          root.append(button);
          return instance;
        },
      },
    }));
    const acquireMount = vi.fn(async () => uiLease());
    const mounted = reactRoot();
    await act(async () => {
      mounted.root.render(
        <PluginModuleMount
          active={true}
          loader={h.loader}
          acquireMount={acquireMount}
          mountKey="one"
          props={uiProps()}
        />,
      );
      await flush();
    });
    const slot = mounted.container.querySelector(
      '[data-plugin-content-slot="main.content"]',
    );
    expect(h.instances[0].root.parentNode).toBe(slot);
    await act(async () => {
      mounted.container
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect(h.ports.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ mountRef: uiLease().mountRef }),
      expect.objectContaining({
        action: "saveBrief",
        input: { text: "需求内容" },
      }),
    );
    await act(async () => {
      mounted.root.render(
        <PluginModuleMount
          active={true}
          loader={h.loader}
          acquireMount={acquireMount}
          mountKey="one"
          props={uiProps({ title: "已更新" })}
        />,
      );
      await flush();
    });
    expect(acquireMount).toHaveBeenCalledTimes(1);
    expect(h.importModule).toHaveBeenCalledTimes(1);
    expect(mounted.container.textContent).toContain("已更新");
  });

  it("uses a distinct lease for StrictMode and closes a cancelled acquire that arrives late", async () => {
    const h = uiHarness();
    const late = deferred<PluginUiLease>();
    const acquireMount = vi
      .fn(async (_signal: AbortSignal) => uiLease(2))
      .mockImplementationOnce(() => late.promise);
    const mounted = reactRoot();
    await act(async () => {
      mounted.root.render(
        <StrictMode>
          <PluginModuleMount
            active={true}
            loader={h.loader}
            acquireMount={acquireMount}
            mountKey="one"
            props={uiProps()}
          />
        </StrictMode>,
      );
      await flush();
    });
    expect(acquireMount).toHaveBeenCalledTimes(2);
    expect(acquireMount.mock.calls[0][0].aborted).toBe(true);
    expect(h.instances).toHaveLength(1);
    const child = mounted.container.querySelector("[data-plugin-ui-root]");
    late.resolve(uiLease(1));
    await act(flush);
    expect(
      h.ports.closeMount.mock.calls.map(([lease]) => lease.mountRef),
    ).toEqual([uiLease(1).mountRef]);
    expect(mounted.container.querySelector("[data-plugin-ui-root]")).toBe(
      child,
    );
    await act(async () => mounted.root.unmount());
    roots.splice(roots.indexOf(mounted.root), 1);
    await flush();
    expect(
      h.ports.closeMount.mock.calls.map(([lease]) => lease.mountRef).sort(),
    ).toEqual([uiLease(1).mountRef, uiLease(2).mountRef].sort());
    expect(h.instances[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the old pane while a replacement imports and after a failed upgrade", async () => {
    const h = uiHarness();
    let serial = 0;
    const acquireMount = vi.fn(async () => uiLease(++serial));
    const onError = vi.fn();
    const mounted = reactRoot();
    const render = (key: string) => (
      <PluginModuleMount
        active={true}
        loader={h.loader}
        acquireMount={acquireMount}
        mountKey={key}
        props={uiProps()}
        onError={onError}
      />
    );
    await act(async () => {
      mounted.root.render(render("one"));
      await flush();
    });
    const old = mounted.container.querySelector("[data-plugin-ui-root]");
    const imported = deferred<unknown>();
    h.importModule.mockImplementationOnce(() => imported.promise);
    await act(async () => {
      mounted.root.render(render("two"));
      await flush();
    });
    expect(mounted.container.querySelector("[data-plugin-ui-root]")).toBe(old);
    imported.reject(new Error("bad UI upgrade"));
    await act(flush);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "bad UI upgrade" }),
    );
    expect(mounted.container.querySelector("[data-plugin-ui-root]")).toBe(old);
    expect(h.instances[0].dispose).not.toHaveBeenCalled();
    await act(async () => {
      mounted.root.render(render("three"));
      await flush();
    });
    expect(mounted.container.querySelector("[data-plugin-ui-root]")).not.toBe(
      old,
    );
    expect(h.instances[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("cancels import on unmount without executing the late module", async () => {
    const imported = deferred<unknown>();
    const h = uiHarness(() => imported.promise);
    const mounted = reactRoot();
    await act(async () => {
      mounted.root.render(
        <PluginModuleMount
          active={true}
          loader={h.loader}
          acquireMount={async () => uiLease()}
          mountKey="one"
          props={uiProps()}
        />,
      );
      await flush();
    });
    await act(async () => mounted.root.unmount());
    roots.splice(roots.indexOf(mounted.root), 1);
    imported.resolve({ default: h.definition });
    await flush();
    expect(h.instances).toHaveLength(0);
    expect(h.ports.closeMount).toHaveBeenCalledTimes(1);
    expect(h.loader.pendingCleanupCount).toBe(0);
  });

  it("closes a cancelled acquire result even when no module import started", async () => {
    const h = uiHarness();
    const late = deferred<PluginUiLease>();
    const mounted = reactRoot();
    await act(async () =>
      mounted.root.render(
        <PluginModuleMount
          active={true}
          loader={h.loader}
          acquireMount={() => late.promise}
          mountKey="one"
          props={uiProps()}
        />,
      ),
    );
    await act(async () => mounted.root.unmount());
    roots.splice(roots.indexOf(mounted.root), 1);
    late.resolve(uiLease());
    await flush();
    expect(h.importModule).not.toHaveBeenCalled();
    expect(h.ports.closeMount).toHaveBeenCalledTimes(1);
  });
});
