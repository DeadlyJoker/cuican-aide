import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import type { AgentReadResponse } from "../app-server/appServer";
import {
  openAgentConfigAction,
  type OpenAgentConfigActionParams,
} from "./agentConfigActions";
import type {
  AgentConfig,
  LibraryItemAction,
  LibraryPanel,
} from "../domain/crewonDomain";

type AgentConfigAction = Extract<LibraryItemAction, { type: "agent-config" }>;

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Frontend Agent",
    glyph: "◷",
    accent: "blue",
    role: "Refactor UI",
    model: "gpt-5",
    models: ["gpt-5"],
    permission: "workspace-write",
    permissions: ["workspace-write"],
    systemPrompt: "Keep the frontend clean.",
    mcp: [
      {
        id: "git",
        name: "Git",
        glyph: "⌁",
        accent: "green",
        description: "Git tools",
        enabled: true,
      },
    ],
    skills: [
      {
        id: "review",
        name: "Review",
        glyph: "✓",
        accent: "cyan",
        description: "Review skill",
        enabled: true,
      },
    ],
    ...overrides,
  };
}

function agentAction(
  overrides: Partial<AgentConfigAction> = {},
): AgentConfigAction {
  return {
    type: "agent-config",
    config: agentConfig(),
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Preview",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    clientVersion: "test",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

function readResponse(config: AgentConfig): AgentReadResponse {
  return {
    record: {
      filePath: "/repo/.crewon/agents/frontend.json",
      savedAt: "2026-06-17T07:00:00.000Z",
      config,
    },
  };
}

async function runAction(
  overrides: Partial<OpenAgentConfigActionParams> = {},
) {
  let panel: LibraryPanel | null = {
    kind: "agents",
    title: "Agents",
    subtitle: "Library",
    items: [],
  };
  const readParams: unknown[] = [];
  const readThreads: string[] = [];
  const handled = await openAgentConfigAction({
    action: agentAction(),
    isConnected: true,
    locale: "en",
    readAgentConfig: async (params) => {
      readParams.push(params);
      return null;
    },
    readThread: async (threadId) => {
      readThreads.push(threadId);
      return null;
    },
    setLibraryPanel: (updater) => {
      panel = updater(panel);
    },
    ...overrides,
  });
  return { handled, panel, readParams, readThreads };
}

describe("agent config actions", () => {
  it("renders local agent config without backend reads when disconnected", async () => {
    let read = false;
    const { handled, panel } = await runAction({
      isConnected: false,
      readAgentConfig: async () => {
        read = true;
        return null;
      },
    });

    expect(handled).toBe(true);
    expect(read).toBe(false);
    expect(panel).toMatchObject({
      title: "Frontend Agent",
      agentConfig: { name: "Frontend Agent" },
    });
  });

  it("loads the latest agent config and thread history", async () => {
    const latestConfig = agentConfig({
      name: "Latest Frontend Agent",
      threadId: "thread-latest",
    });
    const agentReads: unknown[] = [];
    const threadReads: string[] = [];
    const { handled, panel } = await runAction({
      readAgentConfig: async (params) => {
        agentReads.push(params);
        return readResponse(latestConfig);
      },
      readThread: async (threadId) => {
        threadReads.push(threadId);
        return thread({ id: threadId, preview: "Latest run" });
      },
    });

    expect(handled).toBe(true);
    expect(agentReads).toEqual([
      {
        agentId: null,
        name: "Frontend Agent",
        threadId: null,
      },
    ]);
    expect(threadReads).toEqual(["thread-latest"]);
    expect(panel).toMatchObject({
      title: "Latest Frontend Agent",
      agentConfig: {
        name: "Latest Frontend Agent",
        threadId: "thread-latest",
      },
      items: [
        expect.objectContaining({
          title: "No backend records",
        }),
      ],
    });
  });

  it("hydrates with the latest config when no backend thread exists", async () => {
    const latestConfig = agentConfig({ name: "Latest Agent" });
    const { handled, panel, readThreads } = await runAction({
      readAgentConfig: async () => readResponse(latestConfig),
    });

    expect(handled).toBe(true);
    expect(readThreads).toEqual([]);
    expect(panel).toMatchObject({
      title: "Latest Agent",
      agentConfig: { name: "Latest Agent" },
      items: [],
    });
  });

  it("shows hydration failures", async () => {
    const { handled, panel } = await runAction({
      readAgentConfig: async () => {
        throw new Error("agent read failed");
      },
    });

    expect(handled).toBe(true);
    expect(panel).toMatchObject({
      error: "agent read failed",
    });
  });
});
