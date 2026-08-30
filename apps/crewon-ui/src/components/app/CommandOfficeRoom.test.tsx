import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  ControlOfficeDefinitionRecordReference,
  OfficeRuntimeRecordReference,
} from "../../lib/office/officePanelFromRecord";
import type { ExpertTeamRecordReference } from "../../lib/experts/expertTeamRecord";
import {
  CommandOfficeRoom,
  commandOfficeCardPresentation,
} from "./CommandOfficeRoom";
import { TeamView } from "./CommandWorkspaceViews";

function record(
  filePath: string,
  status: "running" | "completed",
): OfficeRuntimeRecordReference {
  return {
    filePath,
    config: {
      title: "同名办公室",
      subtitle: "真实记录",
      workspace: {
        goal: "完成办公室前端",
        backendStatus: "connected",
        members: [
          {
            name: "产品组长",
            role: "manager",
            glyph: "组",
            accent: "blue",
            status: "online",
          },
        ],
        messages: [],
        tasks: [],
        activity: {
          runs: [
            {
              id: `${filePath}-run`,
              title: status === "running" ? "核对交互" : "完成验收",
              status,
              updatedAt: "2026-07-13T10:00:00Z",
            },
          ],
        },
      },
    },
  };
}

const expertTeam: ExpertTeamRecordReference = {
  filePath: "/repo/.crewon/experts/review.json",
  config: {
    expertsId: "experts-review",
    title: "代码审阅专家团",
    goal: "由团长汇总审阅结论。",
    leader: {
      name: "审阅团长",
      role: "分派审阅并汇总结论",
      agentType: "worker",
    },
    experts: [
      {
        name: "风险专家",
        role: "定位风险",
        agentType: "explorer",
      },
    ],
    recordRevision: "revision-1",
    workspaceKey: "/repo/personal",
    ownerSubject: "user-1",
    tenantId: null,
    spaceId: null,
  },
};

const teamViewRuntimeProps = {
  expertTeams: [],
  expertTeamsStatus: "ready" as const,
  workflows: [],
  workflowStatus: "ready" as const,
  onReloadWorkflows: vi.fn(async () => undefined),
  onCancelWorkflow: vi.fn(async () => ({
    executionId: "workflow-run-1",
    workflowId: "workflow-1",
    status: "canceled",
    output: "",
    executedNodes: [],
    error: null,
  })),
  onResolveWorkflowGate: vi.fn(async () => ({
    executionId: "workflow-run-1",
    workflowId: "workflow-1",
    status: "running",
    output: "",
    executedNodes: [],
    error: null,
  })),
  onRunWorkflow: vi.fn(async () => ({
    executionId: "workflow-run-1",
    workflowId: "workflow-1",
    status: "completed",
    output: "done",
    executedNodes: [],
    error: null,
  })),
  onSelectExpert: vi.fn(),
};

describe("CommandOfficeRoom", () => {
  it("opens a Control Office as a real group chat", () => {
    const definition: ControlOfficeDefinitionRecordReference = {
      authority: "controlDefinition",
      filePath: "control:office:office-version-1",
      config: {
        title: "发布办公室",
        subtitle: "Control · r1",
      },
      definition: {
        officeVersionId: "office-version-1",
        revision: 1,
        members: [
          {
            agentVersionId: "agent-version-1",
            displayName:
              "local-dev-f0848ab670179d8f73ad722e:desktop-workspace-runtime-c4e70635b6f6abce5437f4c9b6720452",
            memberId: "member-1",
          },
        ],
        executionTargets: [
          { agentVersionId: "agent-version-1", targetId: "target-1" },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      <CommandOfficeRoom
        definitionOnly
        isOpen
        records={[definition]}
        room={<main data-control-office-chat="">办公室群聊</main>}
        selectedRecordKey="record:office-version-1"
        status="ready"
        onOpen={vi.fn()}
      />,
    );

    expect(markup).toMatchSnapshot();
    expect(markup).toContain("组长 · 办公室组长 · 1 名成员");
    expect(markup).toContain("可开始群聊");
    expect(markup).toContain("办公室群聊");
    expect(markup).toContain("进入群聊");
    expect(markup).not.toContain("local-dev-");
    expect(markup).not.toContain("Runtime");
    expect(markup).not.toContain("查看定义");
    expect(markup).not.toContain("待命");
  });

  it("derives card status and current work from the canonical Office run", () => {
    expect(
      commandOfficeCardPresentation(record("/repo/a.json", "running")),
    ).toEqual({
      current: "当前：核对交互",
      status: { label: "运行中", tone: "success" },
      subtitle: "组长 · 办公室主控 · 1 员工",
    });
  });

  it("keeps recent conversation runs from replacing the latest task on office cards", () => {
    const office = record("/repo/a.json", "completed");
    office.config.workspace.activity!.runs = [
      {
        id: "conversation-run",
        title: "现在进度怎么样？",
        status: "completed",
        messageIntent: "conversation",
        updatedAt: "2026-07-13T11:00:00Z",
      },
      {
        id: "task-run",
        title: "完成验收",
        status: "completed",
        messageIntent: "task",
        updatedAt: "2026-07-13T10:00:00Z",
      },
    ];

    expect(commandOfficeCardPresentation(office)).toEqual({
      current: "当前：完成验收",
      status: { label: "已完成", tone: "success" },
      subtitle: "组长 · 办公室主控 · 1 员工",
    });
  });

  it("snapshots the real-office list and mounted shared-composer room", () => {
    const records = [
      record("/repo/a.json", "running"),
      record("/repo/b.json", "completed"),
    ];
    const markup = renderToStaticMarkup(
      <CommandOfficeRoom
        isOpen
        records={records}
        room={
          <main className="office-workspace" aria-label="同名办公室">
            <form className="command-input office-global-composer office-shared-composer">
              <textarea id="office-message-input" />
            </form>
          </main>
        }
        selectedRecordKey="path:/repo/b.json"
        status="ready"
        onOpen={vi.fn()}
      />,
    );

    expect(markup).toMatchSnapshot();
    expect(markup).toContain("office-shared-composer");
    expect(markup).toContain('id="office-message-input"');
    expect(markup).not.toContain("告诉组长目标、背景或下一步");
  });

  it("snapshots the compact shared empty landing without inventing office data", () => {
    const markup = renderToStaticMarkup(
      <CommandOfficeRoom
        isOpen={false}
        records={[]}
        room={null}
        selectedRecordKey={null}
        status="ready"
        onCreate={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    expect(markup).toMatchSnapshot();
    expect(markup).toContain("创建你的第一个办公室");
    expect(markup).toContain("创建办公室并选择成员");
    expect(markup).toContain('class="command-team-empty-state"');
    expect(markup).not.toContain("team-office-capability-grid");
    expect(markup).not.toContain("设计交付办公室");
  });

  it("mounts the unavailable Office landing through the Team view", () => {
    const markup = renderToStaticMarkup(
      <TeamView
        {...teamViewRuntimeProps}
        active
        officeRuntime={{
          records: [],
          room: null,
          selectedRecordKey: null,
          status: "unavailable",
          onOpen: vi.fn(),
          onRetry: vi.fn(),
        }}
        officeRoomId={null}
        teamMode="office"
        onCreateOffice={vi.fn()}
        onRefresh={vi.fn()}
        onTeamModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-shell-view="team"');
    expect(markup).toContain('data-office-empty-state="unavailable"');
    expect(markup).toContain("等待自动重试");
    expect(markup).toContain("立即重试");
    expect(markup).not.toContain('aria-label="搜索办公室"');
    expect(markup).not.toContain("同步真实数据");
    expect(markup).not.toContain("<option");
    expect(markup).not.toContain("team-workspace-scope");
    expect(markup).not.toContain("team-mode-intro");
    expect(markup).not.toContain("设计交付办公室");
    expect(markup).toMatchSnapshot();
  });

  it("shows honest unavailable states instead of fake workflow and expert data", () => {
    const markup = renderToStaticMarkup(
      <TeamView
        {...teamViewRuntimeProps}
        active
        officeRuntime={null}
        officeRoomId={null}
        teamMode="workflow"
        workflowStatus="unavailable"
        onCreateWorkflow={vi.fn()}
        onTeamModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain("暂时无法打开协作流");
    expect(markup).toContain("暂时无法读取协作流");
    expect(markup).toContain("重新同步");
    expect(markup).not.toContain("创建协作流");
    expect(markup).not.toContain("App Server");
    expect(markup).not.toContain("team-mode-intro");
    expect(markup).not.toContain("页面交付协作流");
    expect(markup).not.toContain("产品交付专家团");
    expect(markup).toMatchSnapshot();
  });

  it("keeps Control team navigation across Office, Workflow, and Experts", () => {
    const markup = renderToStaticMarkup(
      <TeamView
        {...teamViewRuntimeProps}
        active
        officeRuntime={{
          definitionOnly: true,
          records: [],
          room: null,
          selectedRecordKey: null,
          status: "ready",
          onCreate: vi.fn(),
          onOpen: vi.fn(),
        }}
        officeRoomId={null}
        teamMode="workflow"
        onCreateWorkflow={vi.fn()}
        onCreateExpertTeam={vi.fn()}
        onTeamModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-filter="workflow"');
    expect(markup).toContain("还没有协作流");
    expect(markup).toContain("创建协作流");
    expect(markup).toContain("办公室");
    expect(markup).toContain("专家团");
    expect(markup).not.toContain("team-mode-intro");
    expect(markup).not.toContain("App Server");
    expect(markup).toMatchSnapshot();
  });

  it("keeps Experts as a leader single-chat catalog independent from Office records", () => {
    const markup = renderToStaticMarkup(
      <TeamView
        {...teamViewRuntimeProps}
        active
        expertTeams={[expertTeam]}
        officeRuntime={{
          records: [record("/repo/office-only.json", "running")],
          room: null,
          selectedRecordKey: null,
          status: "ready",
          onOpen: vi.fn(),
        }}
        officeRoomId={null}
        teamMode="experts"
        onTeamModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain("代码审阅专家团");
    expect(markup).toContain("团长：审阅团长");
    expect(markup).not.toContain("同名办公室");
    expect(markup).not.toContain("<option");
    expect(markup).not.toContain("team-workspace-scope");
    expect(markup).not.toContain("team-mode-intro");
    expect(markup).toMatchSnapshot();
  });

  it("filters real Office records without turning a search miss into a fake empty catalog", () => {
    const markup = renderToStaticMarkup(
      <CommandOfficeRoom
        isOpen={false}
        query="不存在"
        records={[record("/repo/a.json", "running")]}
        room={null}
        selectedRecordKey={null}
        status="ready"
        onOpen={vi.fn()}
      />,
    );

    expect(markup).toContain("没有匹配“不存在”");
    expect(markup).not.toContain("创建你的第一个办公室");
  });
});
