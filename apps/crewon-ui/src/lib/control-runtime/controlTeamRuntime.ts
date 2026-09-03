import type {
  ActiveAgentVersionCatalogResponse,
  MessageView,
  OfficeContract,
  RunView,
  StartTurnRequest,
  StartTurnResponse,
  ToolPermissionMode,
} from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

import type { TeamMemberRuntimeProfile } from "../thread/threadRuntimeSettings";
import {
  controlTeamDelegatedMemberId,
  controlTeamDelegationMarker,
} from "./controlTeamDelegation";

const MAX_TEAM_MEMBERS = 6;
const MAX_MEMBER_REPORT_CHARACTERS = 1_600;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RUN_DEADLINE_MS = 15 * 60 * 1_000;
// A PIM rolling deployment currently takes roughly 30-40 seconds. Keep the
// browser-side coordinator attached long enough to observe the durable Run
// after that maintenance window instead of reporting a false Team failure.
const MAX_CONSECUTIVE_RUN_READ_FAILURES = 20;
const MAX_FINAL_EXECUTION_INTENT_RETRY_WINDOW_MS = 45_000;
const EXECUTION_INTENT_CAPABILITY_UNAVAILABLE =
  "control_execution_intent_capability_unavailable";

export const CONTROL_TEAM_PLAN_UNSUPPORTED =
  "control_team_plan_unsupported" as const;

export function controlStartTurnExecutionIntentMatches(
  response: Pick<StartTurnResponse, "acceptedExecutionIntent" | "run">,
  expectedIntent: NonNullable<StartTurnResponse["acceptedExecutionIntent"]>,
): boolean {
  const expectedCollaborationMode =
    expectedIntent === "plan" ? "plan" : "default";
  const expectsGoalBinding =
    expectedIntent === "goal" || expectedIntent === "resumeGoal";
  return !(
    (expectedIntent !== "none" &&
      response.acceptedExecutionIntent === undefined) ||
    (response.acceptedExecutionIntent !== undefined &&
      response.acceptedExecutionIntent !== expectedIntent) ||
    response.run.collaborationMode !== expectedCollaborationMode ||
    (expectedIntent === "plan" && response.run.goalBinding !== null) ||
    (expectsGoalBinding && response.run.goalBinding === null)
  );
}

export type ControlTeamRuntimeClient = Pick<
  ControlApiClient,
  | "appendThreadMessage"
  | "authorizeOfficeRun"
  | "createRun"
  | "forkThread"
  | "getExecutionIntentCapability"
  | "getOffice"
  | "getRun"
  | "getThread"
  | "getThreadGoal"
  | "listThreadMessages"
  | "setThreadGoalWithExecutionIntentV1"
  | "startTurn"
>;

export type ControlTeamMember = Readonly<{
  memberId: string;
  displayName: string;
  agentVersionId: string;
  targetId: string;
  profile?: TeamMemberRuntimeProfile;
}>;

export type ControlTeamPlan = Readonly<{
  officeVersionId: string;
  officeTitle: string;
  manager: ControlTeamMember;
  workers: readonly ControlTeamMember[];
}>;

export type ControlTeamTurnResult = Readonly<{
  message: MessageView;
  run: RunView;
}>;

export type ControlTeamResponseMode = "manager" | "member";

export async function resolveControlTeamPlan(input: {
  client: ControlTeamRuntimeClient;
  threadId: string;
  officeVersionId: string;
  catalog: ActiveAgentVersionCatalogResponse;
  office?: OfficeContract;
  memberProfiles?: readonly TeamMemberRuntimeProfile[];
}): Promise<ControlTeamPlan> {
  const office =
    input.office ??
    (await input.client.getOffice(input.officeVersionId)).office;
  validateOfficeIdentity(office, input.officeVersionId);
  if (
    office.members.length < 2 ||
    office.members.length > MAX_TEAM_MEMBERS ||
    office.executionTargets.length !== office.members.length
  ) {
    throw new Error("control_team_member_count_unsupported");
  }

  const activeVersions = new Set(
    input.catalog.data.map((version) => version.agentVersionId),
  );
  const profilesByMemberId = new Map(
    input.memberProfiles?.map((profile) => [profile.memberId, profile]),
  );
  if (
    office.executionTargets.some(
      (target, index) =>
        office.members[index]?.agentVersionId !== target.agentVersionId ||
        !activeVersions.has(target.agentVersionId),
    )
  ) {
    throw new Error("control_team_agent_version_unavailable");
  }

  const authorized = await Promise.all(
    office.executionTargets.map(async (target, index) => {
      const response = await input.client.authorizeOfficeRun(
        input.officeVersionId,
        { targetId: target.targetId, threadId: input.threadId },
      );
      if (
        response.target.targetId !== target.targetId ||
        response.target.agentVersionId !== target.agentVersionId
      ) {
        throw new Error("control_office_authorization_response_invalid");
      }
      const member = office.members[index];
      if (member === undefined) {
        throw new Error("control_team_member_mapping_invalid");
      }
      return {
        memberId: member.memberId,
        displayName: member.displayName,
        agentVersionId: member.agentVersionId,
        targetId: target.targetId,
        ...(profilesByMemberId.get(member.memberId)
          ? { profile: profilesByMemberId.get(member.memberId) }
          : {}),
      } satisfies ControlTeamMember;
    }),
  );
  const [manager, ...workers] = authorized;
  if (manager === undefined || workers.length === 0) {
    throw new Error("control_team_member_count_unsupported");
  }
  return {
    officeVersionId: office.officeVersionId,
    officeTitle: office.title,
    manager,
    workers,
  };
}

/**
 * Executes a bounded TypeScript Team turn through durable Control Threads and
 * Runs. Workers receive immutable forks of the same user context and are
 * submitted together. The runtime may schedule them concurrently or queue
 * them according to local capacity. The manager receives a bounded, auditable
 * report before the final synthesis Run starts on the original Thread.
 */
export async function startControlTeamTurn(input: {
  client: ControlTeamRuntimeClient;
  threadId: string;
  expectedRevision: number;
  content: string;
  plan: ControlTeamPlan;
  responseMode: ControlTeamResponseMode;
  idempotencyKey: (operation: string) => string;
  executionIntent?: "none" | "goal" | "plan";
  toolPermissionMode?: ToolPermissionMode;
  onRunStarted?: (run: RunView) => void;
  onFinalTurnStarted?: (started: ControlTeamTurnResult) => void;
  onExecutionIntentMismatch?: (run: RunView) => void;
  pollIntervalMs?: number;
  runDeadlineMs?: number;
}): Promise<ControlTeamTurnResult> {
  if (input.executionIntent === "plan") {
    throw new Error(CONTROL_TEAM_PLAN_UNSUPPORTED);
  }
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const runDeadlineMs = input.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
  const toolPermissionMode = input.toolPermissionMode ?? "requestApproval";
  let goalPause = await pauseTeamGoalIfNeeded({
    ...input,
    pollIntervalMs,
    runDeadlineMs,
  });
  const forkSource = await input.client.getThread(input.threadId);
  if (
    forkSource.thread.threadId !== input.threadId ||
    forkSource.thread.status !== "active"
  ) {
    throw new Error("control_team_manager_thread_invalid");
  }
  const [managerFork, ...forks] = await Promise.all([
    input.client.forkThread(
      input.threadId,
      {
        expectedRevision: forkSource.thread.revision,
        throughHistorySequence: null,
      },
      input.idempotencyKey("team.manager.plan.fork"),
    ),
    ...input.plan.workers.map((worker) =>
      input.client.forkThread(
        input.threadId,
        {
          expectedRevision: forkSource.thread.revision,
          throughHistorySequence: null,
        },
        input.idempotencyKey(`team.fork.${worker.memberId}`),
      ),
    ),
  ]);
  if (
    managerFork.thread.forkedFromThreadId !== input.threadId ||
    managerFork.thread.forkedThroughHistorySequence === null
  ) {
    throw new Error("control_team_manager_plan_fork_invalid");
  }
  if (
    forks.some(
      (fork) =>
        fork.thread.forkedFromThreadId !== input.threadId ||
        fork.thread.forkedThroughHistorySequence === null,
    )
  ) {
    throw new Error("control_team_fork_response_invalid");
  }
  const appended = await input.client.appendThreadMessage(
    input.threadId,
    {
      expectedRevision: goalPause?.threadRevision ?? input.expectedRevision,
      content: input.content,
    },
    input.idempotencyKey("team.message.append"),
  );
  if (
    appended.thread.threadId !== input.threadId ||
    appended.message.threadId !== input.threadId ||
    appended.message.role !== "user" ||
    appended.message.content !== input.content
  ) {
    throw new Error("control_team_message_response_invalid");
  }
  const managerPlanningPrompt = await input.client.appendThreadMessage(
    managerFork.thread.threadId,
    {
      expectedRevision: managerFork.thread.revision,
      content: teamManagerPlanningPrompt(input.plan, input.content),
    },
    input.idempotencyKey("team.manager.plan.prompt"),
  );
  const managerStarted = await input.client.createRun(
    {
      threadId: managerPlanningPrompt.thread.threadId,
      agentVersionId: input.plan.manager.agentVersionId,
      toolPermissionMode,
    },
    input.idempotencyKey("team.manager.plan"),
  );
  validateStartedRun(managerStarted.run, managerFork.thread.threadId);
  const managerTerminal = await waitForTerminalRun({
    client: input.client,
    run: managerStarted.run,
    pollIntervalMs,
    runDeadlineMs,
  });
  const managerPlan =
    managerTerminal.status === "completed"
      ? await latestAssistantOutput(input.client, managerFork.thread.threadId)
      : null;
  if (managerTerminal.status !== "completed" || managerPlan === null) {
    throw new Error(
      `control_team_manager_plan_failed:${managerTerminal.failure?.code ?? managerTerminal.status}`,
    );
  }
  const workerAssignments = await Promise.all(
    forks.map((fork, index) => {
      const worker = input.plan.workers[index];
      if (worker === undefined) {
        throw new Error("control_team_worker_mapping_invalid");
      }
      return input.client.appendThreadMessage(
        fork.thread.threadId,
        {
          expectedRevision: fork.thread.revision,
          content: teamMemberAssignment(
            input.plan,
            worker,
            input.content,
            managerPlan,
          ),
        },
        input.idempotencyKey(`team.assignment.${worker.memberId}`),
      );
    }),
  );
  const workerRunPromises = workerAssignments.map((assignment, index) => {
    const worker = input.plan.workers[index];
    if (worker === undefined) {
      throw new Error("control_team_worker_mapping_invalid");
    }
    return input.client.createRun(
      {
        threadId: assignment.thread.threadId,
        agentVersionId: worker.agentVersionId,
        toolPermissionMode,
      },
      input.idempotencyKey(`team.worker.${worker.memberId}`),
    );
  });
  const workerStarts = await Promise.all(workerRunPromises);

  const reports = await Promise.all(
    workerStarts.map(async (started, index) => {
      const worker = input.plan.workers[index];
      const fork = forks[index];
      if (worker === undefined || fork === undefined) {
        throw new Error("control_team_worker_mapping_invalid");
      }
      validateStartedRun(started.run, fork.thread.threadId);
      const terminal = await waitForTerminalRun({
        client: input.client,
        run: started.run,
        pollIntervalMs,
        runDeadlineMs,
      });
      const directOutput =
        terminal.status === "completed"
          ? await latestAssistantOutput(input.client, fork.thread.threadId)
          : null;
      if (directOutput !== null) {
        return memberReport(worker, terminal, directOutput, null);
      }
      return recoverWorker({
        ...input,
        worker,
        workerThreadId: fork.thread.threadId,
        failedRun: terminal,
        pollIntervalMs,
        runDeadlineMs,
      });
    }),
  );

  const current = await input.client.getThread(input.threadId);
  if (
    current.thread.threadId !== input.threadId ||
    current.thread.status !== "active"
  ) {
    throw new Error("control_team_manager_thread_invalid");
  }
  const managerMessage =
    input.responseMode === "manager"
      ? teamManagerFinalResponseMessage(input.plan, reports)
      : teamDelegationMessage(input.plan, reports);
  const finalManagerExecutionIntent =
    input.responseMode === "manager" && goalPause !== null
      ? "resumeGoal"
      : "none";
  const finalManagerRequest = Object.freeze({
    expectedRevision: current.thread.revision,
    content: managerMessage,
    agentVersionId: input.plan.manager.agentVersionId,
    executionIntent: finalManagerExecutionIntent,
    toolPermissionMode,
  } satisfies StartTurnRequest);
  const finalManagerIdempotencyKey = input.idempotencyKey(
    input.responseMode === "manager"
      ? "team.manager.final"
      : "team.manager.delegate",
  );
  const finalManagerStarted = await startFinalTeamTurn({
    client: input.client,
    threadId: input.threadId,
    request: finalManagerRequest,
    idempotencyKey: finalManagerIdempotencyKey,
    pollIntervalMs,
    runDeadlineMs,
  });
  const finalManagerIntentMatches = controlStartTurnExecutionIntentMatches(
    finalManagerStarted,
    finalManagerExecutionIntent,
  );
  if (
    finalManagerStarted.thread.threadId !== input.threadId ||
    finalManagerStarted.message.threadId !== input.threadId ||
    finalManagerStarted.message.content !== managerMessage
  ) {
    throw new Error("control_team_report_response_invalid");
  }
  validateStartedRun(finalManagerStarted.run, input.threadId, {
    allowGoalBinding: input.responseMode === "manager",
  });
  if (!finalManagerIntentMatches) {
    input.onExecutionIntentMismatch?.(finalManagerStarted.run);
  }
  if (input.responseMode === "manager") {
    input.onFinalTurnStarted?.({
      message: appended.message,
      run: finalManagerStarted.run,
    });
    input.onRunStarted?.(finalManagerStarted.run);
    return { message: appended.message, run: finalManagerStarted.run };
  }
  const finalManagerTerminal = await waitForTerminalRun({
    client: input.client,
    run: finalManagerStarted.run,
    pollIntervalMs,
    runDeadlineMs,
  });
  const delegation =
    finalManagerTerminal.status === "completed"
      ? await latestAssistantOutput(input.client, input.threadId)
      : null;
  if (finalManagerTerminal.status !== "completed" || delegation === null) {
    throw new Error(
      `control_team_manager_delegation_failed:${finalManagerTerminal.failure?.code ?? finalManagerTerminal.status}`,
    );
  }
  const delegatedMemberId = controlTeamDelegatedMemberId(delegation);
  const delegatedMember = input.plan.workers.find(
    (worker) => worker.memberId === delegatedMemberId,
  );
  if (delegatedMember === undefined) {
    throw new Error("control_team_manager_delegation_invalid");
  }

  const memberThread = await input.client.getThread(input.threadId);
  if (
    memberThread.thread.threadId !== input.threadId ||
    memberThread.thread.status !== "active"
  ) {
    throw new Error("control_team_manager_thread_invalid");
  }
  const memberMessage = teamMemberDirectResponsePrompt({
    delegation,
    member: delegatedMember,
    originalTask: input.content,
    plan: input.plan,
    reports,
  });
  const memberExecutionIntent = goalPause === null ? "none" : "resumeGoal";
  const memberRequest = Object.freeze({
    expectedRevision: memberThread.thread.revision,
    content: memberMessage,
    agentVersionId: delegatedMember.agentVersionId,
    executionIntent: memberExecutionIntent,
    toolPermissionMode,
  } satisfies StartTurnRequest);
  const memberIdempotencyKey = input.idempotencyKey(
    `team.member.final.${delegatedMember.memberId}`,
  );
  const memberStarted = await startFinalTeamTurn({
    client: input.client,
    threadId: input.threadId,
    request: memberRequest,
    idempotencyKey: memberIdempotencyKey,
    pollIntervalMs,
    runDeadlineMs,
  });
  const memberIntentMatches = controlStartTurnExecutionIntentMatches(
    memberStarted,
    memberExecutionIntent,
  );
  if (
    memberStarted.thread.threadId !== input.threadId ||
    memberStarted.message.threadId !== input.threadId ||
    memberStarted.message.content !== memberMessage
  ) {
    throw new Error("control_team_member_response_invalid");
  }
  validateStartedRun(memberStarted.run, input.threadId, {
    allowGoalBinding: true,
  });
  if (!memberIntentMatches) {
    input.onExecutionIntentMismatch?.(memberStarted.run);
  }
  input.onFinalTurnStarted?.({
    message: appended.message,
    run: memberStarted.run,
  });
  input.onRunStarted?.(memberStarted.run);
  return { message: appended.message, run: memberStarted.run };
}

async function pauseTeamGoalIfNeeded(input: {
  client: ControlTeamRuntimeClient;
  threadId: string;
  content: string;
  executionIntent?: "none" | "goal" | "plan";
  idempotencyKey: (operation: string) => string;
  pollIntervalMs: number;
  runDeadlineMs: number;
}): Promise<{ threadRevision: number } | null> {
  const current = await input.client.getThreadGoal(input.threadId);
  const shouldCreateOrReplace = input.executionIntent === "goal";
  if (!shouldCreateOrReplace && current.goal?.status !== "active") {
    return null;
  }
  if (
    shouldCreateOrReplace &&
    (current.goal?.status === "budgetLimited" ||
      current.goal?.status === "usageLimited")
  ) {
    throw new Error(
      current.goal.status === "budgetLimited"
        ? "goal_budget_limited"
        : "goal_usage_limited",
    );
  }
  const objective = shouldCreateOrReplace ? input.content : null;
  const replacesCompletedGoal =
    shouldCreateOrReplace && current.goal?.status === "complete";
  const response = await input.client.setThreadGoalWithExecutionIntentV1(
    input.threadId,
    {
      expectedRevision: current.goal?.revision ?? null,
      objective,
      status: "paused",
      tokenBudget: { kind: "keep" },
    },
    input.idempotencyKey("team.goal.pause"),
  );
  if (
    response.goal?.threadId !== input.threadId ||
    (objective !== null && response.goal.objective !== objective) ||
    response.goal.status !== "paused" ||
    (replacesCompletedGoal &&
      (response.goal.goalId === current.goal?.goalId ||
        response.goal.tokensUsed !== 0 ||
        response.goal.timeUsedSeconds !== 0)) ||
    response.continuationRun !== null
  ) {
    throw new Error("control_team_goal_response_invalid");
  }
  await settleGoalMutationRuns({
    client: input.client,
    response,
    pollIntervalMs: input.pollIntervalMs,
    runDeadlineMs: input.runDeadlineMs,
  });
  const snapshot = await input.client.getThread(input.threadId);
  if (
    snapshot.thread.threadId !== input.threadId ||
    snapshot.thread.status !== "active"
  ) {
    throw new Error("control_team_manager_thread_invalid");
  }
  return { threadRevision: snapshot.thread.revision };
}

async function startFinalTeamTurn(input: {
  client: ControlTeamRuntimeClient;
  threadId: string;
  request: Readonly<StartTurnRequest>;
  idempotencyKey: string;
  pollIntervalMs: number;
  runDeadlineMs: number;
}): Promise<StartTurnResponse> {
  const retryDeadline =
    Date.now() +
    Math.min(input.runDeadlineMs, MAX_FINAL_EXECUTION_INTENT_RETRY_WINDOW_MS);
  let consecutiveRouteMisses = 0;
  while (true) {
    try {
      return await input.client.startTurn(
        input.threadId,
        input.request,
        input.idempotencyKey,
      );
    } catch (error) {
      if (
        input.request.executionIntent !== "resumeGoal" ||
        !isExecutionIntentCapabilityUnavailable(error)
      ) {
        throw error;
      }
      const remainingMs = retryDeadline - Date.now();
      if (remainingMs <= 0) throw error;
      consecutiveRouteMisses += 1;
      const retryDelayMs = Math.min(
        remainingMs,
        5_000,
        Math.max(250, input.pollIntervalMs) *
          2 ** Math.min(consecutiveRouteMisses - 1, 4),
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

function isExecutionIntentCapabilityUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === EXECUTION_INTENT_CAPABILITY_UNAVAILABLE
  );
}

export async function requireControlExecutionIntentCapability(
  client: Pick<ControlTeamRuntimeClient, "getExecutionIntentCapability">,
): Promise<void> {
  const capability: unknown = await client.getExecutionIntentCapability();
  if (
    typeof capability !== "object" ||
    capability === null ||
    Array.isArray(capability) ||
    Object.keys(capability).length !== 1 ||
    !("version" in capability) ||
    capability.version !== "v1"
  ) {
    throw new Error("control_execution_intent_capability_invalid");
  }
}

async function settleGoalMutationRuns(input: {
  client: ControlTeamRuntimeClient;
  response: Awaited<
    ReturnType<ControlTeamRuntimeClient["setThreadGoalWithExecutionIntentV1"]>
  >;
  pollIntervalMs: number;
  runDeadlineMs: number;
}): Promise<void> {
  for (const run of [input.response.canceledRun, input.response.retainedRun]) {
    if (run !== null && !isTerminalRun(run)) {
      await waitForTerminalRun({
        client: input.client,
        run,
        pollIntervalMs: input.pollIntervalMs,
        runDeadlineMs: input.runDeadlineMs,
      });
    }
  }
}

function teamMemberAssignment(
  plan: ControlTeamPlan,
  worker: ControlTeamMember,
  originalTask: string,
  managerPlan: string,
): string {
  return [
    `[Team Runtime · ${plan.officeTitle} · 成员任务]`,
    `你是团队成员「${worker.displayName}」。`,
    "请从该角色的专业视角独立分析上一条原始用户任务。输出可验证结论、证据缺口、风险和给组长的建议。",
    "请将报告控制在 1,200 个字符以内，优先保留结论和证据，避免在回收时被截断。",
    "不要代替组长做最终汇总，不要虚构外部证据，也不要创建或完成主线程 Goal。",
    ...controlTeamMemberGuidance(worker),
    "",
    "原始用户任务：",
    originalTask.slice(0, MAX_MEMBER_REPORT_CHARACTERS),
    "",
    "组长拆解（仅作为任务边界；仍需独立验证）：",
    managerPlan.slice(0, MAX_MEMBER_REPORT_CHARACTERS),
  ].join("\n");
}

function teamManagerPlanningPrompt(
  plan: ControlTeamPlan,
  originalTask: string,
): string {
  return [
    `[Team Runtime · ${plan.officeTitle} · 组长拆解]`,
    "基于上一条原始用户任务，只生成团队执行拆解，不要给最终答复。",
    `请分别为 ${plan.workers.map((worker) => `「${worker.displayName}」`).join("、")} 指定互补的分析重点、证据要求和交付边界。`,
    "输出控制在 1,200 个字符以内；不要创建、修改或完成长期 Goal。",
    ...controlTeamMemberGuidance(plan.manager),
    ...plan.workers.flatMap((worker) => [
      "",
      `成员「${worker.displayName}」的工作设定：`,
      ...controlTeamMemberGuidance(worker),
    ]),
    "",
    "原始用户任务：",
    originalTask.slice(0, MAX_MEMBER_REPORT_CHARACTERS),
  ].join("\n");
}

type MemberReport = Readonly<{
  memberId: string;
  displayName: string;
  agentVersionId: string;
  runId: string;
  status: RunView["status"];
  recoveredBy: string | null;
  output: string;
}>;

async function recoverWorker(input: {
  client: ControlTeamRuntimeClient;
  plan: ControlTeamPlan;
  worker: ControlTeamMember;
  workerThreadId: string;
  failedRun: RunView;
  idempotencyKey: (operation: string) => string;
  toolPermissionMode?: ToolPermissionMode;
  pollIntervalMs: number;
  runDeadlineMs: number;
}): Promise<MemberReport> {
  const snapshot = await input.client.getThread(input.workerThreadId);
  const recovery = await input.client.appendThreadMessage(
    input.workerThreadId,
    {
      expectedRevision: snapshot.thread.revision,
      content: [
        "[Team Runtime 恢复任务]",
        `成员 ${input.worker.displayName} 的运行 ${input.failedRun.runId} 以 ${input.failedRun.status} 结束。`,
        "请组长接管该成员职责，依据当前分支中的原始任务和已有上下文补齐这部分分析。",
        "只输出接管结果、证据缺口和对最终决策的影响，不要声称获得了未提供的外部证据。",
      ].join("\n"),
    },
    input.idempotencyKey(`team.recovery.message.${input.worker.memberId}`),
  );
  if (recovery.message.threadId !== input.workerThreadId) {
    throw new Error("control_team_recovery_message_invalid");
  }
  const started = await input.client.createRun(
    {
      threadId: input.workerThreadId,
      agentVersionId: input.plan.manager.agentVersionId,
      toolPermissionMode: input.toolPermissionMode ?? "requestApproval",
    },
    input.idempotencyKey(`team.recovery.run.${input.worker.memberId}`),
  );
  validateStartedRun(started.run, input.workerThreadId);
  const terminal = await waitForTerminalRun({
    client: input.client,
    run: started.run,
    pollIntervalMs: input.pollIntervalMs,
    runDeadlineMs: input.runDeadlineMs,
  });
  const output =
    terminal.status === "completed"
      ? await latestAssistantOutput(input.client, input.workerThreadId)
      : null;
  return memberReport(
    input.worker,
    terminal,
    output ?? `接管运行未完成：${terminal.failure?.code ?? terminal.status}`,
    input.plan.manager.displayName,
  );
}

function memberReport(
  member: ControlTeamMember,
  run: RunView,
  output: string,
  recoveredBy: string | null,
): MemberReport {
  return {
    memberId: member.memberId,
    displayName: member.displayName,
    agentVersionId: member.agentVersionId,
    runId: run.runId,
    status: run.status,
    recoveredBy,
    output: output.slice(0, MAX_MEMBER_REPORT_CHARACTERS),
  };
}

function teamDelegationMessage(
  plan: ControlTeamPlan,
  reports: readonly MemberReport[],
): string {
  const lines = [
    `[Team Runtime · ${plan.officeTitle} · 成员报告]`,
    "以下内容由独立成员分支执行后回收；实际并发度由 Runtime 容量决定。请组长选择最适合直接回答用户的一名成员，并在办公室群聊中把最终回答任务明确派发给该成员。不要代替成员给最终答复。",
    "回复必须只有两部分：第一行以该成员的完整显示名写成“@成员名 任务说明”；最后一行原样输出该成员对应的 CrewON delegate 标记。不要选择组长自己，也不要输出多个标记。",
    ...controlTeamMemberGuidance(plan.manager),
    "",
    "可派发成员与必须原样输出的标记：",
    ...plan.workers.map(
      (worker) =>
        `- @${worker.displayName}：${controlTeamDelegationMarker(worker.memberId)}`,
    ),
  ];
  for (const report of reports) {
    lines.push(
      "",
      `## ${report.displayName}`,
      `- memberId: ${report.memberId}`,
      `- agentVersionId: ${report.agentVersionId}`,
      `- runId: ${report.runId}`,
      `- status: ${report.status}`,
      `- recoveredBy: ${report.recoveredBy ?? "none"}`,
      "",
      report.output,
    );
  }
  return lines.join("\n");
}

function teamManagerFinalResponseMessage(
  plan: ControlTeamPlan,
  reports: readonly MemberReport[],
): string {
  const lines = [
    `[Team Runtime · ${plan.officeTitle} · 专家会诊报告]`,
    "以下内容由后台专家分支独立执行后回收；实际并发度由 Runtime 容量决定。",
    "你是专家团团长，也是唯一面向用户的对话入口。请综合报告后直接回答原始用户，给出可验证结论、证据缺口、风险和下一步。",
    "不要 @ 任何专家，不要把最终回答转交给成员，也不要向用户暴露内部 CrewON 标记或后台分支细节。即使用户要求指定专家直接回复，也必须由你统一汇总答复。",
    "若本次运行绑定了长期 Goal：请先检查原始目标与全部阶段是否确实完成；只有全部完成时才调用 update_goal 标记 complete，确有连续三轮且无法推进的同一阻塞时才标记 blocked。若仍有后续阶段，不要完成 Goal。",
    ...controlTeamMemberGuidance(plan.manager),
  ];
  for (const report of reports) {
    lines.push(
      "",
      `## ${report.displayName}`,
      `- memberId: ${report.memberId}`,
      `- agentVersionId: ${report.agentVersionId}`,
      `- runId: ${report.runId}`,
      `- status: ${report.status}`,
      `- recoveredBy: ${report.recoveredBy ?? "none"}`,
      "",
      report.output,
    );
  }
  return lines.join("\n");
}

function teamMemberDirectResponsePrompt(input: {
  plan: ControlTeamPlan;
  member: ControlTeamMember;
  originalTask: string;
  delegation: string;
  reports: readonly MemberReport[];
}): string {
  const lines = [
    `[Team Runtime · ${input.plan.officeTitle} · 成员直答]`,
    `你是办公室成员「${input.member.displayName}」，组长刚刚在群聊中 @ 你执行本轮任务。`,
    "请以你自己的成员身份直接回答原始用户。给出可验证结论、证据缺口、风险和下一步；不要冒充组长，不要再把回答转交给组长，也不要复述内部 CrewON 标记。",
    "若本次运行绑定了长期 Goal：请先检查原始目标与全部阶段是否确实完成；只有全部完成时才调用 update_goal 标记 complete，确有连续三轮且无法推进的同一阻塞时才标记 blocked。若仍有后续阶段，不要完成 Goal。",
    ...controlTeamMemberGuidance(input.member),
    "",
    "原始用户任务：",
    input.originalTask.slice(0, MAX_MEMBER_REPORT_CHARACTERS),
    "",
    "组长派发：",
    input.delegation.slice(0, MAX_MEMBER_REPORT_CHARACTERS),
    "",
    "可参考的成员报告：",
  ];
  for (const report of input.reports) {
    lines.push(
      "",
      `## ${report.displayName}`,
      `- status: ${report.status}`,
      `- recoveredBy: ${report.recoveredBy ?? "none"}`,
      report.output,
    );
  }
  return lines.join("\n");
}

export function controlTeamMemberGuidance(member: ControlTeamMember): string[] {
  const profile = member.profile;
  if (!profile) return [];
  const lines = ["", `请遵循「${member.displayName}」在办公室中的工作设定：`];
  const systemPrompt = profile.systemPrompt.trim().slice(0, 2_000);
  if (systemPrompt) lines.push(systemPrompt);
  appendCapabilityGuidance(lines, "Skill", profile.skills);
  appendCapabilityGuidance(lines, "MCP 服务", profile.mcp);
  appendCapabilityGuidance(lines, "知识库", profile.knowledge);
  lines.push(
    "未选中的专属能力不要主动假设可用；所有操作仍需遵守当前运行权限。",
  );
  return lines;
}

function appendCapabilityGuidance(
  lines: string[],
  label: string,
  capabilities: TeamMemberRuntimeProfile["skills"],
): void {
  const selected = capabilities.slice(0, 8).map((capability) => {
    const name = capability.name.trim().slice(0, 80);
    const description = capability.description.trim().slice(0, 160);
    return description ? `${name}（${description}）` : name;
  });
  if (selected.length > 0) {
    lines.push(`${label}：${selected.join("、")}`);
  }
}

async function latestAssistantOutput(
  client: ControlTeamRuntimeClient,
  threadId: string,
): Promise<string | null> {
  const response = await client.listThreadMessages(threadId, { limit: 100 });
  const assistant = response.data
    .filter((message) => message.role === "assistant")
    .sort((left, right) => right.sequence - left.sequence)[0];
  const content = assistant?.content.trim();
  return content ? content : null;
}

async function waitForTerminalRun(input: {
  client: ControlTeamRuntimeClient;
  run: RunView;
  pollIntervalMs: number;
  runDeadlineMs: number;
}): Promise<RunView> {
  const deadline = Date.now() + input.runDeadlineMs;
  let current = input.run;
  let consecutiveReadFailures = 0;
  while (!isTerminalRun(current)) {
    if (Date.now() >= deadline) {
      throw new Error("control_team_run_deadline_exceeded");
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
    try {
      current = (await input.client.getRun(current.runId)).run;
      consecutiveReadFailures = 0;
    } catch (error) {
      consecutiveReadFailures += 1;
      if (
        consecutiveReadFailures >= MAX_CONSECUTIVE_RUN_READ_FAILURES ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      const retryDelayMs = Math.min(
        5_000,
        Math.max(250, input.pollIntervalMs) *
          2 ** Math.min(consecutiveReadFailures - 1, 4),
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return current;
}

function validateOfficeIdentity(
  office: OfficeContract,
  officeVersionId: string,
): void {
  if (office.officeVersionId !== officeVersionId) {
    throw new Error("control_team_office_identity_invalid");
  }
}

function validateStartedRun(
  run: RunView,
  threadId: string,
  options: { allowGoalBinding?: boolean } = {},
): void {
  if (
    run.threadId !== threadId ||
    run.purpose !== "turn" ||
    run.status !== "queued" ||
    (!options.allowGoalBinding && run.goalBinding !== null)
  ) {
    throw new Error("control_team_run_response_invalid");
  }
}

function isTerminalRun(run: RunView): boolean {
  return ["canceled", "completed", "failed"].includes(run.status);
}
