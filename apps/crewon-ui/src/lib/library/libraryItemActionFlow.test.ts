import { describe, expect, it, vi } from "vitest";

import type { LibraryItem, LibraryItemAction } from "../domain/crewonDomain";
import {
  isLocalLibraryItemAction,
  libraryItemActionForOpen,
  openLibraryItemAction,
  type LibraryItemOpenHandlers,
} from "./libraryItemActionFlow";

function item(action?: LibraryItemAction): LibraryItem {
  return {
    title: "Item",
    meta: "Test",
    glyph: "•",
    accent: "blue",
    ...(action ? { action } : {}),
  };
}

function action(
  overrides: Partial<Extract<LibraryItemAction, { type: "mcp-detail" }>> = {},
): Extract<LibraryItemAction, { type: "mcp-detail" }> {
  return {
    type: "mcp-detail",
    title: "MCP",
    subtitle: "Runtime",
    body: "Backend tool",
    ...overrides,
  };
}

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

function handlers(): LibraryItemOpenHandlers {
  return {
    agentConfig: vi.fn(async () => {}),
    capabilityPreset: vi.fn(async () => {}),
    automationDetail: vi.fn(async () => {}),
    externalAgentImport: vi.fn(async () => {}),
    mcpDetail: vi.fn(async () => {}),
    officeDetail: vi.fn(async () => {}),
    plugin: vi.fn(async () => {}),
    pluginSkill: vi.fn(async () => {}),
    skillFile: vi.fn(async () => {}),
  };
}

describe("library item action flow", () => {
  it("classifies actions that can open from demo preview without backend connection", () => {
    expect(isLocalLibraryItemAction(action())).toBe(true);
    expect(
      isLocalLibraryItemAction({
        type: "agent-config",
        config: {
          name: "Agent",
          glyph: "◷",
          accent: "blue",
          role: "Role",
          model: "gpt-5",
          models: ["gpt-5"],
          permission: "workspace-write",
          permissions: ["workspace-write"],
          systemPrompt: "Prompt",
          mcp: [],
          skills: [],
        },
      }),
    ).toBe(true);
    expect(isLocalLibraryItemAction(pluginAction())).toBe(false);
  });

  it("returns null when the item has no action", () => {
    let marked = false;

    expect(
      libraryItemActionForOpen({
        isConnected: true,
        isDemo: false,
        isDemoPreview: false,
        item: item(),
        markLibraryLoad: () => {
          marked = true;
        },
      }),
    ).toBeNull();
    expect(marked).toBe(false);
  });

  it("allows connected actions and marks the library load", () => {
    let marks = 0;
    const nextAction = pluginAction();

    expect(
      libraryItemActionForOpen({
        isConnected: true,
        isDemo: false,
        isDemoPreview: false,
        item: item(nextAction),
        markLibraryLoad: () => {
          marks += 1;
        },
      }),
    ).toBe(nextAction);
    expect(marks).toBe(1);
  });

  it("blocks disconnected non-demo actions without marking a library load", () => {
    let marked = false;

    expect(
      libraryItemActionForOpen({
        isConnected: false,
        isDemo: false,
        isDemoPreview: false,
        item: item(action()),
        markLibraryLoad: () => {
          marked = true;
        },
      }),
    ).toBeNull();
    expect(marked).toBe(false);
  });

  it("allows local actions in demo preview without a backend connection", () => {
    let marks = 0;
    const nextAction = action();

    expect(
      libraryItemActionForOpen({
        isConnected: false,
        isDemo: false,
        isDemoPreview: true,
        item: item(nextAction),
        markLibraryLoad: () => {
          marks += 1;
        },
      }),
    ).toBe(nextAction);
    expect(marks).toBe(1);
  });

  it("marks then blocks non-local actions in demo mode", () => {
    let marks = 0;

    expect(
      libraryItemActionForOpen({
        isConnected: false,
        isDemo: true,
        isDemoPreview: false,
        item: item(pluginAction()),
        markLibraryLoad: () => {
          marks += 1;
        },
      }),
    ).toBeNull();
    expect(marks).toBe(1);
  });

  it("dispatches opened plugin actions to their handler", async () => {
    const openHandlers = handlers();
    const nextAction = pluginAction();

    await expect(
      openLibraryItemAction({
        handlers: openHandlers,
        isConnected: true,
        isDemo: false,
        isDemoPreview: false,
        item: item(nextAction),
        markLibraryLoad: () => {},
      }),
    ).resolves.toBe(true);
    expect(openHandlers.plugin).toHaveBeenCalledWith(nextAction);
    expect(openHandlers.mcpDetail).not.toHaveBeenCalled();
  });

  it("passes the source item to plugin-skill handlers", async () => {
    const openHandlers = handlers();
    const nextAction = pluginSkillAction();
    const nextItem = item(nextAction);

    await expect(
      openLibraryItemAction({
        handlers: openHandlers,
        isConnected: true,
        isDemo: false,
        isDemoPreview: false,
        item: nextItem,
        markLibraryLoad: () => {},
      }),
    ).resolves.toBe(true);
    expect(openHandlers.pluginSkill).toHaveBeenCalledWith(nextAction, nextItem);
  });

  it("returns false when the gate blocks the action", async () => {
    const openHandlers = handlers();

    await expect(
      openLibraryItemAction({
        handlers: openHandlers,
        isConnected: false,
        isDemo: false,
        isDemoPreview: false,
        item: item(pluginAction()),
        markLibraryLoad: () => {},
      }),
    ).resolves.toBe(false);
    expect(openHandlers.plugin).not.toHaveBeenCalled();
  });
});
