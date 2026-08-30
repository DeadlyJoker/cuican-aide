import { describe, expect, it } from "vitest";

import { toolLibraryPanelContent } from "./domainToolLibraryItems";

describe("tool library panel content", () => {
  it("builds a unified editable Skill and MCP market", () => {
    const content = toolLibraryPanelContent({
      locale: "zh",
      mcpInventory: { configs: [], servers: [], statuses: [] },
      pluginsResponse: null,
      skillsResponse: null,
      workspaceToolItems: [],
    });

    const catalogItems = content.items.filter((item) => item.catalog);
    expect(content.subtitle).toBe("0 个已添加 · 71 个预制能力");
    expect(content.actions).toEqual([
      { id: "create-skill", label: "创建技能", tone: "primary" },
      { id: "create-mcp", label: "创建服务" },
      { id: "reload-tools", label: "刷新工具" },
    ]);
    expect(catalogItems).toHaveLength(71);
    expect(catalogItems.some((item) => item.tags?.includes("本地"))).toBe(true);
    expect(catalogItems.some((item) => item.tags?.includes("云端"))).toBe(true);
    expect(catalogItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "表格分析", capabilityKind: "skill" }),
        expect.objectContaining({ title: "GitHub", capabilityKind: "mcp" }),
        expect.objectContaining({ title: "企业微信", capabilityKind: "mcp" }),
        expect.objectContaining({ title: "飞书套件", capabilityKind: "skill" }),
      ]),
    );
  });
});
