import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CapabilityPanelItem } from "../capability/capabilityPanelTypes";
import type { AppDomainActionCoordinatorParams } from "./appDomainActionCoordinator";
import type { createAppDomainActionHandlers } from "./handlers/appDomainActionHandlers";

const domainActionHandlerSpy = vi.hoisted(() => ({
  lastParams: null as Parameters<typeof createAppDomainActionHandlers>[0] | null,
  create: vi.fn((params: Parameters<typeof createAppDomainActionHandlers>[0]) => {
    domainActionHandlerSpy.lastParams = params;
    return {
      ensureBackendToolThread: vi.fn(async () => null),
      handleApprovalDecision: vi.fn(async () => undefined),
      handleOfficeArtifact: vi.fn(async () => undefined),
      recordBackendToolEvent: vi.fn(async () => undefined),
      saveAgentConfig: vi.fn(async () => undefined),
      toggleAgentCapability: vi.fn(),
      updateAgentConfig: vi.fn(),
    };
  }),
}));

vi.mock("./handlers/appDomainActionHandlers", () => ({
  createAppDomainActionHandlers: domainActionHandlerSpy.create,
}));

const { createAppDomainActionCoordinator } = await import(
  "./appDomainActionCoordinator"
);

function createParams(
  getCapabilityPanelItemHandler: AppDomainActionCoordinatorParams["getCapabilityPanelItemHandler"],
): AppDomainActionCoordinatorParams {
  return {
    getCapabilityPanelItemHandler,
  } as unknown as AppDomainActionCoordinatorParams;
}

function capturedParams(): Parameters<typeof createAppDomainActionHandlers>[0] {
  const params = domainActionHandlerSpy.lastParams;
  if (!params) {
    throw new Error("createAppDomainActionHandlers was not called");
  }
  return params;
}

describe("app domain action coordinator", () => {
  beforeEach(() => {
    domainActionHandlerSpy.lastParams = null;
    vi.clearAllMocks();
  });

  it("defers capability panel item handling to the current handler", async () => {
    const calls: CapabilityPanelItem[][] = [];
    let currentHandler = async (item: CapabilityPanelItem) => {
      calls.push([item]);
    };

    createAppDomainActionCoordinator(
      createParams(() => currentHandler),
    );
    const params = capturedParams();
    const firstItem: CapabilityPanelItem = {
      kind: "file",
      label: "a.ts",
      path: "/repo/a.ts",
    };
    const secondItem: CapabilityPanelItem = {
      kind: "directory",
      label: "src",
      path: "/repo/src",
    };

    await params.handleCapabilityPanelItem(firstItem);
    currentHandler = async (item) => {
      calls.push([secondItem, item]);
    };
    await params.handleCapabilityPanelItem(secondItem);

    expect(calls).toEqual([
      [firstItem],
      [secondItem, secondItem],
    ]);
  });
});
