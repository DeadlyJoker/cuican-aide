import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandWorkbenchTabStrip } from "./CommandWorkbenchTabStrip";

describe("shared tool and plugin tab strip", () => {
  it("renders one accessible strip with independent close controls and a common launcher", () => {
    const markup = renderToStaticMarkup(
      <CommandWorkbenchTabStrip
        locale="zh"
        launcherOpen={true}
        launcherRef={{ current: null }}
        onToggleLauncher={vi.fn()}
        onHide={vi.fn()}
        launcher={
          <div role="menu">
            <button role="menuitem">短剧页面</button>
            <button role="menuitem">网页</button>
          </div>
        }
        tabs={[
          {
            id: "plugin",
            label: "分集剧本",
            closeLabel: "关闭 分集剧本",
            active: true,
            activate: vi.fn(),
            close: vi.fn(),
          },
          {
            id: "web",
            label: "网页",
            closeLabel: "关闭 网页",
            active: false,
            activate: vi.fn(),
            close: vi.fn(),
          },
        ]}
      />,
    );
    expect(markup).toMatchSnapshot();
    expect(markup.match(/role="tablist"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="打开工具"');
    expect(markup).toContain('aria-label="收起工作台"');
  });
});
