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
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
        onPanelItem={vi.fn()}
      />,
    );

    expect(markup).toMatchInlineSnapshot(
      `"<aside aria-label=\"任务上下文面板\" class=\"command-capability-drawer\"><button aria-label=\"关闭上下文面板\" class=\"command-capability-drawer-close\" type=\"button\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-x\" aria-hidden=\"true\"><path d=\"M18 6 6 18\"></path><path d=\"m6 6 12 12\"></path></svg></button><section class=\"capability-result\" aria-live=\"polite\"><div class=\"capability-result-header\"><strong>添加上下文</strong><span>/repo</span></div><pre>选择文件加入任务上下文。</pre><ul><li><button type=\"button\" class=\"capability-result-item\">  README.md</button></li></ul></section></aside>"`,
    );
  });
});
