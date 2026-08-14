import type { AutomationView } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import { describe, expect, it, vi } from "vitest";

import type { LibraryPanel } from "../domain/crewonDomain";
import {
  createControlLibraryPanelActionHandler,
  openControlLibraryItem,
} from "./controlLibraryInteraction";

function automation(overrides: Partial<AutomationView> = {}): AutomationView {
  return {
    agentVersionId: "agent-version-1",
    automationId: "automation-1",
    createdAt: "2026-08-13T00:00:00.000Z",
    misfirePolicy: "coalesceLatest",
    prompt: "Fresh prompt",
    revision: 1,
    schedule: {
      kind: "daily",
      localTime: "18:00",
      timezone: "Asia/Shanghai",
    },
    threadId: "thread-fresh",
    title: "Fresh title",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("Control Library interactions", () => {
  it("re-reads canonical Automation detail instead of trusting list state", async () => {
    let panel: LibraryPanel | null = null;
    const getAutomation = vi.fn(async () => ({
      automation: automation(),
    }));

    await openControlLibraryItem({
      client: { getAutomation } as unknown as ControlApiClient,
      item: {
        title: "Stale title",
        meta: "Control",
        action: {
          type: "automation-detail",
          title: "Stale title",
          subtitle: "Control",
          body: "Stale body",
          prompt: "Stale prompt",
          threadId: "thread-stale",
          controlAutomationId: "automation-1",
          controlAutomationRevision: 1,
        },
      },
      locale: "en",
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
      setNotice: vi.fn(),
    });

    expect(getAutomation).toHaveBeenCalledWith("automation-1");
    expect(panel).toMatchObject({
      title: "Fresh title",
      actions: [
        {
          id: "run-automation",
          automationThreadId: "thread-fresh",
          controlAutomationId: "automation-1",
          controlAutomationRevision: 1,
        },
      ],
    });
  });

  it("fails closed when the fresh Automation detail has no thread identity", async () => {
    let panel: LibraryPanel | null = null;
    const setNotice = vi.fn();

    await openControlLibraryItem({
      client: {
        getAutomation: vi.fn(async () => ({
          automation: automation({ threadId: "" }),
        })),
      } as unknown as ControlApiClient,
      item: {
        title: "Listed automation",
        meta: "Control",
        action: {
          type: "automation-detail",
          title: "Listed automation",
          subtitle: "Control",
          body: "Listed body",
          prompt: "Listed prompt",
          threadId: "thread-listed",
          controlAutomationId: "automation-1",
          controlAutomationRevision: 1,
        },
      },
      locale: "en",
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
      setNotice,
    });

    expect(panel).toBeNull();
    expect(setNotice).toHaveBeenCalledWith({
      text: "control_automation_detail_response_invalid",
      tone: "warning",
    });
  });

  it("fails closed when the fresh Automation detail has an unsupported revision", async () => {
    let panel: LibraryPanel | null = null;
    const setNotice = vi.fn();

    await openControlLibraryItem({
      client: {
        getAutomation: vi.fn(async () => ({
          automation: automation({ revision: 2 as 1 }),
        })),
      } as unknown as ControlApiClient,
      item: {
        title: "Listed automation",
        meta: "Control",
        action: {
          type: "automation-detail",
          title: "Listed automation",
          subtitle: "Control",
          body: "Listed body",
          prompt: "Listed prompt",
          threadId: "thread-listed",
          controlAutomationId: "automation-1",
          controlAutomationRevision: 1,
        },
      },
      locale: "en",
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
      setNotice,
    });

    expect(panel).toBeNull();
    expect(setNotice).toHaveBeenCalledWith({
      text: "control_automation_detail_response_invalid",
      tone: "warning",
    });
  });

  it("does not let an obsolete Automation detail replace a newer panel", async () => {
    let currentRequest = 1;
    let finishOlderRequest!: (value: unknown) => void;
    let panel: LibraryPanel | null = null;
    const setNotice = vi.fn();
    const olderRequest = openControlLibraryItem({
      client: {
        getAutomation: vi.fn(
          () =>
            new Promise((resolve) => {
              finishOlderRequest = resolve;
            }),
        ),
      } as unknown as ControlApiClient,
      item: {
        title: "Older",
        meta: "Control",
        action: {
          type: "automation-detail",
          title: "Older",
          subtitle: "Control",
          body: "Older body",
          prompt: "Older prompt",
          threadId: "thread-older",
          controlAutomationId: "automation-older",
          controlAutomationRevision: 1,
        },
      },
      isCurrent: () => currentRequest === 1,
      locale: "en",
      setLibraryPanel: (next) => {
        panel = typeof next === "function" ? next(panel) : next;
      },
      setNotice,
    });

    currentRequest = 2;
    panel = {
      kind: "office",
      title: "Newer panel",
      subtitle: "Newer subtitle",
      items: [],
    };
    finishOlderRequest({
      automation: automation({
        automationId: "automation-older",
        threadId: "thread-older",
        title: "Older",
      }),
    });
    await olderRequest;

    expect(panel).toEqual({
      kind: "office",
      title: "Newer panel",
      subtitle: "Newer subtitle",
      items: [],
    });
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("prepares Automation creation only from Control Threads and AgentVersions", async () => {
    const setLibraryPanel = vi.fn();
    const handler = createControlLibraryPanelActionHandler({
      client: {
        getActiveAgentVersionCatalog: vi.fn(async () => ({
          data: [
            {
              agentVersionId: "agent-version-1",
              model: { modelId: "gpt-5.6" },
            },
          ],
        })),
        listThreads: vi.fn(async () => ({
          data: [
            {
              status: "active",
              threadId: "thread-1",
              title: "Daily summary",
            },
          ],
        })),
      } as unknown as ControlApiClient,
      libraryPanel: null,
      locale: "en",
      openLibrary: vi.fn(async () => undefined),
      selectedThreadId: null,
      setLibraryPanel,
      setNotice: vi.fn(),
    });

    await handler({
      id: "prepare-control-automation",
      label: "New automation",
    });

    expect(setLibraryPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          { id: "submit-control-automation", label: "Save automation" },
        ],
        fields: expect.arrayContaining([
          expect.objectContaining({
            id: "control-automation-thread",
            value: "thread-1",
          }),
          expect.objectContaining({
            id: "control-automation-local-time",
            value: "09:00",
          }),
          expect.objectContaining({ id: "control-automation-timezone" }),
          expect.objectContaining({ id: "control-automation-agent" }),
        ]),
      }),
    );
  });

  it("fails closed for a legacy Library action", async () => {
    const setNotice = vi.fn();
    const handler = createControlLibraryPanelActionHandler({
      client: {} as ControlApiClient,
      libraryPanel: null,
      locale: "en",
      openLibrary: vi.fn(async () => undefined),
      selectedThreadId: null,
      setLibraryPanel: vi.fn(),
      setNotice,
    });

    await handler({ id: "install-plugin", label: "Install" });

    expect(setNotice).toHaveBeenCalledWith({
      text: "This action is not available from CrewON Control; no changes were made.",
      tone: "warning",
    });
  });
});
