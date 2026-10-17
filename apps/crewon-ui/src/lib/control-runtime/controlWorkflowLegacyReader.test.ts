import { describe, expect, it, vi } from "vitest";
import type {
  MessageView,
  RunView,
  ThreadView,
  WorkflowVersionView,
} from "@crewon/contracts";
import { workflowCommandsSnapshotFixture } from "./controlWorkflowCommands.test-support";
import { controlWorkflowDefinition } from "./controlWorkflowDefinition";
import { ControlWorkflowLegacyReader } from "./controlWorkflowLegacyReader";
import { isInternalControlWorkflowThread } from "./controlWorkflowLegacyMarkers";
import { WORKFLOW_VERIFICATION_CONTRACT_V1 } from "@crewon/domain/workflow-verification";

const now = "2026-10-18T00:00:00.000Z";
function legacy(
  options: {
    decision?: "approve" | "reject";
    verifierOutput?: string;
    canceled?: boolean;
    markerFree?: boolean;
    verifierStarted?: boolean;
  } = {},
) {
  const source = controlWorkflowDefinition({
    title: "Release decision",
    description: "Review evidence",
    nodes: [
      {
        type: "agent",
        title: "Producer",
        instruction: "Review evidence",
        agentVersionId: "producer",
      },
      {
        type: "humanGate",
        title: "Approval",
        instruction: "Review before continuing",
      },
      {
        type: "verification",
        title: "Verifier",
        instruction: "Verify independently",
        agentVersionId: "verifier",
      },
    ],
  });
  const version: WorkflowVersionView = {
    ...source,
    workflowId: "workflow-1",
    workflowVersionId: "version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
    createdAt: now,
    executionOrder: source.nodes.map((node) => node.nodeId),
    nodes: source.nodes.map((node) =>
      options.markerFree && node.kind === "verification"
        ? { ...node, instruction: "Legacy verification" }
        : node,
    ),
  };
  const thread: ThreadView = {
    threadId: "legacy-thread",
    title: "__crewon_workflow_run__:version-1:execution-1",
    status: "active",
    revision: 1,
    lastMessageSequence: 0,
    forkedFromThreadId: "main-thread",
    forkedThroughHistorySequence: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  };
  const messages: MessageView[] = [];
  function message(role: "user" | "assistant", content: string) {
    messages.push({
      messageId: `message-${messages.length}`,
      threadId: thread.threadId,
      sequence: messages.length + 1,
      role,
      content,
      proposedPlan: null,
      createdAt: now,
    });
  }
  message(
    "assistant",
    "Unrelated inherited history must not become a node result",
  );
  message("user", "[Control Workflow · input]\nOriginal input");
  message("user", "[Control Workflow · node:node-01]\nProducer");
  message("assistant", "Producer evidence");
  message("user", "[Control Workflow · gate:node-02:request]");
  if (options.decision)
    message(
      "user",
      `[Control Workflow · gate:node-02:${options.decision}]\n  Keep the original review  `,
    );
  if (options.verifierStarted || options.verifierOutput !== undefined)
    message("user", "[Control Workflow · node:node-03]\nVerifier");
  if (options.canceled) message("user", "[Control Workflow · canceled]");
  if (options.verifierOutput !== undefined)
    message("assistant", options.verifierOutput);
  const writes = {
    createRun: vi.fn(),
    appendThreadMessage: vi.fn(),
    forkThread: vi.fn(),
    cancelRun: vi.fn(),
  };
  const client = {
    ...writes,
    listThreads: vi.fn(async () => ({ data: [thread], nextCursor: null })),
    getWorkflowVersion: vi.fn(async () => ({ workflowVersion: version })),
    listThreadMessages: vi.fn(async () => ({
      data: messages,
      nextCursor: null,
    })),
    listThreadRuns: vi.fn(async () => ({
      data:
        options.verifierStarted && options.verifierOutput === undefined
          ? [
              {
                ...workflowCommandsSnapshotFixture().run,
                runId: "verifier-run",
                threadId: thread.threadId,
                status: "running" as const,
                purpose: "turn" as const,
                workflowVersionBinding: null,
              } as RunView,
            ]
          : [],
      nextCursor: null,
    })),
  };
  return {
    reader: new ControlWorkflowLegacyReader(client),
    writes,
    version,
    client,
    thread,
  };
}
async function record(f: ReturnType<typeof legacy>) {
  return (await f.reader.listWorkflows()).records[0]!;
}

describe("read-only legacy Workflow projection after renderer retirement", () => {
  it("retains persisted producer/Gate progress on repeated reads without resuming or sending", async () => {
    const f = legacy();
    const first = await record(f),
      second = await record(f);
    expect(second).toEqual(first);
    expect(first.config.runs?.[0]).toMatchObject({
      executionId: "execution-1",
      input: "Original input",
      status: "waitingForApproval",
    });
    expect(
      first.config.runs?.[0]?.executedNodes.map((node) => node.status),
    ).toEqual(["completed", "waitingForApproval", "pending"]);
    expect(first.config.runs?.[0]?.output).toBe("Producer evidence");
    for (const write of Object.values(f.writes))
      expect(write).not.toHaveBeenCalled();
    expect(isInternalControlWorkflowThread(f.thread)).toBe(true);
  });
  it("retains rejection and prevents a canceled Gate from looking actionable", async () => {
    expect(
      (await record(legacy({ decision: "reject" }))).config.runs?.[0]?.status,
    ).toBe("failed");
    const canceled = await record(legacy({ canceled: true }));
    expect(canceled.config.runs?.[0]?.status).toBe("canceled");
    expect(canceled.config.runs?.[0]?.executedNodes[1]?.status).toBe(
      "canceled",
    );
  });
  it("retains strict FAIL and original verifier output", async () => {
    const output = "VERDICT: FAIL\nMissing rollback proof.";
    const result = (
      await record(legacy({ decision: "approve", verifierOutput: output }))
    ).config.runs![0]!;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("control_workflow_verification_failed");
    expect(result.output).toBe(output);
  });
  it.each([
    "Evidence without a verdict",
    "VERDICT: PASS\nVERDICT: FAIL",
    "VERDICT : PASS",
    "verdict: PASS",
    "VERDICT: PASS - complete",
  ])("fails closed for the persisted v1 verdict %s", async (output) => {
    const result = (
      await record(legacy({ decision: "approve", verifierOutput: output }))
    ).config.runs![0]!;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("control_workflow_verification_invalid");
    expect(result.executedNodes.at(-1)?.output).toBe(output);
  });
  it("accepts one strict PASS with incidental FAIL prose", async () => {
    const result = await record(
      legacy({
        decision: "approve",
        verifierOutput:
          "The instruction mentioned VERDICT: FAIL.\nVERDICT: PASS\nEvidence checked.",
      }),
    );
    expect(result.config.runs?.[0]?.status).toBe("completed");
    expect(result.config.runs?.[0]?.error).toBeNull();
  });
  it("retains the explicit parser for historical marker-free definitions", async () => {
    const f = legacy({
      decision: "approve",
      markerFree: true,
      verifierOutput: "Legacy report",
    });
    expect(f.version.nodes.at(-1)?.instruction).not.toContain(
      WORKFLOW_VERIFICATION_CONTRACT_V1,
    );
    expect((await record(f)).config.runs?.[0]?.status).toBe("completed");
  });
  it("retains incomplete verifier progress after approval without creating the next Run", async () => {
    const f = legacy({ decision: "approve", verifierStarted: true });
    const result = await record(f);
    expect(result.config.runs?.[0]?.status).toBe("running");
    expect(result.config.runs?.[0]?.executedNodes.at(-1)?.status).toBe(
      "running",
    );
    expect(f.writes.createRun).not.toHaveBeenCalled();
  });
  it("does not resurrect cancellation when a late verifier result arrives", async () => {
    const f = legacy({
      decision: "approve",
      canceled: true,
      verifierOutput: "VERDICT: PASS",
    });
    expect((await record(f)).config.runs?.[0]?.status).toBe("canceled");
    for (const write of Object.values(f.writes))
      expect(write).not.toHaveBeenCalled();
  });
});
