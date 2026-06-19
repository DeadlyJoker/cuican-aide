import { describe, expect, it, vi } from "vitest";

import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import {
  handleLibraryConnectionGate,
  handleLibraryPanelActionDispatch,
  handleLibraryDraftPlaceholder,
  showLibraryActionProgress,
} from "./libraryPanelActionFlow";

function panel(): LibraryPanel {
  return {
    kind: "tools",
    title: "Tools",
    subtitle: "Library",
    body: "Existing body",
    items: [{ title: "Existing", meta: "old" }],
    error: "old error",
  };
}

function capturePanel(initialPanel: LibraryPanel | null = panel()) {
  let currentPanel = initialPanel;
  return {
    get panel() {
      return currentPanel;
    },
    setLibraryPanel(updater: (panel: LibraryPanel | null) => LibraryPanel | null) {
      currentPanel = updater(currentPanel);
    },
  };
}

describe("library panel action flow", () => {
  it("allows connected actions to continue", () => {
    const state = capturePanel();

    expect(
      handleLibraryConnectionGate({
        action: { id: "reload-tools", label: "Reload" },
        isConnected: true,
        isDemo: false,
        locale: "en",
        setLibraryPanel: state.setLibraryPanel,
      }),
    ).toBe(false);
    expect(state.panel).toEqual(panel());
  });

  it("allows demo draft actions to continue", () => {
    const state = capturePanel();

    expect(
      handleLibraryConnectionGate({
        action: { id: "create-agent", label: "Create agent" },
        isConnected: false,
        isDemo: true,
        locale: "en",
        setLibraryPanel: state.setLibraryPanel,
      }),
    ).toBe(false);
    expect(state.panel).toEqual(panel());
  });

  it("handles backend-deferred demo actions", () => {
    const state = capturePanel();

    expect(
      handleLibraryConnectionGate({
        action: { id: "install-plugin", label: "Install" },
        isConnected: false,
        isDemo: true,
        locale: "en",
        setLibraryPanel: state.setLibraryPanel,
      }),
    ).toBe(true);
    expect(state.panel?.body).toContain("marketplace browse and install");
    expect(state.panel?.error).toBeUndefined();
  });

  it("swallows unavailable non-demo actions without changing the panel", () => {
    const state = capturePanel();

    expect(
      handleLibraryConnectionGate({
        action: { id: "reload-tools", label: "Reload" },
        isConnected: false,
        isDemo: false,
        locale: "en",
        setLibraryPanel: state.setLibraryPanel,
      }),
    ).toBe(true);
    expect(state.panel).toEqual(panel());
  });

  it("shows draft placeholders for draft actions", () => {
    const state = capturePanel();

    expect(
      handleLibraryDraftPlaceholder({
        action: { id: "create-skill", label: "Create skill" },
        locale: "en",
        setLibraryPanel: state.setLibraryPanel,
      }),
    ).toBe(true);
    expect(state.panel?.body).toContain("New Skill is now in draft state");
    expect(state.panel?.items[0]?.title).toBe("New Skill");
  });

  it("leaves non-draft actions for concrete handlers", () => {
    const state = capturePanel();

    expect(
      handleLibraryDraftPlaceholder({
        action: { id: "reload-tools", label: "Reload" },
        locale: "en",
        setLibraryPanel: state.setLibraryPanel,
      }),
    ).toBe(false);
    expect(state.panel).toEqual(panel());
  });

  it("shows progress for long-running actions", () => {
    const state = capturePanel();
    const action: LibraryPanelAction = {
      id: "run-automation",
      label: "Run automation",
    };

    showLibraryActionProgress({
      action,
      locale: "en",
      setLibraryPanel: state.setLibraryPanel,
    });

    expect(state.panel?.body).toBe("Running automation...");
    expect(state.panel?.error).toBeUndefined();
  });

  it("dispatches immediate handlers before connected-only handlers", async () => {
    const state = capturePanel();
    const calls: string[] = [];

    await expect(
      handleLibraryPanelActionDispatch({
        action: { id: "open-thread", label: "Open thread" },
        connectedHandlers: [
          () => {
            calls.push("connected");
            return true;
          },
        ],
        deferredHandlers: [
          () => {
            calls.push("deferred");
            return true;
          },
        ],
        immediateHandlers: [
          () => {
            calls.push("immediate");
            return true;
          },
        ],
        isConnected: true,
        isDemo: false,
        locale: "en",
        setLibraryPanel: state.setLibraryPanel,
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual(["immediate"]);
    expect(state.panel).toEqual(panel());
  });

  it("skips connected-only handlers when disconnected", async () => {
    const state = capturePanel();
    const connected = vi.fn(() => true);

    await expect(
      handleLibraryPanelActionDispatch({
        action: { id: "reload-tools", label: "Reload" },
        connectedHandlers: [connected],
        deferredHandlers: [],
        immediateHandlers: [],
        isConnected: false,
        isDemo: false,
        locale: "en",
        setLibraryPanel: state.setLibraryPanel,
      }),
    ).resolves.toBe(true);
    expect(connected).not.toHaveBeenCalled();
    expect(state.panel).toEqual(panel());
  });

  it("shows a draft placeholder before deferred handlers", async () => {
    const state = capturePanel();
    const deferred = vi.fn(() => true);

    await expect(
      handleLibraryPanelActionDispatch({
        action: { id: "create-mcp", label: "Create MCP" },
        connectedHandlers: [],
        deferredHandlers: [deferred],
        immediateHandlers: [],
        isConnected: true,
        isDemo: false,
        locale: "en",
        setLibraryPanel: state.setLibraryPanel,
      }),
    ).resolves.toBe(true);
    expect(deferred).not.toHaveBeenCalled();
    expect(state.panel?.items[0]?.title).toBe("New MCP");
  });

  it("wraps deferred handlers with progress and failure panels", async () => {
    const state = capturePanel();

    await expect(
      handleLibraryPanelActionDispatch({
        action: { id: "reload-tools", label: "Reload tools" },
        connectedHandlers: [],
        deferredHandlers: [
          () => {
            throw new Error("denied");
          },
        ],
        immediateHandlers: [],
        isConnected: true,
        isDemo: false,
        locale: "en",
        setLibraryPanel: state.setLibraryPanel,
      }),
    ).resolves.toBe(true);
    expect(state.panel?.body).toBe("Refreshing tools...");
    expect(state.panel?.error).toBe("denied");
  });
});
