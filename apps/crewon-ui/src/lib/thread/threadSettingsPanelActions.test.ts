import type { ConfigReadResponse } from "@crewon-ui-model/v2/ConfigReadResponse";
import type { ConfigRequirementsReadResponse } from "@crewon-ui-model/v2/ConfigRequirementsReadResponse";
import type { ModelListResponse } from "@crewon-ui-model/v2/ModelListResponse";
import type { ThreadGoalView } from "@crewon/contracts";
import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  openThreadSettingsPanelAction,
  type OpenThreadSettingsPanelActionParams,
} from "./threadSettingsPanelActions";

type ThreadSettingsPanelClient = NonNullable<
  OpenThreadSettingsPanelActionParams["client"]
>;

function configRead(
  overrides: Partial<ConfigReadResponse["config"]> = {},
): ConfigReadResponse {
  return {
    config: {
      approval_policy: "on-request",
      approvals_reviewer: null,
      compact_prompt: null,
      desktop: null,
      developer_instructions: null,
      forced_chatgpt_workspace_id: null,
      forced_login_method: null,
      instructions: null,
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

function threadGoal(): ThreadGoalView {
  return {
    createdAt: "2026-08-09T07:00:00.000Z",
    goalId: "goal-1",
    objective: "Finish refactor",
    revision: 1,
    status: "active",
    threadId: "thread-1",
    timeUsedSeconds: 10,
    tokenBudget: 1000,
    tokensUsed: 20,
    updatedAt: "2026-08-09T07:00:10.000Z",
  };
}

function baseClient(
  overrides: Partial<ThreadSettingsPanelClient> = {},
): ThreadSettingsPanelClient {
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
  overrides: Partial<OpenThreadSettingsPanelActionParams> = {},
): OpenThreadSettingsPanelActionParams {
  const sink = panelSink();
  return {
    client: baseClient(),
    cwd: "/repo",
    hasBackendThread: true,
    isConnected: true,
    isDemoPreview: false,
    locale: "en",
    resolveBackendCwd: async () => "/fallback",
    setCapabilityDockOpen: () => {},
    setCapabilityPanel: sink.setCapabilityPanel,
    threadGoal: threadGoal(),
    ...overrides,
  };
}

describe("thread settings panel actions", () => {
  it("shows missing thread panel for real mode without a backend thread", async () => {
    const sink = panelSink();
    const dockStates: boolean[] = [];

    await openThreadSettingsPanelAction(
      baseParams({
        hasBackendThread: false,
        isDemoPreview: false,
        setCapabilityDockOpen: (open) => {
          dockStates.push(open);
        },
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    );

    expect(dockStates).toEqual([true]);
    expect(sink.panel).toEqual({
      error: "Select a session first",
      subtitle: "Goal",
      title: "Session settings",
    });
  });

  it("opens initial panel for demo preview without reading metadata", async () => {
    const sink = panelSink();
    let read = false;

    await openThreadSettingsPanelAction(
      baseParams({
        client: baseClient({
          async readConfig() {
            read = true;
            return configRead();
          },
        }),
        hasBackendThread: false,
        isDemoPreview: true,
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    );

    expect(read).toBe(false);
    expect(sink.panel?.title).toBe("Session settings");
    expect(sink.panel?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "thread-goal-objective",
          value: "Finish refactor",
        }),
      ]),
    );
  });

  it("loads metadata into thread settings fields", async () => {
    const sink = panelSink();
    const calls: string[] = [];

    await openThreadSettingsPanelAction(
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
    expect(sink.panels).toHaveLength(2);
    expect(sink.panels[0]).toMatchObject({
      title: "Session settings",
    });
    expect(sink.panel?.body).toContain(
      "Session settings affect only future turns in this session.",
    );
    expect(sink.panel?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "thread-settings-model",
          options: expect.arrayContaining([
            { label: "GPT-5 Codex", value: "gpt-5-codex" },
          ]),
          placeholder: "gpt-5-codex",
        }),
        expect.objectContaining({
          id: "thread-settings-approval-policy",
          placeholder: "on-request",
        }),
        expect.objectContaining({
          id: "thread-settings-sandbox-mode",
          placeholder: "workspace-write",
        }),
      ]),
    );
  });

  it("uses resolved cwd when current cwd is unavailable", async () => {
    const sink = panelSink();
    const configCwds: Array<string | null | undefined> = [];

    await openThreadSettingsPanelAction(
      baseParams({
        client: baseClient({
          async readConfig(cwd) {
            configCwds.push(cwd);
            return configRead();
          },
        }),
        cwd: null,
        resolveBackendCwd: async () => "/resolved",
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    );

    expect(configCwds).toEqual(["/resolved"]);
  });

  it("does not read metadata when disconnected", async () => {
    const sink = panelSink();
    let read = false;

    await openThreadSettingsPanelAction(
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
    expect(sink.panel).toMatchObject({
      title: "Session settings",
    });
  });
});
