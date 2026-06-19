import { describe, expect, it } from "vitest";

import {
  demoSettingsSectionForAction,
  isAuthDemoAction,
  refreshSettingsSectionAction,
  settingsRefreshActionForActionId,
  settingsSaveActionForActionId,
  type SettingsSectionRefreshHandlers,
  worktreeDemoAction,
} from "./settingsActions";
import type { SettingsSection } from "./settingsCatalog";

describe("settings action routing", () => {
  it("routes settings sections to refresh handlers", async () => {
    const calls: string[] = [];
    const handlers: SettingsSectionRefreshHandlers = {
      account: () => {
        calls.push("account");
      },
      appearance: () => {
        calls.push("appearance");
      },
      appSnapshots: () => {
        calls.push("appSnapshots");
      },
      browser: () => {
        calls.push("browser");
      },
      computerControl: () => {
        calls.push("computerControl");
      },
      config: () => {
        calls.push("config");
      },
      connections: () => {
        calls.push("connections");
      },
      environment: () => {
        calls.push("environment");
      },
      git: () => {
        calls.push("git");
      },
      hooks: () => {
        calls.push("hooks");
      },
      keyboard: () => {
        calls.push("keyboard");
      },
      mcpServers: () => {
        calls.push("mcpServers");
      },
      personalization: () => {
        calls.push("personalization");
      },
      worktrees: () => {
        calls.push("worktrees");
      },
    };
    const cases: Array<[SettingsSection, keyof SettingsSectionRefreshHandlers]> =
      [
        ["account", "account"],
        ["appearance", "appearance"],
        ["app-snapshots", "appSnapshots"],
        ["browser", "browser"],
        ["computer-control", "computerControl"],
        ["config", "config"],
        ["connections", "connections"],
        ["environment", "environment"],
        ["git", "git"],
        ["hooks", "hooks"],
        ["keyboard", "keyboard"],
        ["mcp-servers", "mcpServers"],
        ["personalization", "personalization"],
        ["worktrees", "worktrees"],
      ];

    for (const [section] of cases) {
      await refreshSettingsSectionAction(section, handlers);
    }

    expect(calls).toEqual(cases.map(([, handler]) => handler));
  });

  it("maps refresh action ids to refresh handlers", () => {
    expect(settingsRefreshActionForActionId("refresh-config")).toBe("config");
    expect(settingsRefreshActionForActionId("refresh-mcp-settings")).toBe(
      "mcpSettings",
    );
    expect(settingsRefreshActionForActionId("refresh-browser-apps")).toBe(
      "browserApps",
    );
    expect(settingsRefreshActionForActionId("refresh-worktrees")).toBe(
      "worktrees",
    );
    expect(settingsRefreshActionForActionId("save-config")).toBeNull();
  });

  it("maps save action ids to save handlers", () => {
    expect(settingsSaveActionForActionId("save-config")).toBe("config");
    expect(settingsSaveActionForActionId("save-appearance")).toBe(
      "appearance",
    );
    expect(settingsSaveActionForActionId("save-personalization")).toBe(
      "personalization",
    );
    expect(settingsSaveActionForActionId("refresh-config")).toBeNull();
  });

  it("maps demo action ids to settings sections", () => {
    expect(demoSettingsSectionForAction("refresh-account")).toBe("account");
    expect(demoSettingsSectionForAction("reload-tools")).toBe("mcp-servers");
    expect(demoSettingsSectionForAction("refresh-environment")).toBe(
      "environment",
    );
    expect(demoSettingsSectionForAction("enable-remote-control")).toBe(
      "computer-control",
    );
    expect(demoSettingsSectionForAction("unknown")).toBeNull();
  });

  it("classifies auth and worktree demo actions", () => {
    expect(isAuthDemoAction("login-chatgpt")).toBe(true);
    expect(isAuthDemoAction("refresh-account")).toBe(false);
    expect(worktreeDemoAction("create-worktree-session")).toBe("created");
    expect(worktreeDemoAction("fork-worktree")).toBe("forked");
    expect(worktreeDemoAction("refresh-worktrees")).toBe("refreshed");
    expect(worktreeDemoAction("refresh-git")).toBeNull();
  });
});
