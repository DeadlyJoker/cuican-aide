import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ControlOfficeDefinitionRecordReference } from "../../lib/office/officePanelFromRecord";
import {
  controlOfficeComposerRuntimeSettings,
  createControlCommandOfficeRoomAdapter,
} from "./ControlCommandOfficeRoomAdapter";
import {
  controlOfficeChatErrorMessage,
  controlOfficeChatMessages,
  controlOfficeThreadTitle,
} from "./controlOfficeChatPresentation";

const record: ControlOfficeDefinitionRecordReference = {
  authority: "controlDefinition",
  filePath: "control:office:office-version-1",
  config: {
    title: "产品交付办公室",
    subtitle: "Control · r2",
  },
  definition: {
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

describe("ControlCommandOfficeRoomAdapter", () => {
  it("uses one durable thread title for the Office group chat", () => {
    expect(controlOfficeThreadTitle(record)).toBe("💬 产品交付办公室");
  });

  it("keeps the Office target fixed while forwarding composer choices", () => {
    expect(
      controlOfficeComposerRuntimeSettings({
        executionIntent: "plan",
        model: "gpt-5.6",
        permission: "full-access",
        reasoningEffort: "high",
        record,
      }),
    ).toEqual({
      approvalPolicy: "never",
      executionIntent: "plan",
      model: "gpt-5.6",
      reasoningEffort: "high",
      sandboxMode: "danger-full-access",
      scene: {
        executionTarget: { id: "office-version-1", kind: "team" },
        mode: "coordinate",
        sceneId: "office",
      },
      teamMemberProfiles: [],
      threadSource: "office",
    });
  });

  it("explains an inactive Office member instead of exposing a runtime code", () => {
    expect(
      controlOfficeChatErrorMessage(
        new Error("control_team_agent_version_unavailable"),
        "zh",
      ),
    ).toBe("这个办公室里有成员暂时不可用，请在成员设置中更新后再试。");
  });

  it("never exposes an internal error code to the user", () => {
    expect(
      controlOfficeChatErrorMessage(
        new Error("control_unexpected_internal_failure"),
        "zh",
      ),
    ).toBe("操作没有完成，请稍后再试。");
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

    expect(controlOfficeChatMessages(thread, "交付组长", "zh")[0]?.text).toBe(
      "帮我审阅这份方案",
    );
  });

  it("validates the Control Office before opening its chat", async () => {
    const getOffice = vi.fn(async () => null as never);
    const adapter = createControlCommandOfficeRoomAdapter({
      client: {
        createOffice: vi.fn(),
        createThread: vi.fn(),
        getOffice,
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
        createThread: vi.fn(),
        getOffice: vi.fn(async () => null as never),
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
    expect(markup).toContain('aria-label="权限选择"');
    expect(markup).toContain('aria-label="模型与推理档位"');
    expect(markup).toContain("GPT-5.6 中");
    expect(markup).toContain("目标模式");
    expect(markup).toContain("计划模式");
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
});
