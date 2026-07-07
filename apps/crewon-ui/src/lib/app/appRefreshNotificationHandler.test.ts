import { describe, expect, it } from "vitest";

import type { AppServerNotification } from "../app-server/appServer";
import type { NoticeState } from "./appRuntimeState";
import type { LibraryKind } from "../domain/crewonDomain";
import type { SettingsSection } from "../settings/settingsCatalog";
import { handleRefreshAppNotification } from "./appRefreshNotificationHandler";

type CapturedRefreshState = {
  accountRefreshes: number;
  libraries: LibraryKind[];
  notice: NoticeState | null;
  slashRefreshes: number;
  settingsSections: SettingsSection[][];
};

function handleNotification(notification: AppServerNotification): {
  handled: boolean;
  state: CapturedRefreshState;
} {
  const state: CapturedRefreshState = {
    accountRefreshes: 0,
    libraries: [],
    notice: null,
    slashRefreshes: 0,
    settingsSections: [],
  };

  const handled = handleRefreshAppNotification({
    locale: "en",
    notification,
    refreshAccount: () => {
      state.accountRefreshes += 1;
    },
    refreshComposerSlashCommands: () => {
      state.slashRefreshes += 1;
    },
    refreshVisibleLibrary: (kind) => {
      state.libraries.push(kind);
    },
    refreshVisibleSettings: (sections) => {
      state.settingsSections.push(sections);
    },
    setNotice: (notice) => {
      state.notice = notice;
    },
  });

  return { handled, state };
}

describe("refresh app notification handler", () => {
  it("handles account login notifications with refresh and notice", () => {
    const { handled, state } = handleNotification({
      method: "account/login/completed",
      params: { success: true, error: null },
    } as AppServerNotification);

    expect(handled).toBe(true);
    expect(state.accountRefreshes).toBe(1);
    expect(state.notice).toEqual({
      text: "Account login completed",
      tone: "success",
    });
  });

  it("handles app and remote control notifications by refreshing settings", () => {
    const appList = handleNotification({
      method: "app/list/updated",
      params: {},
    } as AppServerNotification).state;

    expect(appList.settingsSections).toEqual([["browser", "connections"]]);
    expect(appList.slashRefreshes).toBe(1);

    expect(
      handleNotification({
        method: "remoteControl/status/changed",
        params: {},
      } as AppServerNotification).state.settingsSections,
    ).toEqual([["computer-control"]]);
  });

  it("handles skills changes by refreshing tools and MCP settings", () => {
    const { handled, state } = handleNotification({
      method: "skills/changed",
      params: {},
    } as AppServerNotification);

    expect(handled).toBe(true);
    expect(state.libraries).toEqual(["tools"]);
    expect(state.slashRefreshes).toBe(1);
    expect(state.settingsSections).toEqual([["mcp-servers"]]);
  });

  it("handles config and MCP notices", () => {
    expect(
      handleNotification({
        method: "configWarning",
        params: {
          summary: "Bad config",
          details: "Missing key",
          path: "/repo/config.toml",
        },
      } as AppServerNotification).state.notice,
    ).toEqual({
      text: "Bad config\n/repo/config.toml\nMissing key",
      tone: "warning",
    });

    const mcpStartup = handleNotification({
      method: "mcpServer/startupStatus/updated",
      params: { name: "github", status: "failed", error: "port busy" },
    } as AppServerNotification).state;

    expect(mcpStartup.notice).toEqual({
      text: "github: failed\nport busy",
      tone: "warning",
    });
    expect(mcpStartup.slashRefreshes).toBe(1);
  });

  it("leaves thread notifications for the app-level handler", () => {
    const { handled } = handleNotification({
      method: "thread/compacted",
      params: { threadId: "thread-1" },
    } as AppServerNotification);

    expect(handled).toBe(false);
  });
});
