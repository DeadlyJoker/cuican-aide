// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  DesktopLocalPluginSourceConfirmation,
  DesktopLocalPluginSourceConfirmed,
  DesktopLocalPluginSourceImportClient,
  DesktopLocalPluginSourcePreview,
} from "../../lib/desktop/desktopLocalPluginSourceImportProtocol";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../../lib/agent-platform/agentPlatformClient";
import { InstalledPluginSettingsLocalImport } from "./InstalledPluginSettingsLocalImport";
import { InstalledPluginSettings } from "./InstalledPluginSettings";
import {
  SettingsFetchFixture,
  settingsDeferred,
  settingsInstallReceipt,
  settingsSelection,
  settingsSource,
  settleSettings,
} from "./InstalledPluginSettings.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const CHOOSE = "选择本机插件目录";
const CONFIRM = "确认信任并添加来源";
const CLOSE = "关闭预览";
const NODE_TRUST =
  "我信任此包的 Node 代码。启用后，它可在宿主 Node 进程中执行。";
const UI_TRUST = "我信任此包的界面代码。它与 CrewON 主界面共享 Renderer 权限。";

/** Named protocol replies only: this component fixture does not certify filesystem or Main authority. */
class NativeImportFixture {
  preview: DesktopLocalPluginSourcePreview = {
    previewId: "named-preview-1",
    expiresAt: Date.now() + 60_000,
    pluginId: settingsSource().pluginId,
    publisherId: settingsSource().publisherId,
    version: settingsSource().version,
    packageDigest: settingsSource().packageDigest,
    title: "仓外独立包",
    description: "具名 Native 协议夹具，不代表实际磁盘导入。",
    totalBytes: 512,
    fileCount: 4,
    nodeEntry: "node.mjs",
    uiEntry: { path: "ui/entry.mjs", mode: "trustedModule" },
    publicAssetCandidates: ["ui/entry.mjs", "ui/chunk.mjs"],
  };
  previewCalls = 0;
  readonly confirmations: DesktopLocalPluginSourceConfirmation[] = [];
  readonly cancellations: Readonly<{ previewId: string }>[] = [];
  readonly listeners = new Set<() => void>();
  onPreview: () => Promise<DesktopLocalPluginSourcePreview | null> = async () =>
    this.preview;
  onConfirm: (
    command: DesktopLocalPluginSourceConfirmation,
  ) => Promise<DesktopLocalPluginSourceConfirmed> = async (command) =>
    this.confirmed(command);
  confirmed(
    command: DesktopLocalPluginSourceConfirmation,
    runtimeStatus: DesktopLocalPluginSourceConfirmed["runtimeStatus"] = "ready",
  ): DesktopLocalPluginSourceConfirmed {
    return {
      sourceId: "native-source-1",
      pluginId: command.pluginId,
      publisherId: command.publisherId,
      version: command.version,
      packageDigest: command.packageDigest,
      restartRequired: runtimeStatus === "restartRequired",
      runtimeStatus,
    };
  }
  readonly client: DesktopLocalPluginSourceImportClient = {
    version: 1,
    previewDirectory: async () => {
      this.previewCalls++;
      return this.onPreview();
    },
    confirmPreview: async (command) => {
      this.confirmations.push(structuredClone(command));
      return this.onConfirm(command);
    },
    cancelPreview: async (command) => {
      this.cancellations.push({ ...command });
    },
    subscribeOwnerChanged: (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };
  ownerChanged() {
    for (const listener of this.listeners) listener();
  }
}

describe("original Settings local import with an explicit named Native capability", () => {
  let root: Root;
  let container: HTMLDivElement;
  let f: NativeImportFixture;
  let oldStyle: string | null;
  let oldClass: string | null;
  let oldTheme: string | null;
  beforeEach(() => {
    f = new NativeImportFixture();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    oldStyle = document.documentElement.getAttribute("style");
    oldClass = document.documentElement.getAttribute("class");
    oldTheme = document.documentElement.getAttribute("data-theme");
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await settleSettings();
    });
    container.remove();
    expect(document.documentElement.getAttribute("style")).toBe(oldStyle);
    expect(document.documentElement.getAttribute("class")).toBe(oldClass);
    expect(document.documentElement.getAttribute("data-theme")).toBe(oldTheme);
    expect(f.listeners.size).toBe(0);
  });
  async function render({
    fixture = f,
    ownerKey = "native-generation-1",
    locale = "zh" as "zh" | "en",
  } = {}) {
    await act(async () => {
      root.render(
        <InstalledPluginSettingsLocalImport
          client={fixture.client}
          ownerKey={ownerKey}
          locale={locale}
        />,
      );
      await settleSettings();
    });
  }
  function button(label: string): HTMLButtonElement {
    const found = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (item) =>
        item.getAttribute("aria-label") === label || item.textContent === label,
    );
    if (!found) throw new Error(`missing_local_import_button:${label}`);
    return found;
  }
  async function click(label: string) {
    expect(button(label).disabled).toBe(false);
    await act(async () => {
      button(label).click();
      await settleSettings();
    });
  }
  async function check(label: string, selected = true) {
    const found = [...container.querySelectorAll("label")].find(
      (item) => item.textContent?.trim() === label,
    );
    const input = found?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!input) throw new Error(`missing_local_import_checkbox:${label}`);
    expect(input.disabled).toBe(false);
    await act(async () => {
      if (input.checked !== selected) input.click();
      await settleSettings();
    });
    expect(input.checked).toBe(selected);
  }
  function preview(): HTMLElement {
    const found = container.querySelector<HTMLElement>(
      'article[aria-label="本地插件预览"]',
    );
    if (!found) throw new Error("missing_local_import_preview");
    return found;
  }
  async function chooseNode() {
    await click(CHOOSE);
    await check(NODE_TRUST);
  }
  const text = () => container.textContent ?? "";

  it("previews without any catalog client or provider and preserves original scoped styling", async () => {
    await render();
    expect(f.previewCalls).toBe(0);
    await click(CHOOSE);
    expect(f.previewCalls).toBe(1);
    expect(f.confirmations).toHaveLength(0);
    expect(button(CONFIRM).disabled).toBe(true);
    const card = preview();
    expect({
      rootClass: container.firstElementChild?.className,
      cardClass: card.className,
      title: card.querySelector("h4")?.textContent,
      metadata: [...card.querySelectorAll(":scope > p")].map(
        (item) => item.textContent,
      ),
      assets: [
        ...card.querySelectorAll('section[aria-label="公开界面资源"] label'),
      ].map((label) => ({
        label: label.textContent?.trim(),
        selected: label.querySelector<HTMLInputElement>("input")?.checked,
      })),
      confirmDisabled: button(CONFIRM).disabled,
      closeDisabled: button(CLOSE).disabled,
    }).toMatchInlineSnapshot(`
      {
        "assets": [
          {
            "label": "ui/entry.mjs（界面入口）",
            "selected": false,
          },
          {
            "label": "ui/chunk.mjs",
            "selected": false,
          },
        ],
        "cardClass": "installed-plugin-card",
        "closeDisabled": false,
        "confirmDisabled": true,
        "metadata": [
          "具名 Native 协议夹具，不代表实际磁盘导入。",
          "插件：fixture.independent-plugin",
          "发布者（包内声明）：fixture.approved-publisher",
          "版本：1.0.0",
          "完整摘要：sha256:0000000000000000000000000000000000000000000000000000000000000001",
          "文件数：4 · 512 bytes",
          "Node 入口：node.mjs",
          "添加来源不会安装或启用插件，也不会授予业务调用或计费权限。",
          "确认添加会重启本机运行环境，正在运行的任务可能中断。",
        ],
        "rootClass": "installed-plugin-settings",
        "title": "仓外独立包",
      }
    `);
    expect(text()).not.toContain("node.mjs（界面入口）");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      3,
    );
  });

  it("requires separate human Node and UI trust and submits only the exact identity and selected assets", async () => {
    await render();
    await chooseNode();
    expect(button(CONFIRM).disabled).toBe(false);
    await check("ui/chunk.mjs");
    expect(button(CONFIRM).disabled).toBe(true);
    expect(text()).toContain("公开界面资源必须包含界面入口");
    await check("ui/entry.mjs（界面入口）");
    expect(button(CONFIRM).disabled).toBe(true);
    await check(UI_TRUST);
    const pending = settingsDeferred<DesktopLocalPluginSourceConfirmed>();
    f.onConfirm = () => pending.promise;
    await click(CONFIRM);
    await act(async () => {
      button(CONFIRM).click();
      await settleSettings();
    });
    expect(f.confirmations).toEqual([
      {
        previewId: f.preview.previewId,
        pluginId: f.preview.pluginId,
        publisherId: f.preview.publisherId,
        version: f.preview.version,
        packageDigest: f.preview.packageDigest,
        publicAssets: ["ui/entry.mjs", "ui/chunk.mjs"],
        trustNodeExecution: true,
        trustUiModule: true,
      },
    ]);
    expect(button(CHOOSE).disabled).toBe(true);
    expect(button(CLOSE).disabled).toBe(true);
    await act(async () => {
      pending.resolve(f.confirmed(f.confirmations[0]!));
      await settleSettings();
    });
    expect(text()).toContain("来源已添加");
    expect(container.querySelector("article")).toBeNull();
    expect(f.cancellations).toHaveLength(0);
    expect(text()).not.toContain("已安装");
    expect(text()).not.toContain("已启用");
  });

  it("can register a source without publishing UI assets and leaves install/enable as original explicit actions", async () => {
    await render();
    await chooseNode();
    await click(CONFIRM);
    expect(f.confirmations[0]).toMatchObject({
      publicAssets: [],
      trustNodeExecution: true,
      trustUiModule: false,
    });
    const installation = new SettingsFetchFixture();
    installation.sources = [
      { ...settingsSource(), sourceId: "native-source-1" },
    ];
    installation.onMutation = () => {
      installation.selections = [settingsSelection()];
      return settingsInstallReceipt(1, installation.selections[0]!);
    };
    await act(async () => {
      root.render(
        <InstalledPluginSettings
          client={installation.client.plugins}
          locale="zh"
        />,
      );
      await settleSettings();
    });
    expect(installation.mutations).toHaveLength(0);
    expect(text()).not.toContain(CHOOSE);
    await click("安装 独立插件 1.0.0");
    expect(installation.mutations).toHaveLength(1);
    expect(installation.mutations[0]?.body).toMatchObject({
      sourceId: "native-source-1",
      expectedSelectionRevision: null,
    });
    expect(text()).toContain("已停用");
    expect(button("启用").disabled).toBe(false);
    expect(text()).not.toContain("已启用");
  });

  it("does not confirm a canceled native dialog and prevents duplicate previews while it is pending", async () => {
    const pending = settingsDeferred<DesktopLocalPluginSourcePreview | null>();
    f.onPreview = () => pending.promise;
    await render();
    await click(CHOOSE);
    await act(async () => {
      button(CHOOSE).click();
      await settleSettings();
    });
    expect(f.previewCalls).toBe(1);
    await act(async () => {
      pending.resolve(null);
      await settleSettings();
    });
    expect(container.querySelector("article")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(f.confirmations).toHaveLength(0);
    expect(f.cancellations).toHaveLength(0);
    expect(button(CHOOSE).disabled).toBe(false);
  });

  it("closes a preview by its opaque ID and requires fresh explicit trust when choosing again", async () => {
    await render();
    await chooseNode();
    await click(CLOSE);
    expect(f.cancellations).toEqual([{ previewId: "named-preview-1" }]);
    expect(f.confirmations).toHaveLength(0);
    await click(CHOOSE);
    expect(button(CONFIRM).disabled).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLInputElement>("input")].every(
        (input) => !input.checked,
      ),
    ).toBe(true);
  });

  it.each(["account", "native"] as const)(
    "withdraws a visible preview on %s replacement and cannot confirm it",
    async (cause) => {
      await render();
      await chooseNode();
      await act(async () => {
        if (cause === "native") f.ownerChanged();
        else
          window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
        await settleSettings();
      });
      expect(container.querySelector("article")).toBeNull();
      expect(f.cancellations).toEqual([{ previewId: "named-preview-1" }]);
      expect(button(CHOOSE).disabled).toBe(true);
      expect(f.confirmations).toHaveLength(0);
      await render({ ownerKey: "native-generation-2" });
      expect(button(CHOOSE).disabled).toBe(false);
      expect(text()).not.toContain("会话已变化");
    },
  );

  it.each(["account", "native", "close"] as const)(
    "ignores and discards a late preview after %s withdrawal",
    async (cause) => {
      const pending =
        settingsDeferred<DesktopLocalPluginSourcePreview | null>();
      f.onPreview = () => pending.promise;
      await render();
      await click(CHOOSE);
      await act(async () => {
        if (cause === "close") root.render(<p>已离开设置</p>);
        else if (cause === "native") f.ownerChanged();
        else
          window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
        await settleSettings();
        pending.resolve(f.preview);
        await settleSettings();
      });
      expect(container.querySelector("article")).toBeNull();
      expect(f.cancellations).toEqual([{ previewId: "named-preview-1" }]);
      expect(f.confirmations).toHaveLength(0);
      if (cause === "close") expect(text()).toBe("已离开设置");
    },
  );

  it("keeps a replacement client's preview when the old client's preview arrives late", async () => {
    const pending = settingsDeferred<DesktopLocalPluginSourcePreview | null>();
    f.onPreview = () => pending.promise;
    await render();
    await click(CHOOSE);
    const replacement = new NativeImportFixture();
    replacement.preview = {
      ...replacement.preview,
      previewId: "new-owner-preview",
      title: "新会话预览",
    };
    await render({ fixture: replacement, ownerKey: "native-generation-2" });
    await click(CHOOSE);
    await act(async () => {
      pending.resolve(f.preview);
      await settleSettings();
    });
    expect(text()).toContain("新会话预览");
    expect(text()).not.toContain("仓外独立包");
    expect(f.cancellations).toEqual([{ previewId: "named-preview-1" }]);
    expect(replacement.cancellations).toHaveLength(0);
    await act(async () => {
      root.render(<p>已离开设置</p>);
      await settleSettings();
    });
    expect(replacement.listeners.size).toBe(0);
  });

  it.each(["account", "close", "client"] as const)(
    "never publishes late confirmation feedback after %s withdrawal",
    async (cause) => {
      const pending = settingsDeferred<DesktopLocalPluginSourceConfirmed>();
      f.onConfirm = () => pending.promise;
      await render();
      await chooseNode();
      await click(CONFIRM);
      if (cause === "client")
        await render({
          fixture: new NativeImportFixture(),
          ownerKey: "native-generation-2",
        });
      else
        await act(async () => {
          if (cause === "close") root.render(<p>已离开设置</p>);
          else
            window.dispatchEvent(
              new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT),
            );
          await settleSettings();
        });
      await act(async () => {
        pending.resolve(f.confirmed(f.confirmations[0]!));
        await settleSettings();
      });
      expect(text()).not.toContain("来源已添加");
      expect(text()).not.toContain("添加结果未确认");
      expect(f.confirmations).toHaveLength(1);
      expect(f.cancellations).toEqual([{ previewId: "named-preview-1" }]);
    },
  );

  it("does not misreport a late confirmation across the actual owner-change notification", async () => {
    const pending = settingsDeferred<DesktopLocalPluginSourceConfirmed>();
    f.onConfirm = () => pending.promise;
    await render();
    await chooseNode();
    await click(CONFIRM);
    await act(async () => {
      f.ownerChanged();
      await settleSettings();
    });
    expect(text()).toContain("本机会话正在切换");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("article")).toBeNull();
    await render({ ownerKey: "native-generation-2" });
    await act(async () => {
      pending.resolve(f.confirmed(f.confirmations[0]!));
      await settleSettings();
    });
    expect(text()).not.toContain("添加结果未确认");
    expect(text()).not.toContain("来源已添加");
    expect(f.confirmations).toHaveLength(1);
    expect(button(CHOOSE).disabled).toBe(false);
  });

  it("clears an unknown confirmation without replay, automatic trust or leaking native error details", async () => {
    f.onConfirm = async () => {
      throw new Error("/private/secret-path token=secret");
    };
    await render();
    await chooseNode();
    await click(CONFIRM);
    expect(text()).toContain("添加结果未确认");
    expect(text()).not.toContain("secret");
    expect(container.querySelector("article")).toBeNull();
    expect(f.confirmations).toHaveLength(1);
    await click(CHOOSE);
    expect(button(CONFIRM).disabled).toBe(true);
    expect(f.confirmations).toHaveLength(1);
    expect(f.previewCalls).toBe(2);
  });

  it("shows saved source and required restart without claiming current runtime readiness", async () => {
    f.onConfirm = async (command) => f.confirmed(command, "restartRequired");
    await render();
    await chooseNode();
    await click(CONFIRM);
    expect(text()).toContain("来源已保存。请重启 CrewON 后安装");
    expect(text()).not.toContain("已启用");
    expect(f.confirmations).toHaveLength(1);
  });

  it("supports a UI-only source without inventing Node consent and keeps unsupported UI modes unpublished", async () => {
    f.preview = {
      ...f.preview,
      nodeEntry: null,
      uiEntry: { path: "ui/entry.mjs", mode: "isolatedWeb" },
    };
    await render({ locale: "en" });
    await click("Choose a local plugin directory");
    expect(text()).toContain("This UI mode cannot be loaded yet");
    expect(container.querySelectorAll("input")).toHaveLength(0);
    await click("Trust and add source");
    expect(f.confirmations[0]).toMatchObject({
      publicAssets: [],
      trustNodeExecution: false,
      trustUiModule: false,
    });
    expect(text()).toContain("Source added");
  });

  it("publishes a UI-only package only after selecting its entry and explicitly trusting its renderer code", async () => {
    f.preview = { ...f.preview, nodeEntry: null };
    await render();
    await click(CHOOSE);
    expect(text()).not.toContain(NODE_TRUST);
    await check("ui/entry.mjs（界面入口）");
    expect(button(CONFIRM).disabled).toBe(true);
    await check(UI_TRUST);
    await check("ui/entry.mjs（界面入口）", false);
    await check("ui/entry.mjs（界面入口）");
    expect(button(CONFIRM).disabled).toBe(true);
    await check(UI_TRUST);
    await click(CONFIRM);
    expect(f.confirmations[0]).toMatchObject({
      publicAssets: ["ui/entry.mjs"],
      trustNodeExecution: false,
      trustUiModule: true,
    });
  });
});
