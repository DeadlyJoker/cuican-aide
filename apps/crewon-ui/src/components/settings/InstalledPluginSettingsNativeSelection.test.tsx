// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginSelectionView,
  SelectPluginPackageRequest,
} from "@crewon/contracts";
import type {
  DesktopPluginSelectionReply,
  DesktopPluginSelectionRequest,
} from "../../lib/desktop/desktopBridge";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../../lib/agent-platform/agentPlatformClient";
import {
  INSTALLED_PLUGIN_SELECTION_CHANGED,
  installedPluginSelectionChange,
} from "../../lib/plugins/installedPluginChanges";
import { InstalledPluginSettings } from "./InstalledPluginSettings";
import {
  SETTINGS_PLUGIN_ID,
  SettingsFetchFixture,
  settingsDeferred,
  settingsPackage,
  settingsSelection,
  settingsSelectionReceipt,
  settleSettings,
} from "./InstalledPluginSettings.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("original plugin Settings Native selection and activation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let fixture: SettingsFetchFixture;
  let originalBridge: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalBridge = Object.getOwnPropertyDescriptor(window, "crewonDesktop");
    Object.defineProperty(window, "crewonDesktop", {
      configurable: true,
      value: undefined,
    });
    fixture = new SettingsFetchFixture();
    fixture.selections = [settingsSelection()];
    fixture.packages = [settingsPackage()];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await settleSettings();
    });
    container.remove();
    if (originalBridge)
      Object.defineProperty(window, "crewonDesktop", originalBridge);
    else Reflect.deleteProperty(window, "crewonDesktop");
    vi.restoreAllMocks();
  });

  function native(
    handler: (
      input: DesktopPluginSelectionRequest,
    ) => Promise<DesktopPluginSelectionReply>,
  ) {
    const runtime = {
      setPluginSelection: vi.fn(function (
        this: unknown,
        input: DesktopPluginSelectionRequest,
      ) {
        expect(this).toBe(runtime);
        return handler(input);
      }),
    };
    Object.defineProperty(window, "crewonDesktop", {
      configurable: true,
      value: { version: 1, runtime },
    });
    return runtime.setPluginSelection;
  }

  async function render(client = fixture.client.plugins) {
    await act(async () => {
      root.render(<InstalledPluginSettings client={client} locale="zh" />);
      await settleSettings();
    });
    await settle();
  }

  async function settle() {
    await act(async () => {
      await settleSettings();
      await settleSettings();
    });
  }

  function button(label: string) {
    const result = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) => item.textContent === label);
    if (!result) throw new Error(`missing_native_settings_button:${label}`);
    return result;
  }

  async function click(label: string) {
    const target = button(label);
    expect(target.disabled).toBe(false);
    await act(async () => {
      target.click();
      await settleSettings();
    });
    await settle();
  }

  function receipt(
    selection: PluginSelectionView,
    disposition: "committed" | "replayed" = "committed",
  ): DesktopPluginSelectionReply & { ok: true } {
    return {
      ok: true,
      value: {
        mutation: { kind: "select", disposition, selection },
        projection: {
          outcome: disposition === "replayed" ? "unchanged" : "applied",
        },
      },
    };
  }

  it("uses the additive Native Main path for enable, disable and uninstall, while rereading the original Control catalog", async () => {
    const select = native(async (input) => {
      fixture.selections = [
        settingsSelection(
          input.request.expectedSelectionRevision + 1,
          input.request.state,
        ),
      ];
      return receipt(fixture.selections[0]!);
    });
    await render();
    await click("启用");
    expect(container.textContent).toContain("已启用");
    await click("停用");
    expect(container.textContent).toContain("已停用");
    await click("卸载");
    expect(container.textContent).toContain("已卸载");
    expect(select.mock.calls.map(([input]) => input.request)).toEqual([
      {
        state: "enabled",
        selectedPackageDigest: settingsPackage().packageDigest,
        expectedSelectionRevision: 1,
      },
      {
        state: "disabled",
        selectedPackageDigest: settingsPackage().packageDigest,
        expectedSelectionRevision: 2,
      },
      {
        state: "uninstalled",
        selectedPackageDigest: null,
        expectedSelectionRevision: 3,
      },
    ]);
    expect(
      select.mock.calls.every(
        ([input]) => input.pluginId === SETTINGS_PLUGIN_ID,
      ),
    ).toBe(true);
    expect(
      new Set(select.mock.calls.map(([input]) => input.idempotencyKey)).size,
    ).toBe(3);
    expect(fixture.mutations).toHaveLength(0);
    expect(
      fixture.requests.filter(
        (request) => request.path === "/api/v1/plugins/selections",
      ),
    ).toHaveLength(4);
  });

  it("keeps the exact original request and key when selection committed but Native activation failed, even after refresh", async () => {
    let selectionCommits = 0;
    const select = native(async (input) => {
      if (selectionCommits === 0) {
        selectionCommits++;
        fixture.selections = [settingsSelection(2, "enabled")];
        return {
          ok: false,
          error: {
            kind: "unknown",
            code: "desktop_native_plugin_business_activation_failed",
          },
        };
      }
      expect(input.request.expectedSelectionRevision).toBe(1);
      return receipt(fixture.selections[0]!, "replayed");
    });
    await render();
    await click("启用");
    expect(container.textContent).toContain("暂时无法确认操作结果");
    expect(container.textContent).not.toContain("选择已保存");
    expect(container.textContent).toContain("已启用");
    expect(button("停用").disabled).toBe(true);
    await click("刷新插件");
    expect(container.textContent).toContain("已启用");
    expect(button("停用").disabled).toBe(true);
    await click("重试上次操作");
    const original = select.mock.calls[0]![0];
    const retry = select.mock.calls[1]![0];
    expect(retry.request).toBe(original.request);
    expect(retry.idempotencyKey).toBe(original.idempotencyKey);
    expect(selectionCommits).toBe(1);
    expect(fixture.selections[0]!.revision).toBe(2);
    expect(fixture.mutations).toHaveLength(0);
    expect(container.textContent).not.toContain("重试上次操作");
    expect(container.textContent).toContain("选择已保存");
    expect(button("停用").disabled).toBe(false);
  });

  it("withdraws a stale enabled module from an actual current selection read after committed disable and failed activation", async () => {
    fixture.selections = [settingsSelection(2, "enabled")];
    const hints: unknown[] = [];
    const changed = (event: Event) =>
      hints.push(installedPluginSelectionChange(event));
    window.addEventListener(INSTALLED_PLUGIN_SELECTION_CHANGED, changed);
    try {
      native(async () => {
        fixture.selections = [settingsSelection(3, "disabled")];
        throw new Error(
          "desktop_native_plugin_business_activation_failed:retirement_failed",
        );
      });
      await render();
      await click("停用");
      expect(hints).toEqual([
        {
          pluginId: SETTINGS_PLUGIN_ID,
          selection: settingsSelection(3, "disabled"),
        },
      ]);
      expect(
        fixture.requests.filter(
          (request) =>
            request.path === `/api/v1/plugins/selections/${SETTINGS_PLUGIN_ID}`,
        ),
      ).toHaveLength(1);
      expect(container.textContent).toContain("已停用");
      expect(container.textContent).not.toContain("选择已保存");
      expect(button("启用").disabled).toBe(true);
      expect(button("重试上次操作").disabled).toBe(false);
      expect(fixture.mutations).toHaveLength(0);
    } finally {
      window.removeEventListener(INSTALLED_PLUGIN_SELECTION_CHANGED, changed);
    }
  });

  it.each(["web", "legacy", "wrongVersion"] as const)(
    "keeps the original authenticated Control selection path for %s without the supported Native capability",
    async (surface) => {
      const unsupported = vi.fn();
      Object.defineProperty(window, "crewonDesktop", {
        configurable: true,
        value:
          surface === "web"
            ? undefined
            : {
                version: surface === "legacy" ? 1 : 2,
                runtime:
                  surface === "legacy"
                    ? {}
                    : { setPluginSelection: unsupported },
              },
      });
      fixture.onMutation = (input) => {
        const request = input.body as SelectPluginPackageRequest;
        fixture.selections = [
          settingsSelection(
            request.expectedSelectionRevision + 1,
            request.state,
          ),
        ];
        return settingsSelectionReceipt(fixture.selections[0]!);
      };
      await render();
      await click("启用");
      expect(fixture.mutations).toHaveLength(1);
      expect(fixture.mutations[0]!.method).toBe("PUT");
      expect(fixture.mutations[0]!.headers.get("idempotency-key")).toMatch(
        /^plugin-settings-/,
      );
      expect(unsupported).not.toHaveBeenCalled();
      expect(container.textContent).toContain("选择已保存");
    },
  );

  it("preserves a known Native HTTP conflict as the original refusal and uses the refreshed CAS only for a new intent", async () => {
    const select = native(async (input) => {
      if (input.request.expectedSelectionRevision === 1) {
        fixture.selections = [settingsSelection(5, "disabled")];
        return {
          ok: false,
          error: {
            kind: "http",
            status: 409,
            category: "conflict",
            code: "plugin_installation_revision_conflict",
            message: "plugin_installation_revision_conflict",
            requestId: "named-native-settings-conflict",
          },
        };
      }
      fixture.selections = [settingsSelection(6, "enabled")];
      return receipt(fixture.selections[0]!);
    });
    await render();
    await click("启用");
    expect(container.textContent).toContain("插件状态已变化，已重新读取");
    expect(container.textContent).not.toContain("重试上次操作");
    await click("启用");
    expect(select.mock.calls[1]![0].request.expectedSelectionRevision).toBe(5);
    expect(select.mock.calls[1]![0].idempotencyKey).not.toBe(
      select.mock.calls[0]![0].idempotencyKey,
    );
    expect(fixture.mutations).toHaveLength(0);
    expect(container.textContent).toContain("已启用");
  });

  it("keeps a known Native HTTP authorization refusal distinct from a potentially committed activation failure", async () => {
    native(async () => ({
      ok: false,
      error: {
        kind: "http",
        status: 403,
        category: "authorization",
        code: "plugin_management_denied",
        message: "plugin_management_denied",
        requestId: "named-native-settings-denial",
      },
    }));
    await render();
    await click("启用");
    expect(container.textContent).toContain("当前账号无法管理这些插件");
    expect(container.textContent).not.toContain("重试上次操作");
    expect(fixture.mutations).toHaveLength(0);
    expect(fixture.selections[0]!.revision).toBe(1);
  });

  it("does not publish a Native activation reply after the original account has withdrawn", async () => {
    const pending = settingsDeferred<DesktopPluginSelectionReply>();
    native(() => pending.promise);
    await render();
    await click("启用");
    await act(async () => {
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
      await settleSettings();
    });
    const originalReads = fixture.requests.length;
    await act(async () => {
      pending.resolve(receipt(settingsSelection(2, "enabled")));
      await settleSettings();
    });
    await settle();
    expect(container.textContent).toContain("账号已变化");
    expect(container.textContent).not.toContain("选择已保存");
    expect(container.textContent).not.toContain("重试上次操作");
    expect(fixture.requests).toHaveLength(originalReads);
  });

  it("rejects a foreign Native receipt instead of showing successful selection or notifying discovery", async () => {
    const select = native(async () =>
      receipt({
        ...settingsSelection(2, "enabled"),
        pluginId: "fixture.foreign-plugin",
      }),
    );
    await render();
    const originalReads = fixture.requests.length;
    await click("启用");
    expect(select).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("暂时无法确认操作结果");
    expect(container.textContent).not.toContain("选择已保存");
    expect(button("重试上次操作").disabled).toBe(false);
    expect(fixture.requests).toHaveLength(originalReads);
  });
});
