// @ts-expect-error Vitest runs this check in Node, while the browser bundle omits Node types.
import { readFileSync } from "node:fs";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  alternateCommandShellOverlay,
  AppCommandShellRoute,
  resolveCommandShellEscapeTarget,
  shouldHandleCommandShellEscape,
} from "./AppCommandShellRoute";
import { emptyTerminalOutputStream } from "../../lib/terminal/terminalOutputStream";

const selectedThread = {
  agentNickname: null,
  agentRole: null,
  clientVersion: "0.1.0",
  createdAt: 100,
  cwd: "/repo",
  ephemeral: false,
  forkedFromId: null,
  gitInfo: null,
  id: "thread-task-detail",
  modelProvider: "openai",
  name: "任务详细信息回归",
  parentThreadId: null,
  path: "/tmp/thread-task-detail.jsonl",
  preview: "任务详细信息回归",
  sessionId: "session-task-detail",
  source: "appServer",
  status: { type: "idle" },
  threadSource: null,
  turns: [
    {
      completedAt: 110,
      durationMs: 10_000,
      error: null,
      id: "run-task-detail",
      items: [
        {
          type: "fileChange",
          id: "task-change",
          status: "completed",
          changes: [
            {
              path: "src/task-detail.ts",
              kind: { type: "update", move_path: null },
              diff: "+first\n+second\n-previous",
            },
          ],
        },
      ],
      itemsView: "full",
      startedAt: 100,
      status: "completed",
    },
  ],
  updatedAt: 100,
} as unknown as Thread;

describe("AppCommandShellRoute task detail integration", () => {
  it("routes Escape and the narrow switch to the last active surface", () => {
    expect([
      resolveCommandShellEscapeTarget({
        activeOverlay: "task-detail",
        taskDetailOpen: true,
        workbenchOpen: true,
      }),
      resolveCommandShellEscapeTarget({
        activeOverlay: "workbench",
        taskDetailOpen: true,
        workbenchOpen: true,
      }),
      resolveCommandShellEscapeTarget({
        activeOverlay: "workbench",
        taskDetailOpen: true,
        workbenchOpen: false,
      }),
      resolveCommandShellEscapeTarget({
        activeOverlay: null,
        taskDetailOpen: false,
        workbenchOpen: true,
      }),
      resolveCommandShellEscapeTarget({
        activeOverlay: null,
        taskDetailOpen: true,
        workbenchOpen: false,
      }),
      alternateCommandShellOverlay("workbench"),
      alternateCommandShellOverlay("task-detail"),
    ]).toEqual([
      "task-detail",
      "workbench",
      "task-detail",
      "workbench",
      "task-detail",
      "task-detail",
      "workbench",
    ]);
  });

  it("reserves Escape for modal layers and IME composition before closing a surface", () => {
    const base = {
      defaultPrevented: false,
      isComposing: false,
      key: "Escape",
      keyCode: 27,
      modalOpen: false,
    };

    expect([
      shouldHandleCommandShellEscape(base),
      shouldHandleCommandShellEscape({ ...base, modalOpen: true }),
      shouldHandleCommandShellEscape({ ...base, isComposing: true }),
      shouldHandleCommandShellEscape({ ...base, keyCode: 229 }),
      shouldHandleCommandShellEscape({ ...base, defaultPrevented: true }),
      shouldHandleCommandShellEscape({ ...base, key: "Enter" }),
    ]).toEqual([true, false, false, false, false, false]);
  });

  it("puts task controls in the panel header and keeps the workbench independent", () => {
    const markup = renderToStaticMarkup(
      <AppCommandShellRoute
        capabilityDrawer={{
          busyToolId: null,
          commandValue: "",
          disabled: false,
          locale: "zh",
          open: true,
          panel: null,
          scene: "code",
          terminalCwd: "/repo",
          terminalOutput: emptyTerminalOutputStream,
          terminalProcessId: null,
          onClose: vi.fn(),
          onCommandChange: vi.fn(),
          onCommandSubmit: vi.fn(),
          onFiles: vi.fn(),
          onOpen: vi.fn(),
          onPanelAction: vi.fn(),
          onPanelFieldChange: vi.fn(),
          onPanelItem: vi.fn(),
          onReview: vi.fn(),
          onSideChat: vi.fn(),
          onTerminal: vi.fn(),
          onTerminalResize: vi.fn(),
          onTerminalStart: vi.fn(),
          onTerminalStop: vi.fn(),
          onTerminalWrite: vi.fn(),
        }}
        composerValue=""
        confirmDialog={{
          locale: "zh",
          request: null,
          onCancel: vi.fn(),
          onConfirm: vi.fn(),
        }}
        connectionState="connected"
        cwd="/repo"
        isSending={false}
        linkedThreads={[selectedThread]}
        locale="zh"
        platform="mac"
        selectedThread={selectedThread}
        selectedThreadId={selectedThread.id}
        workMode="code"
        workspaceAuthority="control"
        onAttachContext={vi.fn()}
        onChangeComposerValue={vi.fn()}
        onModeChange={vi.fn()}
        onRetryConnection={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    expect(markup).toContain('data-active-overlay="workbench"');
    expect(markup).toContain('data-capability-sidebar-open="true"');
    expect(markup).toContain('aria-label="任务详细信息"');
    const header = markup.match(
      /<header[^>]*class="command-panel-header"[\s\S]*?<\/header>/,
    )?.[0];
    expect(header).toBeDefined();
    expect(header).toContain('aria-label="面板标题栏"');
    expect(header).toContain("任务详细信息回归");
    expect(header).toContain('aria-label="任务详细信息"');
    expect(header).toMatchSnapshot();
    expect(markup.match(/aria-label="任务详细信息"/g)).toHaveLength(1);
    expect(markup).not.toContain('class="command-thread-toolbar"');
    expect(markup.indexOf('class="command-panel-header"')).toBeLessThan(
      markup.indexOf("screen-shell command-screen"),
    );
    expect(markup).toContain("1 个文件已更改");
    expect(markup).toContain("+2");
    expect(markup).toContain("-1");
    expect(markup.indexOf("screen-shell command-screen")).toBeLessThan(
      markup.indexOf("command-workbench"),
    );
  });

  it("keeps branch-wide workspace totals separate from recorded task changes", () => {
    const routeSource = readFileSync(
      new URL("./AppCommandShellRoute.tsx", import.meta.url),
      "utf8",
    );
    const appSource = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );
    const workspaceGitSource = readFileSync(
      new URL(
        "../../lib/task-detail/useTaskDetailWorkspaceGit.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(routeSource).toContain("useTaskDetailWorkspaceGit({");
    expect(routeSource).toContain("taskDetailWorkspaceGitClient");
    expect(routeSource).toContain("workspaceScopeKey: workspaceGitScopeKey");
    expect(routeSource).toContain("latestTurn.items.length");
    expect(routeSource).toContain("projection?.changes.complete");
    expect(routeSource).toContain("recordedAdditions");
    expect(routeSource).toContain(
      'workspaceGit: authority === "control" ? workspaceGit : null',
    );
    expect(appSource).toContain("taskDetailWorkspaceGitClient={");
    expect(appSource).toContain(
      'workspaceUiAuthority === "control" ? controlSandboxClient : null',
    );
    expect(workspaceGitSource).toContain(
      ".readSandboxGitSummary(null, { signal: controller.signal })",
    );
    expect(workspaceGitSource).not.toContain(".readSandboxDiff(");
  });

  it("coordinates low-width overlap without making task details part of the workbench", () => {
    const routeStyles = readFileSync(
      new URL("./AppCommandShellRoute.css", import.meta.url),
      "utf8",
    );
    const detailStyles = readFileSync(
      new URL("../task-detail/TaskDetailPopover.css", import.meta.url),
      "utf8",
    );

    expect(routeStyles).toContain("@media (max-width: 880px)");
    expect(routeStyles).toContain('data-active-overlay="workbench"');
    expect(routeStyles).toContain("z-index: 29");
    expect(routeStyles).toContain("z-index: 30");
    expect(routeStyles).toContain("command-shell-overlay-switch");
    expect(routeStyles).toContain("z-index: 50");
    expect(detailStyles).toContain("grid-column: 1 / 2");
    expect(detailStyles).toContain("grid-row: 1 / 2");
    expect(detailStyles).toContain("width: min(336px, calc(100% - 16px))");
    expect(detailStyles).not.toContain(".command-workbench");
  });
});
