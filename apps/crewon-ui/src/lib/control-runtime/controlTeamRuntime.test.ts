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
import { controlTeamDelegationMarker } from "./controlTeamDelegation";

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
  initialGoalStatus:
    | "active"
    | "paused"
    | "blocked"
    | "usageLimited"
    | "budgetLimited"
    | "complete"
    | null = null,
  managerCreatesGoal = false,
  transientRunReadFailures = 0,
) {
  const createdRuns: RunView[] = [];
  const appendedMessages: MessageView[] = [];
  const forkIds = ["thread-manager-plan", "thread-qa", "thread-security"];
  let forkIndex = 0;
  let goalStatus = initialGoalStatus;
  let goalRevision = initialGoalStatus === null ? 0 : 5;
  let goalId = "goal-1";
  let goalTokensUsed = initialGoalStatus === "complete" ? 80 : 0;
  let goalTimeUsedSeconds = initialGoalStatus === "complete" ? 45 : 0;
  let goalObjective =
    initialGoalStatus === null ? "" : "Decide whether to launch the pilot";
  let sourceHasIncompleteUserBoundary = false;
  const client: ControlTeamRuntimeClient = {
    getExecutionIntentCapability: vi.fn(async () => ({
      version: "v1" as const,
    })),
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
              goalId,
              revision: goalRevision,
              objective: goalObjective,
              status: goalStatus,
              tokenBudget: 100_000,
              tokensUsed: goalTokensUsed,
              timeUsedSeconds: goalTimeUsedSeconds,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            }
          : null,
      };
    }),
    setThreadGoalWithExecutionIntentV1: vi.fn(async (threadId, body) => {
      const replacesCompletedGoal =
        goalStatus === "complete" && body.objective !== null;
      goalRevision += 1;
      if (replacesCompletedGoal) {
        goalId = "goal-2";
        goalTokensUsed = 0;
        goalTimeUsedSeconds = 0;
      }
      goalObjective = body.objective ?? goalObjective;
      const nextStatus = body.status ?? goalStatus ?? "active";
      goalStatus = nextStatus;
      const continuationRun =
        nextStatus === "active"
          ? {
              ...run("goal-continuation", threadId),
              goalBinding: {
                goalId,
                revision: goalRevision,
                objectiveDigest: `sha256:${"d".repeat(64)}`,
              },
            }
          : null;
      return {
        disposition: "committed" as const,
        goal: {
          threadId,
          goalId,
          revision: goalRevision,
          objective: goalObjective,
          status: nextStatus,
          tokenBudget: 100_000,
          tokensUsed: goalTokensUsed,
          timeUsedSeconds: goalTimeUsedSeconds,
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
      const isManagerResponse =
        body.agentVersionId === "agent-manager" &&
        body.content.includes("· 成员报告]");
      const isManagerFinal =
        body.agentVersionId === "agent-manager" &&
        body.content.includes("· 专家会诊报告]");
      const nextMessage = message(
        threadId,
        isManagerResponse || isManagerFinal ? 3 : 5,
        "user",
        body.content,
      );
      appendedMessages.push(nextMessage);
      const created = {
        ...run(
          isManagerFinal
            ? "manager-final"
            : isManagerResponse
              ? "manager-delegate"
              : "member-final-qa",
          threadId,
        ),
        goalBinding:
          body.executionIntent === "resumeGoal"
            ? {
                goalId,
                revision: goalRevision,
                objectiveDigest: `sha256:${"d".repeat(64)}`,
              }
            : null,
      };
      createdRuns.push(created);
      return {
        disposition: "committed" as const,
        acceptedExecutionIntent: body.executionIntent,
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
        revision:
          threadId === "thread-main"
            ? createdRuns.some((item) =>
                ["manager-delegate", "manager-final"].includes(item.runId),
              )
              ? 4
              : 3
            : 2,
      }),
      eventSequence: threadId === "thread-main" ? 3 : 2,
    })),
    listThreadMessages: vi.fn(async (threadId) => {
      const content =
        threadId === "thread-main"
          ? `@QA answer the user directly.\n${controlTeamDelegationMarker("qa")}`
          : `${threadId} evidence report`;
      return {
        data: [message(threadId, 3, "assistant", content)],
        nextCursor: null,
      };
    }),
  };
  return {
    createdRuns,
    appendedMessages,
    client,
  };
}

describe("Control TypeScript Team Runtime", () => {
  it("rejects Plan before any Team or Goal side effect", async () => {
    const state = teamClient(null, "active");
    const plan = {
      officeVersionId: office.officeVersionId,
      officeTitle: office.title,
      manager: {
        ...office.members[0]!,
        targetId: office.executionTargets[0]!.targetId,
      },
      workers: office.members.slice(1).map((member, index) => ({
        ...member,
        targetId: office.executionTargets[index + 1]!.targetId,
      })),
    };

    await expect(
      startControlTeamTurn({
        client: state.client,
        threadId: "thread-main",
        expectedRevision: 1,
        content: "Plan the release without executing it",
        plan,
        responseMode: "manager",
        idempotencyKey: (operation) => operation,
        executionIntent: "plan",
        pollIntervalMs: 0,
        runDeadlineMs: 1_000,
      }),
    ).rejects.toThrow("control_team_plan_unsupported");

    expect(state.client.getThreadGoal).not.toHaveBeenCalled();
    expect(
      state.client.setThreadGoalWithExecutionIntentV1,
    ).not.toHaveBeenCalled();
    expect(state.client.authorizeOfficeRun).not.toHaveBeenCalled();
    expect(state.client.getThread).not.toHaveBeenCalled();
    expect(state.client.forkThread).not.toHaveBeenCalled();
    expect(state.client.appendThreadMessage).not.toHaveBeenCalled();
    expect(state.client.createRun).not.toHaveBeenCalled();
    expect(state.client.startTurn).not.toHaveBeenCalled();
    expect(state.createdRuns).toEqual([]);
    expect(state.appendedMessages).toEqual([]);
  });

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

  it("returns the assigned member Run before completion so its answer can stream", async () => {
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
      responseMode: "member",
      idempotencyKey: (operation) => operation,
      onRunStarted: (current) => started.push(current.runId),
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(state.createdRuns.map((current) => current.runId)).toEqual([
      "manager-plan",
      "worker-thread-qa",
      "worker-thread-security",
      "manager-delegate",
      "member-final-qa",
    ]);
    expect(started).toEqual(["member-final-qa"]);
    expect(result.run).toEqual(
      expect.objectContaining({
        runId: "member-final-qa",
        status: "queued",
      }),
    );
    expect(state.client.getRun).not.toHaveBeenCalledWith("member-final-qa");
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
      expect.objectContaining({
        agentVersionId: "agent-manager",
        executionIntent: "none",
      }),
      "team.manager.delegate",
    );
    expect(state.client.startTurn).toHaveBeenCalledWith(
      "thread-main",
      expect.objectContaining({
        agentVersionId: "agent-qa",
        executionIntent: "none",
      }),
      "team.member.final.qa",
    );
  });

  it("returns the expert-team manager Run before completion so its answer can stream", async () => {
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
      content: "Ask the expert panel for a release verdict",
      plan,
      responseMode: "manager",
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
      expect.objectContaining({
        runId: "manager-final",
        status: "queued",
      }),
    );
    expect(state.client.getRun).not.toHaveBeenCalledWith("manager-final");
    expect(state.client.startTurn).toHaveBeenCalledTimes(1);
    expect(state.client.startTurn).toHaveBeenCalledWith(
      "thread-main",
      expect.objectContaining({
        agentVersionId: "agent-manager",
        executionIntent: "none",
      }),
      "team.manager.final",
    );
    const finalPrompt = state.appendedMessages.at(-1)?.content ?? "";
    expect(finalPrompt).toContain("唯一面向用户的对话入口");
    expect(finalPrompt).toContain("不要 @ 任何专家");
    expect(finalPrompt).not.toContain(controlTeamDelegationMarker("qa"));
  });

  it("adopts a committed Team turn with a mismatched acknowledgement and warns", async () => {
    const state = teamClient();
    const plan = await resolveControlTeamPlan({
      client: state.client,
      threadId: "thread-main",
      officeVersionId: office.officeVersionId,
      catalog,
    });
    const startTurn = vi.mocked(state.client.startTurn);
    const originalStartTurn = startTurn.getMockImplementation();
    if (originalStartTurn === undefined) {
      throw new Error("missing_test_start_turn_implementation");
    }
    startTurn.mockImplementationOnce(async (...args) => ({
      ...(await originalStartTurn(...args)),
      acceptedExecutionIntent: "plan",
    }));
    const onFinalTurnStarted = vi.fn();
    const onExecutionIntentMismatch = vi.fn();
    const onRunStarted = vi.fn();

    await expect(
      startControlTeamTurn({
        client: state.client,
        threadId: "thread-main",
        expectedRevision: 1,
        content: "Ask the expert panel for a release verdict",
        plan,
        responseMode: "manager",
        idempotencyKey: (operation) => operation,
        onFinalTurnStarted,
        onExecutionIntentMismatch,
        onRunStarted,
        pollIntervalMs: 0,
        runDeadlineMs: 1_000,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        run: expect.objectContaining({ runId: "manager-final" }),
      }),
    );

    expect(onFinalTurnStarted).toHaveBeenCalledOnce();
    expect(onRunStarted).toHaveBeenCalledOnce();
    expect(onExecutionIntentMismatch).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "manager-final" }),
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
      responseMode: "member",
      idempotencyKey: (operation) => operation,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(result.run).toEqual(
      expect.objectContaining({
        runId: "member-final-qa",
        status: "queued",
      }),
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
        responseMode: "member",
        idempotencyKey: (operation) => operation,
        pollIntervalMs: 0,
        runDeadlineMs: 120_000,
      });
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toEqual({
        message: expect.objectContaining({ threadId: "thread-main" }),
        run: expect.objectContaining({
          runId: "member-final-qa",
          status: "queued",
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
      responseMode: "member",
      idempotencyKey: (operation) => operation,
      executionIntent: "goal",
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(result.run).toEqual(
      expect.objectContaining({
        runId: "member-final-qa",
        status: "queued",
      }),
    );
    expect(state.client.startTurn).toHaveBeenCalledWith(
      "thread-main",
      expect.objectContaining({
        agentVersionId: "agent-qa",
        executionIntent: "resumeGoal",
      }),
      "team.member.final.qa",
    );
    expect(
      state.client.setThreadGoalWithExecutionIntentV1,
    ).toHaveBeenCalledWith(
      "thread-main",
      expect.objectContaining({
        objective: "Continue the release goal",
        status: "paused",
      }),
      "team.goal.pause",
    );
    expect(
      state.client.setThreadGoalWithExecutionIntentV1,
    ).toHaveBeenCalledTimes(1);
  });

  it("retries final Goal resume through the rolling-deployment window without duplicating work", async () => {
    vi.useFakeTimers();
    try {
      const state = teamClient(null, "active");
      const plan = await resolveControlTeamPlan({
        client: state.client,
        threadId: "thread-main",
        officeVersionId: office.officeVersionId,
        catalog,
      });
      const startTurn = vi.mocked(state.client.startTurn);
      const routeMiss = new Error(
        "control_execution_intent_capability_unavailable",
      );
      for (let miss = 0; miss < 9; miss += 1) {
        startTurn.mockRejectedValueOnce(routeMiss);
      }

      const pending = startControlTeamTurn({
        client: state.client,
        threadId: "thread-main",
        expectedRevision: 1,
        content: "Continue the release goal across a rolling deployment",
        plan,
        responseMode: "manager",
        idempotencyKey: (operation) => operation,
        executionIntent: "goal",
        pollIntervalMs: 1_000,
        runDeadlineMs: 45_000,
      });
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual(
        expect.objectContaining({
          run: expect.objectContaining({ runId: "manager-final" }),
        }),
      );

      expect(startTurn).toHaveBeenCalledTimes(10);
      for (const call of startTurn.mock.calls.slice(1)) {
        expect(call).toEqual(startTurn.mock.calls[0]);
      }
      expect(state.client.forkThread).toHaveBeenCalledTimes(3);
      expect(state.client.appendThreadMessage).toHaveBeenCalledTimes(4);
      expect(state.client.createRun).toHaveBeenCalledTimes(3);
      await expect(state.client.getThreadGoal("thread-main")).resolves.toEqual(
        expect.objectContaining({
          goal: expect.objectContaining({ status: "active" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds final Goal resume retries and preserves the paused recovery state", async () => {
    vi.useFakeTimers();
    try {
      const state = teamClient(null, "active");
      const plan = await resolveControlTeamPlan({
        client: state.client,
        threadId: "thread-main",
        officeVersionId: office.officeVersionId,
        catalog,
      });
      const startTurn = vi.mocked(state.client.startTurn);
      startTurn.mockRejectedValue(
        new Error("control_execution_intent_capability_unavailable"),
      );

      const pending = startControlTeamTurn({
        client: state.client,
        threadId: "thread-main",
        expectedRevision: 1,
        content: "Continue the release goal while old nodes remain",
        plan,
        responseMode: "manager",
        idempotencyKey: (operation) => operation,
        executionIntent: "goal",
        pollIntervalMs: 0,
        runDeadlineMs: 1_000,
      });
      const rejected = expect(pending).rejects.toThrow(
        "control_execution_intent_capability_unavailable",
      );
      await vi.runAllTimersAsync();
      await rejected;

      expect(startTurn).toHaveBeenCalledTimes(4);
      for (const call of startTurn.mock.calls.slice(1)) {
        expect(call).toEqual(startTurn.mock.calls[0]);
      }
      expect(state.client.forkThread).toHaveBeenCalledTimes(3);
      expect(state.client.appendThreadMessage).toHaveBeenCalledTimes(4);
      expect(state.client.createRun).toHaveBeenCalledTimes(3);
      await expect(state.client.getThreadGoal("thread-main")).resolves.toEqual(
        expect.objectContaining({
          goal: expect.objectContaining({ status: "paused" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["usageLimited", "goal_usage_limited"],
    ["budgetLimited", "goal_budget_limited"],
  ] as const)(
    "rejects Goal for a %s Team Goal before any mutation",
    async (goalStatus, expectedError) => {
      const state = teamClient(null, goalStatus);
      const plan = await resolveControlTeamPlan({
        client: state.client,
        threadId: "thread-main",
        officeVersionId: office.officeVersionId,
        catalog,
      });
      vi.clearAllMocks();

      await expect(
        startControlTeamTurn({
          client: state.client,
          threadId: "thread-main",
          expectedRevision: 1,
          content: "Continue the limited goal",
          plan,
          responseMode: "manager",
          idempotencyKey: (operation) => operation,
          executionIntent: "goal",
          pollIntervalMs: 0,
          runDeadlineMs: 1_000,
        }),
      ).rejects.toThrow(expectedError);

      expect(
        state.client.setThreadGoalWithExecutionIntentV1,
      ).not.toHaveBeenCalled();
      expect(state.client.forkThread).not.toHaveBeenCalled();
      expect(state.client.appendThreadMessage).not.toHaveBeenCalled();
      expect(state.client.createRun).not.toHaveBeenCalled();
      expect(state.client.startTurn).not.toHaveBeenCalled();
    },
  );

  it("stops before Team side effects when the versioned Goal route is unavailable", async () => {
    const state = teamClient(null, "complete");
    const plan = await resolveControlTeamPlan({
      client: state.client,
      threadId: "thread-main",
      officeVersionId: office.officeVersionId,
      catalog,
    });
    vi.clearAllMocks();
    vi.mocked(
      state.client.setThreadGoalWithExecutionIntentV1,
    ).mockRejectedValueOnce(
      new Error("control_execution_intent_capability_unavailable"),
    );

    await expect(
      startControlTeamTurn({
        client: state.client,
        threadId: "thread-main",
        expectedRevision: 1,
        content: "Start a fresh release goal",
        plan,
        responseMode: "manager",
        idempotencyKey: (operation) => operation,
        executionIntent: "goal",
        pollIntervalMs: 0,
        runDeadlineMs: 1_000,
      }),
    ).rejects.toThrow("control_execution_intent_capability_unavailable");

    expect(state.client.getThreadGoal).toHaveBeenCalledTimes(1);
    expect(state.client.getExecutionIntentCapability).not.toHaveBeenCalled();
    expect(
      state.client.setThreadGoalWithExecutionIntentV1,
    ).toHaveBeenCalledTimes(1);
    expect(state.client.forkThread).not.toHaveBeenCalled();
    expect(state.client.appendThreadMessage).not.toHaveBeenCalled();
    expect(state.client.createRun).not.toHaveBeenCalled();
    expect(state.client.startTurn).not.toHaveBeenCalled();
  });

  it("replaces a completed Team Goal before pausing the fresh objective", async () => {
    const state = teamClient(null, "complete");
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
      content: "Start a fresh release goal",
      plan,
      responseMode: "manager",
      idempotencyKey: (operation) => operation,
      executionIntent: "goal",
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(
      state.client.setThreadGoalWithExecutionIntentV1,
    ).toHaveBeenCalledWith(
      "thread-main",
      expect.objectContaining({
        expectedRevision: 5,
        objective: "Start a fresh release goal",
        status: "paused",
      }),
      "team.goal.pause",
    );
    const replacedGoal = await state.client.getThreadGoal("thread-main");
    expect(replacedGoal.goal).toMatchObject({
      goalId: "goal-2",
      objective: "Start a fresh release goal",
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
    });
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
      responseMode: "member",
      idempotencyKey: (operation) => operation,
      executionIntent: "none",
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(
      state.client.setThreadGoalWithExecutionIntentV1,
    ).toHaveBeenNthCalledWith(
      1,
      "thread-main",
      expect.objectContaining({
        expectedRevision: 5,
        objective: null,
        status: "paused",
      }),
      "team.goal.pause",
    );
    expect(
      state.client.setThreadGoalWithExecutionIntentV1,
    ).toHaveBeenCalledTimes(1);
    expect(result.run).toEqual(
      expect.objectContaining({
        runId: "member-final-qa",
        status: "queued",
      }),
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
      responseMode: "member",
      idempotencyKey: (operation) => operation,
      pollIntervalMs: 0,
      runDeadlineMs: 1_000,
    });

    expect(state.client.getThreadGoal).toHaveBeenCalledTimes(1);
    expect(
      state.client.setThreadGoalWithExecutionIntentV1,
    ).not.toHaveBeenCalled();
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
      responseMode: "member",
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
