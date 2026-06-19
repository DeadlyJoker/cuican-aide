import type { AppInfo } from "@crewon-protocol/v2/AppInfo";
import type { ConfigRequirementsReadResponse } from "@crewon-protocol/v2/ConfigRequirementsReadResponse";
import { describe, expect, it } from "vitest";

import {
  appSnapshotsDisconnectedPanel,
  appSnapshotsErrorPanel,
  appSnapshotsLoadingPanel,
  appSnapshotsPanel,
  connectionsDisconnectedPanel,
  connectionsLoadingPanel,
  connectionsPanel,
  environmentDisconnectedPanel,
  environmentLoadingPanel,
  environmentPanel,
  windowsSandboxSetupFailurePanel,
  windowsSandboxSetupFailureMessage,
  windowsSandboxSetupNotice,
  windowsSandboxSetupNoticeText,
  windowsSandboxSetupProgressBody,
  windowsSandboxSetupProgressPanel,
} from "./settingsRuntimePanels";

function appInfo(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    id: "app-1",
    name: "Browser",
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
    ...overrides,
  };
}

function configRequirements(
  overrides: Partial<
    NonNullable<ConfigRequirementsReadResponse["requirements"]>
  > = {},
): ConfigRequirementsReadResponse {
  return {
    requirements: {
      allowedApprovalPolicies: null,
      allowedSandboxModes: null,
      allowedWindowsSandboxImplementations: null,
      allowedPermissionProfiles: null,
      defaultPermissions: null,
      allowedWebSearchModes: null,
      allowManagedHooksOnly: null,
      allowAppshots: null,
      computerUse: null,
      featureRequirements: null,
      enforceResidency: null,
      ...overrides,
    },
  };
}

describe("settings runtime panels", () => {
  it("builds environment panels", () => {
    expect(environmentDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Environment",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(environmentLoadingPanel(null, "zh")).toEqual({
      title: "环境",
      subtitle: "全局环境",
      body: "正在读取环境能力...",
    });
    expect(
      environmentPanel({
        cwd: "/repo",
        error: "requirements failed",
        locale: "en",
        readiness: "ready",
        readinessError: null,
        requirements: configRequirements({
          allowedSandboxModes: ["workspace-write"],
          allowedWindowsSandboxImplementations: ["elevated"],
        }),
      }),
    ).toEqual({
      title: "Environment",
      subtitle: "/repo",
      body: [
        "Runtime environment",
        "Sandbox modes: workspace-write",
        "Windows sandbox implementations: elevated",
        "Windows sandbox status: ready",
      ].join("\n"),
      actions: [
        { id: "refresh-environment", label: "Refresh environment" },
        {
          id: "setup-windows-sandbox-elevated",
          label: "Set up Windows sandbox: elevated",
        },
      ],
      error: "requirements failed",
    });
  });

  it("builds Windows sandbox setup feedback", () => {
    expect(windowsSandboxSetupProgressBody("elevated", "en")).toBe(
      "Starting Windows sandbox setup: elevated",
    );
    expect(
      windowsSandboxSetupProgressPanel(
        { title: "Environment", body: "Ready", error: "old error" },
        "unelevated",
        "zh",
      ),
    ).toEqual({
      title: "Environment",
      body: "正在启动 Windows 沙箱配置：unelevated",
      error: undefined,
    });
    expect(windowsSandboxSetupNoticeText(true, "zh")).toBe(
      "Windows 沙箱配置已启动",
    );
    expect(windowsSandboxSetupNoticeText(false, "en")).toBe(
      "Windows sandbox setup did not start",
    );
    expect(windowsSandboxSetupNotice(true, "en")).toEqual({
      text: "Windows sandbox setup started",
      tone: "success",
    });
    expect(windowsSandboxSetupNotice(null, "zh")).toEqual({
      text: "Windows 沙箱配置未启动",
      tone: "warning",
    });
    expect(windowsSandboxSetupFailureMessage(null, "zh")).toBe(
      "启动 Windows 沙箱配置失败",
    );
    expect(windowsSandboxSetupFailureMessage(new Error("denied"), "en")).toBe(
      "denied",
    );
    expect(
      windowsSandboxSetupFailurePanel(
        { title: "Environment", body: "Starting" },
        null,
        "en",
      ),
    ).toEqual({
      title: "Environment",
      body: "Starting",
      error: "Unable to start Windows sandbox setup",
    });
    expect(
      windowsSandboxSetupProgressPanel(null, "elevated", "en"),
    ).toBeNull();
    expect(windowsSandboxSetupFailurePanel(null, null, "en")).toBeNull();
  });

  it("builds app snapshots panels", () => {
    expect(appSnapshotsDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "App snapshots",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(appSnapshotsLoadingPanel("zh")).toEqual({
      title: "应用快照",
      subtitle: "策略与状态",
      body: "正在读取应用快照策略...",
    });
    expect(
      appSnapshotsPanel(configRequirements({ allowAppshots: false }), "en"),
    ).toEqual({
      title: "App snapshots",
      subtitle: "Policy disabled",
      body: [
        "App snapshots",
        "Status: disabled",
        "Purpose: Provide auditable state snapshots for apps, browser, and computer-control capabilities.",
      ].join("\n"),
      actions: [
        { id: "refresh-app-snapshots", label: "Refresh app snapshots" },
      ],
    });
    expect(
      appSnapshotsPanel(configRequirements({ allowAppshots: true }), "zh"),
    ).toMatchObject({
      title: "应用快照",
      subtitle: "策略允许",
      actions: [{ id: "refresh-app-snapshots", label: "刷新应用快照" }],
    });
    expect(appSnapshotsErrorPanel(null, "en")).toEqual({
      title: "App snapshots",
      subtitle: "Policy and status",
      error: "Unable to read app snapshot policy",
    });
    expect(appSnapshotsErrorPanel(new Error("denied"), "zh")).toEqual({
      title: "应用快照",
      subtitle: "策略与状态",
      error: "denied",
    });
  });

  it("builds connections panels", () => {
    expect(connectionsDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Connections",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(connectionsLoadingPanel(null, "en")).toEqual({
      title: "Connections",
      subtitle: "Global connections",
      body: "Reading connection status...",
    });
    expect(
      connectionsPanel({
        account: null,
        apps: { data: [appInfo()], nextCursor: null },
        auth: {
          authMethod: "chatgpt",
          authToken: null,
          requiresOpenaiAuth: false,
        },
        errors: ["plugins failed"],
        locale: "en",
        plugins: null,
        providerCapabilities: null,
        requirements: null,
      }),
    ).toEqual({
      title: "Connections",
      subtitle: "1 apps · 0 marketplaces · chatgpt",
      body: [
        "Connection status",
        "Account: Reading account status...",
        "Auth method: chatgpt",
        "Requires OpenAI auth: no",
        "Plugin marketplaces: 0 · plugins: 0",
        "App connectors: 1 · enabled: 1 · accessible: 1",
        "Apps: Browser (accessible)",
        "Some connection reads failed\n- plugins failed",
      ].join("\n"),
      actions: [{ id: "refresh-connections", label: "Refresh connections" }],
      error: "plugins failed",
    });
  });
});
