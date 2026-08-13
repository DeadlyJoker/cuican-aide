import type { ExternalAgentConfigMigrationItem } from "@crewon-ui-model/v2/ExternalAgentConfigMigrationItem";
import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { Turn } from "@crewon-ui-model/v2/Turn";
import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { AgentConfig, LibraryPanel } from "../domain/crewonDomain";
import {
  openExternalAgentImportAction,
  type OpenExternalAgentImportActionParams,
} from "./externalAgentImportActions";

function migrationItem(
  overrides: Partial<ExternalAgentConfigMigrationItem> = {},
): ExternalAgentConfigMigrationItem {
  return {
    itemType: "AGENTS_MD",
    description: "Repo instructions",
    cwd: "/repo",
    details: null,
    ...overrides,
  };
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Base Agent",
    glyph: "◷",
    accent: "blue",
    role: "Base role",
    model: "gpt-5",
    models: ["gpt-5"],
    permission: "workspace-write",
    permissions: ["workspace-write"],
    systemPrompt: "Base prompt.",
    mcp: [],
    skills: [],
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
    cwd: "/repo",
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

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function runActionState() {
  let panel: LibraryPanel | null = {
    kind: "agents",
    title: "Agents",
    subtitle: "Library",
    items: [],
  };
  let notice: NoticeState | null = null;
  let threads: Thread[] = [];
  return {
    get notice() {
      return notice;
    },
    get panel() {
      return panel;
    },
    get threads() {
      return threads;
    },
    setLibraryPanel: (
      updater: (currentPanel: LibraryPanel | null) => LibraryPanel | null,
    ) => {
      panel = updater(panel);
    },
    setNotice: (nextNotice: NoticeState | null) => {
      notice = nextNotice;
    },
    setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => {
      threads = updater(threads);
    },
  };
}

async function runAction(
  overrides: Partial<OpenExternalAgentImportActionParams> = {},
) {
  const state = runActionState();
  const calls: string[] = [];
  const handled = await openExternalAgentImportAction({
    createBackendAgentConfig: async () => {
      calls.push("create-config");
      return agentConfig();
    },
    importExternalAgentConfig: async () => {
      calls.push("import");
      return {};
    },
    item: migrationItem(),
    locale: "en",
    openAgentsLibrary: async () => {
      calls.push("open-agents");
    },
    renameThread: async (threadId, name) => {
      calls.push(`rename:${threadId}:${name}`);
    },
    setLibraryPanel: state.setLibraryPanel,
    setNotice: state.setNotice,
    setThreadGoal: async (threadId, goal) => {
      calls.push(`goal:${threadId}:${goal}`);
    },
    setThreads: state.setThreads,
    startAgentThread: async (cwd, source) => {
      calls.push(`start-thread:${cwd}:${source}`);
      return thread();
    },
    startTurn: async (threadId, text) => {
      calls.push(`start-turn:${threadId}:${text}`);
      return { turn: turn() };
    },
    writeAgentConfig: async (config) => {
      calls.push(`write:${config.name}:${config.threadId}`);
      return {
        agentId: "agent-written",
        filePath: "/repo/.crewon/agents/imported.json",
      };
    },
    ...overrides,
  });
  return { calls, handled, state };
}

describe("external agent import actions", () => {
  it("imports an external agent, creates a thread, writes config, and starts a turn", async () => {
    const { calls, handled, state } = await runAction();

    expect(handled).toBe(true);
    expect(calls[0]).toBe("import");
    expect(calls).toContain("create-config");
    expect(calls).toContain("start-thread:/repo:agent");
    expect(calls).toContain(
      "rename:thread-1:Imported agent · Repo instructions",
    );
    expect(calls).toContain(
      "write:Imported agent · Repo instructions:thread-1",
    );
    expect(calls.some((call) => call.startsWith("goal:thread-1:"))).toBe(true);
    expect(calls.some((call) => call.startsWith("start-turn:thread-1:"))).toBe(
      true,
    );
    expect(calls).toContain("open-agents");
    expect(state.threads).toMatchObject([
      {
        id: "thread-1",
        name: "Imported agent · Repo instructions",
        turns: [{ id: "turn-1" }],
      },
    ]);
    expect(state.notice).toEqual({
      text: "Imported and created backend agent: Imported agent · Repo instructions",
      tone: "success",
    });
  });

  it("imports external config without a created agent thread", async () => {
    const startCalls: string[] = [];
    const { calls, handled, state } = await runAction({
      startAgentThread: async () => {
        startCalls.push("start-thread:none");
        return null;
      },
    });

    expect(handled).toBe(true);
    expect(calls).toEqual([
      "import",
      "create-config",
      "open-agents",
    ]);
    expect(startCalls).toEqual(["start-thread:none"]);
    expect(state.threads).toEqual([]);
    expect(state.notice).toEqual({
      text: "External config imported, but no agent thread was created",
      tone: "warning",
    });
  });

  it("shows import failures on the current library panel", async () => {
    const { handled, state } = await runAction({
      importExternalAgentConfig: async () => {
        throw new Error("import failed");
      },
    });

    expect(handled).toBe(true);
    expect(state.panel).toMatchObject({
      body: "Importing agent config...",
      error: "import failed",
    });
    expect(state.notice).toBeNull();
  });
});
