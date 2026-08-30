import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  handleSettingsRuntimeAction,
  settingsRuntimeActionForActionId,
  type SettingsRuntimeActionHandlersParams,
} from "./settingsRuntimeActions";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function baseParams(
  overrides: Partial<SettingsRuntimeActionHandlersParams> = {},
): SettingsRuntimeActionHandlersParams {
  let panel: CapabilityPanel | null = {
    title: "Settings",
    body: "Ready",
  };
  return {
    client: {
      async reloadMcpServers() {},
      async startWindowsSandboxSetup() {
        return { started: true };
      },
    },
    locale: "en",
    refreshEnvironmentSettingsPanel: async () => {},
    refreshMcpSettingsPanel: async () => {},
    resolveBackendCwd: async () => "/repo",
    setCapabilityPanel: (updater) => {
      panel = updater(panel);
    },
    setNotice: () => {},
    ...overrides,
  };
}

describe("settings runtime actions", () => {
  it("maps runtime settings action ids", () => {
    expect(settingsRuntimeActionForActionId("reload-tools")).toEqual({
      type: "reloadTools",
    });
    expect(
      settingsRuntimeActionForActionId("setup-windows-sandbox-elevated"),
    ).toEqual({
      type: "setupWindowsSandbox",
      mode: "elevated",
    });
    expect(
      settingsRuntimeActionForActionId("setup-windows-sandbox-unelevated"),
    ).toEqual({
      type: "setupWindowsSandbox",
      mode: "unelevated",
    });
    expect(settingsRuntimeActionForActionId("setup-windows-sandbox-other")).toBeNull();
    expect(settingsRuntimeActionForActionId("refresh-account")).toBeNull();
  });

  it("reloads MCP servers and refreshes the panel", async () => {
    let panel: CapabilityPanel | null = {
      title: "MCP",
      body: "Ready",
    };
    let reloads = 0;
    let refreshes = 0;

    handleSettingsRuntimeAction(
      baseParams({
        client: {
          async reloadMcpServers() {
            reloads += 1;
          },
          async startWindowsSandboxSetup() {
            return { started: true };
          },
        },
        refreshMcpSettingsPanel: async () => {
          refreshes += 1;
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
      { type: "reloadTools" },
    );

    expect(panel).toMatchObject({
      body: "Reloading MCP config...",
      error: undefined,
    });
    await flushAsyncAction();

    expect(reloads).toBe(1);
    expect(refreshes).toBe(1);
  });

  it("shows MCP reload failures", async () => {
    let panel: CapabilityPanel | null = {
      title: "MCP",
      body: "Ready",
    };

    handleSettingsRuntimeAction(
      baseParams({
        client: {
          async reloadMcpServers() {
            throw new Error("denied");
          },
          async startWindowsSandboxSetup() {
            return { started: true };
          },
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
      { type: "reloadTools" },
    );
    await flushAsyncAction();

    expect(panel).toMatchObject({
      error: "denied",
    });
  });

  it("starts Windows sandbox setup with cwd and notice", async () => {
    let panel: CapabilityPanel | null = {
      title: "Environment",
      body: "Ready",
    };
    let notice: NoticeState | null = null;
    let refreshes = 0;
    const setupCalls: Array<{ cwd?: string; mode: string }> = [];

    handleSettingsRuntimeAction(
      baseParams({
        client: {
          async reloadMcpServers() {},
          async startWindowsSandboxSetup(mode, cwd) {
            setupCalls.push({ cwd, mode });
            return { started: true };
          },
        },
        refreshEnvironmentSettingsPanel: async () => {
          refreshes += 1;
        },
        resolveBackendCwd: async () => "/repo",
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setNotice: (nextNotice) => {
          notice = nextNotice;
        },
      }),
      { type: "setupWindowsSandbox", mode: "elevated" },
    );

    expect(panel).toMatchObject({
      body: "Starting Windows sandbox setup: elevated",
      error: undefined,
    });
    await flushAsyncAction();

    expect(setupCalls).toEqual([{ cwd: "/repo", mode: "elevated" }]);
    expect(refreshes).toBe(1);
    expect(notice).toEqual({
      text: "Windows sandbox setup started",
      tone: "success",
    });
  });

  it("shows Windows sandbox setup failures", async () => {
    let panel: CapabilityPanel | null = {
      title: "Environment",
      body: "Ready",
    };

    handleSettingsRuntimeAction(
      baseParams({
        client: {
          async reloadMcpServers() {},
          async startWindowsSandboxSetup() {
            throw new Error("denied");
          },
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
      { type: "setupWindowsSandbox", mode: "unelevated" },
    );
    await flushAsyncAction();

    expect(panel).toMatchObject({
      error: "denied",
    });
  });
});
