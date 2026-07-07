import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import type {
  AgentConfig,
  LibraryItemAction,
  OfficeConfig,
  OfficeMember,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import {
  buildOfficeCreatePanel,
  buildOfficeDetailPanel,
  demoOfficeRecruitPanel,
  demoOfficeRecruitWorkspace,
  officeBindThreadTurnPrompt,
  officeApprovalDecisionLabel,
  officeApprovalDecisionNotice,
  officeApprovalFailureNotice,
  officeApprovalFallbackError,
  officeApprovalLocalDecisionPanel,
  officeApprovalNotice,
  officeApprovalOptimisticPanel,
  officeApprovalSavedPanel,
  officeApprovalSystemMessage,
  officeCreateFailureMessage,
  officeCreateFailureNotice,
  officeCreateFailurePanel,
  officeCreateSubtitle,
  officeCreateTitle,
  officeCreateTurnPrompt,
  matchingOfficeDetailPanel,
  officeDetailBindFailurePanel,
  officeDetailBindFailurePatch,
  officeDetailHydratedThreadPanel,
  officeDetailHydratedThreadPatch,
  officeDetailPanel,
  officeDetailPanelPatch,
  officeRecruitCapabilitySummary,
  officeRecruitFailureNotice,
  officeRecruitFallbackError,
  officeRecruitJoinMessage,
  officeRecruitMissingAgentNoticeState,
  officeRecruitMissingAgentNotice,
  officeRecruitPersistenceWarningNotice,
  officeRecruitPersistenceWarning,
  officeRecruitSavedPanel,
  officeRecruitSuccessNotice,
  officeRecruitSuccessNoticeState,
  officeRecruitTurnPrompt,
  matchingOfficeWorkspaceConnectedPanel,
  officeThreadBindingPanel,
  officeThreadBindingPatch,
  officeThreadBoundPanel,
  officeThreadBoundPatch,
  officeWorkspaceConnectedPanel,
  officeWorkspaceConnectedPatch,
  officeWorkspaceWithApprovalDecision,
  officeWorkspaceConnected,
  officeWorkspaceWithRecruitMessage,
} from "./officeDetailPanel";

type OfficeDetailAction = Extract<LibraryItemAction, { type: "office-detail" }>;

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Ship cleaner frontend",
    members: [],
    messages: [],
    tasks: [],
    backendStatus: "connected",
    ...overrides,
  };
}

function officeAction(
  overrides: Partial<OfficeDetailAction> = {},
): OfficeDetailAction {
  return {
    type: "office-detail",
    title: "Frontend Office",
    subtitle: "Refactor desk",
    body: "Office summary",
    items: [{ title: "Plan", meta: "office" }],
    ...overrides,
  };
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Planner",
    role: "Plan work",
    model: "gpt-5",
    models: ["gpt-5"],
    permission: "workspace-write",
    permissions: ["workspace-write"],
    glyph: "◇",
    accent: "blue",
    systemPrompt: "Plan carefully.",
    mcp: [
      {
        id: "git",
        name: "Git",
        glyph: "⌁",
        accent: "green",
        description: "Git tools",
        enabled: true,
      },
      {
        id: "db",
        name: "Database",
        glyph: "▣",
        accent: "violet",
        description: "DB tools",
        enabled: false,
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

function officeMember(overrides: Partial<OfficeMember> = {}): OfficeMember {
  return {
    name: "Planner",
    role: "Plan work",
    glyph: "◇",
    accent: "blue",
    status: "Recruited",
    online: true,
    ...overrides,
  };
}

function officeConfig(overrides: Partial<OfficeConfig> = {}): OfficeConfig {
  return {
    title: "Frontend Office",
    subtitle: "Refactor desk",
    workspace: workspace({
      goal: "Coordinate frontend refactors.",
      threadId: "thread-1",
    }),
    ...overrides,
  };
}

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
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
    turns: [turn()],
    ...overrides,
  };
}

describe("office detail panel content", () => {
  it("builds office creation labels and turn prompt", () => {
    const officeWorkspace = workspace({
      goal: "Coordinate frontend refactors.",
      threadId: "thread-1",
    });

    expect(officeCreateTitle("14:30", "en")).toBe("New office 14:30");
    expect(officeCreateTitle("14:30", "zh")).toBe("新办公室 14:30");
    expect(officeCreateSubtitle("en")).toBe(
      "New office · configuration stage",
    );
    expect(officeCreateSubtitle("zh")).toBe("新建办公室 · 配置阶段");
    expect(
      officeCreateTurnPrompt({
        locale: "en",
        title: "New office 14:30",
        workspace: officeWorkspace,
      }),
    ).toBe(
      [
        "Create office: New office 14:30",
        "Backend record: pending office/create",
        "Goal: Coordinate frontend refactors.",
      ].join("\n"),
    );
  });

  it("builds created office panels", () => {
    const officeWorkspace = workspace({ threadId: "thread-1" });

    expect(
      buildOfficeCreatePanel({
        configPath: "/repo/.crewon/offices/frontend.json",
        locale: "zh",
        subtitle: "新建办公室 · 已绑定后端线程",
        title: "新办公室 14:30",
        workspace: officeWorkspace,
      }),
    ).toEqual({
      kind: "office",
      title: "新办公室 14:30",
      subtitle: "新建办公室 · 已绑定后端线程",
      configPath: "/repo/.crewon/offices/frontend.json",
      body: "后端记录：/repo/.crewon/offices/frontend.json",
      items: [],
      actions: [
        {
          id: "recruit-agent",
          label: "招募智能体",
          tone: "primary",
        },
      ],
      workspace: officeWorkspace,
    });
    expect(officeCreateFailureMessage(null, "en")).toBe(
      "Unable to create office",
    );
    expect(officeCreateFailureNotice(new Error("offline"), "zh")).toEqual({
      text: "offline",
      tone: "warning",
    });
    expect(
      officeCreateFailurePanel(
        buildOfficeCreatePanel({
          configPath: null,
          locale: "en",
          subtitle: "New office · backend thread bound",
          title: "New office 14:30",
          workspace: officeWorkspace,
        }),
        null,
        "zh",
      )?.error,
    ).toBe("创建办公室失败");
    expect(officeCreateFailurePanel(null, null, "en")).toBeNull();
  });

  it("builds office detail lifecycle patches", () => {
    const officeWorkspace = workspace({
      threadId: "thread-1",
      messages: [
        {
          author: "System",
          glyph: "⌗",
          accent: "slate",
          time: "now",
          text: "Existing message",
        },
      ],
    });
    const panel = buildOfficeDetailPanel(
      officeAction({ workspace: officeWorkspace }),
      null,
      "en",
    );

    expect(officeDetailPanelPatch(panel)).toEqual({
      ...panel,
      error: undefined,
    });
    expect(
      officeDetailPanel(
        { ...panel, title: "Office library", error: "old error" },
        panel,
      ),
    ).toEqual({
      ...panel,
      error: undefined,
    });
    expect(
      matchingOfficeDetailPanel(
        { ...panel, title: "Frontend Office" },
        "Frontend Office",
        { ...panel, title: "Updated Office" },
      ),
    ).toEqual({
      ...panel,
      title: "Updated Office",
      error: undefined,
    });
    expect(
      matchingOfficeDetailPanel(
        { ...panel, title: "Other Office" },
        "Frontend Office",
        { ...panel, title: "Updated Office" },
      ),
    ).toEqual({ ...panel, title: "Other Office" });
    expect(
      officeDetailHydratedThreadPatch({
        latestPanel: panel,
        locale: "en",
        thread: thread({
          turns: [
            turn({
              items: [
                {
                  type: "agentMessage",
                  id: "item-1",
                  text: "Backend update",
                  phase: null,
                  memoryCitation: null,
                },
              ],
            }),
          ],
        }),
      }).workspace,
    ).toMatchObject({
      threadId: "thread-1",
      messages: [
        { text: "Existing message" },
        { author: "Crewon", text: "Backend update" },
      ],
    });
    expect(
      officeDetailHydratedThreadPanel(
        panel,
        "thread-1",
        {
          latestPanel: panel,
          locale: "en",
          thread: thread({
            turns: [
              turn({
                items: [
                  {
                    type: "agentMessage",
                    id: "item-1",
                    text: "Backend update",
                    phase: null,
                    memoryCitation: null,
                  },
                ],
              }),
            ],
          }),
        },
      )?.workspace,
    ).toMatchObject({
      threadId: "thread-1",
      messages: [
        { text: "Existing message" },
        { author: "Crewon", text: "Backend update" },
      ],
    });
    expect(
      officeDetailHydratedThreadPanel(panel, "thread-2", {
        latestPanel: panel,
        locale: "en",
        thread: thread(),
      }),
    ).toEqual(panel);
    expect(
      officeDetailBindFailurePatch({
        error: null,
        locale: "zh",
        workspace: officeWorkspace,
      }),
    ).toMatchObject({
      error: "绑定办公室线程失败",
      workspace: { backendStatus: "error" },
    });
    expect(officeDetailBindFailurePanel(panel, null, "zh")).toMatchObject({
      error: "绑定办公室线程失败",
      workspace: { backendStatus: "error" },
    });
    expect(
      officeDetailBindFailurePanel({ ...panel, workspace: undefined }, null, "zh"),
    ).toEqual({ ...panel, workspace: undefined });
  });

  it("builds office thread binding patches and prompts", () => {
    const officeWorkspace = workspace({
      threadId: "thread-1",
      backendStatus: "connected",
    });

    expect(officeThreadBindingPatch(officeWorkspace)).toEqual({
      workspace: {
        ...officeWorkspace,
        threadId: undefined,
        backendStatus: "binding",
      },
    });
    expect(
      officeThreadBindingPanel({
        kind: "office",
        title: "Frontend Office",
        subtitle: "Refactor desk",
        items: [],
        workspace: officeWorkspace,
      }),
    ).toMatchObject({
      workspace: {
        threadId: undefined,
        backendStatus: "binding",
      },
    });
    expect(
      officeThreadBoundPatch({
        locale: "en",
        subtitle: "Refactor desk",
        threadId: "thread-2",
        workspace: officeWorkspace,
      }),
    ).toEqual({
      subtitle: "Refactor desk · backend thread bound",
      workspace: {
        ...officeWorkspace,
        threadId: "thread-2",
        backendStatus: "connected",
      },
    });
    expect(
      officeThreadBoundPanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: officeWorkspace,
        },
        { locale: "en", threadId: "thread-2" },
      ),
    ).toMatchObject({
      subtitle: "Refactor desk · backend thread bound",
      workspace: {
        threadId: "thread-2",
        backendStatus: "connected",
      },
    });
    expect(
      officeThreadBoundPatch({
        locale: "zh",
        subtitle: "重构办公室 · 已绑定后端线程",
        threadId: "thread-2",
        workspace: officeWorkspace,
      }).subtitle,
    ).toBe("重构办公室 · 已绑定后端线程");
    expect(
      officeBindThreadTurnPrompt({
        config: officeConfig(),
        locale: "en",
        officeConfigPath: "/repo/.crewon/offices/frontend.json",
        panel: { title: "Frontend Office" },
      }),
    ).toBe(
      [
        "Bind office: Frontend Office",
        "Backend record: /repo/.crewon/offices/frontend.json",
        "Goal: Coordinate frontend refactors.",
      ].join("\n"),
    );
    expect(
      officeBindThreadTurnPrompt({
        config: officeConfig({
          workspace: workspace({ goal: "协调前端重构。" }),
        }),
        locale: "zh",
        officeConfigPath: null,
        panel: { title: "前端办公室" },
      }),
    ).toBe(
      ["绑定办公室：前端办公室", "后端记录：已提交到 office/save", "目标：协调前端重构。"].join(
        "\n",
      ),
    );
  });

  it("builds demo recruit workspace updates", () => {
    expect(demoOfficeRecruitWorkspace(workspace(), "en")).toMatchObject({
      members: [
        {
          name: "New",
          role: "Custom agent",
          glyph: "✦",
          accent: "rose",
          status: "Just joined",
          online: true,
        },
      ],
      messages: [
        {
          author: "System",
          glyph: "⌗",
          accent: "slate",
          time: "now",
          kind: "system",
          text: "New member joined the office group chat and can be @mentioned for tasks",
        },
      ],
    });
    expect(
      demoOfficeRecruitPanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: workspace(),
        },
        "zh",
      )?.workspace?.members,
    ).toEqual([
      {
        name: "新成员",
        role: "自定义智能体",
        glyph: "✦",
        accent: "rose",
        status: "刚加入群聊",
        online: true,
      },
    ]);
    expect(demoOfficeRecruitPanel(null, "en")).toBeNull();
  });

  it("builds office recruit copy and prompts", () => {
    const agent = agentConfig();
    const member = officeMember();
    const capabilitySummary = officeRecruitCapabilitySummary(agent, "en");

    expect(capabilitySummary).toEqual({
      enabledMcp: "Git",
      enabledSkills: "Review",
    });
    expect(officeRecruitMissingAgentNotice("en")).toBe(
      "No backend agent is available to recruit. Create and save an agent in the agent library first, then recruit it into the office.",
    );
    expect(officeRecruitMissingAgentNoticeState("en")).toEqual({
      text: "No backend agent is available to recruit. Create and save an agent in the agent library first, then recruit it into the office.",
      tone: "warning",
    });
    expect(officeRecruitPersistenceWarning("zh")).toBe(
      "招募智能体未写入后端办公室配置，请稍后重试。",
    );
    expect(officeRecruitPersistenceWarningNotice("zh")).toEqual({
      text: "招募智能体未写入后端办公室配置，请稍后重试。",
      tone: "warning",
    });
    expect(officeRecruitFallbackError("en")).toBe(
      "Unable to write agent recruitment to backend",
    );
    expect(officeRecruitFailureNotice(null, "en")).toEqual({
      text: "Unable to write agent recruitment to backend",
      tone: "warning",
    });
    expect(officeRecruitSuccessNotice("Planner", "zh")).toBe(
      "已招募 Planner，并写入后端办公室配置",
    );
    expect(officeRecruitSuccessNoticeState("Planner", "zh")).toEqual({
      text: "已招募 Planner，并写入后端办公室配置",
      tone: "success",
    });
    expect(
      officeRecruitJoinMessage({
        agent,
        enabledMcp: capabilitySummary.enabledMcp,
        enabledSkills: capabilitySummary.enabledSkills,
        locale: "en",
        member,
      }),
    ).toEqual({
      author: "System",
      glyph: "⌗",
      accent: "slate",
      time: "now",
      kind: "system",
      text: "Recruited Planner from agents. Model gpt-5; MCP: Git; skills: Review.",
    });
    expect(
      officeRecruitTurnPrompt({
        agent,
        enabledMcp: capabilitySummary.enabledMcp,
        enabledSkills: capabilitySummary.enabledSkills,
        locale: "en",
        member,
        officeTitle: "Frontend Office",
        threadId: "thread-1",
      }),
    ).toBe(
      [
        'Office "Frontend Office" recruited agent: Planner, role: Plan work. Model: gpt-5. MCP: Git. Skills: Review. Include it in future collaboration.',
        "Backend record: submitted to office/member/add",
        "Execution thread: thread-1",
      ].join("\n"),
    );
  });

  it("builds recruited workspace updates without duplicating members", () => {
    const baseWorkspace = workspace({
      members: [officeMember({ name: "Existing" })],
      messages: [
        {
          author: "System",
          glyph: "⌗",
          accent: "slate",
          time: "now",
          text: "Existing",
        },
      ],
    });
    const message = officeRecruitJoinMessage({
      agent: agentConfig(),
      enabledMcp: "Git",
      enabledSkills: "Review",
      locale: "en",
      member: officeMember(),
    });

    expect(officeWorkspaceWithRecruitMessage(baseWorkspace, message)).toEqual({
      ...baseWorkspace,
      messages: [...baseWorkspace.messages, message],
    });
    expect(officeWorkspaceConnected(baseWorkspace, "thread-2")).toMatchObject({
      threadId: "thread-2",
      backendStatus: "connected",
    });
    expect(officeWorkspaceConnectedPatch(baseWorkspace, "thread-2")).toEqual({
      workspace: {
        ...baseWorkspace,
        threadId: "thread-2",
        backendStatus: "connected",
      },
    });
    expect(
      officeWorkspaceConnectedPanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: baseWorkspace,
        },
        baseWorkspace,
        "thread-2",
      ),
    ).toMatchObject({
      workspace: {
        threadId: "thread-2",
        backendStatus: "connected",
      },
    });
    expect(
      matchingOfficeWorkspaceConnectedPanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: { ...baseWorkspace, threadId: "thread-1" },
        },
        baseWorkspace,
        "thread-1",
      ),
    ).toMatchObject({
      workspace: {
        threadId: "thread-1",
        backendStatus: "connected",
      },
    });
    expect(
      officeRecruitSavedPanel(
        {
          kind: "office",
          title: "Frontend Office",
          subtitle: "Refactor desk",
          items: [],
          workspace: baseWorkspace,
        },
        {
          config: officeConfig({
            workspace: workspace({ backendStatus: "local", threadId: "old" }),
          }),
          threadId: "thread-2",
        },
      )?.workspace,
    ).toMatchObject({
      backendStatus: "connected",
      threadId: "thread-2",
    });
    expect(
      officeRecruitSavedPanel(null, {
        config: officeConfig(),
        threadId: "thread-2",
      }),
    ).toBeNull();
  });

  it("builds approval decisions and workspace updates", () => {
    const approval = {
      id: "approval-1",
      actor: "Planner",
      glyph: "P",
      accent: "blue" as const,
      action: "Write file",
      detail: "Create artifact",
      risk: "medium" as const,
      time: "now",
    };
    const baseWorkspace = workspace({
      activity: {
        trace: [],
        approvals: [approval],
        budget: [],
        budgetCapUsd: 10,
        artifacts: [],
      },
    });
    const message = officeApprovalSystemMessage({
      approval,
      decision: "approved",
      locale: "en",
    });
    const activity = baseWorkspace.activity!;

    expect(officeApprovalDecisionLabel(approval)).toBe("Planner · Write file");
    expect(officeApprovalDecisionLabel(null)).toBe("");
    expect(
      officeApprovalNotice({
        decision: "denied",
        label: "Planner · Write file",
        locale: "zh",
      }),
    ).toBe("已拒绝：Planner · Write file");
    expect(
      officeApprovalDecisionNotice({
        approval,
        decision: "approved",
        locale: "en",
      }),
    ).toEqual({
      text: "Approved: Planner · Write file",
      tone: "success",
    });
    expect(
      officeApprovalDecisionNotice({
        approval: null,
        decision: "denied",
        locale: "zh",
      }),
    ).toEqual({
      text: "已拒绝：",
      tone: "warning",
    });
    expect(message).toEqual({
      author: "System",
      glyph: "⌗",
      accent: "green",
      time: "now",
      kind: "system",
      text: "Approved approval: Planner · Write file",
    });
    expect(
      officeWorkspaceWithApprovalDecision({
        decision: "approved",
        message,
        requestId: "approval-1",
        workspace: baseWorkspace,
      }),
    ).toEqual({
      ...baseWorkspace,
      activity: {
        ...activity,
        approvals: [{ ...approval, decision: "approved" }],
      },
      messages: [message],
    });
    const panel = {
      kind: "office" as const,
      title: "Frontend Office",
      subtitle: "Refactor desk",
      items: [],
      workspace: baseWorkspace,
    };

    expect(
      officeApprovalLocalDecisionPanel(panel, {
        decision: "denied",
        requestId: "approval-1",
      })?.workspace?.activity?.approvals,
    ).toEqual([{ ...approval, decision: "denied" }]);
    expect(
      officeApprovalOptimisticPanel(panel, {
        decision: "approved",
        message,
        requestId: "approval-1",
        workspace: baseWorkspace,
      })?.workspace,
    ).toEqual({
      ...baseWorkspace,
      activity: {
        ...activity,
        approvals: [{ ...approval, decision: "approved" }],
      },
      messages: [message],
      threadId: panel.workspace.threadId,
      backendStatus: panel.workspace.backendStatus,
    });
    expect(
      officeApprovalSavedPanel(panel, {
        config: officeConfig({
          workspace: workspace({ backendStatus: "local", threadId: "old" }),
        }),
        threadId: "thread-2",
      })?.workspace,
    ).toMatchObject({
      backendStatus: "connected",
      threadId: "thread-2",
    });
    expect(officeApprovalFallbackError("en")).toBe(
      "Unable to write approval decision to backend",
    );
    expect(officeApprovalFailureNotice(null, "en")).toEqual({
      text: "Unable to write approval decision to backend",
      tone: "warning",
    });
    expect(officeApprovalFailureNotice(new Error("offline"), "zh")).toEqual({
      text: "offline",
      tone: "warning",
    });
  });

  it("builds panels without workspace details", () => {
    expect(buildOfficeDetailPanel(officeAction(), null, "en")).toEqual({
      kind: "office",
      title: "Frontend Office",
      subtitle: "Refactor desk",
      configPath: undefined,
      body: "Office summary",
      actions: [
        {
          id: "recruit-agent",
          label: "Recruit agent",
          tone: "primary",
        },
      ],
      items: [{ title: "Plan", meta: "office" }],
      workspace: undefined,
    });
  });

  it("adds thread and backend record actions when available", () => {
    expect(
      buildOfficeDetailPanel(
        officeAction({
          workspace: workspace({ threadId: "thread-1" }),
          configPath: "/repo/.crewon/offices/frontend.json",
        }),
        null,
        "zh",
      ).actions,
    ).toEqual([
      {
        id: "open-thread",
        label: "打开后端线程",
        threadId: "thread-1",
      },
      {
        id: "recruit-agent",
        label: "招募智能体",
        tone: "primary",
      },
      {
        id: "open-path",
        label: "打开后端记录",
        pathToOpen: "/repo/.crewon/offices/frontend.json",
        pathKind: "file",
      },
      {
        id: "delete-config-file",
        label: "删除后端记录",
        pathToOpen: "/repo/.crewon/offices/frontend.json",
        pathKind: "file",
        domainConfigKind: "office",
        tone: "danger",
      },
    ]);
  });

  it("uses refreshed backend config title and workspace", () => {
    const refreshedWorkspace = workspace({ threadId: "thread-2" });

    expect(
      buildOfficeDetailPanel(
        officeAction({ workspace: workspace({ threadId: "thread-1" }) }),
        {
          title: "Updated Office",
          subtitle: "Backend record",
          workspace: refreshedWorkspace,
        },
        "en",
      ),
    ).toMatchObject({
      title: "Updated Office",
      subtitle: "Backend record",
      body: undefined,
      workspace: refreshedWorkspace,
      actions: [
        {
          id: "open-thread",
          label: "Open backend thread",
          threadId: "thread-2",
        },
        {
          id: "recruit-agent",
          label: "Recruit agent",
          tone: "primary",
        },
      ],
    });
  });
});
