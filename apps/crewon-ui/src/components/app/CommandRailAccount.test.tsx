// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DesktopLocalManagementAccessProvider } from "../../lib/desktop/DesktopLocalManagementContext";
import {
  subscribeDesktopLocalManagementAccess,
  type DesktopLocalManagementAccess,
} from "../../lib/desktop/desktopLocalManagementAccess";
import { CommandRailAccount } from "./CommandRailAccount";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let stopAccess: (() => void) | undefined;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  stopAccess?.();
  stopAccess = undefined;
  container.remove();
  delete (window as unknown as Record<string, unknown>).crewonDesktop;
  vi.restoreAllMocks();
});
async function openMenu() {
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
}
function item(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent?.trim() === label,
  );
}
describe("rail account capability actions", () => {
  it("opens enterprise sign-in only through a valid Native local-management grant", async () => {
    Object.defineProperty(window, "crewonDesktop", {
      configurable: true,
      value: {
        version: 1,
        runtime: {
          localManagementAccess: async () => ({
            schemaVersion: "crewon.desktop-local-management-access.v1",
            generation: 9,
          }),
          onLocalManagementAccessChanged: () => () => {},
        },
      },
    });
    let access: DesktopLocalManagementAccess | null = null;
    stopAccess = subscribeDesktopLocalManagementAccess((value) => {
      access = value;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(access).not.toBeNull();
    const onLogin = vi.fn();
    await act(async () =>
      root.render(
        <DesktopLocalManagementAccessProvider
          access={access!}
          onLoginAccount={onLogin}
        >
          <TooltipProvider>
            <CommandRailAccount account={null} locale="zh" />
          </TooltipProvider>
        </DesktopLocalManagementAccessProvider>,
      ),
    );
    expect(container.textContent).not.toContain("admin");
    expect(
      container.querySelector("button")?.getAttribute("aria-label"),
    ).toContain("本机管理");
    await openMenu();
    expect(item("登录企业账号")).toBeDefined();
    await act(async () => item("登录企业账号")!.click());
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it("rejects a renderer-created local-management identity", async () => {
    const onLogin = vi.fn();
    await act(async () =>
      root.render(
        <DesktopLocalManagementAccessProvider
          access={{ generation: 9 } as DesktopLocalManagementAccess}
          onLoginAccount={onLogin}
        >
          <TooltipProvider>
            <CommandRailAccount account={null} locale="zh" />
          </TooltipProvider>
        </DesktopLocalManagementAccessProvider>,
      ),
    );
    expect(
      container.querySelector("button")?.getAttribute("aria-label"),
    ).toContain("未登录");
    await openMenu();
    expect(item("登录企业账号")).toBeUndefined();
    expect(onLogin).not.toHaveBeenCalled();
  });
  it("keeps the enterprise account actions without adding a second login identity", async () => {
    const onSettings = vi.fn(),
      onLogout = vi.fn(),
      onSetPassword = vi.fn();
    await act(async () =>
      root.render(
        <TooltipProvider>
          <CommandRailAccount
            locale="zh"
            onSettings={onSettings}
            account={{
              needsPassword: true,
              providerLabel: "企业账号",
              user: {
                id: 42,
                username: "lin",
                email: "lin@example.com",
                role: "user",
                display_name: "林晓",
              },
              onLogout,
              onSetPassword,
            }}
          />
        </TooltipProvider>,
      ),
    );
    await openMenu();
    expect(item("登录企业账号")).toBeUndefined();
    expect(item("设置登录密码")).toBeDefined();
    await act(async () => item("设置")!.click());
    expect(onSettings).toHaveBeenCalledTimes(1);
    await openMenu();
    await act(async () => item("设置登录密码")!.click());
    expect(onSetPassword).toHaveBeenCalledTimes(1);
    await openMenu();
    await act(async () => item("退出登录")!.click());
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
