import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandWorkspaceCapabilityDrawer } from "./CommandWorkspaceCapabilityDrawer";

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
        onWeb={vi.fn()}
      />,
    );

    expect(markup).toContain("工作区工作台");
    expect(markup).toContain("command-workbench-file-preview");
    expect(markup).toContain("command-workbench-file-explorer");
    expect(markup).toContain("打开文件");
    expect(markup).toMatchInlineSnapshot(
      `"<aside aria-label="工作区工作台" class="command-workbench"><header class="command-workbench-tabbar"><div class="command-workbench-tabs" role="tablist"><div aria-selected="true" class="command-workbench-tab" data-active="true" role="tab"><button type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"></path></svg><span>打开文件</span></button><button aria-label="关闭 打开文件" class="command-workbench-tab-close" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div><div class="command-workbench-launcher-anchor"><button aria-expanded="false" aria-label="打开工具" class="command-workbench-add" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg></button></div></div><button aria-label="关闭工作台" class="command-workbench-close" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-panel-right-close" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M15 3v18"></path><path d="m8 9 3 3-3 3"></path></svg></button></header><div class="command-workbench-context-bar">/repo</div><div class="command-workbench-content"><div class="command-workbench-files"><main class="command-workbench-file-preview"><div class="command-workbench-file-empty"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"></path></svg><strong>打开文件</strong><span>从工作区目录树中选择文件</span></div></main><aside class="command-workbench-file-explorer"><div class="command-workbench-file-tree" role="tree"><button type="button" class="command-workbench-file-row" role="treeitem" title="/repo/README.md"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg><span>README.md</span></button></div></aside></div></div></aside>"`,
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
        onWeb={vi.fn()}
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
        onWeb={vi.fn()}
      />,
    );

    expect(markup).toContain("审阅");
    expect(markup).toContain("终端");
    expect(markup).toContain("浏览器");
    expect(markup).toContain("文件");
    expect(markup).not.toContain("侧边聊天");
  });
});
