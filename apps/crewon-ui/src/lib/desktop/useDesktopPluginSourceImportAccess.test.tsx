// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrewonDesktopBridge } from "./desktopBridge";
import type { DesktopLocalPluginSourceImportClient } from "./desktopLocalPluginSourceImportProtocol";
import { useDesktopPluginSourceImportAccess } from "./useDesktopPluginSourceImportAccess";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete (window as unknown as Record<string, unknown>).crewonDesktop;
  window.history.replaceState(null, "", "/");
});

function mount(accountKey = "account:1") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function View({ account }: { account: string }) {
    const access = useDesktopPluginSourceImportAccess(account);
    return <span>{access?.ownerKey ?? "unavailable"}</span>;
  }
  const render = async (account = accountKey) => {
    await act(async () => root.render(<View account={account} />));
  };
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, render };
}

describe("actual Native plugin chooser capability", () => {
  it("keeps Web and an older preload unchanged even with a desktop URL", async () => {
    window.history.replaceState(null, "", "/?surface=desktop&platform=mac");
    const view = mount();
    await view.render();
    expect(view.container.textContent).toBe("unavailable");
    Object.defineProperty(window, "crewonDesktop", {
      configurable: true,
      value: { version: 1 },
    });
    await view.render();
    expect(view.container.textContent).toBe("unavailable");
  });

  it("refreshes only the actual optional versioned client and revokes its subscription", async () => {
    let changed = () => {};
    const unsubscribe = vi.fn();
    const client: DesktopLocalPluginSourceImportClient = {
      version: 1,
      previewDirectory: vi.fn(async () => null),
      confirmPreview: vi.fn(),
      cancelPreview: vi.fn(),
      subscribeOwnerChanged(listener) {
        changed = listener;
        return unsubscribe;
      },
    };
    const bridge = {
      version: 1,
      pluginSourceImports: client,
    } as CrewonDesktopBridge;
    Object.defineProperty(window, "crewonDesktop", {
      configurable: true,
      value: bridge,
    });
    const view = mount();
    await view.render();
    expect(view.container.textContent).toBe("account:1:0");
    await act(async () => changed());
    expect(view.container.textContent).toBe("account:1:1");
    await view.render("account:2");
    expect(view.container.textContent).toBe("account:2:1");
    expect(client.previewDirectory).not.toHaveBeenCalled();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
