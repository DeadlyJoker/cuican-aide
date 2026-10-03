// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandSettingsRoute } from "./CommandSettingsRoute";
import { ConfigurationPanelFetchFixture } from "../settings/InstalledPluginConfigurationPanel.test-support";
import {
  SettingsFetchFixture,
  settingsPackage,
  settingsSelection,
  settleSettings,
} from "../settings/InstalledPluginSettings.test-support";
import type {
  GetExtensionConfigurationResponse,
  SaveExtensionConfigurationRequest,
} from "@crewon/contracts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Actual original route and typed client, with named HTTP responses only.
// The PostgreSQL/browser process test separately proves persistence and package authority.
describe("installed configuration in the original settings route", () => {
  let root: Root;
  let container: HTMLDivElement;
  let fixture: SettingsFetchFixture;
  let configuration: GetExtensionConfigurationResponse["configuration"];
  let beforeRoot: string;

  beforeEach(() => {
    fixture = new SettingsFetchFixture();
    fixture.selections = [settingsSelection()];
    fixture.packages = [settingsPackage()];
    configuration = null;
    beforeRoot = JSON.stringify([
      document.documentElement.getAttribute("style"),
      document.documentElement.className,
      document.documentElement.getAttribute("data-theme"),
    ]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const data = new ConfigurationPanelFetchFixture();
    fixture.onRead = (request) => {
      if (request.path.startsWith("/api/v1/plugins/packages/"))
        return Response.json({ package: settingsPackage() });
      if (request.path === "/api/v1/extensions")
        return Response.json({
          extensions: [
            {
              pluginId: settingsSelection().pluginId,
              pluginVersion: "1.0.0",
              title: "Named independent configuration fixture",
              description: "Original route composition check",
              inputSchema: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
              },
              configurationSchema: data.schema,
              credentialSlots: [],
              resultViews: ["text"],
            },
          ],
        });
      if (request.path.endsWith("/configuration"))
        return Response.json({ configuration });
      return undefined;
    };
    fixture.onMutation = (request) => {
      const body = request.body as SaveExtensionConfigurationRequest;
      configuration = data.saved(body.parameters, body.expectedRevision + 1);
      return Response.json({ disposition: "created", configuration });
    };
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await settleSettings();
    });
    container.remove();
    expect(
      JSON.stringify([
        document.documentElement.getAttribute("style"),
        document.documentElement.className,
        document.documentElement.getAttribute("data-theme"),
      ]),
    ).toBe(beforeRoot);
  });
  async function mount() {
    await act(async () => {
      root.render(
        <CommandSettingsRoute
          activeSection="mcp-servers"
          controlClient={fixture.client}
          dataMode="live"
          disabled={false}
          locale="zh"
          notice={null}
          panel={null}
          platform="mac"
          onBack={vi.fn()}
          onDismissNotice={vi.fn()}
          onPanelAction={vi.fn()}
          onPanelFieldChange={vi.fn()}
          onPanelFieldCommit={vi.fn()}
          onSectionChange={vi.fn()}
        />,
      );
      await settleSettings();
      await settleSettings();
    });
  }
  function button(label: string) {
    const element = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    expect(element, label).toBeDefined();
    return element!;
  }
  async function click(label: string) {
    await act(async () => {
      button(label).click();
      await settleSettings();
      await settleSettings();
    });
  }
  it("opens lazily in the existing plugin card, saves, closes and rereads without publishing or creating a task", async () => {
    await mount();
    expect(container.querySelector(".settings-command-screen")).not.toBeNull();
    expect(
      container.querySelector(".settings-command-canvas .settings-content"),
    ).not.toBeNull();
    expect(
      container.querySelector(".installed-plugin-configuration"),
    ).toBeNull();
    expect(
      fixture.requests.some((request) =>
        request.path.startsWith("/api/v1/extensions"),
      ),
    ).toBe(false);
    const navigation = container.querySelector(".settings-sidebar")!.outerHTML;
    await click("业务配置");
    expect(button("业务配置").getAttribute("aria-expanded")).toBe("true");
    const field = container.querySelector<HTMLInputElement>(
      'input[aria-label="organization"]',
    )!;
    expect(field).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, "独立开发插件企业");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await settleSettings();
    });
    await click("保存参数");
    expect(fixture.mutations).toHaveLength(1);
    expect(fixture.mutations[0]!.body).toEqual({
      pluginVersion: "1.0.0",
      expectedRevision: 0,
      parameters: { organization: "独立开发插件企业" },
      credentialBindings: [],
    });
    expect(container.textContent).toContain("已保存版本 1");
    await click("业务配置");
    expect(
      container.querySelector(".installed-plugin-configuration"),
    ).toBeNull();
    await click("业务配置");
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="organization"]',
      )!.value,
    ).toBe("独立开发插件企业");
    expect(container.querySelector(".settings-sidebar")!.outerHTML).toBe(
      navigation,
    );
    expect(
      fixture.requests.some((request) =>
        /activation|tasks|runs|quote|credits/u.test(request.path),
      ),
    ).toBe(false);
  });
  it("removes configuration access after uninstall while preserving installation management", async () => {
    fixture.selections = [settingsSelection(2, "uninstalled")];
    await mount();
    expect(container.textContent).toContain("已卸载");
    expect(container.textContent).toContain("管理版本");
    expect(container.textContent).not.toContain("业务配置");
    expect(
      fixture.requests.some((request) =>
        request.path.startsWith("/api/v1/extensions"),
      ),
    ).toBe(false);
    expect(fixture.mutations).toHaveLength(0);
  });
});
