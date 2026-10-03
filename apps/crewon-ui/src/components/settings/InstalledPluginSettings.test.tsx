// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectPluginPackageRequest } from "@crewon/contracts";
import { InstalledPluginSettings } from "./InstalledPluginSettings";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../../lib/agent-platform/agentPlatformClient";
import {
  SETTINGS_PLUGIN_ID,
  SettingsFetchFixture,
  settingsDeferred,
  settingsHttpError,
  settingsInstallReceipt,
  settingsPackage,
  settingsSelection,
  settingsSelectionReceipt,
  settingsSource,
  settleSettings,
} from "./InstalledPluginSettings.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
  async function render(fixture = f) {
    await act(async () => {
      root.render(
        <InstalledPluginSettings client={fixture.client.plugins} locale="zh" />,
      );
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
  function section(label: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      `section[aria-label="${label}"]`,
    );
    if (!element) throw new Error(`missing_settings_section:${label}`);
    return element;
  }
  function button(
    label: string,
    scope: ParentNode = container,
  ): HTMLButtonElement {
    const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === label ||
        candidate.textContent === label,
    );
    if (!found) throw new Error(`missing_settings_button:${label}`);
    return found;
  }
  async function click(label: string, scope: ParentNode = container) {
    const found = button(label, scope);
    expect(found.disabled).toBe(false);
    await act(async () => {
      found.click();
      await settleSettings();
    });
    await settle();
  }
  function text() {
    return container.textContent ?? "";
  }

  it("installs only the approved source identity, starts disabled and performs explicit enable/disable/uninstall with current CAS", async () => {
    f.onMutation = (request) => {
      if (request.method === "POST") {
        f.packages = [settingsPackage()];
        f.selections = [settingsSelection()];
        return settingsInstallReceipt(1, f.selections[0]!);
      }
      const body = request.body as SelectPluginPackageRequest;
      const next = settingsSelection(
        body.expectedSelectionRevision + 1,
        body.state,
      );
      f.selections = [next];
      return settingsSelectionReceipt(next);
    };
    await render();
    await click("安装 独立插件 1.0.0");
    expect(f.mutations).toHaveLength(1);
    expect(f.mutations[0]!.body).toEqual({
      sourceId: settingsSource().sourceId,
      expectedPluginId: SETTINGS_PLUGIN_ID,
      expectedPackageDigest: settingsPackage().packageDigest,
      expectedSelectionRevision: null,
    });
    expect(Object.keys(f.mutations[0]!.body as object).sort()).toEqual([
      "expectedPackageDigest",
      "expectedPluginId",
      "expectedSelectionRevision",
      "sourceId",
    ]);
    expect(f.mutations[0]!.headers.get("authorization")).toBe(
      "Bearer named-current-actor-token",
    );
    expect(f.mutations[0]!.headers.get("x-csrf-token")).toBe(
      "named-current-csrf-token",
    );
    expect(f.mutations[0]!.headers.get("idempotency-key")).toMatch(
      /^plugin-settings-/,
    );
    expect(text()).toContain("已停用");
    await click("启用");
    expect(text()).toContain("已启用");
    await click("停用");
    expect(text()).toContain("已停用");
    await click("卸载");
    expect(text()).toContain("已卸载");
    expect(f.mutations.slice(1).map((request) => request.body)).toEqual([
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
      new Set(
        f.mutations.map((request) => request.headers.get("idempotency-key")),
      ).size,
    ).toBe(4);
    expect(text()).toContain("卸载保留历史任务和业务数据");
  });

  it("installs an upgrade while preserving the active version until an explicit version selection", async () => {
    f.selections = [settingsSelection(2, "enabled")];
    f.packages = [settingsPackage()];
    f.onMutation = (request) => {
      if (request.method === "POST") {
        f.packages = [settingsPackage(), settingsPackage(2)];
        return settingsInstallReceipt(2, f.selections[0]!);
      }
      f.selections = [settingsSelection(3, "enabled", 2)];
      return settingsSelectionReceipt(f.selections[0]!);
    };
    await render();
    await click("安装 独立插件 2.0.0");
    expect(f.mutations).toHaveLength(1);
    expect(f.mutations[0]!.body).toMatchObject({
      expectedSelectionRevision: 2,
      expectedPackageDigest: settingsPackage(2).packageDigest,
    });
    expect(f.selections[0]!.selectedPackageDigest).toBe(
      settingsPackage().packageDigest,
    );
    await click("管理版本");
    const versions = section("安装版本");
    expect(versions.textContent).toContain("1.0.0 · 当前版本");
    const candidate = [
      ...versions.querySelectorAll(".installed-plugin-version"),
    ].find((row) => row.textContent?.includes("2.0.0"))!;
    await click("使用此版本", candidate);
    expect(f.mutations[1]!.body).toEqual({
      state: "enabled",
      selectedPackageDigest: settingsPackage(2).packageDigest,
      expectedSelectionRevision: 2,
    });
    expect(section("安装版本").textContent).toContain("2.0.0 · 当前版本");
  });

  it("pages installed versions by the authoritative digest cursor and allows returning without unbounded prefetch", async () => {
    f.selections = [settingsSelection()];
    f.packages = Array.from({ length: 12 }, (_, i) => settingsPackage(i + 1));
    await render();
    await click("管理版本");
    expect(
      section("安装版本").querySelectorAll(".installed-plugin-version"),
    ).toHaveLength(10);
    await click("下一页", section("安装版本"));
    expect(
      section("安装版本").querySelectorAll(".installed-plugin-version"),
    ).toHaveLength(2);
    expect(section("安装版本").textContent).toContain("第 2 页");
    await click("上一页", section("安装版本"));
    const calls = f.requests.filter(
      (request) => request.path === "/api/v1/plugins/packages",
    );
    expect(calls).toHaveLength(3);
    expect(calls.map((request) => Object.fromEntries(request.query))).toEqual([
      { pluginId: SETTINGS_PLUGIN_ID, limit: "10" },
      {
        pluginId: SETTINGS_PLUGIN_ID,
        afterPackageDigest: settingsPackage(10).packageDigest,
        limit: "10",
      },
      { pluginId: SETTINGS_PLUGIN_ID, limit: "10" },
    ]);
  });

  it("pages approved sources and current selections independently using bounded authoritative cursors", async () => {
    f.sources = Array.from({ length: 12 }, (_, i) => settingsSource(i + 1));
    f.selections = Array.from({ length: 12 }, (_, i) => ({
      ...settingsSelection(),
      pluginId: `fixture.installed${String(i + 1).padStart(2, "0")}`,
    }));
    await render();
    expect(section("可安装插件").querySelectorAll("article")).toHaveLength(10);
    expect(section("已安装插件").querySelectorAll("article")).toHaveLength(10);
    await click("下一页", section("可安装插件"));
    expect(section("可安装插件").querySelectorAll("article")).toHaveLength(2);
    expect(section("已安装插件").querySelectorAll("article")).toHaveLength(10);
    await click("下一页", section("已安装插件"));
    expect(section("已安装插件").querySelectorAll("article")).toHaveLength(2);
    const sourceCalls = f.requests.filter(
      (request) => request.path === "/api/v1/plugins/sources",
    );
    const selectionCalls = f.requests.filter(
      (request) => request.path === "/api/v1/plugins/selections",
    );
    expect(sourceCalls.at(-1)!.query.get("afterSourceId")).toBe(
      settingsSource(10).sourceId,
    );
    expect(selectionCalls.at(-1)!.query.get("afterPluginId")).toBe(
      "fixture.installed10",
    );
    expect(
      [...sourceCalls, ...selectionCalls].every(
        (request) => request.query.get("limit") === "10",
      ),
    ).toBe(true);
  });

  it("reloads authoritative current state rather than applying an old mutation receipt as the current selection", async () => {
    f.selections = [settingsSelection(2)];
    f.onMutation = () => {
      f.selections = [settingsSelection(4, "disabled")];
      return settingsSelectionReceipt(
        settingsSelection(3, "enabled"),
        "unchanged",
      );
    };
    await render();
    await click("启用");
    expect(text()).toContain("选择已保存");
    expect(text()).toContain("已停用");
    expect(text()).not.toContain("已启用");
    expect(button("启用").disabled).toBe(false);
    expect(
      f.requests.filter(
        (request) => request.path === "/api/v1/plugins/selections",
      ),
    ).toHaveLength(2);
  });

  it("reports committed pending projection without claiming generation readiness", async () => {
    f.selections = [settingsSelection()];
    f.onMutation = () => {
      f.selections = [settingsSelection(2, "enabled")];
      return settingsSelectionReceipt(f.selections[0]!, "pending");
    };
    await render();
    await click("启用");
    expect(text()).toContain("选择已保存，运行状态尚未确认。请刷新检查。");
    expect(text()).toContain("启用状态不代表生成服务已可用");
    expect(section("插件管理").outerHTML).toMatchSnapshot();
  });

  it.each(["network", "500"] as const)(
    "retains the exact key and body after %s unknown outcome, including an intervening refresh",
    async (failure) => {
      f.selections = [settingsSelection(2, "enabled")];
      f.onMutation = () => {
        if (f.mutations.length === 1) {
          f.selections = [settingsSelection(3, "disabled")];
          if (failure === "network")
            throw new TypeError("named_fetch_result_lost");
          return settingsHttpError(500);
        }
        return settingsSelectionReceipt(
          settingsSelection(3, "disabled"),
          "unchanged",
        );
      };
      await render();
      await click("停用");
      expect(text()).toContain("暂时无法确认操作结果");
      expect(button("停用").disabled).toBe(true);
      await click("刷新插件");
      await click("重试上次操作");
      expect(f.mutations).toHaveLength(2);
      expect(f.mutations[1]!.body).toEqual(f.mutations[0]!.body);
      expect(f.mutations[1]!.headers.get("idempotency-key")).toBe(
        f.mutations[0]!.headers.get("idempotency-key"),
      );
      expect(f.mutations[1]!.body).toEqual({
        state: "disabled",
        selectedPackageDigest: settingsPackage().packageDigest,
        expectedSelectionRevision: 2,
      });
      expect(text()).not.toContain("重试上次操作");
      expect(button("启用").disabled).toBe(false);
    },
  );

  it("retries an installation with its original null CAS and key after a lost response without rereading selection", async () => {
    f.onMutation = () => {
      if (f.mutations.length === 1) {
        f.selections = [settingsSelection()];
        f.packages = [settingsPackage()];
        throw new TypeError("named_installation_response_lost");
      }
      return settingsInstallReceipt(1, settingsSelection(), "replayed");
    };
    await render();
    await click("安装 独立插件 1.0.0");
    await click("刷新插件");
    expect(text()).toContain("已停用");
    await click("重试上次操作");
    expect(f.mutations).toHaveLength(2);
    expect(f.mutations[1]!.body).toEqual(f.mutations[0]!.body);
    expect(f.mutations[1]!.headers.get("idempotency-key")).toBe(
      f.mutations[0]!.headers.get("idempotency-key"),
    );
    expect(f.mutations[1]!.body).toMatchObject({
      expectedSelectionRevision: null,
    });
    expect(
      f.requests.filter(
        (request) =>
          request.path === `/api/v1/plugins/selections/${SETTINGS_PLUGIN_ID}`,
      ),
    ).toHaveLength(1);
    expect(f.mutations.some((request) => request.method === "PUT")).toBe(false);
  });

  it("refreshes after a 409, retains the conflict hint and uses the newly read revision for the next intent", async () => {
    f.selections = [settingsSelection(2, "enabled")];
    f.onMutation = (request) => {
      if (f.mutations.length === 1) {
        f.selections = [settingsSelection(5, "disabled")];
        return settingsHttpError(409);
      }
      const command = request.body as SelectPluginPackageRequest;
      f.selections = [
        settingsSelection(command.expectedSelectionRevision + 1, command.state),
      ];
      return settingsSelectionReceipt(f.selections[0]!);
    };
    await render();
    await click("停用");
    expect(text()).toContain("插件状态已变化，已重新读取。请检查后再操作。");
    expect(text()).toContain("已停用");
    expect(text()).not.toContain("重试上次操作");
    await click("启用");
    expect(f.mutations[1]!.body).toMatchObject({
      expectedSelectionRevision: 5,
      state: "enabled",
    });
    expect(f.mutations[1]!.headers.get("idempotency-key")).not.toBe(
      f.mutations[0]!.headers.get("idempotency-key"),
    );
  });

  it("ignores late reads from a replaced client and aborts the old page scope", async () => {
    const oldRead = settingsDeferred<Response>();
    f.onRead = (request) =>
      request.path === "/api/v1/plugins/sources" ? oldRead.promise : undefined;
    await render();
    expect(text()).toContain("正在读取插件");
    const replacement = new SettingsFetchFixture();
    replacement.sources = [{ ...settingsSource(), title: "新账号批准来源" }];
    await render(replacement);
    expect(text()).toContain("新账号批准来源");
    expect(f.requests[0]!.signal?.aborted).toBe(true);
    await act(async () => {
      oldRead.resolve(
        Response.json({
          sources: [{ ...settingsSource(), title: "旧账号晚响应" }],
          next: null,
        }),
      );
      await settleSettings();
    });
    await settle();
    expect(text()).not.toContain("旧账号晚响应");
    expect(text()).toContain("新账号批准来源");
  });

  it("does not publish late mutation feedback or refresh into a replacement client or after leaving", async () => {
    f.selections = [settingsSelection()];
    const pending = settingsDeferred<Response>();
    f.onMutation = () => pending.promise;
    await render();
    await click("启用");
    const replacement = new SettingsFetchFixture();
    await render(replacement);
    const reads = replacement.requests.length;
    expect(f.mutations[0]!.signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(
        settingsSelectionReceipt(settingsSelection(2, "enabled")),
      );
      await settleSettings();
    });
    await settle();
    expect(text()).not.toContain("选择已保存");
    expect(replacement.requests).toHaveLength(reads);
    const late = settingsDeferred<Response>();
    replacement.onRead = (request) =>
      request.path === "/api/v1/plugins/sources" ? late.promise : undefined;
    await click("刷新插件");
    await act(async () => {
      root.render(<p>已离开设置</p>);
      await settleSettings();
    });
    const lastRead = replacement.requests.findLast(
      (request) => request.path === "/api/v1/plugins/sources",
    )!;
    expect(lastRead.signal?.aborted).toBe(true);
    await act(async () => {
      late.resolve(Response.json({ sources: [], next: null }));
      await settleSettings();
    });
    expect(text()).toBe("已离开设置");
  });

  it.each(["read", "mutation"] as const)(
    "withdraws old catalog on a real session event and never reopens it from a late %s result",
    async (operation) => {
      const pending = settingsDeferred<Response>();
      f.selections = [settingsSelection()];
      if (operation === "read")
        f.onRead = (request) =>
          request.path === "/api/v1/plugins/sources"
            ? pending.promise
            : undefined;
      else f.onMutation = () => pending.promise;
      await render();
      if (operation === "mutation") await click("启用");
      await act(async () => {
        window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
        await settleSettings();
      });
      expect(text()).toContain("账号已变化，请重新打开插件设置。");
      expect(
        container.querySelector('section[aria-label="可安装插件"]'),
      ).toBeNull();
      expect(
        container.querySelector('section[aria-label="已安装插件"]'),
      ).toBeNull();
      expect(text()).not.toContain("重试上次操作");
      expect(f.requests.every((request) => request.signal?.aborted)).toBe(true);
      const count = f.requests.length;
      await act(async () => {
        pending.resolve(
          operation === "read"
            ? Response.json({ sources: f.sources, next: null })
            : settingsSelectionReceipt(settingsSelection(2, "enabled")),
        );
        await settleSettings();
      });
      await settle();
      expect(text()).not.toContain("选择已保存");
      expect(
        container.querySelector('section[aria-label="可安装插件"]'),
      ).toBeNull();
      await click("刷新插件");
      expect(f.requests).toHaveLength(count);
      expect(text()).toContain("账号已变化");
    },
  );
});
