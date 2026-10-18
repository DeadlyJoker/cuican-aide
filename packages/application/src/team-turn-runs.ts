import type { RunView } from "@crewon/contracts";
import type {
  ControlTeamRuntimeClient,
  StartControlTeamTurnInput,
  ControlTeamRunAcceptedEvent,
} from "./team-turn-types.ts";

// Preserve the existing transient-read recovery window during host migration.
const MAX_CONSECUTIVE_RUN_READ_FAILURES = 20;

export async function waitForTerminalRun(input: {
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

export function validateStartedRun(
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

export function emitControlTeamRunAccepted(
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

export function isTerminalRun(run: RunView): boolean {
  return ["canceled", "completed", "failed"].includes(run.status);
}
