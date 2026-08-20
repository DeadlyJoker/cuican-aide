import { describe, expect, it, vi } from "vitest";

import {
  commandShellViewFromHash,
  installCommandShellHashRouting,
  openControlLibraryFromCommandShell,
} from "./commandWorkspaceHashRouting";

function routeWindow(hash: string) {
  const events = new EventTarget();
  const location = {
    hash,
    pathname: "/workspace",
    search: "?tenant=tenant-1",
  };
  const replaceState = vi.fn(
    (_data: unknown, _unused: string, url?: string | URL | null) => {
      if (url !== undefined && url !== null) {
        location.hash = new URL(String(url), "https://crewon.local").hash;
      }
    },
  );
  return {
    events,
    location,
    replaceState,
    value: {
      addEventListener: (type: string, listener: EventListener) =>
        events.addEventListener(type, listener),
      history: { replaceState },
      location,
      removeEventListener: (type: string, listener: EventListener) =>
        events.removeEventListener(type, listener),
    } as unknown as Window,
  };
}

describe("command Workspace hash routing", () => {
  it("opens a direct Agent hash in the Control Library and keeps command active", () => {
    const browser = routeWindow("#view-agents");
    const onOpenLibrary = vi.fn();
    const setActiveView = vi.fn();

    installCommandShellHashRouting(browser.value, setActiveView, onOpenLibrary);

    expect(setActiveView).toHaveBeenLastCalledWith("command");
    expect(onOpenLibrary).toHaveBeenCalledOnce();
    expect(onOpenLibrary).toHaveBeenCalledWith("agents");
    expect(browser.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/workspace?tenant=tenant-1#view-command",
    );
    expect(browser.location.hash).toBe("#view-command");
  });

  it("routes Knowledge hashchange, Agent popstate, and Schedule through Control", () => {
    const browser = routeWindow("#view-command");
    const opened: string[] = [];
    const activeViews: string[] = [];
    const cleanup = installCommandShellHashRouting(
      browser.value,
      (view) => activeViews.push(view),
      (kind) => {
        opened.push(kind);
      },
    );

    browser.location.hash = "#view-knowledge";
    browser.events.dispatchEvent(new Event("hashchange"));
    browser.location.hash = "#view-agents";
    browser.events.dispatchEvent(new Event("popstate"));
    browser.location.hash = "#view-schedule";
    browser.events.dispatchEvent(new Event("hashchange"));

    expect(opened).toEqual(["knowledge", "agents", "automation"]);
    expect(activeViews).toEqual(["command", "command", "command", "command"]);
    expect(browser.location.hash).toBe("#view-command");

    cleanup();
    browser.location.hash = "#view-knowledge";
    browser.events.dispatchEvent(new Event("hashchange"));
    expect(opened).toEqual(["knowledge", "agents", "automation"]);
  });

  it("keeps ordinary shell hashes local and canonicalizes catalog views", () => {
    expect({
      agents: commandShellViewFromHash("#view-agents"),
      assist: commandShellViewFromHash("#view-assist"),
      knowledge: commandShellViewFromHash("#view-knowledge"),
      projects: commandShellViewFromHash("#view-projects"),
      schedule: commandShellViewFromHash("#view-schedule"),
      team: commandShellViewFromHash("#view-team"),
      unknown: commandShellViewFromHash("#view-unknown"),
    }).toMatchInlineSnapshot(`
      {
        "agents": "command",
        "assist": "assist",
        "knowledge": "command",
        "projects": "projects",
        "schedule": "command",
        "team": "team",
        "unknown": "command",
      }
    `);
  });

  it("canonicalizes an in-app catalog selection before opening Control", () => {
    const browser = routeWindow("#view-assist");
    const onOpenLibrary = vi.fn();
    const setActiveView = vi.fn();

    openControlLibraryFromCommandShell(
      browser.value,
      setActiveView,
      "knowledge",
      onOpenLibrary,
    );

    expect(setActiveView).toHaveBeenCalledWith("command");
    expect(browser.location.hash).toBe("#view-command");
    expect(onOpenLibrary).toHaveBeenCalledWith("knowledge");
  });
});
