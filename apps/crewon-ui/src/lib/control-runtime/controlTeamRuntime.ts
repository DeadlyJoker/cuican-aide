import type {
  ActiveAgentVersionCatalogResponse,
  MessageView,
  OfficeContract,
  RunView,
  StartTurnRequest,
  StartTurnResponse,
  ToolPermissionMode,
} from "@crewon/contracts";
import { formatMessageCursor } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

import type { TeamMemberRuntimeProfile } from "../thread/threadRuntimeSettings";
import {
  controlTeamDelegatedMemberId,
  controlTeamDelegationMarker,
} from "./controlTeamDelegation";
import {
  controlExpertManagerFinalResponseMessage,
  controlOfficeManagerFinalResponseMessage,
  controlTeamModelVisibleReportExecution,
} from "./controlTeamManagerPrompts";
import {
  controlTeamManagerPlanningPrompt,
  controlTeamMemberAssignment,
  controlTeamMemberGuidance,
  controlTeamPlanningStrategy,
  type ControlTeamAssignmentBasis,
} from "./controlTeamPlanning";

export { controlTeamMemberGuidance } from "./controlTeamPlanning";

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

export type ControlTeamManagerResponseKind = "office" | "experts";

export type ControlTeamRunKind =
  | "managerPlanning"
  | "worker"
  | "workerRecovery"
  | "managerFinal"
  | "managerDelegation"
  | "memberFinal";

/**
 * Emitted only after Control accepted a durable Team Run and the response was
 * checked against the expected Thread and Run shape. The Run remains the
 * source of truth; this event only records its structural place in the
 * browser-side Team execution.
 */
export type ControlTeamRunAcceptedEvent = Readonly<{
  phaseIndex: number;
  kind: ControlTeamRunKind;
  /** Office member whose AgentVersion was submitted for this Run. */
  memberId: string;
  agentVersionId: string;
  runId: string;
  runThreadId: string;
  recoveredMemberId?: string;
}>;

export type StartControlTeamTurnInput = Readonly<{
  client: ControlTeamRuntimeClient;
  threadId: string;
  expectedRevision: number;
  content: string;
  plan: ControlTeamPlan;
  idempotencyKey: (operation: string) => string;
  executionIntent?: "none" | "goal" | "plan";
  toolPermissionMode?: ToolPermissionMode;
  onRunStarted?: (run: RunView) => void;
  onTaskAccepted?: (message: MessageView) => void;
  onTeamRunAccepted?: (
    event: ControlTeamRunAcceptedEvent,
  ) => void | Promise<void>;
  onFinalTurnStarted?: (started: ControlTeamTurnResult) => void;
  onExecutionIntentMismatch?: (run: RunView) => void;
  pollIntervalMs?: number;
  runDeadlineMs?: number;
}> &
  (
    | Readonly<{
        responseMode: "manager";
        managerResponseKind: ControlTeamManagerResponseKind;
      }>
    | Readonly<{
        responseMode: "member";
        managerResponseKind?: never;
      }>
  );

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
      const localProfile = profilesByMemberId.get(member.memberId);
      const responsibility = member.responsibility?.trim();
      const profile = responsibility
        ? {
            ...(localProfile ?? {
              memberId: member.memberId,
              systemPrompt: "",
              skills: [],
              mcp: [],
              knowledge: [],
            }),
            memberId: member.memberId,
            teamCoordination: {
              assignmentMode: "roleDirected" as const,
              responsibility,
              source: "officeDefinition" as const,
            },
          }
        : localProfile;
      return {
        memberId: member.memberId,
        displayName: member.displayName,
        agentVersionId: member.agentVersionId,
        targetId: target.targetId,
        ...(profile ? { profile } : {}),
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
export async function startControlTeamTurn(
  input: StartControlTeamTurnInput,
): Promise<ControlTeamTurnResult> {
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
  const planningStrategy = controlTeamPlanningStrategy(input.plan);
  const workerPhaseIndex = planningStrategy === "managerGenerated" ? 1 : 0;
  const forked = await Promise.all([
    ...(planningStrategy === "managerGenerated"
      ? [
          input.client.forkThread(
            input.threadId,
            {
              expectedRevision: forkSource.thread.revision,
              throughHistorySequence: null,
            },
            input.idempotencyKey("team.manager.plan.fork"),
          ),
        ]
      : []),
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
  const managerFork =
    planningStrategy === "managerGenerated" ? forked[0] : null;
  const forks =
    planningStrategy === "managerGenerated" ? forked.slice(1) : forked;
  if (
    managerFork !== null &&
    (managerFork.thread.forkedFromThreadId !== input.threadId ||
      managerFork.thread.forkedThroughHistorySequence === null)
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
  try {
    input.onTaskAccepted?.(appended.message);
  } catch {
    // Presentation must not fail an already durable task submission.
  }
  const branchOriginals = await Promise.all([
    ...(managerFork === null
      ? []
      : [
          input.client.appendThreadMessage(
            managerFork.thread.threadId,
            {
              expectedRevision: managerFork.thread.revision,
              content: input.content,
            },
            input.idempotencyKey("team.manager.plan.original"),
          ),
        ]),
    ...forks.map((fork, index) => {
      const worker = input.plan.workers[index];
      if (worker === undefined) {
        throw new Error("control_team_worker_mapping_invalid");
      }
      return input.client.appendThreadMessage(
        fork.thread.threadId,
        {
          expectedRevision: fork.thread.revision,
          content: input.content,
        },
        input.idempotencyKey(`team.original.${worker.memberId}`),
      );
    }),
  ]);
  if (
    branchOriginals.some(
      (original) =>
        original.message.role !== "user" ||
        original.message.content !== input.content ||
        original.message.threadId !== original.thread.threadId,
    )
  ) {
    throw new Error("control_team_branch_message_response_invalid");
  }
  const managerOriginal = managerFork === null ? null : branchOriginals[0];
  const workerOriginals =
    managerFork === null ? branchOriginals : branchOriginals.slice(1);
  let assignmentBasis: ControlTeamAssignmentBasis;
  if (managerFork === null) {
    assignmentBasis = { kind: "explicitResponsibilities" };
  } else {
    if (managerOriginal === null) {
      throw new Error("control_team_manager_plan_fork_invalid");
    }
    const managerPlanningPrompt = await input.client.appendThreadMessage(
      managerFork.thread.threadId,
      {
        expectedRevision: managerOriginal.thread.revision,
        content: controlTeamManagerPlanningPrompt(input.plan),
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
    emitControlTeamRunAccepted(input.onTeamRunAccepted, managerStarted.run, {
      phaseIndex: 0,
      kind: "managerPlanning",
      memberId: input.plan.manager.memberId,
      agentVersionId: input.plan.manager.agentVersionId,
    });
    const managerTerminal = await waitForTerminalRun({
      client: input.client,
      run: managerStarted.run,
      pollIntervalMs,
      runDeadlineMs,
    });
    const managerPlan =
      managerTerminal.status === "completed"
        ? await latestAssistantOutput(
            input.client,
            managerFork.thread.threadId,
            managerPlanningPrompt.message.sequence,
          )
        : null;
    if (managerTerminal.status !== "completed" || managerPlan === null) {
      throw new Error(
        `control_team_manager_plan_failed:${managerTerminal.failure?.code ?? managerTerminal.status}`,
      );
    }
    assignmentBasis = { kind: "managerPlan", text: managerPlan };
  }
  const workerAssignments = await Promise.all(
    forks.map((fork, index) => {
      const worker = input.plan.workers[index];
      const original = workerOriginals[index];
      if (worker === undefined || original === undefined) {
        throw new Error("control_team_worker_mapping_invalid");
      }
      return input.client.appendThreadMessage(
        fork.thread.threadId,
        {
          expectedRevision: original.thread.revision,
          content: controlTeamMemberAssignment(
            input.plan,
            worker,
            assignmentBasis,
          ),
        },
        input.idempotencyKey(`team.assignment.${worker.memberId}`),
      );
    }),
  );
  const workerRunPromises = workerAssignments.map(async (assignment, index) => {
    const worker = input.plan.workers[index];
    if (worker === undefined) {
      throw new Error("control_team_worker_mapping_invalid");
    }
    const started = await input.client.createRun(
      {
        threadId: assignment.thread.threadId,
        agentVersionId: worker.agentVersionId,
        toolPermissionMode,
      },
      input.idempotencyKey(`team.worker.${worker.memberId}`),
    );
    validateStartedRun(started.run, assignment.thread.threadId);
    emitControlTeamRunAccepted(input.onTeamRunAccepted, started.run, {
      phaseIndex: workerPhaseIndex,
      kind: "worker",
      memberId: worker.memberId,
      agentVersionId: worker.agentVersionId,
    });
    return started;
  });
  const workerStarts = await Promise.all(workerRunPromises);

  const reports = await Promise.all(
    workerStarts.map(async (started, index) => {
      const worker = input.plan.workers[index];
      const fork = forks[index];
      if (worker === undefined || fork === undefined) {
        throw new Error("control_team_worker_mapping_invalid");
      }
      const terminal = await waitForTerminalRun({
        client: input.client,
        run: started.run,
        pollIntervalMs,
        runDeadlineMs,
      });
      const directOutput =
        terminal.status === "completed"
          ? await latestAssistantOutput(
              input.client,
              fork.thread.threadId,
              workerAssignments[index]!.message.sequence,
            )
          : null;
      if (directOutput !== null) {
        return memberReport(worker, terminal, directOutput, null);
      }
      return recoverWorker({
        ...input,
        worker,
        workerThreadId: fork.thread.threadId,
        failedRun: terminal,
        phaseIndex: workerPhaseIndex + 1,
        pollIntervalMs,
        runDeadlineMs,
      });
    }),
  );

  const managerFinalPhaseIndex =
    workerPhaseIndex +
    1 +
    (reports.some((report) => report.recoveredBy !== null) ? 1 : 0);

  const current = await input.client.getThread(input.threadId);
  if (
    current.thread.threadId !== input.threadId ||
    current.thread.status !== "active"
  ) {
    throw new Error("control_team_manager_thread_invalid");
  }
  const managerPromptInput = {
    officeTitle: input.plan.officeTitle,
    managerDisplayName: input.plan.manager.displayName,
    managerGuidance: controlTeamMemberGuidance(input.plan.manager),
    reports,
  };
  const managerMessage =
    input.responseMode === "manager"
      ? input.managerResponseKind === "office"
        ? controlOfficeManagerFinalResponseMessage(managerPromptInput)
        : controlExpertManagerFinalResponseMessage(managerPromptInput)
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
  emitControlTeamRunAccepted(input.onTeamRunAccepted, finalManagerStarted.run, {
    phaseIndex: managerFinalPhaseIndex,
    kind:
      input.responseMode === "manager" ? "managerFinal" : "managerDelegation",
    memberId: input.plan.manager.memberId,
    agentVersionId: input.plan.manager.agentVersionId,
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
      ? await latestAssistantOutput(
          input.client,
          input.threadId,
          finalManagerStarted.message.sequence,
        )
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
  emitControlTeamRunAccepted(input.onTeamRunAccepted, memberStarted.run, {
    phaseIndex: managerFinalPhaseIndex + 1,
    kind: "memberFinal",
    memberId: delegatedMember.memberId,
    agentVersionId: delegatedMember.agentVersionId,
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

type MemberReport = Readonly<{
  memberId: string;
  displayName: string;
  agentVersionId: string;
  runId: string;
  status: RunView["status"];
  recoveredBy: string | null;
  truncated: boolean;
  output: string;
}>;

async function recoverWorker(input: {
  client: ControlTeamRuntimeClient;
  plan: ControlTeamPlan;
  worker: ControlTeamMember;
  workerThreadId: string;
  failedRun: RunView;
  phaseIndex: number;
  idempotencyKey: (operation: string) => string;
  onTeamRunAccepted?: (
    event: ControlTeamRunAcceptedEvent,
  ) => void | Promise<void>;
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
  emitControlTeamRunAccepted(input.onTeamRunAccepted, started.run, {
    phaseIndex: input.phaseIndex,
    kind: "workerRecovery",
    memberId: input.plan.manager.memberId,
    agentVersionId: input.plan.manager.agentVersionId,
    recoveredMemberId: input.worker.memberId,
  });
  const terminal = await waitForTerminalRun({
    client: input.client,
    run: started.run,
    pollIntervalMs: input.pollIntervalMs,
    runDeadlineMs: input.runDeadlineMs,
  });
  const output =
    terminal.status === "completed"
      ? await latestAssistantOutput(
          input.client,
          input.workerThreadId,
          recovery.message.sequence,
        )
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
    truncated: output.length > MAX_MEMBER_REPORT_CHARACTERS,
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
      controlTeamModelVisibleReportExecution(report),
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
      controlTeamModelVisibleReportExecution(report),
      report.output,
    );
  }
  return lines.join("\n");
}

async function latestAssistantOutput(
  client: ControlTeamRuntimeClient,
  threadId: string,
  afterSequence: number,
): Promise<string | null> {
  const response = await client.listThreadMessages(threadId, {
    cursor: formatMessageCursor(afterSequence),
    limit: 100,
  });
  const assistant = response.data
    .filter(
      (message) =>
        message.role === "assistant" && message.sequence > afterSequence,
    )
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

function emitControlTeamRunAccepted(
  observer: StartControlTeamTurnInput["onTeamRunAccepted"],
  run: RunView,
  placement: Omit<ControlTeamRunAcceptedEvent, "runId" | "runThreadId">,
): void {
  if (!observer) return;
  try {
    void Promise.resolve(
      observer(
        Object.freeze({
          ...placement,
          runId: run.runId,
          runThreadId: run.threadId,
        }),
      ),
    ).catch(() => undefined);
  } catch {
    // Observation is best-effort here: the Run is already durable, so a
    // collector failure must not turn accepted execution into a false failure.
  }
}

function isTerminalRun(run: RunView): boolean {
  return ["canceled", "completed", "failed"].includes(run.status);
}
