import { describe, expect, it, vi } from "vitest";

import type {
  ActiveAgentVersionCatalogResponse,
  MessageView,
  RunView,
  ThreadView,
} from "@crewon/contracts";

import {
  controlTeamMemberGuidance,
  resolveControlTeamPlan,
  startControlTeamTurn,
  type ControlTeamRuntimeClient,
} from "./controlTeamRuntime";

describe("Control Team member settings", () => {
  it("adds the saved prompt and selected capabilities to a member assignment", () => {
    expect(
      controlTeamMemberGuidance({
        memberId: "qa",
        displayName: "QA",
        agentVersionId: "agent-qa",
        targetId: "qa",
        profile: {
          memberId: "qa",
          systemPrompt: "先核对证据，再判断是否通过。",
          skills: [{ name: "交付审查", description: "检查交付完整性" }],
          mcp: [{ name: "任务服务", description: "读取团队任务" }],
          knowledge: [{ name: "验收规范", description: "团队统一标准" }],
        },
      }),
    ).toEqual([
      "",
      "请遵循「QA」在办公室中的工作设定：",
      "先核对证据，再判断是否通过。",
      "Skill：交付审查（检查交付完整性）",
      "MCP 服务：任务服务（读取团队任务）",
      "知识库：验收规范（团队统一标准）",
      "未选中的专属能力不要主动假设可用；所有操作仍需遵守当前运行权限。",
    ]);
  });
});

const occurredAt = "2026-08-29T08:00:00.000Z";
const office = {
  schemaVersion: "crewon.office-definition.v0" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  officeId: "office-1",
  officeVersionId: "office-version-1",
  revision: 1,
  title: "Release office",
  members: [
    {
      memberId: "manager",
      displayName: "Release lead",
      agentVersionId: "agent-manager",
    },
    {
      memberId: "qa",
      displayName: "QA",
      agentVersionId: "agent-qa",
    },
    {
      memberId: "security",
      displayName: "Security",
      agentVersionId: "agent-security",
    },
  ],
  executionTargets: [
    { targetId: "manager", agentVersionId: "agent-manager" },
    { targetId: "qa", agentVersionId: "agent-qa" },
    { targetId: "security", agentVersionId: "agent-security" },
  ],
  createdByActorId: "actor-1",
  createdAt: occurredAt,
};

const catalog: ActiveAgentVersionCatalogResponse = {
  releaseId: `sha256:${"a".repeat(64)}`,
  activatedAt: occurredAt,
  defaultAgentVersionId: "agent-manager",
  data: office.members.map((member, index) => ({
    agentVersionId: member.agentVersionId,
    contentDigest: `sha256:${String(index + 1).repeat(64)}`,
    runtimeGeneration: "ts-v0",
    policySnapshotId: `policy-${index + 1}`,
    model: {
      adapterName: "responses-http",
      adapterVersion: "1",
      modelId: "gpt-test",
    },
    createdAt: occurredAt,
  })),
};

function thread(
  threadId: string,
  overrides: Partial<ThreadView> = {},
): ThreadView {
  return {
    threadId,
    title: "Team task",
    status: "active",
    revision: 2,
    lastMessageSequence: 1,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function message(
  threadId: string,
  sequence: number,
  role: MessageView["role"],
  content: string,
): MessageView {
  return {
    messageId: `${threadId}-message-${sequence}`,
    threadId,
    sequence,
    role,
    content,
    proposedPlan: null,
    createdAt: occurredAt,
  };
}

function run(
  runId: string,
  threadId: string,
  status: RunView["status"] = "queued",
): RunView {
  return {
    runId,
    threadId,
    status,
    revision: status === "queued" ? 1 : 3,
    lastSequence: status === "queued" ? 1 : 3,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "turn",
    workflowVersionBinding: null,
    goalBinding: null,
    outputRef: status === "completed" ? `${runId}-output` : null,
    failure:
      status === "failed"
        ? { code: "injected_member_failure", retryable: false }
        : null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    terminalAt: status === "queued" ? null : occurredAt,
  };
}

function teamClient(
  failedWorker: string | null = null,
  initialGoalStatus: "active" | "paused" | null = null,
  managerCreatesGoal = false,
  transientRunReadFailures = 0,
) {
  const createdRuns: RunView[] = [];
  const appendedMessages: MessageView[] = [];
  const forkIds = ["thread-manager-plan", "thread-qa", "thread-security"];
  let forkIndex = 0;
  let goalStatus: "active" | "paused" | null = initialGoalStatus;
  let goalRevision = initialGoalStatus === null ? 0 : 5;
  let goalObjective =
    initialGoalStatus === null ? "" : "Decide whether to launch the pilot";
  let sourceHasIncompleteUserBoundary = false;
  const client: ControlTeamRuntimeClient = {
    getOffice: vi.fn(async () => ({ office })),
    authorizeOfficeRun: vi.fn(async (_officeVersionId, body) => ({
      target: office.executionTargets.find(
        (target) => target.targetId === body.targetId,
      )!,
    })),
    getThreadGoal: vi.fn(async () => {
      if (
        managerCreatesGoal &&
        goalStatus === null &&
        createdRuns.some((item) => item.runId === "manager-plan")
      ) {
        goalRevision = 1;
        goalObjective = "Decide whether to launch the pilot";
        goalStatus = "active";
      }
      return {
        eventSequence: goalRevision,
        goal: goalStatus
          ? {
              threadId: "thread-main",
              goalId: "goal-1",
              revision: goalRevision,
              objective: goalObjective,
              status: goalStatus,
              tokenBudget: 100_000,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            }
          : null,
      };
    }),
    setThreadGoal: vi.fn(async (threadId, body) => {
      goalRevision += 1;
      goalObjective = body.objective ?? goalObjective;
      const nextStatus = body.status ?? goalStatus ?? "active";
      goalStatus = nextStatus;
      const continuationRun =
        nextStatus === "active"
          ? {
              ...run("goal-continuation", threadId),
              goalBinding: {
                goalId: "goal-1",
                revision: goalRevision,
                objectiveDigest: `sha256:${"d".repeat(64)}`,
              },
            }
          : null;
      return {
        disposition: "committed" as const,
        goal: {
          threadId,
          goalId: "goal-1",
          revision: goalRevision,
          objective: goalObjective,
          status: nextStatus,
          tokenBudget: 100_000,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
        canceledRun: null,
        retainedRun: null,
        continuationRun,
      };
    }),
    appendThreadMessage: vi.fn(async (threadId, body) => {
      if (threadId === "thread-main") {
        sourceHasIncompleteUserBoundary = true;
      }
      const isReport = body.content.includes("· 成员报告]");
      const isAssignment = body.content.includes("· 成员任务]");
      const isManagerPlan = body.content.includes("· 组长拆解]");
      const isRecovery = body.content.startsWith("[Team Runtime 恢复任务]");
      const sequence = isReport
        ? 3
        : isRecovery
          ? 4
          : isAssignment || isManagerPlan
            ? 2
            : 1;
      const nextMessage = message(threadId, sequence, "user", body.content);
      appendedMessages.push(nextMessage);
      return {
        disposition: "committed" as const,
        thread: thread(threadId, {
          revision: body.expectedRevision + 1,
          lastMessageSequence: sequence,
        }),
        message: nextMessage,
      };
    }),
    forkThread: vi.fn(async (_threadId, body) => {
      if (sourceHasIncompleteUserBoundary) {
        throw new Error("thread_fork_boundary_incomplete");
      }
      const threadId = forkIds[forkIndex]!;
      forkIndex += 1;
      return {
        disposition: "committed" as const,
        thread: thread(threadId, {
          revision: 1,
          forkedFromThreadId: "thread-main",
          forkedThroughHistorySequence: body.throughHistorySequence ?? 2,
        }),
      };
    }),
    createRun: vi.fn(async (body) => {
      const suffix =
        body.threadId === "thread-manager-plan"
          ? "manager-plan"
          : body.agentVersionId === "agent-manager"
            ? `recovery-${body.threadId}`
            : `worker-${body.threadId}`;
      const created = run(suffix, body.threadId);
      createdRuns.push(created);
      return { disposition: "committed" as const, run: created };
    }),
    startTurn: vi.fn(async (threadId, body) => {
      if (body.executionIntent === "resumeGoal") {
        goalRevision += 1;
        goalStatus = "active";
      }
      const nextMessage = message(threadId, 3, "user", body.content);
      appendedMessages.push(nextMessage);
      const created = {
        ...run("manager-final", threadId),
        goalBinding:
          body.executionIntent === "resumeGoal"
            ? {
                goalId: "goal-1",
                revision: goalRevision,
                objectiveDigest: `sha256:${"d".repeat(64)}`,
              }
            : null,
      };
      createdRuns.push(created);
      return {
        disposition: "committed" as const,
        thread: thread(threadId, {
          revision: body.expectedRevision + 1,
          lastMessageSequence: 3,
        }),
        message: nextMessage,
        run: created,
      };
    }),
    getRun: vi.fn(async (runId) => {
      if (transientRunReadFailures > 0) {
        transientRunReadFailures -= 1;
        throw new Error("temporary_web_proxy_failure");
      }
      const created = createdRuns.find((item) => item.runId === runId)!;
      const failed =
        failedWorker !== null && runId === `worker-thread-${failedWorker}`;
      return {
        run: run(runId, created.threadId, failed ? "failed" : "completed"),
      };
    }),
    getThread: vi.fn(async (threadId) => ({
      thread: thread(threadId, {
        revision: threadId === "thread-main" ? 3 : 2,
      }),
      eventSequence: threadId === "thread-main" ? 3 : 2,
    })),
    listThreadMessages: vi.fn(async (threadId) => ({
      data: [message(threadId, 3, "assistant", `${threadId} evidence report`)],
      nextCursor: null,
    })),
  };
  return {
    createdRuns,
    appendedMessages,
    client,
  };
}

describe("Control TypeScript Team Runtime", () => {
  it("authorizes every pinned member and preserves the first target as manager", async () => {
    const state = teamClient();
    const plan = await resolveControlTeamPlan({
      client: state.client,
      threadId: "thread-main",
      officeVersionId: office.officeVersionId,
      catalog,
    });

    expect(plan.manager.displayName).toBe("Release lead");
    expect(plan.workers.map((worker) => worker.displayName)).toEqual([
      "QA",
      "Security",
    ]);
    expect(state.client.authorizeOfficeRun).toHaveBeenCalledTimes(3);
  });

  it("submits member forks together and completes final manager synthesis with bounded reports", async () => {
    const state = teamClient();
    const plan = await resolveControlTeamPlan({
      client: state.client,
      threadId: "thread-main",
      officeVersionId: office.officeVersionId,
      catalog,
    });
    const started: string[] = [];

    const result = await startControlTeamTurn({
      client: state.client,
      threadId: "thread-main",
      expectedRevision: 1,
      content: "Assess the release",
      plan,
      idempotencyKey: (operation) => operation,
      onRunStarted: (current) => started.push(current.runId),
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(state.createdRuns.map((current) => current.runId)).toEqual([
      "manager-plan",
      "worker-thread-qa",
      "worker-thread-security",
      "manager-final",
    ]);
    expect(started).toEqual(["manager-final"]);
    expect(result.run).toEqual(
      expect.objectContaining({ runId: "manager-final", status: "completed" }),
    );
    expect(state.appendedMessages.at(-1)?.content).toContain(
      "thread-security evidence report",
    );
    expect(
      state.appendedMessages.find((item) =>
        item.content.includes("· 成员任务]"),
      )?.content,
    ).toContain("1,200 个字符以内");
    expect(
      state.appendedMessages.find((item) =>
        item.content.includes("· 成员任务]"),
      )?.content,
    ).toContain("thread-manager-plan evidence report");
    expect(state.client.startTurn).toHaveBeenCalledWith(
      "thread-main",
      expect.objectContaining({ executionIntent: "none" }),
      "team.manager.final",
    );
  });

  it("survives a bounded transient Web proxy failure during a long Team run", async () => {
    const state = teamClient(null, null, false, 1);
    const plan = await resolveControlTeamPlan({
      client: state.client,
      threadId: "thread-main",
      officeVersionId: office.officeVersionId,
      catalog,
    });

    const result = await startControlTeamTurn({
      client: state.client,
      threadId: "thread-main",
      expectedRevision: 1,
      content: "Assess the release despite a brief proxy restart",
      plan,
      idempotencyKey: (operation) => operation,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(result.run).toEqual(
      expect.objectContaining({ runId: "manager-final", status: "completed" }),
    );
    expect(state.client.getRun).toHaveBeenCalledTimes(5);
  });

  it("stays attached across a full PIM rolling-deployment window", async () => {
    vi.useFakeTimers();
    try {
      const state = teamClient(null, null, false, 9);
      const plan = await resolveControlTeamPlan({
        client: state.client,
        threadId: "thread-main",
        officeVersionId: office.officeVersionId,
        catalog,
      });

      const pending = startControlTeamTurn({
        client: state.client,
        threadId: "thread-main",
        expectedRevision: 1,
        content: "Assess the release across a PIM rolling deployment",
        plan,
        idempotencyKey: (operation) => operation,
        pollIntervalMs: 0,
        runDeadlineMs: 120_000,
      });
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toEqual({
        message: expect.objectContaining({ threadId: "thread-main" }),
        run: expect.objectContaining({
          runId: "manager-final",
          status: "completed",
        }),
      });
      expect(state.client.getRun).toHaveBeenCalledTimes(13);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a long-running Goal without racing Team execution", async () => {
    const state = teamClient();
    const plan = await resolveControlTeamPlan({
      client: state.client,
      threadId: "thread-main",
      officeVersionId: office.officeVersionId,
      catalog,
    });

    const result = await startControlTeamTurn({
      client: state.client,
      threadId: "thread-main",
      expectedRevision: 1,
      content: "Continue the release goal",
      plan,
      idempotencyKey: (operation) => operation,
      executionIntent: "goal",
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(result.run).toEqual(
      expect.objectContaining({ runId: "manager-final", status: "completed" }),
    );
    expect(state.client.startTurn).toHaveBeenCalledWith(
      "thread-main",
      expect.objectContaining({ executionIntent: "resumeGoal" }),
      "team.manager.final",
    );
    expect(state.client.setThreadGoal).toHaveBeenCalledWith(
      "thread-main",
      expect.objectContaining({
        objective: "Continue the release goal",
        status: "paused",
      }),
      "team.goal.pause",
    );
    expect(state.client.setThreadGoal).toHaveBeenCalledTimes(1);
  });

  it("pauses an existing active Goal around a follow-up Team turn", async () => {
    const state = teamClient(null, "active");
    const plan = await resolveControlTeamPlan({
      client: state.client,
      threadId: "thread-main",
      officeVersionId: office.officeVersionId,
      catalog,
    });

    const result = await startControlTeamTurn({
      client: state.client,
      threadId: "thread-main",
      expectedRevision: 1,
      content: "Apply the stage-two evidence",
      plan,
      idempotencyKey: (operation) => operation,
      executionIntent: "none",
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(state.client.setThreadGoal).toHaveBeenNthCalledWith(
      1,
      "thread-main",
      expect.objectContaining({
        expectedRevision: 5,
        objective: null,
        status: "paused",
      }),
      "team.goal.pause",
    );
    expect(state.client.setThreadGoal).toHaveBeenCalledTimes(1);
    expect(result.run).toEqual(
      expect.objectContaining({ runId: "manager-final", status: "completed" }),
    );
  });

  it("keeps manager planning isolated so it cannot create a Goal on the main thread", async () => {
    const state = teamClient(null, null, true);
    const plan = await resolveControlTeamPlan({
      client: state.client,
      threadId: "thread-main",
      officeVersionId: office.officeVersionId,
      catalog,
    });

    await startControlTeamTurn({
      client: state.client,
      threadId: "thread-main",
      expectedRevision: 1,
      content: "Start a long-running release goal",
      plan,
      idempotencyKey: (operation) => operation,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(state.client.getThreadGoal).toHaveBeenCalledTimes(1);
    expect(state.client.setThreadGoal).not.toHaveBeenCalled();
    expect(state.createdRuns[0]).toEqual(
      expect.objectContaining({
        runId: "manager-plan",
        threadId: "thread-manager-plan",
      }),
    );
  });

  it("has the manager take over a failed member before final convergence", async () => {
    const state = teamClient("security");
    const plan = await resolveControlTeamPlan({
      client: state.client,
      threadId: "thread-main",
      officeVersionId: office.officeVersionId,
      catalog,
    });

    await startControlTeamTurn({
      client: state.client,
      threadId: "thread-main",
      expectedRevision: 1,
      content: "Assess the release",
      plan,
      idempotencyKey: (operation) => operation,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(state.createdRuns.map((current) => current.runId)).toContain(
      "recovery-thread-security",
    );
    expect(
      state.appendedMessages.some((item) =>
        item.content.includes("成员 Security 的运行 worker-thread-security"),
      ),
    ).toBe(true);
    expect(state.appendedMessages.at(-1)?.content).toContain(
      "recoveredBy: Release lead",
    );
  });
});
