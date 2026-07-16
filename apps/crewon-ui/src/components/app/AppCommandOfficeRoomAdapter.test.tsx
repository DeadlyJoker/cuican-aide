import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LibraryPanel } from "../../lib/domain/crewonDomain";
import {
  officePanelFromRecord,
  type OfficeConfigRecordReference,
} from "../../lib/office/officePanelFromRecord";
import { createAppCommandOfficeRoomAdapter } from "./AppCommandOfficeRoomAdapter";

const record: OfficeConfigRecordReference = {
  filePath: "/repo/team/.crewon/offices/frontend.json",
  workspaceCwd: "/repo/team",
  config: {
    title: "前端交付办公室",
    subtitle: "群聊运行态",
    workspace: {
      backendStatus: "connected",
      goal: "稳定交付 Team Office",
      members: [
        {
          accent: "blue",
          glyph: "组",
          memberId: "member-lead",
          name: "办公室组长",
          role: "组长",
          status: "待命",
        },
      ],
      messages: [],
      recordId: "office-record-1",
      tasks: [],
      threadId: "thread-office-1",
    },
  },
};

function runtimeProps() {
  return {
    activeTurnByThread: {},
    locale: "zh" as const,
    onArtifact: vi.fn(),
    onDecision: vi.fn(),
    onDelegationCancel: vi.fn(),
    onDelegationDispatch: vi.fn(),
    onDelegationRetry: vi.fn(),
    onPanelAction: vi.fn(),
    onRunCancel: vi.fn(),
    onRunRetry: vi.fn(),
    onSendMessage: vi.fn(),
    onVerificationCancel: vi.fn(),
    onVerificationRetry: vi.fn(),
  };
}

describe("AppCommandOfficeRoomAdapter", () => {
  it("opens the exact workspace-scoped record", async () => {
    let panel: LibraryPanel | null = null;
    const adapter = createAppCommandOfficeRoomAdapter({
      libraryPanel: panel,
      locale: "zh",
      runtimeProps: runtimeProps(),
      setLibraryPanel: (nextPanel) => {
        panel = nextPanel;
      },
    });

    await adapter.open(record);

    expect(panel).toMatchObject({
      configPath: "/repo/team/.crewon/offices/frontend.json",
      kind: "office",
      workspaceCwd: "/repo/team",
      workspace: {
        recordId: "office-record-1",
        threadId: "thread-office-1",
      },
    });
  });

  it("renders the Command Office surface directly", () => {
    const panel = officePanelFromRecord(record, "zh");
    const adapter = createAppCommandOfficeRoomAdapter({
      libraryPanel: panel,
      locale: "zh",
      runtimeProps: runtimeProps(),
      setLibraryPanel: vi.fn(),
    });
    const markup = renderToStaticMarkup(
      <>{adapter.render(record, vi.fn(), vi.fn())}</>,
    );

    expect(markup).toContain('class="office-workspace"');
    expect(markup).toContain("前端交付办公室");
    expect(markup).not.toContain('class="library-page"');
    expect(markup).toMatchSnapshot();
  });

  it("fails closed when a same-record panel belongs to another workspace", () => {
    const otherWorkspacePanel = {
      ...officePanelFromRecord(record, "zh"),
      workspaceCwd: "/repo/other-team",
    };
    const adapter = createAppCommandOfficeRoomAdapter({
      libraryPanel: otherWorkspacePanel,
      locale: "zh",
      runtimeProps: runtimeProps(),
      setLibraryPanel: vi.fn(),
    });
    const markup = renderToStaticMarkup(
      <>{adapter.render(record, vi.fn(), vi.fn())}</>,
    );

    expect(markup).toContain("正在连接办公室运行态");
    expect(markup).not.toContain("前端交付办公室");
  });

  it("closes the Team room only after the Office record delete succeeds", async () => {
    const panel = officePanelFromRecord(record, "zh");
    const runtime = runtimeProps();
    runtime.onPanelAction.mockResolvedValue(true);
    const onDeleted = vi.fn();
    const adapter = createAppCommandOfficeRoomAdapter({
      libraryPanel: panel,
      locale: "zh",
      runtimeProps: runtime,
      setLibraryPanel: vi.fn(),
    });
    const element = adapter.render(record, vi.fn(), onDeleted) as ReactElement<{
      onPanelAction: typeof runtime.onPanelAction;
    }>;

    await element.props.onPanelAction({
      id: "delete-config-file",
      label: "删除后端记录",
      pathToOpen: record.filePath,
      domainConfigKind: "office",
    });

    expect(runtime.onPanelAction).toHaveBeenCalledOnce();
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it("keeps the Team room open when deferred Office deletion fails", async () => {
    const panel = officePanelFromRecord(record, "zh");
    const runtime = runtimeProps();
    runtime.onPanelAction.mockResolvedValue(false);
    const onDeleted = vi.fn();
    const adapter = createAppCommandOfficeRoomAdapter({
      libraryPanel: panel,
      locale: "zh",
      runtimeProps: runtime,
      setLibraryPanel: vi.fn(),
    });
    const element = adapter.render(record, vi.fn(), onDeleted) as ReactElement<{
      onPanelAction: typeof runtime.onPanelAction;
    }>;

    await element.props.onPanelAction({
      id: "delete-config-file",
      label: "删除后端记录",
      pathToOpen: record.filePath,
      domainConfigKind: "office",
    });

    expect(runtime.onPanelAction).toHaveBeenCalledOnce();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("reloads the canonical Office record after recruiting a member", async () => {
    const panel = officePanelFromRecord(record, "zh");
    const runtime = runtimeProps();
    runtime.onPanelAction.mockResolvedValue(true);
    const refreshedRecord: OfficeConfigRecordReference = {
      ...record,
      config: {
        ...record.config,
        workspace: {
          ...record.config.workspace,
          members: [
            ...record.config.workspace.members,
            {
              accent: "green",
              agentId: "agent-platform:10",
              glyph: "A",
              memberId: "member-agent-platform-10",
              name: "AI智能助理",
              role: "通用助理",
              status: "已加入",
            },
          ],
        },
      },
    };
    const refreshRecord = vi.fn().mockResolvedValue(refreshedRecord);
    const setLibraryPanel = vi.fn();
    const adapter = createAppCommandOfficeRoomAdapter({
      libraryPanel: panel,
      locale: "zh",
      refreshRecord,
      runtimeProps: runtime,
      setLibraryPanel,
    });
    const element = adapter.render(record, vi.fn(), vi.fn()) as ReactElement<{
      onPanelAction: typeof runtime.onPanelAction;
    }>;

    await element.props.onPanelAction({
      id: "recruit-agent",
      label: "招募 AI智能助理",
    });

    expect(refreshRecord).toHaveBeenCalledWith(record);
    expect(setLibraryPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({
          members: expect.arrayContaining([
            expect.objectContaining({
              agentId: "agent-platform:10",
              name: "AI智能助理",
            }),
          ]),
        }),
      }),
    );
  });
});
