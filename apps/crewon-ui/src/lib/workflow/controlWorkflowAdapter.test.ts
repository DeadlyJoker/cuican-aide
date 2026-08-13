import { describe, expect, it, vi } from "vitest";
import type { RunView } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

import { createControlWorkflowAdapter } from "./controlWorkflowAdapter";

describe("ControlWorkflowAdapter", () => {
  it("discovers without a caller-owned workflow id and starts a bound Run", async () => {
    const run = workflowRun();
    const client = {
      listWorkflowVersions: vi.fn(async () => ({ data: [], nextCursor: null })),
      startWorkflowRun: vi.fn(async () => ({ disposition: "committed", run })),
    } as unknown as ControlApiClient;
    const adapter = createControlWorkflowAdapter(client);

    await expect(adapter.discover({ limit: 100 })).resolves.toEqual({
      data: [],
      nextCursor: null,
    });
    expect(client.listWorkflowVersions).toHaveBeenCalledWith(
      { cursor: undefined, limit: 100 },
      { signal: undefined },
    );
    await expect(
      adapter.start({
        workflowVersionId: "workflow-version-1",
        threadId: "thread-1",
        value: { prompt: "ship" },
        idempotencyKey: "workflow-key",
      }),
    ).resolves.toEqual(run);
    expect(client.startWorkflowRun).toHaveBeenCalledWith(
      {
        workflowVersionId: "workflow-version-1",
        threadId: "thread-1",
        input: { prompt: "ship" },
      },
      "workflow-key",
      { signal: undefined },
    );
  });

  it("fails closed when Control returns a different Workflow binding", async () => {
    const client = {
      startWorkflowRun: vi.fn(async () => ({
        disposition: "committed",
        run: {
          ...workflowRun(),
          workflowVersionBinding: {
            workflowId: "workflow-2",
            workflowVersionId: "workflow-version-2",
            contentDigest: `sha256:${"b".repeat(64)}`,
          },
        },
      })),
    } as unknown as ControlApiClient;
    const adapter = createControlWorkflowAdapter(client);
    await expect(
      adapter.start({
        workflowVersionId: "workflow-version-1",
        threadId: "thread-1",
        value: {},
        idempotencyKey: "workflow-key",
      }),
    ).rejects.toThrow("control_workflow_binding_invalid");
  });
});

function workflowRun(): RunView {
  return {
    runId: "run-1",
    threadId: "thread-1",
    status: "queued",
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "workflow",
    workflowVersionBinding: {
      workflowId: "workflow-1",
      workflowVersionId: "workflow-version-1",
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    terminalAt: null,
  };
}
