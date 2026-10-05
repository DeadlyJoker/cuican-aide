// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopLocalPluginExecutionPreview,
  DesktopLocalPluginExecutionResult,
} from "../../lib/desktop/desktopLocalPluginExecutionSetupProtocol";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../../lib/agent-platform/agentPlatformClient";
import {
  clearLocalPluginExecutionSetupTicket,
  currentLocalPluginExecutionSetupPluginId,
  localPluginExecutionSetupTicket,
  registerLocalPluginExecutionSetupShell,
  retainLocalPluginExecutionSetupTicket,
} from "../../lib/plugins/localPluginExecutionSetupRecovery";
import { InstalledPluginExecutionSetup } from "./InstalledPluginExecutionSetup";
import { InstalledPluginConfigurationPanel } from "./InstalledPluginConfigurationPanel";
import { InstalledPluginSettings } from "./InstalledPluginSettings";
import { ConfigurationPanelFetchFixture } from "./InstalledPluginConfigurationPanel.test-support";
import {
  settingsDeferred,
  settingsPackage,
  settingsSelection,
  settleSettings,
} from "./InstalledPluginSettings.test-support";
import {
  ExecutionSetupFixture,
  executionTestIdentity,
  executionTestParameters,
  historicalQueryPreview,
} from "./InstalledPluginExecutionSetup.test-support";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let fixtures: ExecutionSetupFixture[];
let globalStyle: string | null;
let globalClass: string;
beforeEach(() => {
  fixtures = [];
  globalStyle = document.documentElement.getAttribute("style");
  globalClass = document.documentElement.className;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    await settleSettings();
  });
  for (const fixture of fixtures)
    clearLocalPluginExecutionSetupTicket(fixture.access);
  container.remove();
  expect(document.documentElement.getAttribute("style")).toBe(globalStyle);
  expect(document.documentElement.className).toBe(globalClass);
  vi.useRealTimers();
});
function fixture(identity = executionTestIdentity) {
  const value = new ExecutionSetupFixture(identity);
  fixtures.push(value);
  return value;
}
async function mount(
  f: ExecutionSetupFixture,
  disabled = false,
  locale: "zh" | "en" = "zh",
  identity = f.identity,
  ownerKey = f.access.ownerKey,
) {
  await act(async () => {
    root.render(
      <InstalledPluginExecutionSetup
        access={{ client: f.client, ownerKey }}
        identity={identity}
        parameters={executionTestParameters}
        disabled={disabled}
        locale={locale}
      />,
    );
    await settleSettings();
  });
}
function button(text: string) {
  const element = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  expect(element, text).toBeDefined();
  return element!;
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
    await settleSettings();
  });
}
async function consent() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    await settleSettings();
  });
}
async function choose(f: ExecutionSetupFixture) {
  await mount(f);
  await click("预览执行准备");
  await consent();
}
async function remount(f: ExecutionSetupFixture) {
  await act(async () => {
    root.unmount();
    await settleSettings();
  });
  root = createRoot(container);
  await mount(f);
}
function configurationFixture() {
  const f = new ConfigurationPanelFetchFixture();
  f.selection = {
    ...settingsSelection(7, "disabled", 12),
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
  };
  f.package = {
    ...settingsPackage(12),
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
  };
  f.schema = {
    type: "object",
    required: ["baseUrl", "preset"],
    additionalProperties: false,
    properties: {
      baseUrl: { type: "string", maxLength: 2048, enum: null },
      preset: {
        type: "string",
        maxLength: 64,
        enum: ["krea2-portrait", "krea2-character-three-view"],
      },
    },
  };
  f.configuration = f.saved(executionTestParameters, 3);
  const value = f.configuration;
  const execution = fixture({
    pluginId: f.selection.pluginId,
    publisherId: f.selection.publisherId,
    version: f.package.version,
    packageDigest: f.package.packageDigest,
    manifestDigest: value.manifestDigest,
    implementationDigest: value.implementationDigest,
    selectionRevision: f.selection.revision,
    configurationRevision: value.revision,
    configurationDigest: value.contentDigest,
  });
  return { configuration: f, execution };
}

describe("explicit Native execution setup in original settings", () => {
  it("an unavailable optional historical target leaves self preparation available without a historical approval flag", async () => {
    const f = fixture();
    f.onPreview = async () => ({
      ...f.preview(),
      historyQueryAvailability: "unavailable",
    });
    await choose(f);
    expect(container.textContent).toContain("历史图片查询不可用");
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(button("允许并准备").disabled).toBe(false);
    await click("允许并准备");
    expect(f.client.confirm).toHaveBeenCalledExactlyOnceWith({
      previewId: "named-execution-preview",
      approveExecution: true,
    });
  });
  it("requires separate explicit GET-only historical target consent and sends the exact opt-in confirmation", async () => {
    const f = fixture();
    f.onPreview = async () => ({
      ...f.preview(),
      historyQueryAvailability: "available",
      historyQuery: historicalQueryPreview(f.identity),
    });
    await choose(f);
    expect(container.textContent).toContain("crewon.comfyui-krea2 · 1.0.0");
    expect(button("允许并准备").disabled).toBe(true);
    expect(f.client.confirm).not.toHaveBeenCalled();
    expect(
      [...container.querySelectorAll("label")].map((item) => item.textContent),
    ).toMatchSnapshot();
    await act(async () => {
      container
        .querySelectorAll<HTMLButtonElement>('[role="switch"]')[1]!
        .click();
      await settleSettings();
    });
    expect(button("允许并准备").disabled).toBe(false);
    await click("允许并准备");
    expect(f.client.confirm).toHaveBeenCalledExactlyOnceWith({
      previewId: "named-execution-preview",
      approveExecution: true,
      approveHistoricalQueries: true,
    });
  });
  it("a malformed historical preview cannot expose a consent control or confirm authority", async () => {
    const f = fixture();
    f.onPreview = async () =>
      ({
        ...f.preview(),
        historyQueryAvailability: "available",
        historyQuery: { ...historicalQueryPreview(), methods: ["POST"] },
      }) as unknown as DesktopLocalPluginExecutionPreview;
    await mount(f);
    await click("预览执行准备");
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(f.client.confirm).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("previews real public pins with an original inline Switch and only confirms after explicit consent", async () => {
    const f = fixture();
    await mount(f);
    expect(f.client.preview).not.toHaveBeenCalled();
    expect(f.client.confirm).not.toHaveBeenCalled();
    await click("预览执行准备");
    expect(f.client.preview).toHaveBeenCalledWith({
      pluginId: "crewon.short-drama",
    });
    expect(button("允许并准备").disabled).toBe(true);
    expect(container.querySelector('[data-slot="switch"]')).not.toBeNull();
    expect({
      rootClass: container.firstElementChild?.className,
      metadata: [...container.querySelectorAll(":scope > section > p")].map(
        (item) => item.textContent,
      ),
      consentLabel: container.querySelector("label")?.textContent,
      switchChecked: container
        .querySelector('[role="switch"]')
        ?.getAttribute("aria-checked"),
      confirmDisabled: button("允许并准备").disabled,
    }).toMatchSnapshot();
    await consent();
    await click("允许并准备");
    expect(f.client.confirm).toHaveBeenCalledExactlyOnceWith({
      previewId: "named-execution-preview",
      approveExecution: true,
    });
    expect(container.textContent).toContain("执行环境已准备；");
    expect(container.textContent).toContain("服务连通与出图仍需实际任务验证");
    expect(container.textContent).not.toContain("生成服务已可用");
    expect(f.client.cancel).not.toHaveBeenCalled();
    expect(localPluginExecutionSetupTicket(f.access)?.preview).toMatchObject({
      ...f.identity,
      ...executionTestParameters,
    });
  });

  it("keeps preparation separate from current enablement and shows a committed restart requirement accurately", async () => {
    const f = fixture();
    f.onConfirm = async () => ({
      ...f.identity,
      state: "restartRequired",
      runtimeStatus: "restartRequired",
      stage: "policyCommitted",
    });
    await choose(f);
    await click("允许并准备");
    expect(container.textContent).toContain("执行批准已保存");
    expect(container.textContent).toContain("插件启用状态保持原选择");
    expect(container.textContent).toContain("尚未提交生成");
    expect(container.textContent).not.toContain("执行环境已准备；");
  });

  it("locks preparation during dirty or pending configuration and cancels its unclaimed preview", async () => {
    const f = fixture();
    await mount(f, true);
    expect(button("预览执行准备").disabled).toBe(true);
    await click("预览执行准备");
    expect(f.client.preview).not.toHaveBeenCalled();
    await mount(f);
    await click("预览执行准备");
    await mount(f, true);
    expect(f.client.cancel).toHaveBeenCalledExactlyOnceWith({
      previewId: "named-execution-preview",
    });
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(f.client.confirm).not.toHaveBeenCalled();
  });

  it("withdraws a preview after its deadline and does not submit expired consent", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.onPreview = async () => ({ ...f.preview(), expiresAt: Date.now() + 100 });
    await choose(f);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(101);
      await settleSettings();
    });
    expect(container.textContent).toContain("预览已过期");
    expect(f.client.cancel).toHaveBeenCalledOnce();
    expect(f.client.confirm).not.toHaveBeenCalled();
  });

  it("rejects foreign package/configuration replies and does not evaluate an accessor", async () => {
    const f = fixture();
    f.onPreview = async () => ({ ...f.preview(), configurationRevision: 99 });
    await mount(f);
    await click("预览执行准备");
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(f.client.confirm).not.toHaveBeenCalled();
    let getterCalls = 0;
    const malformed = { ...f.preview() };
    Object.defineProperty(malformed, "baseUrl", {
      enumerable: true,
      get() {
        getterCalls++;
        return "secret";
      },
    });
    f.onPreview = async () => malformed;
    await click("预览执行准备");
    expect(getterCalls).toBe(0);
    expect(container.textContent).not.toContain("secret");
    expect(f.client.confirm).not.toHaveBeenCalled();
  });

  it("cancels a late unclaimed preview after selection or configuration pins change", async () => {
    const f = fixture();
    const pending = settingsDeferred<DesktopLocalPluginExecutionPreview>();
    f.onPreview = () => pending.promise;
    await mount(f);
    await click("预览执行准备");
    await mount(f, false, "zh", {
      ...f.identity,
      selectionRevision: 8,
      configurationRevision: 4,
    });
    await act(async () => {
      pending.resolve(f.preview());
      await settleSettings();
    });
    expect(f.client.cancel).toHaveBeenCalledExactlyOnceWith({
      previewId: "named-execution-preview",
    });
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(f.client.confirm).not.toHaveBeenCalled();
  });

  it("reads an unknown confirmation's original pending receipt and never sends a second confirmation", async () => {
    const f = fixture();
    f.onConfirm = async () => {
      f.status = {
        previewId: "named-execution-preview",
        pluginId: f.identity.pluginId,
        state: "pending",
      };
      throw new Error("fixture-transport-error-containing-private-data");
    };
    await choose(f);
    await click("允许并准备");
    expect(container.textContent).toContain("请等待原准备结果");
    expect(container.textContent).not.toContain("private-data");
    expect(button("预览执行准备").disabled).toBe(true);
    await click("重新读取准备状态");
    expect(f.client.confirm).toHaveBeenCalledOnce();
    await act(async () => {
      f.status = f.committed();
      f.emitStatus();
      await settleSettings();
    });
    expect(container.textContent).toContain("执行环境已准备；");
    expect(f.client.confirm).toHaveBeenCalledOnce();
  });

  it("recovers across real tree unmounts and retains only the public ticket without cancelling a claimed confirmation", async () => {
    const f = fixture();
    const initialShell = Symbol("initial-shell");
    registerLocalPluginExecutionSetupShell(f.access, initialShell);
    const pending = settingsDeferred<DesktopLocalPluginExecutionResult>();
    f.onConfirm = () => {
      f.status = {
        previewId: "named-execution-preview",
        pluginId: f.identity.pluginId,
        state: "pending",
      };
      return pending.promise;
    };
    await choose(f);
    await click("允许并准备");
    expect(
      registerLocalPluginExecutionSetupShell(f.access, Symbol("restart-shell")),
    ).toBe("crewon.short-drama");
    await remount(f);
    expect(container.textContent).toContain("请等待原准备结果");
    expect(f.client.cancel).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve(f.result());
      f.status = f.committed();
      f.emitStatus();
      await settleSettings();
    });
    expect(container.textContent).toContain("执行环境已准备；");
    expect(
      registerLocalPluginExecutionSetupShell(
        f.access,
        Symbol("second-restart-shell"),
      ),
    ).toBe("crewon.short-drama");
    await remount(f);
    expect(container.textContent).toContain("执行环境已准备；");
    expect(f.client.confirm).toHaveBeenCalledOnce();
    expect(f.client.cancel).not.toHaveBeenCalled();
    await click("关闭准备结果");
    expect(currentLocalPluginExecutionSetupPluginId(f.access)).toBeNull();
  });

  it.each(["owner", "account"] as const)(
    "withdraws %s before a late confirmation without cancelling the Main-owned intent",
    async (kind) => {
      const f = fixture();
      const pending = settingsDeferred<DesktopLocalPluginExecutionResult>();
      f.onConfirm = () => pending.promise;
      await choose(f);
      await click("允许并准备");
      await act(async () => {
        if (kind === "owner") f.emitOwner();
        else
          window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
        pending.resolve(f.result());
        await settleSettings();
      });
      expect(currentLocalPluginExecutionSetupPluginId(f.access)).toBeNull();
      expect(container.textContent).toContain("会话已变化");
      expect(container.textContent).not.toContain("执行环境已准备；");
      expect(f.client.cancel).not.toHaveBeenCalled();
    },
  );

  it("reports a partial committed policy failure without claiming rollback or enabling execution", async () => {
    const f = fixture();
    f.onConfirm = async () => {
      f.status = {
        previewId: "named-execution-preview",
        pluginId: f.identity.pluginId,
        state: "failed",
        code: "desktop_plugin_execution_setup_failed",
        policyCommitted: true,
      };
      throw new Error("named-failure-after-policy-commit");
    };
    await choose(f);
    await click("允许并准备");
    expect(container.textContent).toContain("执行批准已保存，但准备未完成");
    expect(container.textContent).not.toContain("执行环境已准备；");
    expect(f.client.confirm).toHaveBeenCalledOnce();
  });

  it("rejects a foreign successful confirmation and keeps readback available", async () => {
    const f = fixture();
    f.onConfirm = async () => ({
      ...f.result(),
      packageDigest: `sha256:${"f".repeat(64)}`,
    });
    await choose(f);
    await click("允许并准备");
    expect(container.textContent).toContain("准备结果尚未确认");
    expect(container.textContent).not.toContain("执行环境已准备；");
    expect(f.client.confirm).toHaveBeenCalledOnce();
  });

  it("uses English for setup and consent while preserving the original presentation", async () => {
    const f = fixture();
    await mount(f, false, "en");
    await click("Preview execution setup");
    expect(container.textContent).toContain("Generation service:");
    expect(container.textContent).toContain("execute Node code locally");
    expect(button("Allow and prepare").disabled).toBe(true);
    await consent();
    await click("Allow and prepare");
    expect(container.textContent).toContain(
      "Execution environment prepared; the plugin's enabled state keeps its original selection.",
    );
  });

  it("only adds setup to Short with a current saved configuration and prevents dirty parameters from being approved", async () => {
    const { configuration: f, execution } = configurationFixture();
    const render = async () => {
      await act(async () => {
        root.render(
          <InstalledPluginConfigurationPanel
            client={f.client}
            selection={f.selection}
            executionSetup={execution.access}
            locale="zh"
          />,
        );
        await settleSettings();
      });
    };
    f.configuration = null;
    await render();
    expect(container.querySelector('[aria-label="本机执行准备"]')).toBeNull();
    f.configuration = f.saved(executionTestParameters, 3);
    await click("重新读取");
    expect(button("预览执行准备").disabled).toBe(false);
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="baseUrl"]',
      )!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "https://another-service.test/");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settleSettings();
    });
    expect(button("预览执行准备").disabled).toBe(true);
    expect(execution.client.preview).not.toHaveBeenCalled();
    expect(f.mutations).toHaveLength(0);
  });

  it("opens the original configuration panel after a submitted preparation remount and only reads Main's committed status", async () => {
    const { configuration: f, execution } = configurationFixture();
    registerLocalPluginExecutionSetupShell(
      execution.access,
      Symbol("before-submit"),
    );
    retainLocalPluginExecutionSetupTicket(
      execution.access,
      execution.preview(),
    );
    execution.status = execution.committed();
    f.onRead = (request) => {
      if (request.path === "/api/v1/plugins/sources")
        return Response.json({ sources: [], next: null });
      if (request.path === "/api/v1/plugins/selections")
        return Response.json({ selections: [f.selection], next: null });
      if (request.path === "/api/v1/plugins/packages")
        return Response.json({ packages: [f.package], next: null });
    };
    await act(async () => {
      root.render(
        <InstalledPluginSettings
          client={f.client.plugins}
          configurationClient={f.client}
          executionSetup={execution.access}
          locale="zh"
        />,
      );
      await settleSettings();
    });
    expect(
      container.querySelector('[aria-label="插件参数配置"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("执行环境已准备；");
    expect(execution.client.confirm).not.toHaveBeenCalled();
    expect(execution.client.preview).not.toHaveBeenCalled();
    expect(f.mutations).toHaveLength(0);
  });

  it("locks original configuration editing while a claimed execution preparation is physically pending", async () => {
    const { configuration: f, execution } = configurationFixture();
    const pending = settingsDeferred<DesktopLocalPluginExecutionResult>();
    execution.onConfirm = () => pending.promise;
    await act(async () => {
      root.render(
        <InstalledPluginConfigurationPanel
          client={f.client}
          selection={f.selection}
          executionSetup={execution.access}
          locale="zh"
        />,
      );
      await settleSettings();
    });
    await click("预览执行准备");
    await consent();
    await click("允许并准备");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="baseUrl"]')!
        .disabled,
    ).toBe(true);
    expect(button("保存参数").disabled).toBe(true);
    expect(button("重新读取").disabled).toBe(true);
    await act(async () => {
      pending.resolve(execution.result());
      await settleSettings();
    });
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="baseUrl"]')!
        .disabled,
    ).toBe(false);
    expect(f.mutations).toHaveLength(0);
  });
});
