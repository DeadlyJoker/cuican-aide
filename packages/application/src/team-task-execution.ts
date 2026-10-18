import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ActorContext } from "./authorization-port.ts";
import { startControlTeamTurn } from "./team-turn.ts";
import type {
  ControlTeamRuntimeClient,
  TeamTurnCheckpoint,
} from "./team-turn-types.ts";
import {
  TeamTaskJournalError,
  teamJournalJson,
  teamJournalFail,
  validateTeamTaskFence,
  validateTeamLeaseDuration,
  type TeamTaskFence,
  type TeamTaskJournalStore,
} from "./team-task-journal.ts";

/**
 * Experimental, explicitly leased Team continuation. Host must separately
 * provide current authorization and main-Thread reservation before enabling
 * this as a production scheduler. Cancellation records intent only here.
 */
export async function executeTeamTask(input: {
  store: TeamTaskJournalStore;
  actor: ActorContext;
  fence: TeamTaskFence;
  operations: ControlTeamRuntimeClient;
  digester: ContentDigester;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  runDeadlineMs?: number;
}) {
  const { store, fence, operations } = input;
  validateTeamTaskFence(fence);
  const leaseMs = input.leaseDurationMs ?? 30_000;
  validateTeamLeaseDuration(leaseMs);
  const task = await store.read(fence);
  if (!task) teamJournalFail("team_task_not_found");
  if (
    input.actor.tenantId !== task.intent.tenantId ||
    input.actor.spaceId !== task.intent.spaceId ||
    input.actor.actorId !== task.intent.actorId ||
    input.actor.principalId !== task.intent.principalId
  )
    teamJournalFail("team_task_issuer_mismatch");
  if (task.cancelRequested) teamJournalFail("team_task_cancel_requested");
  if (task.status === "finalAccepted") return task.result!;
  let stopped = false;
  const pending = new Set<Promise<unknown>>();
  const labels = new Map<string, string>();
  const key = (label: string) => {
    const digest = input.digester.sha256(
      JSON.stringify([fence.tenantId, fence.spaceId, fence.taskId, label]),
    );
    if (!/^sha256:[a-f0-9]{64}$/.test(digest))
      teamJournalFail("team_journal_digest_invalid");
    const result = `team:${digest.slice(7)}`;
    labels.set(result, label);
    return result;
  };
  const guard = () => {
    if (stopped)
      throw new TeamTaskJournalError("team_journal_execution_stopped");
  };
  async function command<T>(
    method: string,
    args: readonly unknown[],
    idempotencyKey: string,
    run: () => Promise<T>,
  ): Promise<T> {
    guard();
    const effect = await store.prepare(
      fence,
      {
        key: `command:${idempotencyKey}`,
        kind: "command",
        request: JSON.parse(
          teamJournalJson({
            method,
            operation: labels.get(idempotencyKey) ?? null,
            args,
          }),
        ),
      },
      { renewForMs: leaseMs },
    );
    if (effect.settled) return effect.response as T;
    const response = await run();
    const settled = await store.settle(
      fence,
      effect.key,
      JSON.parse(teamJournalJson(response)),
    );
    return settled.response as T;
  }
  function track<T>(run: () => Promise<T>): Promise<T> {
    const promise = run();
    pending.add(promise);
    return promise.finally(() => pending.delete(promise));
  }
  async function observation<T>(
    label: string,
    read: () => Promise<T>,
    retain: (value: T) => boolean = () => true,
  ): Promise<T> {
    guard();
    const effect = await store.prepare(
      fence,
      {
        key: `observation:${key(label)}`,
        kind: "observation",
        request: { label },
      },
      { renewForMs: leaseMs },
    );
    if (effect.settled) return effect.response as T;
    const value = await read();
    if (!retain(value)) return value;
    return (
      await store.settle(fence, effect.key, JSON.parse(teamJournalJson(value)))
    ).response as T;
  }
  const checkpoint: TeamTurnCheckpoint = (label, read) =>
    track(() => observation(label, read));
  const client: ControlTeamRuntimeClient = {
    appendThreadMessage: (threadId, body, id) =>
      track(() =>
        command("appendThreadMessage", [threadId, body, id], id, () =>
          operations.appendThreadMessage(threadId, body, id),
        ),
      ),
    forkThread: (threadId, body, id) =>
      track(() =>
        command("forkThread", [threadId, body, id], id, () =>
          operations.forkThread(threadId, body, id),
        ),
      ),
    createRun: (body, id) =>
      track(() =>
        command("createRun", [body, id], id, () =>
          operations.createRun(body, id),
        ),
      ),
    startTurn: (threadId, body, id) =>
      track(() =>
        command("startTurn", [threadId, body, id], id, () =>
          operations.startTurn(threadId, body, id),
        ),
      ),
    setThreadGoalWithExecutionIntentV1: (threadId, body, id) =>
      track(() =>
        command(
          "setThreadGoalWithExecutionIntentV1",
          [threadId, body, id],
          id,
          () =>
            operations.setThreadGoalWithExecutionIntentV1(threadId, body, id),
        ),
      ),
    getRun: (runId) =>
      track(() =>
        observation(
          `run.${runId}`,
          async () => {
            const result = await operations.getRun(runId);
            if (result.run.runId !== runId)
              teamJournalFail("team_journal_run_identity_invalid");
            return result;
          },
          (result) =>
            ["completed", "failed", "canceled"].includes(result.run.status),
        ),
      ),
    getThread: (id) => operations.getThread(id),
    getThreadGoal: (id) => operations.getThreadGoal(id),
    listThreadMessages: (id, query) => operations.listThreadMessages(id, query),
    getExecutionIntentCapability: () =>
      operations.getExecutionIntentCapability(),
    getOffice: (id) => operations.getOffice(id),
    authorizeOfficeRun: (id, body) => operations.authorizeOfficeRun(id, body),
  };
  try {
    const result = await startControlTeamTurn({
      ...task.intent.turn,
      client,
      checkpoint,
      idempotencyKey: key,
      ...(input.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: input.pollIntervalMs }),
      ...(input.runDeadlineMs === undefined
        ? {}
        : { runDeadlineMs: input.runDeadlineMs }),
    });
    guard();
    await store.finalAccepted(fence, result);
    return result;
  } finally {
    stopped = true;
    await Promise.allSettled([...pending]);
  }
}
