import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createAppSettingsRefreshHandlers,
  createSettingsRefreshHandlers,
  createSettingsSectionRefreshHandlers,
} from "./settingsRefreshHandlers";

type SetCapabilityPanel = Parameters<
  typeof createAppSettingsRefreshHandlers
>[0]["setCapabilityPanel"];

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function baseParams(
  overrides: {
    client?: AppServerClient | null;
    isConnected?: boolean;
    isDemoPreview?: boolean;
    selectedThreadId?: string | null;
    setCapabilityDockOpen?: (open: boolean) => void;
    setCapabilityPanel?: SetCapabilityPanel;
  } = {},
) {
  return {
    accountStatus: null,
    platformUser: null,
    client: overrides.client ?? null,
    connectionHint: "Disconnected",
    connectionState: "demo" as const,
    conversationSummary: null,
    currentCwd: "/repo",
    isConnected: overrides.isConnected ?? false,
    isDemoPreview: overrides.isDemoPreview ?? false,
    locale: "en" as const,
    resolveBackendCwd: async () => "/repo",
    selectedThread: null,
    selectedThreadId: overrides.selectedThreadId ?? null,
    setAccountStatus: () => {},
    setCapabilityDockOpen: overrides.setCapabilityDockOpen ?? (() => {}),
    setCapabilityPanel: overrides.setCapabilityPanel ?? (() => {}),
    setThreads: () => {},
    theme: "dark" as const,
    threadGoal: null,
    threads: [] as Thread[],
  };
}

describe("settings refresh handlers", () => {
  it("refreshes config settings with the current connection hint", async () => {
    let panel: CapabilityPanel | null = null;
    const handlers = createAppSettingsRefreshHandlers(
      baseParams({
        setCapabilityPanel: (nextPanel) => {
          panel =
            typeof nextPanel === "function" ? nextPanel(panel) : nextPanel;
        },
      }),
    );

    await handlers.refreshConfigPanel();

    expect(panel).toMatchObject({
      title: "Config",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
  });

  it("opens thread settings missing-thread panel without a backend thread", async () => {
    let dockOpen = false;
    let panel: CapabilityPanel | null = null;
    const handlers = createAppSettingsRefreshHandlers(
      baseParams({
        setCapabilityDockOpen: (open) => {
          dockOpen = open;
        },
        setCapabilityPanel: (nextPanel) => {
          panel =
            typeof nextPanel === "function" ? nextPanel(panel) : nextPanel;
        },
      }),
    );

    await handlers.openThreadSettingsPanel();

    expect(dockOpen).toBe(true);
    expect(panel).toMatchObject({
      title: "Session settings",
      error: "Select a session first",
    });
  });

  it("opens thread settings initial panel for a demo preview thread", async () => {
    let panel: CapabilityPanel | null = null;
    const handlers = createAppSettingsRefreshHandlers(
      baseParams({
        isDemoPreview: true,
        selectedThreadId: "demo-thread",
        setCapabilityPanel: (nextPanel) => {
          panel =
            typeof nextPanel === "function" ? nextPanel(panel) : nextPanel;
        },
      }),
    );

    await handlers.openThreadSettingsPanel();

    expect(panel).toMatchObject({
      title: "Session settings",
      subtitle: "Goal",
    });
    expect((panel as CapabilityPanel | null)?.error).toBeUndefined();
  });

  it("passes connected account refresh through to the backend client", async () => {
    const calls: string[] = [];
    const handlers = createAppSettingsRefreshHandlers(
      baseParams({
        client: client({
          async getAccount() {
            calls.push("account");
            return null as unknown as Awaited<
              ReturnType<AppServerClient["getAccount"]>
            >;
          },
          async getAccountRateLimits() {
            calls.push("rateLimits");
            return null as unknown as Awaited<
              ReturnType<AppServerClient["getAccountRateLimits"]>
            >;
          },
          async getAccountUsage() {
            calls.push("usage");
            return null as unknown as Awaited<
              ReturnType<AppServerClient["getAccountUsage"]>
            >;
          },
          async getAuthStatus() {
            calls.push("auth");
            return null as unknown as Awaited<
              ReturnType<AppServerClient["getAuthStatus"]>
            >;
          },
          async getModelProviderCapabilities() {
            calls.push("providerCapabilities");
            return null as unknown as Awaited<
              ReturnType<AppServerClient["getModelProviderCapabilities"]>
            >;
          },
          async listModels() {
            calls.push("models");
            return { data: [], nextCursor: null };
          },
          async listPermissionProfiles(cwd) {
            calls.push(`permissions:${cwd}`);
            return { data: [], nextCursor: null };
          },
        }),
        isConnected: true,
      }),
    );

    await handlers.refreshAccountPanel();

    expect(calls).toEqual([
      "account",
      "auth",
      "rateLimits",
      "usage",
      "models",
      "permissions:/repo",
      "providerCapabilities",
    ]);
  });

  it("derives section and action refresh adapters from the same handler bundle", async () => {
    const handlers = createAppSettingsRefreshHandlers(baseParams());
    const calls: string[] = [];
    const bundle = {
      ...handlers,
      refreshConfigPanel: async () => {
        calls.push("config");
      },
      refreshMcpSettingsPanel: async () => {
        calls.push("mcp");
      },
    };

    await createSettingsSectionRefreshHandlers(bundle).config();
    createSettingsRefreshHandlers(bundle).mcpSettings();

    expect(calls).toEqual(["config", "mcp"]);
  });
});
