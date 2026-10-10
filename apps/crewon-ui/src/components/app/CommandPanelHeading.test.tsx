import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CommandPanelHeading,
  CommandPanelSceneControl,
} from "./CommandPanelHeading";

describe("command panel heading", () => {
  it("keeps all three scenes selectable when the header switches to its compact control", () => {
    const markup = renderToStaticMarkup(
      <CommandPanelHeading
        title="检查桌面面板交互"
        actions={
          <CommandPanelSceneControl
            locale="zh"
            scene="code"
            onSceneChange={vi.fn()}
          />
        }
      />,
    );
    expect(markup).toContain('<option value="office">日常办公</option>');
    expect(markup).toContain('<option value="code" selected="">生码</option>');
    expect(markup).toContain('<option value="design">设计创意</option>');
    expect(markup).toMatchSnapshot();
  });
});
