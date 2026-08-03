import type { ConfigReadResponse } from "@crewon-protocol/v2/ConfigReadResponse";
import type { ConfigRequirementsReadResponse } from "@crewon-protocol/v2/ConfigRequirementsReadResponse";
import type { ModelListResponse } from "@crewon-protocol/v2/ModelListResponse";
import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  refreshAppearanceSettingsPanelAction,
  refreshConfigPanelAction,
  refreshKeyboardSettingsPanelAction,
  refreshPersonalizationSettingsPanelAction,
  type RefreshConfigPanelParams,
} from "./settingsConfigurationActions";

type SettingsConfigurationClient = NonNullable<
  RefreshConfigPanelParams["client"]
>;

function configRead(
  overrides: Partial<ConfigReadResponse["config"]> = {},
): ConfigReadResponse {
  return {
    config: {
      approval_policy: "on-request",
      approvals_reviewer: null,
      compact_prompt: null,
      desktop: {
        appearanceTheme: "light",
        uiLocale: "en",
      },
      developer_instructions: null,
      forced_chatgpt_workspace_id: null,
      forced_login_method: null,
      instructions: "Prefer concise answers.",
      model: "gpt-5-codex",
      model_auto_compact_token_limit: null,
      model_auto_compact_token_limit_scope: null,
      model_context_window: null,
      model_provider: "openai",
      model_reasoning_effort: null,
      model_reasoning_summary: null,
      model_verbosity: null,
      review_model: null,
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: null,
      service_tier: null,
      tools: null,
      web_search: null,
      analytics: null,
      apps: null,
      ...overrides,
    },
    layers: [],
    origins: {},
  } as ConfigReadResponse;
}

function requirements(): ConfigRequirementsReadResponse {
  return {
    requirements: {
      allowAppshots: null,
      allowedApprovalPolicies: ["on-request", "never"],
      allowedPermissionProfiles: null,
      allowedSandboxModes: ["read-only", "workspace-write"],
      allowedWebSearchModes: null,
      allowedWindowsSandboxImplementations: null,
      allowManagedHooksOnly: null,
      computerUse: null,
      defaultPermissions: null,
      enforceResidency: null,
      featureRequirements: null,
    },
  };
}

function models(): ModelListResponse {
  return {
    data: [
      {
        additionalSpeedTiers: [],
        availabilityNux: null,
        defaultReasoningEffort: "medium",
        defaultServiceTier: null,
        description: "Codex model",
        displayName: "GPT-5 Codex",
        hidden: false,
        id: "gpt-5-codex",
        inputModalities: ["text"],
        isDefault: true,
        model: "gpt-5-codex",
        serviceTiers: [],
        supportedReasoningEfforts: [],
        supportsPersonality: false,
        upgrade: null,
        upgradeInfo: null,
      },
    ],
    nextCursor: null,
  };
}

function baseClient(
  overrides: Partial<SettingsConfigurationClient> = {},
): SettingsConfigurationClient {
  return {
    async listModels() {
      return models();
    },
    async readConfig() {
      return configRead();
    },
    async readConfigRequirements() {
      return requirements();
    },
    ...overrides,
  };
}

function panelSink() {
  let panel: CapabilityPanel | null = null;
  const panels: Array<CapabilityPanel | null> = [];
  return {
    get panel() {
      return panel;
    },
    get panels() {
      return panels;
    },
    setCapabilityPanel: (
      panelOrUpdater:
        | CapabilityPanel
        | null
        | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
    ) => {
      panel =
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(panel)
          : panelOrUpdater;
      panels.push(panel);
    },
  };
}

function baseParams(
  overrides: Partial<RefreshConfigPanelParams> = {},
): RefreshConfigPanelParams {
  const sink = panelSink();
  return {
    client: baseClient(),
    connectionHint: "Disconnected",
    isConnected: true,
    locale: "en",
    resolveBackendCwd: async () => "/repo",
    setCapabilityPanel: sink.setCapabilityPanel,
    ...overrides,
  };
}

describe("settings configuration actions", () => {
  it("shows config disconnected panel without reading the backend", async () => {
    const sink = panelSink();
    let read = false;

    await refreshConfigPanelAction(
      baseParams({
        client: baseClient({
          async readConfig() {
            read = true;
            return configRead();
          },
        }),
        isConnected: false,
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    );

    expect(read).toBe(false);
    expect(sink.panel).toEqual({
      error: "Local app-server is not connected",
      subtitle: "Disconnected",
      title: "Config",
    });
  });

  it("loads config, requirements, and models into the config panel", async () => {
    const sink = panelSink();
    const calls: string[] = [];

    await refreshConfigPanelAction(
      baseParams({
        client: baseClient({
          async listModels() {
            calls.push("models");
            return models();
          },
          async readConfig(cwd) {
            calls.push(`config:${cwd}`);
            return configRead();
          },
          async readConfigRequirements() {
            calls.push("requirements");
            return requirements();
          },
        }),
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    );

    expect(calls.sort()).toEqual(["config:/repo", "models", "requirements"]);
    expect(sink.panels[0]).toEqual({
      body: "Reading config...",
      subtitle: "/repo",
      title: "Config",
    });
    expect(sink.panel).toMatchObject({
      title: "Config",
      subtitle: "/repo",
      fields: [
        expect.objectContaining({
          id: "config-model",
          value: "gpt-5-codex",
        }),
        expect.objectContaining({
          id: "config-approval-policy",
          value: "on-request",
        }),
        expect.objectContaining({
          id: "config-sandbox-mode",
          value: "workspace-write",
        }),
      ],
    });
  });

  it("loads appearance settings with current UI fallbacks", async () => {
    const sink = panelSink();

    await refreshAppearanceSettingsPanelAction({
      ...baseParams(),
      client: baseClient({
        async readConfig() {
          return configRead({ desktop: null });
        },
      }),
      currentLocale: "zh",
      currentTheme: "dark",
      os: "mac",
      setCapabilityPanel: sink.setCapabilityPanel,
      surface: "desktop",
    });

    expect({
      subtitle: sink.panel?.subtitle,
      title: sink.panel?.title,
      locale: sink.panel?.fields?.find(
        (field) => field.id === "appearance-locale",
      )?.value,
      // An unset desktop table falls back to following the system theme.
      theme: sink.panel?.fields?.find(
        (field) => field.id === "appearance-theme",
      )?.value,
    }).toEqual({
      locale: "zh",
      subtitle: "/repo",
      theme: "system",
      title: "Appearance",
    });
  });

  it("loads personalization settings", async () => {
    const sink = panelSink();

    await refreshPersonalizationSettingsPanelAction({
      ...baseParams(),
      client: baseClient({
        async readConfig() {
          return configRead({
            developer_instructions: "Use local patterns.",
            features: { memories: true },
            instructions: "Keep answers short.",
            memories: {
              generate_memories: true,
              use_memories: false,
            },
          });
        },
      }),
      setCapabilityPanel: sink.setCapabilityPanel,
    });

    expect(sink.panel).toMatchObject({
      title: "Assistant profile & memory",
      subtitle: "/repo",
      fields: [
        expect.objectContaining({
          id: "personalization-instructions",
          value: "Keep answers short.",
        }),
        expect.objectContaining({
          id: "personalization-developer-instructions",
          value: "Use local patterns.",
        }),
        expect.objectContaining({
          id: "personalization-memory-mode",
          value: "learn-only",
        }),
      ],
    });
  });

  it("loads keyboard settings", async () => {
    const sink = panelSink();

    await refreshKeyboardSettingsPanelAction({
      ...baseParams(),
      setCapabilityPanel: sink.setCapabilityPanel,
    });

    expect(sink.panel).toMatchObject({
      actions: [{ id: "refresh-keyboard", label: "Refresh shortcuts" }],
      subtitle: "/repo",
      title: "Keyboard shortcuts",
    });
  });

  it("shows an error panel when appearance config read fails", async () => {
    const sink = panelSink();

    await refreshAppearanceSettingsPanelAction({
      ...baseParams(),
      client: baseClient({
        async readConfig() {
          throw new Error("read failed");
        },
      }),
      currentLocale: "en",
      currentTheme: "light",
      setCapabilityPanel: sink.setCapabilityPanel,
    });

    expect(sink.panel).toEqual({
      error: "read failed",
      subtitle: "/repo",
      title: "Appearance",
    });
  });
});
