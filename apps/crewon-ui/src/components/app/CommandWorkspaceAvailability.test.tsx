import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CommandSidebar,
  type CommandControlWorkspaceNav,
  type CommandLinkedThread,
} from "./CommandWorkspaceChrome";
import {
  emptyAgentPlatformSnapshot,
  selectCommandHomeSlots,
} from "./commandWorkspaceState";

function renderWorkspace(
  controlWorkspace: CommandControlWorkspaceNav,
  linkedThreads: CommandLinkedThread[] = [],
) {
  return renderToStaticMarkup(
    <CommandSidebar
      activeView="command"
      controlWorkspace={controlWorkspace}
      cwd=""
      isSearchOpen={false}
      linkedThreads={linkedThreads}
      locale="zh"
      query=""
      selectedLinkedThreadId={null}
      slots={selectCommandHomeSlots(emptyAgentPlatformSnapshot)}
      workspaceAuthority="control"
      onCloseSearch={vi.fn()}
      onNewThread={vi.fn()}
      onOpenLinkedThread={vi.fn()}
      onQueryChange={vi.fn()}
      onSwitchView={vi.fn()}
      onToggleCollapse={vi.fn()}
      onToggleSearch={vi.fn()}
    />,
  );
}

describe("workspace availability in the sidebar", () => {
  it("explains the Web boundary without offering an unusable folder picker", () => {
    const markup = renderWorkspace({
      name: null,
      busy: false,
      mutationAuthority: "readOnly",
    });
    expect(markup).toContain("本机工作空间请在桌面端选择。");
    expect(markup).not.toContain("尚未绑定本机文件夹");
    expect(markup).not.toContain('aria-label="新增空间"');
  });

  it("distinguishes unavailable authority from an empty desktop registry", () => {
    const unavailable = renderWorkspace({
      name: null,
      busy: false,
      mutationAuthority: "unavailable",
    });
    expect(unavailable).toContain("工作空间暂未连接。");
    expect(unavailable).not.toContain("尚未绑定本机文件夹");

    const desktop = renderWorkspace({
      name: null,
      busy: false,
      mutationAuthority: "desktop",
      onSelect: vi.fn(),
    });
    expect(desktop).toContain("尚未绑定本机文件夹作为工作空间。");
    expect(desktop).toContain('aria-label="新增空间"');
  });

  it("keeps a disconnected workspace's saved thread in its original ID group", () => {
    const markup = renderWorkspace(
      { name: null, busy: false, mutationAuthority: "readOnly" },
      [
        {
          id: "bound-thread",
          workspaceId: "saved-workspace",
          cwd: null,
          title: "Existing project conversation",
          preview: "Saved content",
          updatedLabel: "刚刚",
        },
      ],
    );
    expect(markup).toContain('data-workspace-id="saved-workspace"');
    expect(markup).toContain('data-linked-thread-id="bound-thread"');
    expect(markup).toContain("未连接的工作空间");
    expect(markup).not.toContain("standalone-workspace-node");
    expect(markup).not.toContain("workspace-empty-hint");
  });
});
