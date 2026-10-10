// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
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

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function workspaceElement(
  controlWorkspace: CommandControlWorkspaceNav,
  linkedThreads: CommandLinkedThread[] = [],
) {
  return (
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
    />
  );
}

function renderWorkspace(
  controlWorkspace: CommandControlWorkspaceNav,
  linkedThreads: CommandLinkedThread[] = [],
) {
  return renderToStaticMarkup(
    workspaceElement(controlWorkspace, linkedThreads),
  );
}

describe("workspace availability in the sidebar", () => {
  it("dispatches the recheck button while normal native mutation callbacks are absent", async () => {
    const onRecheck = vi.fn();
    const native = {
      name: null,
      busy: false,
      mutationAuthority: "unavailable" as const,
      error: "工作空间目录已被删除或移动。",
      onRecheck,
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(workspaceElement(native)));
      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "重新检查",
      );
      expect(retry).toBeDefined();
      await act(async () => retry!.click());
      expect(onRecheck).toHaveBeenCalledOnce();
      await act(async () =>
        root.render(workspaceElement({ ...native, busy: true })),
      );
      const busyRetry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "正在检查…",
      );
      expect(busyRetry?.disabled).toBe(true);
      await act(async () => busyRetry!.click());
      expect(onRecheck).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("offers a status recheck while directory mutations are fenced and disables it during confirmation", () => {
    const workspace = {
      name: "Project A",
      workspaceId: "workspace-a",
      workspaces: [{ workspaceId: "workspace-a", displayName: "Project A" }],
      busy: false,
      mutationAuthority: "unavailable" as const,
      error: "工作空间目录已被删除或移动。",
      onRecheck: vi.fn(),
    };
    const markup = renderWorkspace(workspace);
    expect(markup).toContain("已被删除或移动");
    expect(markup).toContain(">重新检查</button>");
    expect(markup).not.toContain('aria-label="新增空间"');
    const busyMarkup = renderWorkspace({ ...workspace, busy: true });
    expect(busyMarkup).toContain('disabled="">正在检查…</button>');
  });
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
