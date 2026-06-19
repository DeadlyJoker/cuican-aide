import { describe, expect, it } from "vitest";

import type { AgentConfig, LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import { createDefaultAgentConfig } from "../agent-config/agentConfigDefaults";
import { handleLibraryAgentAction } from "./libraryAgentActions";

type CapturedAgentActionState = {
  panel: LibraryPanel | null;
  writtenConfigs: AgentConfig[];
};

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...createDefaultAgentConfig("en"),
    name: "Backend Agent",
    model: "gpt-5",
    ...overrides,
  };
}

function panel(): LibraryPanel {
  return {
    kind: "agents",
    title: "Agents",
    subtitle: "Library",
    body: "Existing",
    items: [],
  };
}

async function handleAction(
  action: LibraryPanelAction,
  options: {
    createError?: unknown;
    writeError?: unknown;
    writeResult?: { filePath: string; agentId?: string } | null;
  } = {},
): Promise<{ handled: boolean; state: CapturedAgentActionState }> {
  const state: CapturedAgentActionState = {
    panel: panel(),
    writtenConfigs: [],
  };

  const handled = await handleLibraryAgentAction({
    action,
    createAgentConfig: async () => {
      if (options.createError) {
        throw options.createError;
      }
      return agentConfig();
    },
    defaultAgentConfig: () => createDefaultAgentConfig("en"),
    locale: "en",
    setLibraryPanel: (updater) => {
      state.panel = updater(state.panel);
    },
    writeAgentConfig: async (config) => {
      state.writtenConfigs.push(config);
      if (options.writeError) {
        throw options.writeError;
      }
      return options.writeResult ?? { filePath: "/workspace/.crewon/agents/agent.json", agentId: "agent-1" };
    },
  });

  return { handled, state };
}

describe("library agent actions", () => {
  it("creates backend agent configs and writes records", async () => {
    const { handled, state } = await handleAction({
      id: "create-agent",
      label: "Create agent",
    });

    expect(handled).toBe(true);
    expect(state.writtenConfigs).toEqual([agentConfig()]);
    expect(state.panel).toMatchObject({
      title: "Backend Agent",
      subtitle: "Agent configuration",
      body: "Created backend agent record: /workspace/.crewon/agents/agent.json",
      error: undefined,
      agentConfig: {
        agentId: "agent-1",
        name: "Backend Agent",
      },
    });
  });

  it("falls back to the default config when capability loading fails", async () => {
    const { handled, state } = await handleAction(
      {
        id: "create-agent",
        label: "Create agent",
      },
      { createError: new Error("capability offline"), writeResult: null },
    );

    expect(handled).toBe(true);
    expect(state.writtenConfigs).toEqual([createDefaultAgentConfig("en")]);
    expect(state.panel).toMatchObject({
      title: "New Agent",
      error: "capability offline",
      agentConfig: {
        name: "New Agent",
      },
    });
  });

  it("keeps the created config and surfaces record write failures", async () => {
    const { handled, state } = await handleAction(
      {
        id: "create-agent",
        label: "Create agent",
      },
      { writeError: new Error("record write failed") },
    );

    expect(handled).toBe(true);
    expect(state.panel).toMatchObject({
      title: "Backend Agent",
      body: undefined,
      error: "record write failed",
      agentConfig: {
        name: "Backend Agent",
      },
    });
  });

  it("leaves unrelated actions for the app handler", async () => {
    const { handled, state } = await handleAction({
      id: "reload-tools",
      label: "Reload",
    });

    expect(handled).toBe(false);
    expect(state.writtenConfigs).toEqual([]);
    expect(state.panel).toEqual(panel());
  });
});
