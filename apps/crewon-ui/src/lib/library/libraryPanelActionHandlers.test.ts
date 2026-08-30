import { describe, expect, it, vi } from "vitest";

import type { LibraryPanelActionHandlersParams } from "./libraryPanelActionHandlers";
import { createLibraryPanelActionHandlers } from "./libraryPanelActionHandlers";

const handlerSpies = vi.hoisted(() => ({
  agent: vi.fn(() => true),
  automationCreate: vi.fn(() => true),
  automationRun: vi.fn(() => true),
  draft: vi.fn(() => true),
  file: vi.fn(() => true),
  knowledge: vi.fn(() => true),
  maintenance: vi.fn(() => true),
  mcp: vi.fn(() => true),
  office: vi.fn(() => true),
  officeRecruit: vi.fn(() => true),
  plugin: vi.fn(() => true),
  skill: vi.fn(() => true),
  thread: vi.fn(() => true),
}));

vi.mock("./libraryAgentActions", () => ({
  handleLibraryAgentAction: handlerSpies.agent,
}));
vi.mock("./libraryAutomationCreateActions", () => ({
  handleLibraryAutomationCreateAction: handlerSpies.automationCreate,
}));
vi.mock("./libraryAutomationRunActions", () => ({
  handleLibraryAutomationRunAction: handlerSpies.automationRun,
}));
vi.mock("./libraryDraftActions", () => ({
  handleLibraryDraftAction: handlerSpies.draft,
}));
vi.mock("./libraryFileActions", () => ({
  handleLibraryFileAction: handlerSpies.file,
}));
vi.mock("./libraryKnowledgeActions", () => ({
  handleKnowledgeLibraryAction: handlerSpies.knowledge,
}));
vi.mock("./libraryMaintenanceActions", () => ({
  handleLibraryMaintenanceAction: handlerSpies.maintenance,
}));
vi.mock("./libraryMcpActions", () => ({
  handleLibraryMcpAction: handlerSpies.mcp,
}));
vi.mock("./libraryOfficeActions", () => ({
  handleLibraryOfficeAction: handlerSpies.office,
}));
vi.mock("./libraryOfficeRecruitActions", () => ({
  handleLibraryOfficeRecruitAction: handlerSpies.officeRecruit,
}));
vi.mock("./libraryPluginActions", () => ({
  handleLibraryPluginAction: handlerSpies.plugin,
}));
vi.mock("./librarySkillActions", () => ({
  handleLibrarySkillAction: handlerSpies.skill,
}));
vi.mock("./libraryThreadActions", () => ({
  handleLibraryThreadAction: handlerSpies.thread,
}));

describe("library panel action handler factory", () => {
  it("groups action handlers in dispatcher order and injects the action", async () => {
    Object.values(handlerSpies).forEach((spy) => spy.mockClear());
    const action = { id: "reload-tools", label: "Reload tools" } as const;
    const handlers = createLibraryPanelActionHandlers({
      action,
      agent: {},
      automationCreate: {},
      automationRun: {},
      draft: {},
      file: {},
      knowledge: {},
      maintenance: {},
      mcp: {},
      office: {},
      officeRecruit: {},
      plugin: {},
      skill: {},
      thread: {},
    } as unknown as LibraryPanelActionHandlersParams);

    expect(handlers.immediateHandlers).toHaveLength(3);
    expect(handlers.connectedHandlers).toHaveLength(4);
    expect(handlers.deferredHandlers).toHaveLength(6);

    await Promise.all([
      ...handlers.immediateHandlers.map((handler) => handler()),
      ...handlers.connectedHandlers.map((handler) => handler()),
      ...handlers.deferredHandlers.map((handler) => handler()),
    ]);

    expect(handlerSpies.knowledge).toHaveBeenCalledWith({ action });
    expect(handlerSpies.thread).toHaveBeenCalledWith({ action });
    expect(handlerSpies.officeRecruit).toHaveBeenCalledWith({ action });
    expect(handlerSpies.office).toHaveBeenCalledWith({ action });
    expect(handlerSpies.automationCreate).toHaveBeenCalledWith({ action });
    expect(handlerSpies.agent).toHaveBeenCalledWith({ action });
    expect(handlerSpies.draft).toHaveBeenCalledWith({ action });
    expect(handlerSpies.file).toHaveBeenCalledWith({ action });
    expect(handlerSpies.maintenance).toHaveBeenCalledWith({ action });
    expect(handlerSpies.automationRun).toHaveBeenCalledWith({ action });
    expect(handlerSpies.mcp).toHaveBeenCalledWith({ action });
    expect(handlerSpies.skill).toHaveBeenCalledWith({ action });
    expect(handlerSpies.plugin).toHaveBeenCalledWith({ action });
  });
});
