import { describe, expect, it } from "vitest";

import type { AppServerNotification } from "../app-server/appServer";
import type { LibraryPanel, OfficeConfig } from "../domain/crewonDomain";
import { handleOfficeRunUpdatedAppNotification } from "./appOfficeRunUpdatedNotificationHandler";

function config(overrides: Partial<OfficeConfig> = {}): OfficeConfig {
  return {
    title: "Office",
    subtitle: "Runtime",
    workspace: {
      goal: "Ship",
      threadId: "office-thread",
      backendStatus: "connected",
      members: [],
      messages: [],
      tasks: [],
      activity: {
        approvals: [],
        artifacts: [],
        budget: [],
        budgetCapUsd: 0,
        runs: [
          {
            id: "run-1",
            title: "Updated run",
            status: "completed",
            resultPreview: "Auto-dispatch finished",
          },
        ],
        trace: [],
      },
    },
    ...overrides,
  };
}

function panel(overrides: Partial<LibraryPanel> = {}): LibraryPanel {
  return {
    kind: "office",
    title: "Office",
    subtitle: "Runtime",
    items: [],
    workspace: {
      goal: "Old goal",
      threadId: "office-thread",
      backendStatus: "connected",
      members: [],
      messages: [],
      tasks: [],
      activity: {
        approvals: [],
        artifacts: [],
        budget: [],
        budgetCapUsd: 0,
        runs: [],
        trace: [],
      },
    },
    ...overrides,
  };
}

function notification(
  officeConfig: unknown = config(),
): AppServerNotification {
  return {
    method: "office/run/updated",
    params: {
      cwd: "/repo",
      filePath: "/repo/.crewon/offices/office.json",
      config: officeConfig,
      reason: "autoDispatchCompletion",
      sourceThreadId: "member-thread",
      sourceTurnId: "turn-member",
    },
  } as AppServerNotification;
}

describe("office run updated notification handler", () => {
  it("applies matching office run updates to the visible office panel", () => {
    let currentPanel: LibraryPanel | null = panel();

    const handled = handleOfficeRunUpdatedAppNotification({
      notification: notification(),
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel?.configPath).toBe("/repo/.crewon/offices/office.json");
    expect(currentPanel?.workspace?.goal).toBe("Ship");
    expect(currentPanel?.workspace?.activity?.runs?.[0]).toMatchObject({
      id: "run-1",
      lastNotificationReason: "autoDispatchCompletion",
      lastNotificationSourceThreadId: "member-thread",
      lastNotificationSourceTurnId: "turn-member",
      resultPreview: "Auto-dispatch finished",
      status: "completed",
    });
  });

  it("ignores updates for another visible office", () => {
    let currentPanel: LibraryPanel | null = panel({
      workspace: {
        ...panel().workspace!,
        threadId: "other-office-thread",
      },
    });

    const handled = handleOfficeRunUpdatedAppNotification({
      notification: notification(),
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel?.workspace?.goal).toBe("Old goal");
    expect(currentPanel?.workspace?.activity?.runs).toEqual([]);
  });

  it("uses config path identity before thread id when both are available", () => {
    let currentPanel: LibraryPanel | null = panel({
      configPath: "/repo/.crewon/offices/other.json",
    });

    const handled = handleOfficeRunUpdatedAppNotification({
      notification: notification(),
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel?.workspace?.goal).toBe("Old goal");
    expect(currentPanel?.workspace?.activity?.runs).toEqual([]);
  });

  it("applies updates when the config path matches even without thread id", () => {
    let currentPanel: LibraryPanel | null = panel({
      configPath: "/repo/.crewon/offices/office.json",
      workspace: {
        ...panel().workspace!,
        threadId: undefined,
      },
    });

    const handled = handleOfficeRunUpdatedAppNotification({
      notification: notification(),
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel?.workspace?.goal).toBe("Ship");
    expect(currentPanel?.workspace?.activity?.runs?.[0]?.id).toBe("run-1");
  });

  it("handles malformed office config without changing the panel", () => {
    let currentPanel: LibraryPanel | null = panel();

    const handled = handleOfficeRunUpdatedAppNotification({
      notification: notification({ title: "Office" }),
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel?.workspace?.goal).toBe("Old goal");
  });
});
