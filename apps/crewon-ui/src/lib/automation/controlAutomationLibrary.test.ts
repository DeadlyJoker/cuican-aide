import type {
  AutomationView,
  RunAutomationNowResponse,
} from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import { describe, expect, it, vi } from "vitest";

import {
  listControlAutomationLibraryItems,
  runControlAutomationNow,
} from "./controlAutomationLibrary";

function automation(overrides: Partial<AutomationView> = {}): AutomationView {
  return {
    agentVersionId: "agent-version-1",
    automaticScheduling: false,
    automationId: "automation-1",
    createdAt: "2026-08-13T00:00:00.000Z",
    executionMode: "manualOnly",
    prompt: "Summarize progress",
    revision: 1,
    threadId: "thread-1",
    title: "Daily summary",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("Control Automation library", () => {
  it("lists manual-only definitions without scheduler actions", async () => {
    const listAutomations = vi
      .fn()
      .mockResolvedValueOnce({ data: [automation()], nextCursor: "next" })
      .mockResolvedValueOnce({
        data: [automation({ automationId: "automation-2", title: "Review" })],
        nextCursor: null,
      });

    const items = await listControlAutomationLibraryItems(
      { listAutomations } as unknown as ControlApiClient,
      "en",
    );

    expect(listAutomations).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(listAutomations).toHaveBeenNthCalledWith(2, {
      cursor: "next",
      limit: 100,
    });
    expect(items).toHaveLength(2);
    expect(items[0]?.tags).toEqual(["manual only"]);
    expect(items[0]?.action).toMatchObject({
      type: "automation-detail",
      controlAutomationId: "automation-1",
      controlAutomationRevision: 1,
      threadId: "thread-1",
    });
    expect(JSON.stringify(items)).not.toMatch(/schedule|enabled|disabled/iu);
  });

  it("runs with canonical Thread CAS and validates the response binding", async () => {
    const definition = automation();
    const runAutomationNow = vi.fn(
      async (): Promise<RunAutomationNowResponse> => ({
        disposition: "committed",
        automation: definition,
        invocation: { automationId: definition.automationId, runId: "run-1" },
        run: {
          runId: "run-1",
          threadId: definition.threadId,
          status: "queued",
          revision: 1,
          lastSequence: 0,
          cancelRequested: false,
          waitingApproval: null,
          collaborationMode: "default",
          purpose: "turn",
          workflowVersionBinding: null,
          goalBinding: null,
          outputRef: null,
          failure: null,
          createdAt: definition.createdAt,
          updatedAt: definition.updatedAt,
          terminalAt: null,
        },
      }),
    );
    const client = {
      getThread: vi.fn(async () => ({
        thread: { threadId: "thread-1", status: "active", revision: 7 },
      })),
      runAutomationNow,
    } as unknown as ControlApiClient;

    await expect(
      runControlAutomationNow({
        automationId: "automation-1",
        automationRevision: 1,
        client,
        idempotencyKey: "run-now-1",
        threadId: "thread-1",
      }),
    ).resolves.toBe("run-1");
    expect(runAutomationNow).toHaveBeenCalledWith(
      "automation-1",
      { expectedAutomationRevision: 1, expectedThreadRevision: 7 },
      "run-now-1",
    );
  });

  it("fails closed for inactive Threads before mutation", async () => {
    const runAutomationNow = vi.fn();
    const client = {
      getThread: vi.fn(async () => ({
        thread: { threadId: "thread-1", status: "archived", revision: 7 },
      })),
      runAutomationNow,
    } as unknown as ControlApiClient;

    await expect(
      runControlAutomationNow({
        automationId: "automation-1",
        automationRevision: 1,
        client,
        idempotencyKey: "run-now-1",
        threadId: "thread-1",
      }),
    ).rejects.toThrow("control_automation_thread_not_active");
    expect(runAutomationNow).not.toHaveBeenCalled();
  });
});
