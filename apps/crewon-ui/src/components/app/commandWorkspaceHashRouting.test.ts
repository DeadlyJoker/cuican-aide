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
  it("opens a direct Agent hash in the Control Library inside the command shell", () => {
    const browser = routeWindow("#view-agents");
    const onOpenLibrary = vi.fn();
    const setActiveView = vi.fn();

    installCommandShellHashRouting(browser.value, setActiveView, onOpenLibrary);

    expect(setActiveView).toHaveBeenLastCalledWith("agents");
    expect(onOpenLibrary).toHaveBeenCalledOnce();
    expect(onOpenLibrary).toHaveBeenCalledWith("agents");
    expect(browser.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/workspace?tenant=tenant-1#view-agents",
    );
    expect(browser.location.hash).toBe("#view-agents");
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
    expect(activeViews).toEqual(["command", "knowledge", "agents", "schedule"]);
    expect(browser.location.hash).toBe("#view-schedule");

    cleanup();
    browser.location.hash = "#view-knowledge";
    browser.events.dispatchEvent(new Event("hashchange"));
    expect(opened).toEqual(["knowledge", "agents", "automation"]);
  });

  it("keeps every persistent shell destination addressable", () => {
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
        "agents": "agents",
        "assist": "assist",
        "knowledge": "knowledge",
        "projects": "projects",
        "schedule": "schedule",
        "team": "team",
        "unknown": "command",
      }
    `);
  });

  it("keeps an in-app catalog selection inside its shell destination", () => {
    const browser = routeWindow("#view-assist");
    const onOpenLibrary = vi.fn();
    const setActiveView = vi.fn();

    openControlLibraryFromCommandShell(
      browser.value,
      setActiveView,
      "knowledge",
      onOpenLibrary,
    );

    expect(setActiveView).toHaveBeenCalledWith("knowledge");
    expect(browser.location.hash).toBe("#view-knowledge");
    expect(onOpenLibrary).toHaveBeenCalledWith("knowledge");
  });
});
