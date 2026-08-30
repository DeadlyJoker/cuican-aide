import { describe, expect, it, vi } from "vitest";

import type {
  MessageView,
  RunView,
  ThreadView,
  WorkflowVersionView,
} from "@crewon/contracts";

import {
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
});

function workflowClient() {
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
        nodes: source.nodes,
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
            content: `${runAgents.at(-1)} completed ${nodeId}`,
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
      const existing = [...runs.values()]
        .flat()
        .find((item) => item.runId === runId)!;
      return {
        disposition: "committed" as const,
        run: run(runId, existing.threadId, "canceled"),
      };
    }),
  } as unknown as ControlWorkflowRuntimeClient;

  return {
    client,
    threads,
    messages,
    runAgents,
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
