import { describe, expect, it } from "vitest";

import {
  CAPABILITY_PRESETS,
  capabilityPresetById,
  capabilityPresetItems,
  mcpConfigForEditorDraft,
  mcpEditorDraftForPreset,
  mcpPresetSetup,
  orderedCapabilityPresets,
} from "./capabilityCatalog";

describe("capability catalog", () => {
  it("prepares a substantial editable Skill and MCP catalog", () => {
    expect(CAPABILITY_PRESETS).toHaveLength(71);
    expect(
      CAPABILITY_PRESETS.filter((preset) => preset.kind === "skill").length,
    ).toBe(39);
    expect(
      CAPABILITY_PRESETS.filter((preset) => preset.kind === "mcp").length,
    ).toBe(32);
    expect(capabilityPresetById("playwright", "mcp")).toMatchObject({
      kind: "mcp",
      config: {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
      },
    });
    expect(capabilityPresetById("spreadsheet-analysis", "skill")).toMatchObject(
      {
        kind: "skill",
        title: "表格分析",
        location: "local",
        logo: "excel",
      },
    );
    expect(capabilityPresetById("wecom", "mcp")).toMatchObject({
      kind: "mcp",
      location: "cloud",
      logo: "wecom",
    });
    expect(capabilityPresetById("feishu-suite", "skill")).toMatchObject({
      kind: "skill",
      title: "飞书套件",
    });
    expect(capabilityPresetById("tapd", "mcp")).toMatchObject({
      kind: "mcp",
      title: "TAPD",
    });
    expect(
      new Set(CAPABILITY_PRESETS.map((preset) => preset.location)),
    ).toEqual(new Set(["local", "cloud"]));
    expect(CAPABILITY_PRESETS.every((preset) => preset.logo.length > 0)).toBe(
      true,
    );
    expect(new Set(CAPABILITY_PRESETS.map((preset) => preset.id)).size).toBe(
      CAPABILITY_PRESETS.length,
    );
    const ordered = orderedCapabilityPresets();
    expect(ordered.find((preset) => preset.kind === "skill")?.id).toBe(
      "tencent-weiyun-manager",
    );
    expect(ordered.find((preset) => preset.kind === "mcp")?.id).toBe(
      "tongdaxin-market-data",
    );
  });

  it("builds MCP configs from typed fields without exposing server URLs", () => {
    const filesystemDraft = mcpEditorDraftForPreset("filesystem");
    const filesystem = mcpConfigForEditorDraft({
      ...filesystemDraft,
      values: { ALLOWED_DIRECTORY: "/repo" },
    });
    expect(filesystem).toEqual({
      config: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/repo"],
        enabled: true,
      },
      oauth: false,
    });
    expect(mcpPresetSetup("notion")).toMatchObject({
      connectable: true,
      fields: [],
      oauth: true,
    });
    expect(mcpPresetSetup("wecom")).toMatchObject({
      connectable: false,
      oauth: false,
    });
  });

  it("renders Chinese catalog entries as 技能 or 服务", () => {
    const items = capabilityPresetItems("zh");
    expect(new Set(items.map((item) => item.meta))).toEqual(
      new Set(["技能", "服务"]),
    );
    expect(items.every((item) => item.catalog && item.action)).toBe(true);
    expect(items.some((item) => item.tags?.includes("本地"))).toBe(true);
    expect(items.some((item) => item.tags?.includes("云端"))).toBe(true);
    expect(items.every((item) => item.logo)).toBe(true);
  });
});
