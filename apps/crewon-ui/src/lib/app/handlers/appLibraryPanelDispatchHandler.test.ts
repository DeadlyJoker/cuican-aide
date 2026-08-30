import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryPanelAction } from "../../domain/crewonDomain";
import type { AppLibraryPanelActionHandlersParams } from "./appLibraryPanelActionHandlers";

const actionHandlersSpy = vi.hoisted(() => ({
  create: vi.fn(() => ({
    connectedHandlers: [],
    deferredHandlers: [],
    immediateHandlers: [],
  })),
}));

const dispatchSpy = vi.hoisted(() => ({
  handle: vi.fn(async () => true),
}));

vi.mock("./appLibraryPanelActionHandlers", () => ({
  createAppLibraryPanelActionHandlers: actionHandlersSpy.create,
}));

vi.mock("../../library/libraryPanelActionFlow", () => ({
  handleLibraryPanelActionDispatch: dispatchSpy.handle,
}));

const { createAppLibraryPanelDispatchHandler } = await import(
  "./appLibraryPanelDispatchHandler"
);

function params(
  overrides: Partial<Omit<AppLibraryPanelActionHandlersParams, "action">> = {},
) {
  return {
    automationAuthority: "control",
    locale: "en",
    setLibraryPanel: vi.fn(),
    ...overrides,
  } as unknown as Omit<AppLibraryPanelActionHandlersParams, "action">;
}

describe("App Library Automation authority gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { id: "create-automation", label: "Create" },
    { id: "run-automation", label: "Run" },
    {
      domainConfigKind: "automation",
      id: "delete-config-file",
      label: "Delete",
    },
  ] satisfies LibraryPanelAction[])(
    "blocks $id before any legacy action wiring can run",
    async (action) => {
      const setLibraryPanel = vi.fn();
      const handler = createAppLibraryPanelDispatchHandler(
        params({ setLibraryPanel }),
      );

      await expect(handler(action)).resolves.toBe(false);

      expect(actionHandlersSpy.create).not.toHaveBeenCalled();
      expect(dispatchSpy.handle).not.toHaveBeenCalled();
      expect(setLibraryPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          actions: [],
          kind: "automation",
          subtitle: "Scheduling moved to the new scheduler",
        }),
      );
    },
  );

  it("retains the legacy path only when Control is not configured", async () => {
    const handler = createAppLibraryPanelDispatchHandler(
      params({ automationAuthority: "legacy" }),
    );
    const action = {
      id: "run-automation",
      label: "Run",
    } satisfies LibraryPanelAction;

    await expect(handler(action)).resolves.toBe(true);

    expect(actionHandlersSpy.create).toHaveBeenCalledTimes(1);
    expect(dispatchSpy.handle).toHaveBeenCalledTimes(1);
  });
});
