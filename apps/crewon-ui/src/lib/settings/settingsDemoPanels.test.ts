import { describe, expect, it } from "vitest";

import {
  demoCapabilityActionPanel,
  demoThreadSettingsSavedPanel,
  demoThreadSettingsSavedPatch,
} from "./settingsDemoPanels";

describe("settings demo panels", () => {
  it("builds demo save and refresh panels", () => {
    expect(demoThreadSettingsSavedPatch("en")).toEqual({
      body: "Session settings saved (demo). With app-server connected this calls thread/settings/update.",
      error: undefined,
    });
    expect(
      demoThreadSettingsSavedPanel(
        { title: "Session settings", body: "Ready", error: "old" },
        "zh",
      ),
    ).toEqual({
      title: "Session settings",
      body: "会话设置已保存（演示）。连接 app-server 后会调用 thread/settings/update。",
      error: undefined,
    });

    expect(demoCapabilityActionPanel("save-config", "en")).toMatchObject({
      title: "Config",
      subtitle: "Saved (demo)",
      body: "Config saved to demo state. With app-server connected, this writes config.toml and hot-reloads user config.",
    });
    expect(
      demoCapabilityActionPanel("refresh-appearance", "zh"),
    ).toMatchObject({
      title: "外观",
      subtitle: "已刷新（演示）",
    });
  });

  it("builds worktree and auth demo panels", () => {
    expect(demoCapabilityActionPanel("fork-worktree", "en")).toMatchObject({
      title: "Worktrees",
      subtitle: "Forked (demo)",
    });
    expect(demoCapabilityActionPanel("login-chatgpt", "zh")).toEqual({
      title: "账号",
      subtitle: "演示模式",
      body: "演示模式下不会发起真实登录。启动本地 app-server 后，这里会打开模型账号或设备码登录流程。",
      actions: [
        {
          id: "refresh-account",
          label: "返回账号",
        },
      ],
    });
  });

  it("maps generic demo actions and ignores unknown actions", () => {
    expect(demoCapabilityActionPanel("refresh-keyboard", "en")).toMatchObject({
      title: "Keyboard shortcuts",
    });
    expect(demoCapabilityActionPanel("refresh-connectors", "en")).toMatchObject({
      title: "Browser",
    });
    expect(demoCapabilityActionPanel("unknown-action", "en")).toBeNull();
  });
});
