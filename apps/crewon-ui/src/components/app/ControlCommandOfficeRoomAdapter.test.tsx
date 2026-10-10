// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { catalogPage } from "./ControlOfficeThread.test-support";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { OfficeContract } from "@crewon/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ControlOfficeDefinitionRecordReference } from "../../lib/office/officePanelFromRecord";
import { createDefaultAgentConfig } from "../../lib/agent-config/agentConfigDefaults";
import {
  officeMemberAgentProfileId,
  type OfficeMemberAgentProfile,
} from "../../lib/office/officeMemberAgentProfile";
import { controlTeamDelegationMarker } from "../../lib/control-runtime/controlTeamDelegation";
import {
  controlOfficeComposerRuntimeSettings,
  createControlCommandOfficeRoomAdapter,
  readControlOfficeActiveGoal,
  refreshAcceptedControlOfficeTurn,
} from "./ControlCommandOfficeRoomAdapter";
import {
  controlOfficeChatErrorMessage,
  controlOfficeChatMessages,
  controlOfficeLiveThread,
  controlOfficeStreamingAuthor,
  controlOfficeThreadTitle,
  controlOfficeVisibleThread,
} from "./controlOfficeChatPresentation";

const record: ControlOfficeDefinitionRecordReference = {
  authority: "controlDefinition",
  filePath: "control:office:office-version-1",
  config: {
    title: "产品交付办公室",
    subtitle: "Control · r2",
  },
  definition: {
    officeId: "office-1",
    officeVersionId: "office-version-1",
    revision: 2,
    members: [
      {
        agentVersionId: "agent-version-lead",
        displayName: "交付组长",
        memberId: "member-lead",
      },
      {
        agentVersionId: "agent-version-review",
        displayName: "审阅员工",
        memberId: "member-review",
      },
    ],
    executionTargets: [
      { agentVersionId: "agent-version-lead", targetId: "target-lead" },
      { agentVersionId: "agent-version-review", targetId: "target-review" },
    ],
  },
};

function createRuntime() {
  return {
    interruptTurn: vi.fn(),
    listThreads: vi.fn(async () => []),
    readThread: vi.fn(),
    renameThread: vi.fn(),
    startTurn: vi.fn(),
  };
}

async function renderBoundOfficeMarkup(
  adapter: ReturnType<typeof createControlCommandOfficeRoomAdapter>,
): Promise<string> {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  try {
    await act(async () =>
      root.render(adapter.render(record, vi.fn(), vi.fn())),
    );
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

describe("ControlCommandOfficeRoomAdapter", () => {
  it("uses one durable thread title for the Office group chat", () => {
    expect(controlOfficeThreadTitle(record)).toBe("💬 产品交付办公室");
  });

  it("keeps an already-bound Office on its thread when titles collide", () => {
    const sameTitle = controlOfficeThreadTitle(record);
    const wrong = { id: "thread-wrong", name: sameTitle } as Thread;
    const expected = { id: "thread-expected", name: sameTitle } as Thread;

    expect(
      controlOfficeLiveThread(
        [wrong, expected],
        "thread-expected",
        sameTitle,
        "legacy-title",
      ),
    ).toBe(expected);
    expect(
      controlOfficeLiveThread(
        [wrong],
        "thread-missing",
        sameTitle,
        "legacy-title",
      ),
    ).toBeNull();
  });

  it("preserves loaded Office history while adopting live turn updates", () => {
    const loadedTurn = {
      id: "turn-old",
      status: "completed",
      items: [],
    };
    const liveTurn = {
      id: "turn-live",
      status: "inProgress",
      items: [],
    };
    const loaded = {
      id: "thread-live",
      status: { type: "idle" },
      turns: [loadedTurn],
    } as unknown as Thread;
    const live = {
      id: "thread-live",
      status: { type: "notLoaded" },
      turns: [liveTurn],
    } as unknown as Thread;

    expect(controlOfficeVisibleThread(loaded, live)).toMatchObject({
      status: { type: "idle" },
      turns: [loadedTurn, liveTurn],
    });
  });

  it("never resurrects replaced turns from loaded history or delayed live updates", () => {
    const turn = (id: string) => ({ id, status: "completed", items: [] });
    const loaded = {
      id: "thread-1",
      status: { type: "idle" },
      turns: [turn("keep"), turn("removed"), turn("later")],
    } as unknown as Thread;
    const live = {
      ...loaded,
      turns: [turn("removed"), turn("new")],
    } as unknown as Thread;
    const options = { removedTurnIds: new Set(["removed", "later"]) };
    expect(
      controlOfficeVisibleThread(loaded, live, options)?.turns.map(
        (item) => item.id,
      ),
    ).toEqual(["keep", "new"]);
    expect(
      controlOfficeVisibleThread(loaded, null, options)?.turns.map(
        (item) => item.id,
      ),
    ).toEqual(["keep"]);
    expect(
      controlOfficeVisibleThread(null, live, options)?.turns.map(
        (item) => item.id,
      ),
    ).toEqual(["new"]);
  });

  it("maps every Office permission without claiming unsupported reasoning effort", () => {
    for (const [permission, approvalPolicy, approvalsReviewer, sandboxMode] of [
      ["request-approval", "on-request", "user", "workspace-write"],
      ["approve-for-me", "on-request", "auto_review", "workspace-write"],
      ["full-access", "never", "user", "danger-full-access"],
    ] as const) {
      expect(
        controlOfficeComposerRuntimeSettings({
          executionIntent: "plan",
          model: "gpt-5.6",
          permission,
          record,
        }),
      ).toEqual({
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(approvalsReviewer ? { approvalsReviewer } : {}),
        executionIntent: "plan",
        model: "gpt-5.6",
        ...(sandboxMode ? { sandboxMode } : {}),
        scene: {
          executionTarget: { id: "office-version-1", kind: "team" },
          mode: "coordinate",
          sceneId: "office",
        },
        teamMemberProfiles: [],
        threadSource: "office",
      });
    }
  });

  it("explains an inactive Office member instead of exposing a runtime code", () => {
    expect(
      controlOfficeChatErrorMessage(
        new Error("control_team_agent_version_unavailable"),
        "zh",
      ),
    ).toBe("这个办公室里有成员暂时不可用，请在成员设置中更新后再试。");
    expect(
      controlOfficeChatErrorMessage(
        new Error("control_team_plan_unsupported"),
        "zh",
      ),
    ).toContain("多成员办公室暂不支持计划模式");
    expect(
      controlOfficeChatErrorMessage(
        new Error("control_execution_intent_capability_unavailable"),
        "zh",
      ),
    ).toContain("当前后端版本还不支持目标或计划模式");
    expect(
      controlOfficeChatErrorMessage(new Error("goal_usage_limited"), "en"),
    ).toContain("reached its usage or budget limit");
  });

  it("never exposes an internal error code to the user", () => {
    expect(
      controlOfficeChatErrorMessage(
        new Error("control_unexpected_internal_failure"),
        "zh",
      ),
    ).toBe("操作没有完成，请稍后再试。");
  });

  it("keeps optional Goal metadata failures out of the authoritative Office flow", async () => {
    const getThreadGoal = vi
      .fn()
      .mockResolvedValueOnce({
        eventSequence: 1,
        goal: { status: "active" },
      })
      .mockRejectedValueOnce(new Error("goal metadata unavailable"));
    const client = { getThreadGoal } as never;

    await expect(readControlOfficeActiveGoal(client, "thread-1")).resolves.toBe(
      true,
    );
    await expect(
      readControlOfficeActiveGoal(client, "thread-1"),
    ).resolves.toBeUndefined();
  });

  it("does not turn a post-acceptance refresh failure into a duplicate-send prompt", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("temporary refresh"));

    await expect(
      refreshAcceptedControlOfficeTurn(refresh),
    ).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows one user bubble when loaded and live turns share the same message", () => {
    const userMessage = {
      id: "message-shared",
      type: "userMessage" as const,
      content: [{ type: "text" as const, text: "检查发布" }],
    };
    const thread = {
      turns: [
        { id: "turn-loading", startedAt: 1, items: [userMessage] },
        {
          id: "turn-final",
          startedAt: 1,
          items: [
            userMessage,
            { id: "answer", type: "agentMessage", text: "暂缓发布" },
          ],
        },
      ],
    } as unknown as Thread;

    const messages = controlOfficeChatMessages(
      thread,
      "交付组长",
      record.definition.members,
      "zh",
    );

    expect(messages.filter((message) => message.self)).toHaveLength(1);
    expect(messages.filter((message) => !message.self)).toHaveLength(1);
  });

  it("keeps attached file contents out of the visible user message", () => {
    const thread = {
      turns: [
        {
          id: "turn-1",
          startedAt: 1,
          items: [
            {
              id: "message-1",
              type: "userMessage",
              content: [
                {
                  type: "text",
                  text: "帮我审阅这份方案\n\n[附件：方案.md]\n内部内容\n[附件结束]",
                },
              ],
            },
          ],
        },
      ],
    } as unknown as Thread;

    expect(
      controlOfficeChatMessages(
        thread,
        "交付组长",
        record.definition.members,
        "zh",
      )[0]?.text,
    ).toBe("帮我审阅这份方案");
  });

  it("attributes a directly mentioned reply to the selected member", () => {
    const thread = {
      turns: [
        {
          id: "turn-1",
          startedAt: 1,
          items: [
            {
              id: "message-1",
              type: "userMessage",
              content: [{ type: "text", text: "@审阅员工 检查风险" }],
            },
            {
              id: "message-2",
              type: "agentMessage",
              text: "发现两个风险。",
            },
          ],
        },
      ],
    } as unknown as Thread;

    expect(
      controlOfficeChatMessages(
        thread,
        "交付组长",
        record.definition.members,
        "zh",
      ),
    ).toEqual([
      expect.objectContaining({ author: "你", text: "@审阅员工 检查风险" }),
      expect.objectContaining({ author: "审阅员工", text: "发现两个风险。" }),
    ]);
  });

  it("attributes live output to a directly mentioned or delegated member", () => {
    const directThread = {
      turns: [
        {
          id: "turn-direct",
          startedAt: 1,
          items: [
            {
              id: "message-direct",
              type: "userMessage",
              content: [{ type: "text", text: "@审阅员工 检查风险" }],
            },
          ],
        },
      ],
    } as unknown as Thread;
    const delegatedThread = {
      turns: [
        {
          id: "turn-delegated",
          startedAt: 1,
          items: [
            {
              id: "message-user",
              type: "userMessage",
              content: [{ type: "text", text: "检查风险" }],
            },
            {
              id: "message-delegation",
              type: "agentMessage",
              text: controlTeamDelegationMarker("member-review"),
            },
          ],
        },
      ],
    } as unknown as Thread;

    expect(
      controlOfficeStreamingAuthor(
        directThread,
        "交付组长",
        record.definition.members,
        "zh",
      ),
    ).toBe("审阅员工");
    expect(
      controlOfficeStreamingAuthor(
        delegatedThread,
        "交付组长",
        record.definition.members,
        "zh",
      ),
    ).toBe("审阅员工");
  });

  it("does not route live attribution from a mention inside an attachment", () => {
    const thread = {
      turns: [
        {
          id: "turn-attachment",
          startedAt: 1,
          items: [
            {
              id: "message-attachment",
              type: "userMessage",
              content: [
                {
                  type: "text",
                  text: "检查风险\n\n[附件：方案.md]\n请让 @审阅员工 复核\n[附件结束]",
                },
              ],
            },
          ],
        },
      ],
    } as unknown as Thread;

    expect(
      controlOfficeStreamingAuthor(
        thread,
        "交付组长",
        record.definition.members,
        "zh",
      ),
    ).toBe("交付组长");
  });

  it("shows the manager delegation followed by the member's direct answer", () => {
    const marker = controlTeamDelegationMarker("member-review");
    const thread = {
      turns: [
        {
          id: "turn-1",
          startedAt: 1,
          items: [
            {
              id: "message-1",
              type: "userMessage",
              content: [{ type: "text", text: "检查这次交付" }],
            },
            {
              id: "message-2",
              type: "agentMessage",
              text: `@审阅员工 请检查交付风险。\n${marker}`,
            },
            {
              id: "message-3",
              type: "agentMessage",
              text: "我检查后发现权限边界缺少验收证据。",
            },
          ],
        },
      ],
    } as unknown as Thread;

    const messages = controlOfficeChatMessages(
      thread,
      "交付组长",
      record.definition.members,
      "zh",
    );
    expect(messages).toEqual([
      expect.objectContaining({ author: "你", text: "检查这次交付" }),
      expect.objectContaining({
        author: "交付组长",
        text: "@审阅员工 请检查交付风险。",
      }),
      expect.objectContaining({
        author: "审阅员工",
        text: "我检查后发现权限边界缺少验收证据。",
      }),
    ]);
    expect(messages).toMatchSnapshot();
  });

  it("validates the Control Office before opening its chat", async () => {
    const getOffice = vi.fn(async () => null as never);
    const adapter = createControlCommandOfficeRoomAdapter({
      client: {
        createOffice: vi.fn(),
        createOfficeThread: vi.fn(),
        bindOfficeThread: vi.fn(),
        getOfficeThread: vi.fn(),
        getThreadCatalog: vi.fn(),
        getActiveAgentVersionCatalog: vi.fn(),
        getExecutionIntentCapability: vi.fn(),
        getOffice,
        getThreadGoal: vi.fn(),
        listOffices: vi.fn(),
      },
      locale: "zh",
      runtime: createRuntime(),
    });

    await adapter.open(record);

    expect(getOffice).toHaveBeenCalledWith("office-version-1");
  });

  it("renders the group chat as the primary Office surface", () => {
    const adapter = createControlCommandOfficeRoomAdapter({
      client: {
        createOffice: vi.fn(),
        createOfficeThread: vi.fn(),
        bindOfficeThread: vi.fn(),
        getOfficeThread: vi.fn(),
        getThreadCatalog: vi.fn(),
        getActiveAgentVersionCatalog: vi.fn(),
        getExecutionIntentCapability: vi.fn(),
        getOffice: vi.fn(async () => null as never),
        getThreadGoal: vi.fn(),
        listOffices: vi.fn(),
      },
      locale: "zh",
      runtime: createRuntime(),
    });
    const markup = renderToStaticMarkup(
      <>
        {adapter.render(record, vi.fn(), vi.fn(), {
          contextItems: [
            {
              detail: "产品资料",
              kind: "knowledge",
              label: "知识库",
              title: "交付知识库",
            },
          ],
          modelOptions: [
            {
              isDefault: true,
              label: "GPT-5.6",
              reasoningEfforts: [
                { value: "medium", description: "平衡" },
                { value: "high", description: "深入" },
              ],
              value: "gpt-5.6",
            },
          ],
          slashItems: [
            {
              detail: "检查页面",
              kind: "skill",
              label: "Skill",
              title: "页面审阅",
            },
            {
              detail: "读取项目文件",
              kind: "mcp",
              label: "MCP",
              title: "Filesystem",
            },
          ],
        })}
      </>,
    );

    expect(markup).toContain('data-control-office-chat=""');
    expect(markup).toContain("办公室群聊");
    expect(markup).toContain("产品交付办公室");
    expect(markup).toContain("办公室群聊 · 交付组长 · 2 名成员");
    expect(markup).not.toContain("组长 · 交付组长");
    expect(markup).toContain("成员设置");
    expect(markup).toContain('class="control-office-chat-members"');
    expect(markup).toContain('aria-label="群聊成员：交付组长、审阅员工"');
    expect(markup).toContain('class="control-office-member-settings-button"');
    expect(markup).toContain('class="lucide lucide-settings2"');
    expect(markup).not.toContain("<span>群聊</span>");
    expect(markup).toContain('id="control-office-message-input"');
    expect(markup).toContain(
      'class="command-input thread-command-input control-office-chat-composer"',
    );
    expect(markup).toContain('data-command-composer="true"');
    expect(markup).toContain('aria-label="添加上下文"');
    expect(markup).toContain('aria-label="选择文件"');
    expect(markup).toContain('aria-label="选择文件夹"');
    expect(markup).not.toContain('aria-label="权限选择"');
    expect(markup).not.toContain("帮我批准");
    expect(markup).not.toContain("只读工作区");
    expect(markup).not.toContain('data-workspace-permission="read-only"');
    expect(markup).not.toContain('aria-label="模型"');
    expect(markup).not.toContain('aria-label="模型与推理档位"');
    expect(markup).not.toContain(">GPT-5.6</span>");
    expect(markup).not.toContain("GPT-5.6 中");
    expect(markup).not.toContain('class="execution-intent-segmented"');
    expect(markup).not.toContain("data-execution-intent=");
    expect(markup).toContain('data-kind="intent" data-label="目标"');
    expect(markup).toContain('data-kind="intent" data-label="计划"');
    expect(markup.match(/data-kind="intent"/g)).toHaveLength(2);
    expect(markup).toContain('placeholder="搜索办公室成员"');
    expect(markup).toContain('data-kind="agent"');
    expect(markup).toContain('data-label="交付组长"');
    expect(markup).toContain('data-label="审阅员工"');
    expect(markup).toContain("交付知识库");
    expect(markup).toContain("页面审阅");
    expect(markup).toContain("Filesystem");
    expect(markup).not.toContain("2 名成员协作");
    expect(markup).not.toContain("已就绪");
    expect(markup).not.toContain('aria-label="执行主体"');
    expect(markup).not.toContain("长程上下文");
    expect(markup).not.toContain("AgentVersion");
    expect(markup).not.toContain("office-global-composer");
    expect(markup).not.toContain('data-control-office-definition=""');
    expect(markup).toMatchSnapshot();
  });

  it("opens the exact member settings and preserves its existing model and permissions when editing capabilities", async () => {
    const runtime = createRuntime();
    const boundThread = {
      id: "thread-member-settings",
      name: controlOfficeThreadTitle(record),
      status: { type: "idle" },
      turns: [],
    } as unknown as Thread;
    runtime.readThread.mockResolvedValue(boundThread);
    const office: OfficeContract = {
      schemaVersion: "crewon.office-definition.v0",
      tenantId: "tenant-1",
      spaceId: "space-1",
      title: record.config.title,
      ...record.definition,
      members: record.definition.members.map((member) => ({ ...member })),
      executionTargets: record.definition.executionTargets.map((target) => ({
        ...target,
      })),
      createdByActorId: "actor-1",
      createdAt: "2026-08-30T00:00:00.000Z",
    };
    const profile: OfficeMemberAgentProfile = {
      ...createDefaultAgentConfig("zh"),
      agentId: officeMemberAgentProfileId("office-version-1", "member-lead"),
      name: "交付组长",
      model: "gpt-6.1-sol",
      permission: "工作区写入",
      skills: [
        {
          id: "review",
          name: "交付审查",
          glyph: "审",
          accent: "violet",
          description: "检查交付内容是否完整",
          enabled: true,
        },
      ],
      mcp: [],
      knowledge: [],
    };
    const agentSettings = {
      load: vi.fn(async () => profile),
      save: vi.fn(async () => undefined),
    };
    const client = {
      createOffice: vi.fn(),
      createOfficeThread: vi.fn(),
      bindOfficeThread: vi.fn(),
      getOfficeThread: vi.fn(async () => ({
        officeId: record.definition.officeId,
        officeVersionId: record.definition.officeVersionId,
        thread: catalogPage([boundThread]).data[0]!,
      })),
      getThreadCatalog: vi.fn(async () => catalogPage([boundThread])),
      getActiveAgentVersionCatalog: vi.fn(),
      getExecutionIntentCapability: vi.fn(),
      getOffice: vi.fn(async () => ({ office })),
      getThreadGoal: vi.fn(async () => ({ goal: null, eventSequence: 0 })),
      listOffices: vi.fn(),
    };
    const adapter = createControlCommandOfficeRoomAdapter({
      agentSettings,
      client,
      locale: "zh",
      runtime,
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    document.body.append(container);
    try {
      await act(async () =>
        root.render(adapter.render(record, vi.fn(), vi.fn())),
      );
      expect(container.querySelector('[aria-label="模型"]')).toBeNull();
      expect(container.querySelector('[aria-label="权限选择"]')).toBeNull();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="成员设置"]')!
          .click(),
      );
      expect(
        container.querySelector("[data-control-office-definition]"),
      ).not.toBeNull();
      expect(agentSettings.load).toHaveBeenCalledWith({
        agentId: profile.agentId,
        agentVersionId: "agent-version-lead",
        displayName: "交付组长",
      });
      const capability = container.querySelector<HTMLButtonElement>(
        ".control-office-agent-capability-list button",
      )!;
      expect(capability.textContent).toContain("交付审查");
      expect(capability.getAttribute("aria-pressed")).toBe("true");
      await act(async () => capability.click());
      const save = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent === "保存")!;
      expect(save.disabled).toBe(false);
      await act(async () => save.click());
      expect(agentSettings.save).toHaveBeenCalledOnce();
      expect(agentSettings.save).toHaveBeenCalledWith({
        ...profile,
        skills: [{ ...profile.skills[0]!, enabled: false }],
      });
      expect(client.createOffice).not.toHaveBeenCalled();
      expect(runtime.startTurn).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("keeps unsupported multi-member Plan disabled when the menu is clicked or navigated by keyboard", async () => {
    const runtime = createRuntime();
    const boundThread = {
      id: "thread-plan-disabled",
      name: controlOfficeThreadTitle(record),
      status: { type: "idle" },
      turns: [],
    } as unknown as Thread;
    runtime.readThread.mockResolvedValue(boundThread);
    const adapter = createControlCommandOfficeRoomAdapter({
      client: {
        createOffice: vi.fn(),
        createOfficeThread: vi.fn(),
        bindOfficeThread: vi.fn(),
        getOfficeThread: vi.fn(async () => ({
          officeId: record.definition.officeId,
          officeVersionId: record.definition.officeVersionId,
          thread: catalogPage([boundThread]).data[0]!,
        })),
        getThreadCatalog: vi.fn(async () => catalogPage([boundThread])),
        getActiveAgentVersionCatalog: vi.fn(),
        getExecutionIntentCapability: vi.fn(),
        getOffice: vi.fn(async () => null as never),
        getThreadGoal: vi.fn(async () => ({ goal: null, eventSequence: 0 })),
        listOffices: vi.fn(),
      },
      locale: "zh",
      runtime,
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    document.body.append(container);
    try {
      await act(async () =>
        root.render(adapter.render(record, vi.fn(), vi.fn())),
      );
      const add = container.querySelector<HTMLButtonElement>(
        '[aria-label="添加上下文"]',
      )!;
      await act(async () => add.click());
      const plan = container.querySelector<HTMLButtonElement>(
        '[data-kind="intent"][data-label="计划"]',
      )!;
      expect(plan.disabled).toBe(true);
      expect(plan.textContent).toContain(
        "多成员团队暂不支持计划，请选择单个成员",
      );
      await act(async () => {
        plan.click();
        plan.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
      expect(plan.getAttribute("aria-pressed")).toBe("false");
      expect(runtime.startTurn).not.toHaveBeenCalled();
      const goal = container.querySelector<HTMLButtonElement>(
        '[data-kind="intent"][data-label="目标"]',
      )!;
      expect(goal.disabled).toBe(false);
      await act(async () => goal.click());
      await act(async () => add.click());
      expect(
        container
          .querySelector('[data-kind="intent"][data-label="目标"]')!
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        container
          .querySelector('[data-kind="intent"][data-label="计划"]')!
          .getAttribute("aria-pressed"),
      ).toBe("false");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("renders the existing Control Run stream inside the Office room", async () => {
    const liveThread = {
      id: "thread-live",
      name: controlOfficeThreadTitle(record),
      status: { type: "active" },
      turns: [
        {
          id: "turn-live",
          startedAt: 1,
          items: [
            {
              id: "message-user",
              type: "userMessage",
              content: [{ type: "text", text: "@审阅员工 检查风险" }],
            },
          ],
        },
      ],
    } as unknown as Thread;
    const adapter = createControlCommandOfficeRoomAdapter({
      client: {
        createOffice: vi.fn(),
        createOfficeThread: vi.fn(),
        bindOfficeThread: vi.fn(),
        getOfficeThread: vi.fn(async () => ({
          officeId: record.definition.officeId,
          officeVersionId: record.definition.officeVersionId,
          thread: catalogPage([liveThread]).data[0]!,
        })),
        getThreadCatalog: vi.fn(async () => catalogPage([liveThread])),
        getActiveAgentVersionCatalog: vi.fn(),
        getExecutionIntentCapability: vi.fn(),
        getOffice: vi.fn(async () => null as never),
        getThreadGoal: vi.fn(async () => ({ goal: null, eventSequence: 0 })),
        listOffices: vi.fn(),
      },
      liveThreads: [liveThread],
      locale: "zh",
      runtime: {
        ...createRuntime(),
        readThread: vi.fn(async () => liveThread),
      },
      streamingTextByThread: {
        "thread-live": "正在流式检查第一项风险…",
      },
    });

    const markup = await renderBoundOfficeMarkup(adapter);

    expect(markup).toContain('data-kind="streaming"');
    expect(markup).not.toContain("data-message-id");
    expect(markup).toContain("审阅员工");
    expect(markup).toContain("实时回复");
    expect(markup).toContain("正在流式检查第一项风险…");
  });

  it("keeps a repeated answer visible while the latest turn is streaming", async () => {
    const liveThread = {
      id: "thread-live",
      name: controlOfficeThreadTitle(record),
      status: { type: "active" },
      turns: [
        {
          id: "turn-old",
          status: "completed",
          startedAt: 1,
          items: [
            {
              id: "message-old",
              type: "agentMessage",
              text: "相同答复",
            },
          ],
        },
        {
          id: "turn-live",
          status: "inProgress",
          startedAt: 2,
          items: [
            {
              id: "message-user",
              type: "userMessage",
              content: [{ type: "text", text: "再回答一次" }],
            },
          ],
        },
      ],
    } as unknown as Thread;
    const adapter = createControlCommandOfficeRoomAdapter({
      client: {
        createOffice: vi.fn(),
        createOfficeThread: vi.fn(),
        bindOfficeThread: vi.fn(),
        getOfficeThread: vi.fn(async () => ({
          officeId: record.definition.officeId,
          officeVersionId: record.definition.officeVersionId,
          thread: catalogPage([liveThread]).data[0]!,
        })),
        getThreadCatalog: vi.fn(async () => catalogPage([liveThread])),
        getActiveAgentVersionCatalog: vi.fn(),
        getExecutionIntentCapability: vi.fn(),
        getOffice: vi.fn(async () => null as never),
        getThreadGoal: vi.fn(async () => ({ goal: null, eventSequence: 0 })),
        listOffices: vi.fn(),
      },
      liveThreads: [liveThread],
      locale: "zh",
      runtime: {
        ...createRuntime(),
        readThread: vi.fn(async () => liveThread),
      },
      streamingTextByThread: { "thread-live": "相同答复" },
    });

    const markup = await renderBoundOfficeMarkup(adapter);

    expect(markup).toContain('data-kind="streaming"');
  });

  it("hides a partial draft after the latest turn has durably settled", async () => {
    const liveThread = {
      id: "thread-live",
      name: controlOfficeThreadTitle(record),
      status: { type: "idle" },
      turns: [
        {
          id: "turn-live",
          status: "completed",
          startedAt: 1,
          items: [
            {
              id: "message-user",
              type: "userMessage",
              content: [{ type: "text", text: "检查风险" }],
            },
            {
              id: "message-answer",
              type: "agentMessage",
              text: "完整且权威的最终答复",
            },
          ],
        },
      ],
    } as unknown as Thread;
    const adapter = createControlCommandOfficeRoomAdapter({
      client: {
        createOffice: vi.fn(),
        createOfficeThread: vi.fn(),
        bindOfficeThread: vi.fn(),
        getOfficeThread: vi.fn(async () => ({
          officeId: record.definition.officeId,
          officeVersionId: record.definition.officeVersionId,
          thread: catalogPage([liveThread]).data[0]!,
        })),
        getThreadCatalog: vi.fn(async () => catalogPage([liveThread])),
        getActiveAgentVersionCatalog: vi.fn(),
        getExecutionIntentCapability: vi.fn(),
        getOffice: vi.fn(async () => null as never),
        getThreadGoal: vi.fn(async () => ({ goal: null, eventSequence: 0 })),
        listOffices: vi.fn(),
      },
      liveThreads: [liveThread],
      locale: "zh",
      runtime: {
        ...createRuntime(),
        readThread: vi.fn(async () => liveThread),
      },
      streamingTextByThread: { "thread-live": "不再权威的部分草稿" },
    });

    const markup = await renderBoundOfficeMarkup(adapter);

    expect(markup).toContain("完整且权威的最终答复");
    expect(markup).toContain('data-message-id="message-answer"');
    expect(markup).not.toContain('data-kind="streaming"');
    expect(markup).not.toContain("不再权威的部分草稿");
  });
});
