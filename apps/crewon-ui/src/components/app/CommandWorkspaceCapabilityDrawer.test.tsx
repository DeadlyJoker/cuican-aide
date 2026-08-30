import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandWorkbenchBrowser } from "./CommandWorkbenchBrowser";
import { CommandWorkbenchFiles } from "./CommandWorkbenchFiles";
import { CommandWorkbenchReview } from "./CommandWorkbenchReview";
import { CommandWorkbenchTerminal } from "./CommandWorkbenchTerminal";
import { CommandWorkspaceCapabilityDrawer } from "./CommandWorkspaceCapabilityDrawer";
import { emptyTerminalOutputStream } from "../../lib/terminal/terminalOutputStream";

describe("CommandWorkspaceCapabilityDrawer", () => {
  it("renders an actionable file-context panel inside the command workspace", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspaceCapabilityDrawer
        busyToolId={null}
        commandValue=""
        disabled={false}
        locale="zh"
        open
        panel={{
          body: "选择文件加入任务上下文。",
          items: [
            {
              intent: "attach-context",
              kind: "file",
              label: "  README.md",
              path: "/repo/README.md",
            },
          ],
          subtitle: "/repo",
          title: "添加上下文",
        }}
        terminalCwd="/repo"
        terminalOutput={emptyTerminalOutputStream}
        terminalProcessId={null}
        onClose={vi.fn()}
        onCommandChange={vi.fn()}
        onCommandSubmit={vi.fn()}
        onFiles={vi.fn()}
        onOpen={vi.fn()}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
        onPanelItem={vi.fn()}
        onReview={vi.fn()}
        onSideChat={vi.fn()}
        onTerminal={vi.fn()}
        onTerminalResize={vi.fn()}
        onTerminalStart={vi.fn()}
        onTerminalStop={vi.fn()}
        onTerminalWrite={vi.fn()}
        scene="code"
      />,
    );

    expect(markup).toContain("工作区工作台");
    expect(markup).toContain("command-file-preview");
    expect(markup).toContain("command-file-explorer");
    expect(markup).toContain("筛选文件");
    expect(markup).toContain("打开文件");
    expect(markup).toContain('role="separator"');
    expect(markup).toContain("调整工作台宽度");
    expect(markup).toContain("全屏工作台");
    expect(markup).not.toContain('data-maximized="true"');
    expect(markup).toMatchInlineSnapshot(
      `"<aside aria-label="工作区工作台" class="command-workbench" style="width:480px"><div aria-label="调整工作台宽度" aria-orientation="vertical" aria-valuemax="840" aria-valuemin="360" aria-valuenow="480" class="command-workbench-resize-handle" role="separator" tabindex="0"></div><header class="command-workbench-tabbar"><div class="command-workbench-tabs" role="tablist"><div aria-selected="true" class="command-workbench-tab" data-active="true" role="tab"><button type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"></path></svg><span>文件</span></button><button aria-label="关闭 文件" class="command-workbench-tab-close" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div><div class="command-workbench-launcher-anchor"><button aria-controls="command-workbench-launcher-menu" aria-expanded="false" aria-haspopup="menu" aria-label="打开工具" class="command-workbench-add" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg></button></div></div><div class="command-workbench-window-actions"><button aria-label="全屏工作台" class="command-workbench-maximize" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-maximize2" aria-hidden="true"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" x2="14" y1="3" y2="10"></line><line x1="3" x2="10" y1="21" y2="14"></line></svg></button><button aria-label="关闭工作台" class="command-workbench-close" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-panel-right" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M15 3v18"></path></svg></button></div></header><div class="command-workbench-content"><div class="command-workbench-panel"><div class="command-file-workbench"><div class="command-file-toolbar"><nav aria-label="File breadcrumb" class="command-file-breadcrumbs"><span><button disabled="" type="button">repo</button></span></nav><div class="command-file-toolbar-actions"><button aria-label="复制路径" title="复制路径" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg></button><button disabled="" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-external-link" aria-hidden="true"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>打开</button></div></div><div class="command-file-layout"><main class="command-file-preview"><div class="command-file-empty"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"></path></svg><strong>打开文件</strong><span>从右侧工作区中选择文件</span></div></main><aside class="command-file-explorer"><label class="command-file-filter"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg><input aria-label="筛选文件" placeholder="筛选文件…" value=""/></label><button aria-expanded="true" class="command-file-root" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg><strong>repo</strong></button><div class="command-file-tree" role="tree"><button class="command-file-row" role="treeitem" style="padding-left:7px" title="/repo/README.md" type="button"><span class="command-file-row-spacer"></span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg><span>README.md</span></button></div></aside></div></div></div></div></aside>"`,
    );
  });

  it("renders a compact trigger after the tools sidebar is closed", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspaceCapabilityDrawer
        busyToolId={null}
        commandValue=""
        disabled={false}
        locale="zh"
        open={false}
        panel={null}
        terminalCwd="/repo"
        terminalOutput={emptyTerminalOutputStream}
        terminalProcessId={null}
        onClose={vi.fn()}
        onCommandChange={vi.fn()}
        onCommandSubmit={vi.fn()}
        onFiles={vi.fn()}
        onOpen={vi.fn()}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
        onPanelItem={vi.fn()}
        onReview={vi.fn()}
        onSideChat={vi.fn()}
        onTerminal={vi.fn()}
        onTerminalResize={vi.fn()}
        onTerminalStart={vi.fn()}
        onTerminalStop={vi.fn()}
        onTerminalWrite={vi.fn()}
        scene="code"
      />,
    );

    expect(markup).toContain("打开工作台");
    expect(markup).toContain("command-workbench-trigger");
  });

  it("renders the four real workbench tools without side chat", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspaceCapabilityDrawer
        busyToolId={null}
        commandValue=""
        disabled={false}
        locale="zh"
        open
        panel={null}
        terminalCwd="/repo"
        terminalOutput={emptyTerminalOutputStream}
        terminalProcessId={null}
        onClose={vi.fn()}
        onCommandChange={vi.fn()}
        onCommandSubmit={vi.fn()}
        onFiles={vi.fn()}
        onOpen={vi.fn()}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
        onPanelItem={vi.fn()}
        onReview={vi.fn()}
        onSideChat={vi.fn()}
        onTerminal={vi.fn()}
        onTerminalResize={vi.fn()}
        onTerminalStart={vi.fn()}
        onTerminalStop={vi.fn()}
        onTerminalWrite={vi.fn()}
        scene="code"
      />,
    );

    expect(markup).toContain("审阅");
    expect(markup).toContain("终端");
    expect(markup).toContain("浏览器");
    expect(markup).toContain("文件");
    expect(markup).not.toContain("侧边聊天");
  });

  it("keeps approval actions and fields clickable on the generic panel surface", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspaceCapabilityDrawer
        busyToolId={null}
        commandValue=""
        disabled={false}
        locale="zh"
        open
        panel={{
          actions: [
            { id: "approve-request", label: "同意", tone: "primary" },
            { id: "decline-request", label: "拒绝", tone: "danger" },
          ],
          body: "等待处理",
          fields: [{ id: "reason", label: "原因", value: "" }],
          subtitle: "12",
          title: "命令执行审批",
        }}
        terminalCwd="/repo"
        terminalOutput={emptyTerminalOutputStream}
        terminalProcessId={null}
        onClose={vi.fn()}
        onCommandChange={vi.fn()}
        onCommandSubmit={vi.fn()}
        onFiles={vi.fn()}
        onOpen={vi.fn()}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
        onPanelItem={vi.fn()}
        onReview={vi.fn()}
        onSideChat={vi.fn()}
        onTerminal={vi.fn()}
        onTerminalResize={vi.fn()}
        onTerminalStart={vi.fn()}
        onTerminalStop={vi.fn()}
        onTerminalWrite={vi.fn()}
        scene="code"
      />,
    );

    expect(markup).toContain("command-workbench-generic-surface");
    expect(markup).toContain("命令执行审批");
    expect(markup).toContain("同意");
    expect(markup).toContain("拒绝");
    expect(markup).toContain('aria-label="工作区工作台"');
    expect(markup).not.toContain("command-terminal-xterm");
  });

  it("filters launcher tools by scene and drops the apps entry", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkspaceCapabilityDrawer
        busyToolId={null}
        commandValue=""
        disabled={false}
        locale="zh"
        open
        panel={null}
        terminalCwd="/repo"
        terminalOutput={emptyTerminalOutputStream}
        terminalProcessId={null}
        onClose={vi.fn()}
        onCommandChange={vi.fn()}
        onCommandSubmit={vi.fn()}
        onFiles={vi.fn()}
        onOpen={vi.fn()}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
        onPanelItem={vi.fn()}
        onReview={vi.fn()}
        onSideChat={vi.fn()}
        onTerminal={vi.fn()}
        onTerminalResize={vi.fn()}
        onTerminalStart={vi.fn()}
        onTerminalStop={vi.fn()}
        onTerminalWrite={vi.fn()}
        scene="office"
      />,
    );

    expect(markup).toContain('data-tool-id="files"');
    expect(markup).toContain('data-tool-id="web"');
    expect(markup).not.toContain('data-tool-id="terminal"');
    expect(markup).not.toContain('data-tool-id="review"');
    expect(markup).not.toContain('data-tool-id="apps"');
    expect(markup).not.toContain("应用与插件");
  });

  it("snapshots the PIM files, browser, terminal, and review workbench surfaces", () => {
    const surfaces = {
      browser: renderToStaticMarkup(
        <CommandWorkbenchBrowser
          active
          instanceId="web-1"
          locale="zh"
          onNewTab={vi.fn()}
          onTitleChange={vi.fn()}
        />,
      ),
      files: renderToStaticMarkup(
        <CommandWorkbenchFiles
          busyToolId={null}
          disabled={false}
          explorerPanel={{
            body: "PIM Agent 沙箱 · 2 项",
            items: [
              { kind: "directory", label: "> src", path: "/workspace/src" },
              {
                kind: "file",
                label: "  README.md",
                path: "/workspace/README.md",
              },
            ],
            subtitle: "/workspace",
            title: "文件",
          }}
          locale="zh"
          panel={null}
          onPanelItem={vi.fn()}
        />,
      ),
      review: renderToStaticMarkup(
        <CommandWorkbenchReview
          busyToolId={null}
          locale="zh"
          panel={{
            body: [
              "diff --git a/src/App.tsx b/src/App.tsx",
              "--- a/src/App.tsx",
              "+++ b/src/App.tsx",
              "@@ -1 +1 @@",
              "-const ready = false;",
              "+const ready = true;",
            ].join("\n"),
            subtitle: "1 个改动 · 当前显示 1 个文件 · +1 / -1",
            title: "当前改动",
          }}
          onRefresh={vi.fn()}
        />,
      ),
      terminal: renderToStaticMarkup(
        <CommandWorkbenchTerminal
          active
          cwd="/repo"
          disabled={false}
          locale="zh"
          output={{
            generation: 1,
            processId: "pty-1",
            text: "pwd\r\n/repo\r\n",
          }}
          processId="pty-1"
          onResize={vi.fn()}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onWrite={vi.fn()}
        />,
      ),
    };

    expect(surfaces).toMatchSnapshot();
  });
});
