import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import type {
  AgentConfig,
  ArtifactItem,
  LibraryPanel,
  OfficeMessage,
  OfficeWorkspace,
} from "../../domain/crewonDomain";
import type { AppDomainActionHandlersParams } from "./appDomainActionHandlers";
import type {
  EnsureBackendToolThreadParams,
  RecordBackendToolEventParams,
} from "../../backend/backendToolThreadActions";
import type { SaveAgentConfigParams } from "../../library/libraryAgentSaveActions";
import type { OfficeApprovalDecisionActionParams } from "../../office/officeApprovalActions";
import type { OfficeArtifactActionParams } from "../../office/officeArtifactActions";

const backendToolSpy = vi.hoisted(() => ({
  ensureParams: null as EnsureBackendToolThreadParams | null,
  recordParams: null as RecordBackendToolEventParams | null,
  ensure: vi.fn(async (params: EnsureBackendToolThreadParams) => {
    backendToolSpy.ensureParams = params;
    return "tool-thread-1";
  }),
  record: vi.fn(async (params: RecordBackendToolEventParams) => {
    backendToolSpy.recordParams = params;
    return true;
  }),
}));

const agentSaveSpy = vi.hoisted(() => ({
  params: null as SaveAgentConfigParams | null,
  save: vi.fn(async (params: SaveAgentConfigParams) => {
    agentSaveSpy.params = params;
    return true;
  }),
}));

const officeActionSpy = vi.hoisted(() => ({
  approvalParams: null as OfficeApprovalDecisionActionParams | null,
  artifactParams: null as OfficeArtifactActionParams | null,
  approval: vi.fn(async (params: OfficeApprovalDecisionActionParams) => {
    officeActionSpy.approvalParams = params;
    return true;
  }),
  artifact: vi.fn(async (params: OfficeArtifactActionParams) => {
    officeActionSpy.artifactParams = params;
    return true;
  }),
}));

const domainOfficeSpy = vi.hoisted(() => ({
  decide: vi.fn(async () => null),
  upsertArtifact: vi.fn(async () => null),
}));

const agentPanelSpy = vi.hoisted(() => ({
  toggle: vi.fn((panel, group, id) => ({
    ...panel,
    toggled: { group, id },
  })),
  update: vi.fn((panel, patch) => ({
    ...panel,
    agentConfig: { ...panel?.agentConfig, ...patch },
  })),
}));

vi.mock("../../backend/backendToolThreadActions", () => ({
  ensureBackendToolThreadAction: backendToolSpy.ensure,
  recordBackendToolEventAction: backendToolSpy.record,
}));

vi.mock("../../library/libraryAgentSaveActions", () => ({
  saveAgentConfigAction: agentSaveSpy.save,
}));

vi.mock("../../office/officeApprovalActions", () => ({
  handleOfficeApprovalDecisionAction: officeActionSpy.approval,
}));

vi.mock("../../office/officeArtifactActions", () => ({
  handleOfficeArtifactAction: officeActionSpy.artifact,
}));

vi.mock("../../domain/domainOfficeBackend", () => ({
  decideAppOfficeApproval: domainOfficeSpy.decide,
  upsertOfficeArtifact: domainOfficeSpy.upsertArtifact,
}));

vi.mock("../../agent-config/agentConfigPanel", () => ({
  agentCapabilityToggledPanel: agentPanelSpy.toggle,
  agentConfigUpdatedPanel: agentPanelSpy.update,
}));

const { createAppDomainActionHandlers } = await import(
  "./appDomainActionHandlers"
);

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function thread(id = "thread-1"): Thread {
  return {
    id,
    name: "Thread",
    status: { type: "loaded" },
    turns: [],
  } as unknown as Thread;
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    accent: "blue",
    glyph: "A",
    mcp: [],
    model: "gpt-5",
    models: [],
    name: "Agent",
    permission: "default",
    permissions: [],
    role: "Role",
    skills: [],
    systemPrompt: "",
    ...overrides,
  };
}

function workspace(): OfficeWorkspace {
  return {
    goal: "Ship",
    members: [],
    messages: [],
    tasks: [],
  };
}

function libraryPanel(
  overrides: Partial<LibraryPanel> = {},
): LibraryPanel {
  return {
    agentConfig: agentConfig(),
    items: [],
    kind: "agents",
    subtitle: "Library",
    title: "Agents",
    ...overrides,
  };
}

function createParams(
  overrides: Partial<AppDomainActionHandlersParams> = {},
): AppDomainActionHandlersParams {
  return {
    busyToolId: null,
    client: client(),
    ensureOfficeThread: async () => ({
      config: {
        title: "Office",
        subtitle: "Workspace",
        workspace: {
          ...workspace(),
          threadId: "office-thread-1",
        },
      },
      filePath: "/offices/office.json",
      threadId: "office-thread-1",
    }),
    handleCapabilityPanelItem: async () => {},
    isConnected: true,
    isMissingThreadError: () => false,
    libraryPanel: libraryPanel(),
    locale: "en",
    resolveBackendCwd: async () => "/repo",
    selectedThreadId: "thread-1",
    setActiveTurnByThread: () => {},
    setBusyToolId: () => {},
    setCapabilityDockOpen: () => {},
    setCapabilityPanel: () => {},
    setLibraryPanel: () => {},
    setNotice: () => {},
    setThreads: () => {},
    startBackendDomainThread: async () => thread("domain-thread-1"),
    threads: [],
    uniqueOfficeArtifactId: () => "artifact-1",
    writeAgentConfig: async () => null,
    ...overrides,
  };
}

describe("app domain action handlers", () => {
  beforeEach(() => {
    backendToolSpy.ensureParams = null;
    backendToolSpy.recordParams = null;
    agentSaveSpy.params = null;
    officeActionSpy.approvalParams = null;
    officeActionSpy.artifactParams = null;
    vi.clearAllMocks();
  });

  it("wires backend tool thread helpers to the current client", async () => {
    const calls: unknown[] = [];
    const handlers = createAppDomainActionHandlers(
      createParams({
        client: client({
          async renameThread(threadId, title) {
            calls.push({ method: "renameThread", threadId, title });
          },
          async setThreadGoal(threadId, goal, tokenBudget) {
            calls.push({ goal, method: "setThreadGoal", threadId, tokenBudget });
            return null as unknown as Awaited<
              ReturnType<AppServerClient["setThreadGoal"]>
            >;
          },
          async startThread(cwd, source) {
            calls.push({ cwd, method: "startThread", source });
            return thread("tool-thread-1");
          },
          async startTurn(threadId, text) {
            calls.push({ method: "startTurn", text, threadId });
            return null as unknown as Awaited<
              ReturnType<AppServerClient["startTurn"]>
            >;
          },
        }),
      }),
    );

    await handlers.ensureBackendToolThread("docs", "search");
    await handlers.recordBackendToolEvent("thread-1", "Search", "body");
    const ensureParams = backendToolSpy.ensureParams;
    const recordParams = backendToolSpy.recordParams;
    if (!ensureParams || !recordParams) {
      throw new Error("backend tool actions were not wired");
    }
    await ensureParams.renameThread("tool-thread-1", "Docs Search");
    await ensureParams.setThreadGoal("tool-thread-1", "Goal", null);
    await ensureParams.startThread("/repo", "tool");
    await recordParams.startTurn("thread-1", "Prompt");

    expect(ensureParams).toMatchObject({
      locale: "en",
      selectedThreadId: "thread-1",
      serverName: "docs",
      toolName: "search",
    });
    expect(recordParams).toMatchObject({
      body: "body",
      threadId: "thread-1",
      title: "Search",
    });
    expect(calls).toEqual([
      {
        method: "renameThread",
        threadId: "tool-thread-1",
        title: "Docs Search",
      },
      {
        goal: "Goal",
        method: "setThreadGoal",
        threadId: "tool-thread-1",
        tokenBudget: null,
      },
      { cwd: "/repo", method: "startThread", source: "tool" },
      { method: "startTurn", text: "Prompt", threadId: "thread-1" },
    ]);
  });

  it("wires agent saving through current panel config and domain thread helpers", async () => {
    const writeAgentConfig = vi.fn(async () => ({
      agentId: "agent-1",
      filePath: "agents/agent.json",
    }));
    const handlers = createAppDomainActionHandlers(
      createParams({
        libraryPanel: libraryPanel({ agentConfig: agentConfig({ name: "Coder" }) }),
        writeAgentConfig,
      }),
    );

    await handlers.saveAgentConfig();
    const params = agentSaveSpy.params;
    if (!params) {
      throw new Error("save action was not called");
    }
    await params.startAgentThread();
    await params.writeAgentConfig(agentConfig({ name: "Coder" }));

    expect(params.config).toMatchObject({ name: "Coder" });
    expect(params.threads).toEqual([]);
    expect(writeAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Coder" }),
    );
  });

  it("wires office approval decisions through the backend helper", async () => {
    const currentPanel = libraryPanel({ kind: "office", workspace: workspace() });
    const handlers = createAppDomainActionHandlers(
      createParams({ libraryPanel: currentPanel }),
    );
    const message: OfficeMessage = {
      accent: "blue",
      author: "System",
      glyph: "S",
      text: "Approved",
      time: "now",
    };

    await handlers.handleApprovalDecision("approval-1", "approved");
    const params = officeActionSpy.approvalParams;
    if (!params) {
      throw new Error("approval action was not called");
    }
    await params.decideOfficeApproval(
      currentPanel,
      currentPanel.workspace!,
      "office-thread-1",
      "approval-1",
      "approved",
      message,
    );

    expect(params).toMatchObject({
      decision: "approved",
      id: "approval-1",
      isConnected: true,
      locale: "en",
      panel: currentPanel,
    });
    expect(domainOfficeSpy.decide).toHaveBeenCalledWith({
      approvalId: "approval-1",
      client: expect.any(Object),
      decision: "approved",
      message,
      panel: currentPanel,
      resolveBackendCwd: expect.any(Function),
      threadId: "office-thread-1",
      workspace: currentPanel.workspace,
    });
  });

  it("wires office artifacts through directory handling and backend upsert", async () => {
    const handleCapabilityPanelItem = vi.fn(async () => {});
    const currentPanel = libraryPanel({ kind: "office", workspace: workspace() });
    const artifact = {
      accent: "blue",
      glyph: "A",
      title: "Artifact",
    } as ArtifactItem;
    const handlers = createAppDomainActionHandlers(
      createParams({
        handleCapabilityPanelItem,
        libraryPanel: currentPanel,
      }),
    );

    await handlers.handleOfficeArtifact(artifact);
    const params = officeActionSpy.artifactParams;
    if (!params) {
      throw new Error("artifact action was not called");
    }
    await params.handleDirectoryItem({
      kind: "directory",
      label: "Artifact",
      path: "/repo/artifact",
    });
    await params.upsertOfficeArtifact(
      "/repo",
      currentPanel,
      currentPanel.workspace!,
      "office-thread-1",
      artifact,
      {
        accent: "blue",
        author: "System",
        glyph: "S",
        text: "Saved",
        time: "now",
      },
    );

    expect(params).toMatchObject({
      artifact,
      busyToolId: null,
      isConnected: true,
      libraryPanel: currentPanel,
      locale: "en",
    });
    expect(params.uniqueId()).toBe("artifact-1");
    expect(handleCapabilityPanelItem).toHaveBeenCalledWith({
      kind: "directory",
      label: "Artifact",
      path: "/repo/artifact",
    });
    expect(domainOfficeSpy.upsertArtifact).toHaveBeenCalledWith(
      expect.any(Object),
      "/repo",
      currentPanel,
      currentPanel.workspace,
      "office-thread-1",
      artifact,
      expect.objectContaining({ text: "Saved" }),
    );
  });

  it("keeps agent panel field mutations in the domain action factory", () => {
    let panel: LibraryPanel | null = libraryPanel();
    const handlers = createAppDomainActionHandlers(
      createParams({
        setLibraryPanel: (panelOrUpdater) => {
          panel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(panel)
              : panelOrUpdater;
        },
      }),
    );

    handlers.updateAgentConfig({ name: "Updated" });
    handlers.toggleAgentCapability("skills", "skill-1");

    expect(agentPanelSpy.update).toHaveBeenCalledWith(
      expect.any(Object),
      { name: "Updated" },
    );
    expect(agentPanelSpy.toggle).toHaveBeenCalledWith(
      expect.any(Object),
      "skills",
      "skill-1",
    );
    expect(panel).toMatchObject({ toggled: { group: "skills", id: "skill-1" } });
  });
});
