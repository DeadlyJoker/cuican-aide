import { describe, expect, it, vi } from "vitest";

import type { LibraryItem, LibraryItemAction } from "../domain/crewonDomain";
import { createLibraryItemOpenHandlers } from "./libraryItemOpenHandlers";
import type { LibraryItemOpenHandlersParams } from "./libraryItemOpenHandlers";

const actionSpies = vi.hoisted(() => ({
  externalAgentImport: vi.fn(async () => true),
  mcpDetail: vi.fn(async () => true),
  officeDetail: vi.fn(async () => true),
  plugin: vi.fn(async () => true),
  pluginSkill: vi.fn(async () => true),
  skillFile: vi.fn(async () => true),
}));

vi.mock("../external-agent/externalAgentImportActions", () => ({
  openExternalAgentImportAction: actionSpies.externalAgentImport,
}));
vi.mock("../mcp/mcpDetailActions", () => ({
  openMcpDetailAction: actionSpies.mcpDetail,
}));
vi.mock("../office/officeDetailActions", () => ({
  openOfficeDetailAction: actionSpies.officeDetail,
}));
vi.mock("../plugin/pluginDetailActions", () => ({
  openPluginDetailAction: actionSpies.plugin,
}));
vi.mock("../skill/skillDetailActions", () => ({
  openPluginSkillDetailAction: actionSpies.pluginSkill,
  openSkillFileDetailAction: actionSpies.skillFile,
}));

function pluginAction(): Extract<LibraryItemAction, { type: "plugin" }> {
  return {
    type: "plugin",
    pluginName: "docs",
  };
}

function pluginSkillAction(): Extract<
  LibraryItemAction,
  { type: "plugin-skill" }
> {
  return {
    type: "plugin-skill",
    remoteMarketplaceName: "market",
    remotePluginId: "plugin-1",
    skillName: "docs",
  };
}

function skillFileAction(): Extract<LibraryItemAction, { type: "skill-file" }> {
  return {
    type: "skill-file",
    skillName: "Skill",
    path: "/repo/SKILL.md",
  };
}

function item(action: LibraryItemAction): LibraryItem {
  return {
    title: "Fallback title",
    meta: "Test",
    action,
  };
}

describe("library item open handler factory", () => {
  it("forwards plugin detail actions", async () => {
    Object.values(actionSpies).forEach((spy) => spy.mockClear());
    const action = pluginAction();
    const handlers = createLibraryItemOpenHandlers({
      plugin: {
        locale: "en",
        readPlugin: async () => null,
        setLibraryPanel: vi.fn(),
      },
    } as unknown as LibraryItemOpenHandlersParams);

    await handlers.plugin(action);

    expect(actionSpies.plugin).toHaveBeenCalledWith({
      action,
      locale: "en",
      readPlugin: expect.any(Function),
      setLibraryPanel: expect.any(Function),
    });
  });

  it("uses the source item title as plugin-skill fallback title", async () => {
    Object.values(actionSpies).forEach((spy) => spy.mockClear());
    const action = pluginSkillAction();
    const sourceItem = item(action);
    const handlers = createLibraryItemOpenHandlers({
      pluginSkill: {
        locale: "en",
        readPluginSkill: async () => null,
        setLibraryPanel: vi.fn(),
      },
    } as unknown as LibraryItemOpenHandlersParams);

    await handlers.pluginSkill(action, sourceItem);

    expect(actionSpies.pluginSkill).toHaveBeenCalledWith({
      action,
      fallbackTitle: "Fallback title",
      locale: "en",
      readPluginSkill: expect.any(Function),
      setLibraryPanel: expect.any(Function),
    });
  });

  it("refreshes skill-file actions before opening the detail panel", async () => {
    Object.values(actionSpies).forEach((spy) => spy.mockClear());
    const action = skillFileAction();
    const refreshedAction = { ...action, skillName: "Refreshed Skill" };
    const refreshAction = vi.fn(async () => refreshedAction);
    const handlers = createLibraryItemOpenHandlers({
      skillFile: {
        open: {
          locale: "en",
          readFile: async () => null,
          setLibraryPanel: vi.fn(),
        },
        refreshAction,
      },
    } as unknown as LibraryItemOpenHandlersParams);

    await handlers.skillFile(action);

    expect(refreshAction).toHaveBeenCalledWith(action);
    expect(actionSpies.skillFile).toHaveBeenCalledWith({
      action: refreshedAction,
      locale: "en",
      readFile: expect.any(Function),
      setLibraryPanel: expect.any(Function),
    });
  });
});
