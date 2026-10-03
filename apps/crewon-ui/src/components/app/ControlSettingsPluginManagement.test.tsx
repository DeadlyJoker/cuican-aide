// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlSettingsContent } from "./ControlSettingsContent";
import {
  SettingsFetchFixture,
  settingsPackage,
  settingsSelection,
  settleSettings,
} from "../settings/InstalledPluginSettings.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// This composition check belongs beside the app shell; the settings feature
// remains independent of app coordination and keeps its own behavior coverage.
describe("installed plugin settings with a named fetch fixture and the actual Control client", () => {
  let root: Root;
  let container: HTMLDivElement;
  let f: SettingsFetchFixture;
  let oldRootStyle: string | null;
  let oldRootClass: string | null;
  let oldRootTheme: string | null;
  beforeEach(() => {
    f = new SettingsFetchFixture();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    oldRootStyle = document.documentElement.getAttribute("style");
    oldRootClass = document.documentElement.getAttribute("class");
    oldRootTheme = document.documentElement.getAttribute("data-theme");
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await settleSettings();
    });
    container.remove();
    expect(document.documentElement.getAttribute("style")).toBe(oldRootStyle);
    expect(document.documentElement.getAttribute("class")).toBe(oldRootClass);
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      oldRootTheme,
    );
    vi.restoreAllMocks();
  });
  async function settle() {
    await act(async () => {
      await settleSettings();
      await settleSettings();
    });
  }
  function section(label: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      `section[aria-label="${label}"]`,
    );
    if (!element) throw new Error(`missing_settings_section:${label}`);
    return element;
  }
  function text() {
    return container.textContent ?? "";
  }

  it("snapshots visible management states within the original Settings shell and preserves templates/root/account", async () => {
    f.selections = [settingsSelection()];
    f.packages = [settingsPackage()];
    const account = document.createElement("aside");
    account.textContent = "existing host account/settings";
    document.body.appendChild(account);
    try {
      await act(async () => {
        root.render(
          <ControlSettingsContent
            activeSection="mcp-servers"
            client={f.client}
            locale="zh"
            platformUser={{
              id: 37,
              username: "existing account",
              email: "fixture@example.test",
              role: "user",
            }}
            onSectionChange={vi.fn()}
          />,
        );
        await settleSettings();
      });
      await settle();
      expect(container.querySelector(".settings-content")).not.toBeNull();
      expect(container.querySelector(".bundled-task-packs")).not.toBeNull();
      expect(account.textContent).toBe("existing host account/settings");
      expect(section("插件管理").outerHTML).toMatchSnapshot();
      expect(text()).toContain("卸载保留历史任务和业务数据");
      expect(text()).toContain("启用状态不代表生成服务已可用");
      expect(f.mutations).toHaveLength(0);
    } finally {
      account.remove();
    }
  });
});
