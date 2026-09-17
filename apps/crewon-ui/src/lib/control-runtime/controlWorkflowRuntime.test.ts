import { describe, expect, it, vi } from "vitest";

import type {
  MessageView,
  RunView,
  ThreadView,
  WorkflowVersionView,
} from "@crewon/contracts";

import {
  CONTROL_WORKFLOW_VERIFICATION_CONTRACT_V1,
  ControlWorkflowRuntime,
  isInternalControlWorkflowThread,
  type ControlWorkflowRuntimeClient,
} from "./controlWorkflowRuntime";

const now = "2026-08-29T08:00:00.000Z";

describe("Control Workflow Runtime", () => {
  it("publishes a durable definition and executes agent, gate, then agent after approval", async () => {
    const state = workflowClient();
    const runtime = new ControlWorkflowRuntime({
      client: state.client,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    const definition = await runtime.createWorkflow({
      title: "Release decision",
      description: "Review evidence, wait for approval, then decide",
      nodes: [
        {
          type: "agent",
          title: "Evidence review",
          instruction: "Summarize the release evidence",
          agentVersionId: "agent-review",
        },
        {
          type: "humanGate",
          title: "Release approval",
          instruction: "Approve only when the evidence is sufficient",
        },
        {
          type: "verification",
          title: "Independent verification",
          instruction: "Verify the final go/no-go decision",
          agentVersionId: "agent-verifier",
        },
      ],
    });

    expect(definition.config.nodes.map((node) => node.title)).toEqual([
      "Evidence review",
      "Release approval",
      "Independent verification",
    ]);
    expect(definition.config.nodes[2]?.instruction).toBe(
      "Verify the final go/no-go decision",
    );
    expect(state.published?.nodes[2]?.instruction).toContain(
      CONTROL_WORKFLOW_VERIFICATION_CONTRACT_V1,
    );
    expect(state.published?.nodes[1]).toEqual(
      expect.objectContaining({
        kind: "humanGate",
        inputSchema: state.published?.nodes[0]?.outputSchema,
        outputSchema: state.published?.nodes[0]?.outputSchema,
      }),
    );
    expect(state.published?.inputSchema).toEqual({
      type: "object",
      properties: {
        prompt: { type: "string", maxLength: 9_999, enum: null },
      },
      required: ["prompt"],
      additionalProperties: false,
    });
    expect(
      (await runtime.listWorkflows()).map((record) => record.config.name),
    ).toEqual(["Release decision"]);

    const waiting = await runtime.runWorkflow({
      workflowVersionId: definition.config.workflowId,
      threadId: "thread-main",
      prompt: "Use the current pilot evidence and decide whether to launch",
    });
    expect(waiting.status).toBe("waitingForApproval");
    expect(waiting.executedNodes.map((node) => node.status)).toEqual([
      "completed",
      "waitingForApproval",
      "pending",
    ]);
    expect(state.runAgents).toEqual(["agent-review"]);
    const executionThread = state.threads.find(
      (thread) => thread.forkedFromThreadId === "thread-main",
    );
    expect(executionThread).toBeDefined();
    const firstNodePrompt = [
      ...(state.messages.get(executionThread!.threadId) ?? []),
    ]
      .reverse()
      .find((message) =>
        message.content.startsWith("[Control Workflow · node:node-01]"),
      );
    expect(firstNodePrompt?.content).toContain(
      "Use the current pilot evidence and decide whether to launch",
    );
    expect(firstNodePrompt?.content).not.toContain("Legacy assistant output");
    expect(firstNodePrompt?.content).not.toContain(
      "Legacy workflow assistant output",
    );

    const executionMessages = state.messages.get(executionThread!.threadId)!;
    state.messages.set(
      executionThread!.threadId,
      executionMessages.filter(
        (message) =>
          !message.content.startsWith(
            "[Control Workflow · gate:node-02:request]",
          ),
      ),
    );
    const recoveredRuntime = new ControlWorkflowRuntime({
      client: state.client,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });
    const interrupted = await recoveredRuntime.listWorkflows();
    expect(interrupted[0]?.config.runs?.[0]?.status).toBe("running");
    await vi.waitFor(() => {
      expect(
        state.messages
          .get(executionThread!.threadId)
          ?.some((message) =>
            message.content.startsWith(
              "[Control Workflow · gate:node-02:request]",
            ),
          ),
      ).toBe(true);
    });

    const completed = await recoveredRuntime.resolveGate({
      workflowVersionId: definition.config.workflowId,
      executionId: waiting.executionId,
      nodeId: "node-02",
      decision: "approve",
      comment: "Evidence threshold met",
    });
    expect(completed.status).toBe("completed");
    expect(completed.executedNodes.map((node) => node.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(completed.output).toContain("agent-verifier completed node-03");
    expect(state.runAgents).toEqual(["agent-review", "agent-verifier"]);
    const verificationPrompt = [
      ...(state.messages.get(executionThread!.threadId) ?? []),
    ]
      .reverse()
      .find((message) =>
        message.content.startsWith("[Control Workflow · node:node-03]"),
      );
    expect(verificationPrompt?.content).toContain(
      "agent-review completed node-01",
    );
    expect(verificationPrompt?.content).toContain(
      CONTROL_WORKFLOW_VERIFICATION_CONTRACT_V1,
    );
    expect(verificationPrompt?.content).toContain(
      "该行必须逐字等于 `VERDICT: PASS` 或 `VERDICT: FAIL`",
    );
    expect(verificationPrompt?.content).not.toContain(
      "Legacy assistant output",
    );
    expect(verificationPrompt?.content).not.toContain(
      "Legacy workflow assistant output",
    );

    const reloaded = await runtime.listWorkflows();
    expect(reloaded[0]?.config.runs?.[0]).toEqual(
      expect.objectContaining({
        executionId: waiting.executionId,
        status: "completed",
      }),
    );
    expect(
      state.threads.some((thread) => isInternalControlWorkflowThread(thread)),
    ).toBe(true);
  });

  it("fails closed when a canceled Human Gate is resolved", async () => {
    const state = workflowClient();
    const runtime = new ControlWorkflowRuntime({
      client: state.client,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });
    const definition = await createGatedWorkflow(runtime);
    const waiting = await runtime.runWorkflow({
      workflowVersionId: definition.config.workflowId,
      threadId: "thread-main",
      prompt: "Review the release",
    });

    const canceled = await runtime.cancelWorkflow({
      workflowVersionId: definition.config.workflowId,
      executionId: waiting.executionId,
    });

    expect(canceled.status).toBe("canceled");
    expect(canceled.executedNodes.map((node) => node.status)).toEqual([
      "completed",
      "canceled",
      "pending",
    ]);
    await expect(
      runtime.resolveGate({
        workflowVersionId: definition.config.workflowId,
        executionId: waiting.executionId,
        nodeId: "node-02",
        decision: "approve",
        comment: null,
      }),
    ).rejects.toThrow("control_workflow_execution_canceled");
    expect(
      [...state.messages.values()]
        .flat()
        .some((item) =>
          item.content.startsWith("[Control Workflow · gate:node-02:approve]"),
        ),
    ).toBe(false);
  });

  it("fails the verification node and workflow on an explicit VERDICT: FAIL line", async () => {
    const verificationOutput = [
      "## Independent verification",
      "Evidence was reviewed.",
      "VERDICT: FAIL",
      "Missing rollback proof.",
      "Do not release.",
    ].join("\n");
    const state = workflowClient({
      assistantOutput: ({ agentVersionId, nodeId }) =>
        agentVersionId === "agent-verifier"
          ? verificationOutput
          : `${agentVersionId} completed ${nodeId}`,
    });
    const runtime = new ControlWorkflowRuntime({
      client: state.client,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });
    const definition = await createVerifiedWorkflow(runtime);

    const result = await runtime.runWorkflow({
      workflowVersionId: definition.config.workflowId,
      threadId: "thread-main",
      prompt: "Can this release proceed?",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("control_workflow_verification_failed");
    expect(result.output).toBe(verificationOutput);
    expect(result.executedNodes.map((node) => node.status)).toEqual([
      "completed",
      "failed",
    ]);
    expect(result.executedNodes[1]?.output).toBe(verificationOutput);
  });

  it.each([
    ["missing", "Evidence was reviewed, but no verdict was emitted."],
    ["multiple", "VERDICT: PASS\nVERDICT: FAIL"],
    ["malformed spacing", "VERDICT : PASS"],
    ["malformed case", "verdict: PASS"],
    ["malformed suffix", "VERDICT: PASS - evidence complete"],
  ])("fails closed when the v1 verdict is %s", async (_label, output) => {
    const state = workflowClient({
      assistantOutput: ({ agentVersionId, nodeId }) =>
        agentVersionId === "agent-verifier"
          ? output
          : `${agentVersionId} completed ${nodeId}`,
    });
    const runtime = new ControlWorkflowRuntime({
      client: state.client,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });
    const definition = await createVerifiedWorkflow(runtime);

    const result = await runtime.runWorkflow({
      workflowVersionId: definition.config.workflowId,
      threadId: "thread-main",
      prompt: "Can this release proceed?",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("control_workflow_verification_invalid");
    expect(result.executedNodes.at(-1)).toMatchObject({
      error: "control_workflow_verification_invalid",
      output,
      status: "failed",
    });
  });

  it("accepts exactly one strict PASS while ignoring prose that mentions FAIL", async () => {
    const state = workflowClient({
      assistantOutput: ({ agentVersionId, nodeId }) =>
        agentVersionId === "agent-verifier"
          ? [
              "The instructions mention VERDICT: FAIL as an example.",
              "VERDICT: PASS",
              "All required evidence is present.",
            ].join("\n")
          : `${agentVersionId} completed ${nodeId}`,
    });
    const runtime = new ControlWorkflowRuntime({
      client: state.client,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });
    const definition = await createVerifiedWorkflow(runtime);

    const result = await runtime.runWorkflow({
      workflowVersionId: definition.config.workflowId,
      threadId: "thread-main",
      prompt: "Can this release proceed?",
    });

    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.executedNodes.at(-1)?.status).toBe("completed");
  });

  it("keeps marker-free persisted workflows on the explicit legacy parser", async () => {
    const state = workflowClient({
      legacyVerificationContract: true,
      assistantOutput: ({ agentVersionId, nodeId }) =>
        agentVersionId === "agent-verifier"
          ? "Legacy verification report without a verdict"
          : `${agentVersionId} completed ${nodeId}`,
    });
    const runtime = new ControlWorkflowRuntime({
      client: state.client,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });
    const definition = await createVerifiedWorkflow(runtime);

    const result = await runtime.runWorkflow({
      workflowVersionId: definition.config.workflowId,
      threadId: "thread-main",
      prompt: "Can this legacy workflow proceed?",
    });

    expect(state.published?.nodes.at(-1)?.instruction).not.toContain(
      CONTROL_WORKFLOW_VERIFICATION_CONTRACT_V1,
    );
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
  });

  it("projects the verifier as running while an approved Gate is resolving", async () => {
    const state = workflowClient({ heldAgentVersionIds: ["agent-verifier"] });
    const runtime = new ControlWorkflowRuntime({
      client: state.client,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });
    const definition = await createGatedWorkflow(runtime);
    const waiting = await runtime.runWorkflow({
      workflowVersionId: definition.config.workflowId,
      threadId: "thread-main",
      prompt: "Review the release",
    });

    const resolving = runtime.resolveGate({
      workflowVersionId: definition.config.workflowId,
      executionId: waiting.executionId,
      nodeId: "node-02",
      decision: "approve",
      comment: "Proceed to independent verification",
    });
    await vi.waitFor(() => {
      expect(state.runAgents).toContain("agent-verifier");
    });

    const projected = (await runtime.listWorkflows())[0]?.config.runs?.[0];
    expect(projected?.status).toBe("running");
    expect(projected?.executedNodes.map((node) => node.status)).toEqual([
      "completed",
      "completed",
      "running",
    ]);

    state.releaseAgent("agent-verifier");
    await expect(resolving).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps cancellation terminal when it races approved-Gate verification", async () => {
    const state = workflowClient({ heldAgentVersionIds: ["agent-verifier"] });
    const runtime = new ControlWorkflowRuntime({
      client: state.client,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });
    const definition = await createGatedWorkflow(runtime);
    const waiting = await runtime.runWorkflow({
      workflowVersionId: definition.config.workflowId,
      threadId: "thread-main",
      prompt: "Review the release",
    });
    const resolving = runtime.resolveGate({
      workflowVersionId: definition.config.workflowId,
      executionId: waiting.executionId,
      nodeId: "node-02",
      decision: "approve",
      comment: null,
    });
    await vi.waitFor(() => {
      expect(state.runAgents).toContain("agent-verifier");
    });

    const canceled = await runtime.cancelWorkflow({
      workflowVersionId: definition.config.workflowId,
      executionId: waiting.executionId,
    });
    expect(canceled.status).toBe("canceled");
    await resolving;

    const persisted = (await runtime.listWorkflows())[0]?.config.runs?.[0];
    expect(persisted?.status).toBe("canceled");
    expect(persisted?.executedNodes.map((node) => node.status)).toEqual([
      "completed",
      "completed",
      "canceled",
    ]);
  });
});

async function createGatedWorkflow(runtime: ControlWorkflowRuntime) {
  return runtime.createWorkflow({
    title: "Release decision",
    description: "Review evidence, wait for approval, then verify",
    nodes: [
      {
        type: "agent",
        title: "Evidence review",
        instruction: "Summarize the release evidence",
        agentVersionId: "agent-review",
      },
      {
        type: "humanGate",
        title: "Release approval",
        instruction: "Approve only when the evidence is sufficient",
      },
      {
        type: "verification",
        title: "Independent verification",
        instruction: "Verify the final go/no-go decision",
        agentVersionId: "agent-verifier",
      },
    ],
  });
}

async function createVerifiedWorkflow(runtime: ControlWorkflowRuntime) {
  return runtime.createWorkflow({
    title: "Verified release",
    description: "Prepare and independently verify a release",
    nodes: [
      {
        type: "agent",
        title: "Prepare",
        instruction: "Prepare the release evidence",
        agentVersionId: "agent-builder",
      },
      {
        type: "verification",
        title: "Verify",
        instruction: "Return an explicit verdict",
        agentVersionId: "agent-verifier",
      },
    ],
  });
}

function workflowClient(
  options: {
    assistantOutput?: (input: {
      agentVersionId: string;
      nodeId: string;
    }) => string;
    heldAgentVersionIds?: readonly string[];
    legacyVerificationContract?: boolean;
  } = {},
) {
  const threads: ThreadView[] = [
    thread("thread-main", "Release task", { lastMessageSequence: 4 }),
  ];
  const messages = new Map<string, MessageView[]>([
    [
      "thread-main",
      [
        message(
          "message-existing-user",
          "thread-main",
          1,
          "user",
          "Legacy user input",
        ),
        message(
          "message-existing-assistant",
          "thread-main",
          2,
          "assistant",
          "Legacy assistant output",
        ),
        message(
          "message-existing-workflow-node",
          "thread-main",
          3,
          "user",
          "[Control Workflow · node:node-01]\nOld workflow prompt",
        ),
        message(
          "message-existing-workflow-assistant",
          "thread-main",
          4,
          "assistant",
          "Legacy workflow assistant output",
        ),
      ],
    ],
  ]);
  const runs = new Map<string, RunView[]>();
  const runAgents: string[] = [];
  const runAgentById = new Map<string, string>();
  const heldAgentVersionIds = new Set(options.heldAgentVersionIds ?? []);
  let published: WorkflowVersionView | null = null;
  let sequence = 0;

  function updateThread(threadId: string, patch: Partial<ThreadView>) {
    const index = threads.findIndex(
      (candidate) => candidate.threadId === threadId,
    );
    threads[index] = { ...threads[index]!, ...patch };
    return threads[index]!;
  }

  const client = {
    publishWorkflowVersion: vi.fn(async (source) => {
      published = {
        workflowId: source.workflowId,
        workflowVersionId: source.workflowVersionId,
        contentDigest: `sha256:${"a".repeat(64)}`,
        name: source.name,
        description: source.description,
        inputSchema: source.inputSchema,
        outputSchema: source.outputSchema,
        entryNodeIds: source.entryNodeIds,
        outputNodeIds: source.outputNodeIds,
        nodes: source.nodes.map((node: WorkflowVersionView["nodes"][number]) =>
          node.kind === "verification" && options.legacyVerificationContract
            ? {
                ...node,
                instruction: node.instruction.split(
                  `\n\n${CONTROL_WORKFLOW_VERIFICATION_CONTRACT_V1}`,
                  1,
                )[0]!,
              }
            : node,
        ),
        executionOrder: source.nodes.map(
          (node: WorkflowVersionView["nodes"][number]) => node.nodeId,
        ),
        createdAt: now,
      };
      return { disposition: "registered" as const, workflowVersion: published };
    }),
    getWorkflowVersion: vi.fn(async (workflowVersionId: string) => {
      if (published?.workflowVersionId !== workflowVersionId) {
        throw new Error("not found");
      }
      return { workflowVersion: published };
    }),
    createThread: vi.fn(async (body) => {
      const created = thread(`thread-${++sequence}`, body.title);
      threads.push(created);
      return { disposition: "committed" as const, thread: created };
    }),
    listThreads: vi.fn(async () => ({
      data: [...threads],
      nextCursor: null,
    })),
    getThread: vi.fn(async (threadId: string) => ({
      thread: threads.find((candidate) => candidate.threadId === threadId)!,
      eventSequence: threads.find(
        (candidate) => candidate.threadId === threadId,
      )!.revision,
    })),
    forkThread: vi.fn(async (threadId: string) => {
      const source = threads.find(
        (candidate) => candidate.threadId === threadId,
      )!;
      const fork = thread(`thread-${++sequence}`, source.title, {
        forkedFromThreadId: threadId,
        forkedThroughHistorySequence: source.lastMessageSequence,
      });
      threads.push(fork);
      messages.set(fork.threadId, [...(messages.get(threadId) ?? [])]);
      return { disposition: "committed" as const, thread: fork };
    }),
    renameThread: vi.fn(async (threadId: string, body) => ({
      disposition: "committed" as const,
      thread: updateThread(threadId, {
        title: body.title,
        revision: body.expectedRevision + 1,
      }),
    })),
    appendThreadMessage: vi.fn(async (threadId: string, body) => {
      const current = messages.get(threadId) ?? [];
      const item: MessageView = {
        messageId: `message-${++sequence}`,
        threadId,
        sequence: current.length + 1,
        role: "user",
        content: body.content,
        proposedPlan: null,
        createdAt: now,
      };
      messages.set(threadId, [...current, item]);
      const next = updateThread(threadId, {
        revision: body.expectedRevision + 1,
        lastMessageSequence: item.sequence,
        updatedAt: new Date(Date.parse(now) + sequence).toISOString(),
      });
      return { disposition: "committed" as const, thread: next, message: item };
    }),
    listThreadMessages: vi.fn(async (threadId: string) => ({
      data: [...(messages.get(threadId) ?? [])],
      nextCursor: null,
    })),
    createRun: vi.fn(async (body) => {
      const runId = `run-${++sequence}`;
      runAgents.push(body.agentVersionId);
      runAgentById.set(runId, body.agentVersionId);
      const created = run(runId, body.threadId, "queued");
      runs.set(body.threadId, [created, ...(runs.get(body.threadId) ?? [])]);
      return { disposition: "committed" as const, run: created };
    }),
    getRun: vi.fn(async (runId: string) => {
      for (const [threadId, threadRuns] of runs) {
        const index = threadRuns.findIndex(
          (candidate) => candidate.runId === runId,
        );
        if (index === -1) continue;
        const existing = threadRuns[index]!;
        if (["canceled", "completed", "failed"].includes(existing.status)) {
          return { run: existing };
        }
        const agentVersionId = runAgentById.get(runId) ?? "unknown-agent";
        if (heldAgentVersionIds.has(agentVersionId)) {
          const running = run(runId, threadId, "running");
          threadRuns[index] = running;
          return { run: running };
        }
        const completed = run(runId, threadId, "completed");
        threadRuns[index] = completed;
        const current = messages.get(threadId) ?? [];
        const prompt = [...current]
          .reverse()
          .find((message) =>
            message.content.startsWith("[Control Workflow · node:"),
          );
        if (
          prompt !== undefined &&
          !current.some(
            (message) =>
              message.role === "assistant" &&
              message.sequence > prompt.sequence,
          )
        ) {
          const nodeId =
            prompt.content.match(/node:([^\]]+)/u)?.[1] ?? "unknown";
          const assistant: MessageView = {
            messageId: `message-${++sequence}`,
            threadId,
            sequence: current.length + 1,
            role: "assistant",
            content:
              options.assistantOutput?.({ agentVersionId, nodeId }) ??
              [
                `${agentVersionId} completed ${nodeId}`,
                ...(prompt.content.includes(
                  CONTROL_WORKFLOW_VERIFICATION_CONTRACT_V1,
                )
                  ? ["VERDICT: PASS"]
                  : []),
              ].join("\n"),
            proposedPlan: null,
            createdAt: now,
          };
          messages.set(threadId, [...current, assistant]);
          updateThread(threadId, {
            revision:
              threads.find((item) => item.threadId === threadId)!.revision + 1,
            lastMessageSequence: assistant.sequence,
          });
        }
        return { run: completed };
      }
      throw new Error("run not found");
    }),
    listThreadRuns: vi.fn(async (threadId: string) => ({
      data: [...(runs.get(threadId) ?? [])],
      nextCursor: null,
    })),
    cancelRun: vi.fn(async (runId: string) => {
      for (const threadRuns of runs.values()) {
        const index = threadRuns.findIndex((item) => item.runId === runId);
        if (index === -1) continue;
        const existing = threadRuns[index]!;
        const canceled = run(runId, existing.threadId, "canceled");
        threadRuns[index] = canceled;
        heldAgentVersionIds.delete(runAgentById.get(runId) ?? "");
        return { disposition: "committed" as const, run: canceled };
      }
      throw new Error("run not found");
    }),
  } as unknown as ControlWorkflowRuntimeClient;

  return {
    client,
    threads,
    messages,
    runAgents,
    releaseAgent(agentVersionId: string) {
      heldAgentVersionIds.delete(agentVersionId);
    },
    get published() {
      return published;
    },
  };
}

function message(
  messageId: string,
  threadId: string,
  sequence: number,
  role: MessageView["role"],
  content: string,
): MessageView {
  return {
    messageId,
    threadId,
    sequence,
    role,
    content,
    proposedPlan: null,
    createdAt: now,
  };
}

function thread(
  threadId: string,
  title: string | null,
  overrides: Partial<ThreadView> = {},
): ThreadView {
  return {
    threadId,
    title,
    status: "active",
    revision: 1,
    lastMessageSequence: 0,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function run(
  runId: string,
  threadId: string,
  status: RunView["status"],
): RunView {
  const terminal = ["completed", "failed", "canceled"].includes(status);
  return {
    runId,
    threadId,
    status,
    revision: terminal ? 3 : 1,
    lastSequence: terminal ? 3 : 1,
    cancelRequested: status === "canceled",
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "turn",
    workflowVersionBinding: null,
    goalBinding: null,
    outputRef: status === "completed" ? `${runId}:output` : null,
    failure:
      status === "failed" ? { code: "node_failed", retryable: false } : null,
    createdAt: now,
    updatedAt: now,
    terminalAt: terminal ? now : null,
  };
}
