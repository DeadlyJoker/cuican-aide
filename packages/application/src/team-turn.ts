import type { StartTurnRequest } from "@crewon/contracts";
import type {
  StartControlTeamTurnInput,
  ControlTeamTurnResult,
} from "./team-turn-types.ts";
import { readTeamCheckpoint } from "./team-turn-types.ts";
import {
  controlTeamDelegatedMemberId,
  controlExpertManagerFinalResponseMessage,
  controlOfficeManagerFinalResponseMessage,
  controlTeamManagerPlanningPrompt,
  controlTeamMemberAssignment,
  controlTeamMemberGuidance,
  controlTeamPlanningStrategy,
  type ControlTeamAssignmentBasis,
} from "@crewon/domain/team-prompts";
import {
  pauseTeamGoalIfNeeded,
  startFinalTeamTurn,
  controlStartTurnExecutionIntentMatches,
} from "./team-turn-goal.ts";
import {
  latestAssistantOutput,
  memberReport,
  recoverWorker,
  teamDelegationMessage,
  teamMemberDirectResponsePrompt,
} from "./team-turn-reports.ts";
import {
  emitControlTeamRunAccepted,
  validateStartedRun,
  waitForTerminalRun,
} from "./team-turn-runs.ts";

export type * from "./team-turn-types.ts";
export * from "@crewon/domain/team-prompts";
export { resolveControlTeamPlan } from "./team-turn-plan.ts";
export {
  controlStartTurnExecutionIntentMatches,
  requireControlExecutionIntentCapability,
} from "./team-turn-goal.ts";

export const CONTROL_TEAM_PLAN_UNSUPPORTED =
  "control_team_plan_unsupported" as const;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RUN_DEADLINE_MS = 15 * 60 * 1_000;

/**
 * Executes a bounded TypeScript Team turn through durable Control Threads and
 * Runs. Workers receive immutable forks of the same user context and are
 * submitted together. The runtime may schedule them concurrently or queue
 * them according to local capacity. The manager receives a bounded, auditable
 * report before the final synthesis Run starts on the original Thread.
 *
 * A bare invocation is not restartable. The experimental executeTeamTask host
 * supplies frozen observations and command receipts. Current authorization,
 * main-Thread reservation and full cancellation must still be composed before
 * replacing the legacy renderer driver in production.
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
    waitForRunTerminal: input.waitForRunTerminal,
  });
  const forkSource = await readTeamCheckpoint(input, "context", () =>
    input.client.getThread(input.threadId),
  );
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
              throughHistorySequence:
                input.acceptedThroughHistorySequence ?? null,
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
          throughHistorySequence: input.acceptedThroughHistorySequence ?? null,
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
  const appended =
    input.acceptedMessage ??
    (await input.client.appendThreadMessage(
      input.threadId,
      {
        expectedRevision: goalPause?.threadRevision ?? input.expectedRevision,
        content: input.content,
      },
      input.idempotencyKey("team.message.append"),
    ));
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
      signal: input.signal,
      waitForRunTerminal: input.waitForRunTerminal,
    });
    const managerPlan =
      managerTerminal.status === "completed"
        ? await latestAssistantOutput(
            input.client,
            managerFork.thread.threadId,
            managerPlanningPrompt.message.sequence,
            input.checkpoint,
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
        signal: input.signal,
        waitForRunTerminal: input.waitForRunTerminal,
      });
      const directOutput =
        terminal.status === "completed"
          ? await latestAssistantOutput(
              input.client,
              fork.thread.threadId,
              workerAssignments[index]!.message.sequence,
              input.checkpoint,
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

  const current = await readTeamCheckpoint(input, "managerFinalThread", () =>
    input.client.getThread(input.threadId),
  );
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
    waitForRunTerminal: input.waitForRunTerminal,
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
    waitForRunTerminal: input.waitForRunTerminal,
    signal: input.signal,
  });
  const delegation =
    finalManagerTerminal.status === "completed"
      ? await latestAssistantOutput(
          input.client,
          input.threadId,
          finalManagerStarted.message.sequence,
          input.checkpoint,
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

  const memberThread = await readTeamCheckpoint(
    input,
    "memberFinalThread",
    () => input.client.getThread(input.threadId),
  );
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
    waitForRunTerminal: input.waitForRunTerminal,
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
