import { describe, expect, it } from "vitest";

import type { AgentConfig, LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import { createDefaultAgentConfig } from "../agent-config/agentConfigDefaults";
import { handleLibraryAgentAction } from "./libraryAgentActions";

type CapturedAgentActionState = { panel: LibraryPanel | null };

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
  } = {},
): Promise<{ handled: boolean; state: CapturedAgentActionState }> {
  const state: CapturedAgentActionState = {
    panel: panel(),
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
  });

  return { handled, state };
}

describe("library agent actions", () => {
  it("opens a capability-backed draft without writing a placeholder record", async () => {
    const { handled, state } = await handleAction({
      id: "create-agent",
      label: "Create agent",
    });

    expect(handled).toBe(true);
    expect(state.panel).toMatchObject({
      title: "Backend Agent",
      subtitle: "Agent configuration",
      body: undefined,
      error: undefined,
      agentConfig: {
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
      { createError: new Error("capability offline") },
    );

    expect(handled).toBe(true);
    expect(state.panel).toMatchObject({
      title: "New Agent",
      error: "capability offline",
      agentConfig: {
        name: "New Agent",
      },
    });
  });

  it("leaves unrelated actions for the app handler", async () => {
    const { handled, state } = await handleAction({
      id: "reload-tools",
      label: "Reload",
    });

    expect(handled).toBe(false);
    expect(state.panel).toEqual(panel());
  });
});
