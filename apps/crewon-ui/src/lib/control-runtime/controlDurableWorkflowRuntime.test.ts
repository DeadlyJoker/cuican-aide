import { describe, expect, it, vi } from "vitest";
import type { WorkflowVersionView } from "@crewon/contracts";
import {
  ControlDurableWorkflowRuntime,
  type ControlDurableWorkflowClient,
} from "./controlDurableWorkflowRuntime";
import { ControlWorkflowIntentJournal } from "./controlWorkflowIntentJournal";
import {
  workflowIntentMemoryStorage,
  workflowCommandsSnapshotFixture,
  workflowCommandsReviewFixture,
} from "./controlWorkflowCommands.test-support";
import { WORKFLOW_VERIFICATION_CONTRACT_V1 } from "@crewon/domain/workflow-verification";

function fixture() {
  const snapshot = workflowCommandsSnapshotFixture(),
    digest = snapshot.run.workflowVersionBinding!.contentDigest;
  const schema = {
    type: "object",
    properties: { topic: { type: "string", maxLength: 128, enum: null } },
    required: ["topic"],
    additionalProperties: false,
  };
  const version: WorkflowVersionView = {
    workflowId: "workflow-1",
    workflowVersionId: "version-1",
    contentDigest: digest,
    createdAt: "2026-10-17T00:00:00.000Z",
    name: "Review",
    description: "Structured input",
    inputSchema: schema,
    outputSchema: schema,
    entryNodeIds: ["gate"],
    outputNodeIds: ["gate"],
    executionOrder: ["gate"],
    nodes: [
      {
        nodeId: "gate",
        kind: "humanGate",
        title: "Review",
        instruction: "Review input",
        approvalPolicyId: "review-policy",
        dependsOn: [],
        inputSchema: schema,
        outputSchema: schema,
      },
    ],
  };
  const retired = {
    createRun: vi.fn(),
    forkThread: vi.fn(),
    createThread: vi.fn(),
    appendThreadMessage: vi.fn(),
    renameThread: vi.fn(),
  };
  const client = {
    ...retired,
    openRunEventStream: vi.fn<
      ControlDurableWorkflowClient["openRunEventStream"]
    >(async () => {
      throw Error("stream not requested");
    }),
    getThreadTranscriptSnapshot: vi.fn<
      ControlDurableWorkflowClient["getThreadTranscriptSnapshot"]
    >(async () => {
      throw Error("evidence not requested");
    }),
    getWorkflowExecutionCapability: vi.fn(async () => ({
      version: "v1" as const,
      admission: true,
      snapshots: true,
      humanGates: true,
    })),
    getWorkflowRecoveryContext: vi.fn(async () => ({
      version: "v1" as const,
      contextId: digest,
    })),
    getWorkflowReviewCapability: vi.fn(async () => ({
      version: "v1" as const,
      available: true,
    })),
    getWorkflowReviewContextCapability: vi.fn(async () => ({
      version: "v1" as const,
      available: true,
    })),
    listWorkflowVersionCatalog: vi.fn<
      ControlDurableWorkflowClient["listWorkflowVersionCatalog"]
    >(async () => ({
      data: [
        {
          workflowId: version.workflowId,
          workflowVersionId: version.workflowVersionId,
          contentDigest: digest,
          name: version.name,
          description: version.description,
          createdAt: version.createdAt,
        },
      ],
      nextCursor: null,
    })),
    getWorkflowVersion: vi.fn<
      ControlDurableWorkflowClient["getWorkflowVersion"]
    >(async () => ({ workflowVersion: structuredClone(version) })),
    publishWorkflowVersion: vi.fn<
      ControlDurableWorkflowClient["publishWorkflowVersion"]
    >(async (source) => ({
      disposition: "registered",
      workflowVersion: {
        ...source,
        contentDigest: digest,
        executionOrder: source.nodes.map((node) => node.nodeId),
        createdAt: version.createdAt,
      },
    })),
    listWorkflowRuns: vi.fn<ControlDurableWorkflowClient["listWorkflowRuns"]>(
      async () => ({ data: [structuredClone(snapshot.run)], nextCursor: null }),
    ),
    getWorkflowRunSnapshot: vi.fn<
      ControlDurableWorkflowClient["getWorkflowRunSnapshot"]
    >(async () => structuredClone(snapshot)),
    startWorkflowRun: vi.fn<ControlDurableWorkflowClient["startWorkflowRun"]>(
      async () => ({
        disposition: "committed",
        run: structuredClone(snapshot.run),
      }),
    ),
    cancelRun: vi.fn<ControlDurableWorkflowClient["cancelRun"]>(async () => ({
      disposition: "committed",
      run: {
        ...snapshot.run,
        revision: 2,
        lastSequence: 2,
        cancelRequested: true,
      },
    })),
    reviewWorkflowHumanGate: vi.fn<
      ControlDurableWorkflowClient["reviewWorkflowHumanGate"]
    >(async (_locator, body) => ({
      disposition: "committed",
      review: workflowCommandsReviewFixture(body.comment).review!,
    })),
    listThreads: vi.fn<ControlDurableWorkflowClient["listThreads"]>(
      async () => ({ data: [], nextCursor: null }),
    ),
    listThreadMessages: vi.fn<
      ControlDurableWorkflowClient["listThreadMessages"]
    >(async () => ({ data: [], nextCursor: null })),
    listThreadRuns: vi.fn<ControlDurableWorkflowClient["listThreadRuns"]>(
      async () => ({ data: [], nextCursor: null }),
    ),
  };
  // One storage object must be shared across calls, as in actual localStorage.
  const storage = workflowIntentMemoryStorage();
  const runtime = new ControlDurableWorkflowRuntime({
    client,
    journal: new ControlWorkflowIntentJournal({ storage: () => storage }),
  });
  return { runtime, client, snapshot, version, retired, storage };
}

describe("Workflow renderer reads and commands after durable migration", () => {
  it("reads one catalog page without loading every definition, root or hidden Thread", async () => {
    const f = fixture();
    const page = await f.runtime.catalog(null);
    expect(page.records[0]?.control).toMatchObject({
      loaded: false,
      source: "durable",
    });
    expect(f.client.listWorkflowVersionCatalog).toHaveBeenCalledWith(
      { cursor: null, limit: 20 },
      {},
    );
    expect(f.client.getWorkflowVersion).not.toHaveBeenCalled();
    expect(f.client.listWorkflowRuns).not.toHaveBeenCalled();
    expect(f.client.listThreads).not.toHaveBeenCalled();
  });
  it("discovers a bounded root directory once and polls only that explicit root using the cached immutable definition", async () => {
    const f = fixture();
    const record = await f.runtime.read({
      workflowVersionId: "version-1",
      runId: null,
    });
    expect(record.config.runs?.[0]?.status).toBe("waitingForApproval");
    expect(record.control?.roots).toHaveLength(1);
    await f.runtime.read({ workflowVersionId: "version-1", runId: "run-1" });
    await f.runtime.read({ workflowVersionId: "version-1", runId: "run-1" });
    expect(f.client.getWorkflowVersion).toHaveBeenCalledOnce();
    expect(f.client.listWorkflowRuns).toHaveBeenCalledOnce();
    expect(f.client.getWorkflowRunSnapshot).toHaveBeenCalledTimes(3);
    for (const write of Object.values(f.retired))
      expect(write).not.toHaveBeenCalled();
    expect(f.client.startWorkflowRun).not.toHaveBeenCalled();
  });
  it("publishes the original serial schemas and strict verifier without creating a hidden registration Thread", async () => {
    const f = fixture();
    const record = await f.runtime.createWorkflow({
      title: "Release",
      description: "Review",
      nodes: [
        {
          type: "agent",
          title: "Producer",
          instruction: "Collect evidence",
          agentVersionId: "producer",
        },
        { type: "humanGate", title: "Review", instruction: "Approve evidence" },
        {
          type: "verification",
          title: "Verifier",
          instruction: "Check independently",
          agentVersionId: "verifier",
        },
      ],
    });
    const source = f.client.publishWorkflowVersion.mock.calls[0]![0];
    expect(source.nodes[2]?.instruction).toContain(
      WORKFLOW_VERIFICATION_CONTRACT_V1,
    );
    expect(source.nodes[1]?.inputSchema).toEqual(source.nodes[0]?.outputSchema);
    expect(record.config.nodes[2]?.instruction).toBe("Check independently");
    expect(record.control?.inputMode).toBe("prompt");
    for (const write of Object.values(f.retired))
      expect(write).not.toHaveBeenCalled();
  });
  it("submits schema-validated JSON to the root bound to the original main Thread", async () => {
    const f = fixture();
    const record = await f.runtime.runWorkflow({
      workflowVersionId: "version-1",
      threadId: "thread-1",
      prompt: '{"topic":"  原始输入  "}',
    });
    expect(record.control?.root?.threadId).toBe("thread-1");
    expect(record.control?.knownRunId).toBe("run-1");
    expect(record.control?.awaitingSnapshot).toBe(true);
    expect(record.config.runs?.[0]?.status).toBe("queued");
    expect(f.client.startWorkflowRun.mock.calls[0]?.[0].input).toEqual({
      topic: "  原始输入  ",
    });
    expect(f.client.getWorkflowRunSnapshot).not.toHaveBeenCalled();
    for (const write of Object.values(f.retired))
      expect(write).not.toHaveBeenCalled();
    await expect(
      f.runtime.runWorkflow({
        workflowVersionId: "version-1",
        threadId: "thread-1",
        prompt: "a plain prompt cannot stand in for arbitrary JSON",
      }),
    ).rejects.toThrow();
    await expect(
      f.runtime.runWorkflow({
        workflowVersionId: "version-1",
        threadId: "thread-1",
        prompt: '{"unrelated":"field"}',
      }),
    ).rejects.toThrow();
    expect(f.client.startWorkflowRun).toHaveBeenCalledOnce();
  });
  it("rejects a snapshot from another version digest and never starts execution to repair a failed read", async () => {
    const f = fixture();
    f.snapshot.run.workflowVersionBinding!.contentDigest = `sha256:${"b".repeat(64)}`;
    await expect(
      f.runtime.read({ workflowVersionId: "version-1", runId: "run-1" }),
    ).rejects.toThrow("workflow_snapshot_binding_invalid");
    expect(f.client.startWorkflowRun).not.toHaveBeenCalled();
  });
  it("preserves accepted cancellation as canceling until a terminal snapshot arrives", async () => {
    const f = fixture();
    const record = await f.runtime.cancelWorkflow({
      workflowVersionId: "version-1",
      executionId: "run-1",
    });
    expect(record.config.runs?.[0]?.status).toBe("canceling");
    expect(record.control?.root?.status).toBe("queued");
    expect(f.client.cancelRun.mock.calls[0]?.[1]).toEqual({
      expectedRevision: 1,
    });
    for (const write of Object.values(f.retired))
      expect(write).not.toHaveBeenCalled();
  });
  it("uses the exact Gate and opinion as descendant context and waits for an independent snapshot", async () => {
    const f = fixture();
    const record = await f.runtime.resolveGate({
      workflowVersionId: "version-1",
      executionId: "run-1",
      nodeId: "gate",
      decision: "approve",
      comment: "  原意见\n  ",
    });
    expect(record.control?.awaitingSnapshot).toBe(true);
    expect(f.client.reviewWorkflowHumanGate.mock.calls[0]?.[1]).toMatchObject({
      comment: "  原意见\n  ",
      commentContext: "descendants-v1",
      inputDigest: f.snapshot.nodes[0]!.inputDigest,
    });
    expect(f.client.startWorkflowRun).not.toHaveBeenCalled();
    for (const write of Object.values(f.retired))
      expect(write).not.toHaveBeenCalled();
  });
});
