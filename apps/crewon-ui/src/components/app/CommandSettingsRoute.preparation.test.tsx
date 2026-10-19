// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandSettingsRoute } from "./CommandSettingsRoute";
import { ExecutionSetupFixture } from "../settings/InstalledPluginExecutionSetup.test-support";
import {
  retainLocalPluginExecutionSetupTicket,
  clearLocalPluginExecutionSetupTicket,
} from "../../lib/plugins/localPluginExecutionSetupRecovery";
import {
  settleSettings,
  settingsDeferred,
} from "../settings/InstalledPluginSettings.test-support";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let f: ExecutionSetupFixture;
let access: { client: ExecutionSetupFixture["client"]; ownerKey: string };
beforeEach(() => {
  f = new ExecutionSetupFixture();
  access = { client: f.client, ownerKey: "named-real-IPC-shape-test-owner" };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  clearLocalPluginExecutionSetupTicket(access);
  container.remove();
});
async function mount() {
  await act(async () => {
    root.render(
      <CommandSettingsRoute
        activeSection="mcp-servers"
        dataMode="disconnected"
        disabled
        locale="zh"
        notice={null}
        platform="mac"
        panel={null}
        executionSetup={access}
        onBack={vi.fn()}
        onDismissNotice={vi.fn()}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
        onPanelFieldCommit={vi.fn()}
        onSectionChange={vi.fn()}
      />,
    );
    await settleSettings();
  });
}
it("shows the original Main preparation receipt while Control restarts, then restores ordinary disconnected feedback", async () => {
  retainLocalPluginExecutionSetupTicket(access, f.preview());
  f.status = {
    previewId: f.preview().previewId,
    pluginId: f.identity.pluginId,
    state: "pending",
  };
  await mount();
  expect(container.textContent).toContain("正在准备插件执行环境");
  expect(container.textContent).not.toContain("设置暂不可用");
  expect(f.client.confirm).not.toHaveBeenCalled();
  await act(async () => {
    f.status = f.committed();
    f.emitStatus();
    await settleSettings();
  });
  expect(container.textContent).not.toContain("正在准备插件执行环境");
  expect(container.textContent).toContain("设置暂不可用");
});
it("ordinary disconnection has no preparation reads without an original ticket", async () => {
  await mount();
  expect(container.textContent).toContain("设置暂不可用");
  expect(f.client.readStatus).not.toHaveBeenCalled();
});
it("withdraws immediately on owner change and ignores its late status reply", async () => {
  retainLocalPluginExecutionSetupTicket(access, f.preview());
  const pending =
    settingsDeferred<Awaited<ReturnType<typeof f.client.readStatus>>>();
  f.onStatus = () => pending.promise;
  await mount();
  await act(async () => {
    f.emitOwner();
    pending.resolve({
      previewId: f.preview().previewId,
      pluginId: f.identity.pluginId,
      state: "pending",
    });
    await settleSettings();
  });
  expect(container.textContent).not.toContain("正在准备插件执行环境");
  expect(container.textContent).toContain("设置暂不可用");
  expect(f.client.confirm).not.toHaveBeenCalled();
});
it("does not conceal disconnection with a receipt from another preview", async () => {
  retainLocalPluginExecutionSetupTicket(access, f.preview());
  f.status = {
    previewId: "foreign-preview",
    pluginId: f.identity.pluginId,
    state: "pending",
  };
  await mount();
  expect(container.textContent).toContain("设置暂不可用");
  expect(container.textContent).not.toContain("正在准备插件执行环境");
});

it("falls back to the disconnected state when Main cannot confirm the pending receipt", async () => {
  retainLocalPluginExecutionSetupTicket(access, f.preview());
  f.status = {
    previewId: f.preview().previewId,
    pluginId: f.identity.pluginId,
    state: "pending",
  };
  await mount();
  expect(container.textContent).toContain("正在准备插件执行环境");
  await act(async () => {
    f.onStatus = async () => {
      throw new Error("native_reply_unavailable");
    };
    f.emitStatus();
    await settleSettings();
  });
  expect(container.textContent).not.toContain("正在准备插件执行环境");
  expect(container.textContent).toContain("设置暂不可用");
  expect(f.client.confirm).not.toHaveBeenCalled();
});
