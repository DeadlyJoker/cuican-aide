import { describe, expect, it, vi } from "vitest";

import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { LibraryPanel } from "../../domain/crewonDomain";
import {
  createAppCapabilityPanelHandlers,
  type AppCapabilityPanelHandlersParams,
} from "./appCapabilityPanelHandlers";

function createParams(
  overrides: Partial<AppCapabilityPanelHandlersParams> = {},
): AppCapabilityPanelHandlersParams {
  return {
    busyToolId: null,
    capabilityPanel: null,
    confirm: () => true,
    handleSettingsAction: () => false,
    locale: "en",
    onUnavailable: vi.fn(),
    selectedThreadId: "thread-1",
    setActiveTurnByThread: () => {},
    setBusyToolId: () => {},
    setCapabilityPanel: () => {},
    setLibraryPanel: () => {},
    setStreamingTextByThread: () => {},
    setThreads: () => {},
    threadLifecycleClient: null,
    threadLifecycleConnected: false,
    ...overrides,
  };
}

describe("Control capability panel handlers", () => {
  it("routes Settings actions to the Control Settings coordinator", () => {
    const handleSettingsAction = vi.fn(() => true);
    const onUnavailable = vi.fn();
    const handlers = createAppCapabilityPanelHandlers(
      createParams({ handleSettingsAction, onUnavailable }),
    );

    handlers.handleCapabilityPanelAction("refresh-account");

    expect(handleSettingsAction).toHaveBeenCalledWith("refresh-account");
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("runs supported thread lifecycle actions through the Control client", async () => {
    const compactThread = vi.fn(async () => {});
    const readThread = vi.fn(async () => ({ id: "thread-1" }) as never);
    const setBusyToolId = vi.fn();
    const handlers = createAppCapabilityPanelHandlers(
      createParams({
        setBusyToolId,
        threadLifecycleClient: {
          compactThread,
          readThread,
          rollbackThread: vi.fn(),
        },
        threadLifecycleConnected: true,
      }),
    );

    handlers.handleCapabilityPanelAction("compact-thread");
    await vi.waitUntil(() => setBusyToolId.mock.calls.at(-1)?.[0] === null);

    expect(compactThread).toHaveBeenCalledWith("thread-1");
    expect(readThread).toHaveBeenCalledWith("thread-1");
    expect(setBusyToolId).toHaveBeenLastCalledWith(null);
  });

  it("fails closed for removed App Server actions and panel items", async () => {
    const onUnavailable = vi.fn();
    const handlers = createAppCapabilityPanelHandlers(
      createParams({ onUnavailable }),
    );

    handlers.handleCapabilityPanelAction("save-thread-settings");
    await handlers.handleCapabilityPanelItem({
      kind: "file",
      label: "README.md",
      path: "/repo/README.md",
    });

    expect(onUnavailable).toHaveBeenCalledTimes(2);
  });

  it("updates capability and Library form fields together", () => {
    let capabilityPanel: CapabilityPanel | null = {
      fields: [{ id: "shared", label: "Shared", value: "old" }],
      title: "Capability",
    };
    let libraryPanel: LibraryPanel | null = {
      fields: [{ id: "shared", label: "Shared", value: "old" }],
      items: [],
      kind: "tools",
      subtitle: "Library",
      title: "Tools",
    };
    const handlers = createAppCapabilityPanelHandlers(
      createParams({
        capabilityPanel,
        setCapabilityPanel: (next) => {
          capabilityPanel =
            typeof next === "function" ? next(capabilityPanel) : next;
        },
        setLibraryPanel: (update) => {
          libraryPanel = update(libraryPanel);
        },
      }),
    );

    handlers.handleCapabilityPanelFieldChange("shared", "new");

    expect(capabilityPanel?.fields).toEqual([
      { id: "shared", label: "Shared", value: "new" },
    ]);
    expect(libraryPanel?.fields).toEqual([
      { id: "shared", label: "Shared", value: "new" },
    ]);
  });
});
