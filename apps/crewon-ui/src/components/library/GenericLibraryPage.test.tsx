import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LibraryPanel } from "../../lib/domain/crewonDomain";
import { GenericLibraryPage } from "./GenericLibraryPage";

describe("GenericLibraryPage capability market", () => {
  it("snapshots the unified Skill and MCP catalog controls", () => {
    const panel: LibraryPanel = {
      kind: "tools",
      title: "能力",
      subtitle: "0 个已添加 · 2 个预制能力",
      body: "能力统一分为技能和服务。",
      actions: [
        { id: "create-skill", label: "创建技能", tone: "primary" },
        { id: "create-mcp", label: "创建服务" },
      ],
      items: [
        {
          title: "精选技能",
          meta: "1 个模板",
          section: true,
        },
        {
          title: "表格分析",
          meta: "技能",
          description: "创建、清洗和分析 Excel/CSV。",
          glyph: "X",
          logo: "excel",
          accent: "green",
          capabilityKind: "skill",
          capabilityLocation: "local",
          catalog: true,
          action: {
            type: "capability-preset",
            presetId: "spreadsheet-analysis",
            presetKind: "skill",
          },
        },
        {
          title: "服务",
          meta: "1 个预制配置",
          section: true,
        },
        {
          title: "浏览器自动化",
          meta: "服务",
          description: "通过结构化页面信息执行浏览和测试。",
          glyph: "◎",
          logo: "browser",
          accent: "blue",
          capabilityKind: "mcp",
          capabilityLocation: "cloud",
          catalog: true,
          action: {
            type: "capability-preset",
            presetId: "playwright",
            presetKind: "mcp",
          },
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <GenericLibraryPage
        locale="zh"
        panel={panel}
        onBack={vi.fn()}
        onItemAction={vi.fn()}
        onPanelAction={vi.fn()}
        onPanelFieldChange={vi.fn()}
      />,
    );

    expect(markup).toContain("搜索技能或服务");
    expect(markup).toContain("服务");
    expect(markup).toContain("全部位置");
    expect(markup).toContain('data-logo="excel"');
    expect(markup).toMatchSnapshot();
  });
});
