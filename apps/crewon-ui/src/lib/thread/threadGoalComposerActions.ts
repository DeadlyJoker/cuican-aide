import type {
  ClearThreadGoalRequest,
  SetThreadGoalRequest,
  ThreadGoalMutationResponse,
  ThreadGoalView,
} from "@crewon/contracts";

import type { Locale } from "../i18n";

type ThreadGoalStatus = ThreadGoalView["status"];

type GoalComposerClient = {
  clearThreadGoal(
    threadId: string,
    command: ClearThreadGoalRequest,
  ): Promise<ThreadGoalMutationResponse>;
  setThreadGoal(
    threadId: string,
    command: SetThreadGoalRequest,
  ): Promise<ThreadGoalMutationResponse>;
};

export type ThreadGoalComposerHandlersParams = {
  client: GoalComposerClient | null | undefined;
  isConnected: boolean;
  locale: Locale;
  setBusy: (busy: boolean) => void;
  setNotice: (notice: { text: string; tone: "warning" }) => void;
  setThreadGoal: (goal: ThreadGoalView | null) => void;
  threadGoal: ThreadGoalView | null;
};

const THREAD_GOAL_STATUSES = new Set<ThreadGoalStatus>([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

class ThreadGoalComposerStateError extends Error {}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

export function isThreadGoalView(value: unknown): value is ThreadGoalView {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const goal = value as Partial<ThreadGoalView>;
  return (
    typeof goal.threadId === "string" &&
    goal.threadId.length > 0 &&
    typeof goal.goalId === "string" &&
    goal.goalId.length > 0 &&
    isPositiveSafeInteger(goal.revision) &&
    typeof goal.objective === "string" &&
    goal.objective.trim().length > 0 &&
    typeof goal.status === "string" &&
    THREAD_GOAL_STATUSES.has(goal.status as ThreadGoalStatus) &&
    (goal.tokenBudget === null || isPositiveSafeInteger(goal.tokenBudget)) &&
    isNonNegativeSafeInteger(goal.tokensUsed) &&
    isNonNegativeSafeInteger(goal.timeUsedSeconds) &&
    typeof goal.createdAt === "string" &&
    Number.isFinite(Date.parse(goal.createdAt)) &&
    typeof goal.updatedAt === "string" &&
    Number.isFinite(Date.parse(goal.updatedAt))
  );
}

function requireCurrentGoal(goal: ThreadGoalView | null): ThreadGoalView {
  if (!isThreadGoalView(goal)) {
    throw new ThreadGoalComposerStateError("thread_goal_state_invalid");
  }
  return goal;
}

export function editThreadGoalCommand(
  goal: ThreadGoalView,
  objective: string,
): SetThreadGoalRequest {
  const current = requireCurrentGoal(goal);
  const nextObjective = objective.trim();
  if (!nextObjective) {
    throw new ThreadGoalComposerStateError("thread_goal_objective_invalid");
  }
  return {
    expectedRevision: current.revision,
    objective: nextObjective,
    status: null,
    tokenBudget: { kind: "keep" },
  };
}

export function pauseThreadGoalCommand(
  goal: ThreadGoalView,
): SetThreadGoalRequest {
  const current = requireCurrentGoal(goal);
  if (current.status !== "active") {
    throw new ThreadGoalComposerStateError("thread_goal_transition_invalid");
  }
  return {
    expectedRevision: current.revision,
    objective: null,
    status: "paused",
    tokenBudget: { kind: "keep" },
  };
}

export function resumeThreadGoalCommand(
  goal: ThreadGoalView,
): SetThreadGoalRequest {
  const current = requireCurrentGoal(goal);
  if (current.status !== "paused") {
    throw new ThreadGoalComposerStateError("thread_goal_transition_invalid");
  }
  return {
    expectedRevision: current.revision,
    objective: null,
    status: "active",
    tokenBudget: { kind: "keep" },
  };
}

export function clearThreadGoalCommand(
  goal: ThreadGoalView,
): ClearThreadGoalRequest {
  return { expectedRevision: requireCurrentGoal(goal).revision };
}

export function threadGoalFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  if (
    error instanceof Error &&
    !(error instanceof ThreadGoalComposerStateError) &&
    error.message
  ) {
    return error.message;
  }
  return locale === "zh" ? "目标操作失败" : "Goal action failed";
}

function requireUpdatedGoal({
  command,
  current,
  response,
  threadId,
}: {
  command: SetThreadGoalRequest;
  current: ThreadGoalView;
  response: ThreadGoalMutationResponse;
  threadId: string;
}): ThreadGoalView {
  const goal = response.goal;
  if (
    !isThreadGoalView(goal) ||
    goal.threadId !== threadId ||
    goal.goalId !== current.goalId ||
    goal.revision !== current.revision + 1 ||
    goal.objective !== (command.objective ?? current.objective) ||
    goal.status !== (command.status ?? current.status) ||
    goal.tokenBudget !== current.tokenBudget
  ) {
    throw new ThreadGoalComposerStateError("thread_goal_response_invalid");
  }
  return goal;
}

/**
 * Composer-side controls for an existing Control API Goal. Edits and status
 * changes use the visible revision as their concurrency fence and preserve the
 * backend-owned nullable budget with the explicit `keep` command.
 */
export function createThreadGoalComposerHandlers({
  client,
  isConnected,
  locale,
  setBusy,
  setNotice,
  setThreadGoal,
  threadGoal,
}: ThreadGoalComposerHandlersParams) {
  async function run(
    action: (
      connectedClient: GoalComposerClient,
    ) => Promise<ThreadGoalView | null>,
  ) {
    if (!client || !isConnected) {
      return;
    }
    setBusy(true);
    try {
      setThreadGoal(await action(client));
    } catch (error) {
      setNotice({
        text: threadGoalFailureMessage(error, locale),
        tone: "warning",
      });
    } finally {
      setBusy(false);
    }
  }

  return {
    clearThreadGoal: (threadId: string) =>
      run(async (connectedClient) => {
        const current = requireCurrentGoal(threadGoal);
        if (current.threadId !== threadId) {
          throw new ThreadGoalComposerStateError("thread_goal_thread_invalid");
        }
        const response = await connectedClient.clearThreadGoal(
          threadId,
          clearThreadGoalCommand(current),
        );
        if (response.goal !== null) {
          throw new ThreadGoalComposerStateError(
            "thread_goal_response_invalid",
          );
        }
        return null;
      }),
    setThreadGoalObjective: (threadId: string, objective: string) =>
      run(async (connectedClient) => {
        const current = requireCurrentGoal(threadGoal);
        if (current.threadId !== threadId) {
          throw new ThreadGoalComposerStateError("thread_goal_thread_invalid");
        }
        const command = editThreadGoalCommand(current, objective);
        return requireUpdatedGoal({
          command,
          current,
          response: await connectedClient.setThreadGoal(threadId, command),
          threadId,
        });
      }),
    setThreadGoalStatus: (threadId: string, status: ThreadGoalStatus) =>
      run(async (connectedClient) => {
        const current = requireCurrentGoal(threadGoal);
        if (current.threadId !== threadId) {
          throw new ThreadGoalComposerStateError("thread_goal_thread_invalid");
        }
        const command =
          status === "paused"
            ? pauseThreadGoalCommand(current)
            : status === "active"
              ? resumeThreadGoalCommand(current)
              : null;
        if (!command) {
          throw new ThreadGoalComposerStateError(
            "thread_goal_transition_invalid",
          );
        }
        return requireUpdatedGoal({
          command,
          current,
          response: await connectedClient.setThreadGoal(threadId, command),
          threadId,
        });
      }),
  };
}
