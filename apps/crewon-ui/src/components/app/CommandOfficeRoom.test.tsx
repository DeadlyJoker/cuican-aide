import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { OfficeConfigRecordReference } from "../../lib/office/officePanelFromRecord";
import {
  CommandOfficeRoom,
  commandOfficeCardPresentation,
} from "./CommandOfficeRoom";
import { TeamView } from "./CommandWorkspaceViews";

function record(
  filePath: string,
  status: "running" | "completed",
): OfficeConfigRecordReference {
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

describe("CommandOfficeRoom", () => {
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

  it("snapshots a prominent empty landing without inventing office data", () => {
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
    expect(markup).toContain("群聊");
    expect(markup).toContain("任务协作");
    expect(markup).not.toContain("执行台");
    expect(markup).toContain("记忆与上下文");
    expect(markup).not.toContain("设计交付办公室");
  });

  it("mounts the unavailable Office landing through the Team view", () => {
    const markup = renderToStaticMarkup(
      <TeamView
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
    expect(markup).not.toContain("<option");
    expect(markup).not.toContain("team-workspace-scope");
    expect(markup).not.toContain("设计交付办公室");
    expect(markup).toMatchSnapshot();
  });

  it("shows honest unavailable states instead of fake workflow and expert data", () => {
    const markup = renderToStaticMarkup(
      <TeamView
        active
        officeRuntime={null}
        officeRoomId={null}
        teamMode="workflow"
        onTeamModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain("协作流服务暂不可用");
    expect(markup).toContain("CrewON Control 未提供 Workflow authority");
    expect(markup).not.toContain("创建协作流");
    expect(markup).not.toContain("页面交付协作流");
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
