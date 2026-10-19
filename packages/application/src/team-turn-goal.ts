import type { StartTurnRequest, StartTurnResponse } from "@crewon/contracts";
import type {
  ControlTeamRuntimeClient,
  TeamRunTerminalWait,
} from "./team-turn-types.ts";
import {
  readTeamCheckpoint,
  type TeamTurnCheckpoint,
} from "./team-turn-types.ts";
import { isTerminalRun, waitForTerminalRun } from "./team-turn-runs.ts";

const MAX_FINAL_EXECUTION_INTENT_RETRY_WINDOW_MS = 45_000;
const EXECUTION_INTENT_CAPABILITY_UNAVAILABLE =
  "control_execution_intent_capability_unavailable";

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

export async function pauseTeamGoalIfNeeded(input: {
  client: ControlTeamRuntimeClient;
  threadId: string;
  content: string;
  executionIntent?: "none" | "goal" | "plan";
  idempotencyKey: (operation: string) => string;
  pollIntervalMs: number;
  runDeadlineMs: number;
  signal?: AbortSignal;
  waitForRunTerminal?: TeamRunTerminalWait;
  checkpoint?: TeamTurnCheckpoint;
}): Promise<{ threadRevision: number } | null> {
  const current = await readTeamCheckpoint(input, "goalInitial", () =>
    input.client.getThreadGoal(input.threadId),
  );
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
    signal: input.signal,
    waitForRunTerminal: input.waitForRunTerminal,
  });
  const snapshot = await readTeamCheckpoint(input, "goalPausedThread", () =>
    input.client.getThread(input.threadId),
  );
  if (
    snapshot.thread.threadId !== input.threadId ||
    snapshot.thread.status !== "active"
  ) {
    throw new Error("control_team_manager_thread_invalid");
  }
  return { threadRevision: snapshot.thread.revision };
}

export async function startFinalTeamTurn(input: {
  client: ControlTeamRuntimeClient;
  threadId: string;
  request: Readonly<StartTurnRequest>;
  idempotencyKey: string;
  pollIntervalMs: number;
  runDeadlineMs: number;
  signal?: AbortSignal;
  waitForRunTerminal?: TeamRunTerminalWait;
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
  signal?: AbortSignal;
  waitForRunTerminal?: TeamRunTerminalWait;
}): Promise<void> {
  for (const run of [input.response.canceledRun, input.response.retainedRun]) {
    if (run !== null && !isTerminalRun(run)) {
      await waitForTerminalRun({
        client: input.client,
        run,
        pollIntervalMs: input.pollIntervalMs,
        runDeadlineMs: input.runDeadlineMs,
        signal: input.signal,
        waitForRunTerminal: input.waitForRunTerminal,
      });
    }
  }
}
