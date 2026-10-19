import type { ContentDigester } from "./application-runtime-ports.ts";
import { formatMessageCursor } from "@crewon/contracts";
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
import type { AutonomousTaskCapabilitySnapshot } from "./task-lineage-policy.ts";

/** Explicit host identity and operations required by a durable Team executor. */
export type TeamTaskExecutionHost = Readonly<{
  actor: ActorContext;
  /** Optional host-generated capability; never populated from task/model input. */
  autonomousCapability?: AutonomousTaskCapabilitySnapshot;
  operations: ControlTeamRuntimeClient;
  digester: ContentDigester;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  runDeadlineMs?: number;
}>;

/** Binds one explicit host to the scheduler's durable journal. */
export function createTeamTaskExecutor(input: {
  store: TeamTaskJournalStore;
  host: TeamTaskExecutionHost;
}): (fence: TeamTaskFence, signal: AbortSignal) => Promise<void> {
  const capability = input.host.autonomousCapability;
  if (
    capability !== undefined &&
    (capability.tenantId !== input.host.actor.tenantId ||
      capability.spaceId !== input.host.actor.spaceId ||
      capability.actorId !== input.host.actor.actorId ||
      capability.principalId !== input.host.actor.principalId)
  )
    teamJournalFail("team_task_host_capability_scope_mismatch");
  return async (fence, signal) => {
    if (
      input.host.actor.tenantId !== fence.tenantId ||
      input.host.actor.spaceId !== fence.spaceId
    )
      teamJournalFail("team_task_host_scope_mismatch");
    await executeTeamTask({
      store: input.store,
      actor: input.host.actor,
      fence,
      operations: input.host.operations,
      digester: input.host.digester,
      ...(capability === undefined ? {} : { autonomousCapability: capability }),
      ...(input.host.leaseDurationMs === undefined
        ? {}
        : { leaseDurationMs: input.host.leaseDurationMs }),
      ...(input.host.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: input.host.pollIntervalMs }),
      ...(input.host.runDeadlineMs === undefined
        ? {}
        : { runDeadlineMs: input.host.runDeadlineMs }),
      signal,
    });
  };
}

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
  autonomousCapability?: AutonomousTaskCapabilitySnapshot;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  runDeadlineMs?: number;
  signal?: AbortSignal;
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
  if (
    input.autonomousCapability !== undefined &&
    (input.autonomousCapability.tenantId !== task.intent.tenantId ||
      input.autonomousCapability.spaceId !== task.intent.spaceId ||
      input.autonomousCapability.actorId !== task.intent.actorId ||
      input.autonomousCapability.principalId !== task.intent.principalId)
  )
    teamJournalFail("team_task_capability_scope_mismatch");
  if (task.cancelRequested) teamJournalFail("team_task_cancel_requested");
  if (task.status === "finalAccepted") return task.result!;
  const fencedOperations = operations.withTeamTaskFence
    ? operations.withTeamTaskFence(fence)
    : operations;
  let stopped = false;
  const pending = new Set<Promise<unknown>>();
  let mainThreadRevision: number | null = null;
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
    if (input.signal?.aborted) {
      const reason = input.signal.reason;
      if (reason instanceof TeamTaskJournalError) throw reason;
      teamJournalFail("team_task_cancel_requested");
    }
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
    track(async () => {
      const value = await observation(label, read);
      if (label === "managerFinalThread" && mainThreadRevision !== null) {
        const thread = value as {
          thread?: { threadId?: string; revision?: number };
        };
        if (
          thread.thread?.threadId !== task.intent.turn.threadId ||
          thread.thread.revision !== mainThreadRevision
        )
          teamJournalFail("team_task_main_thread_changed");
      }
      return value;
    });
  const client: ControlTeamRuntimeClient = {
    appendThreadMessage: (threadId, body, id) =>
      track(async () => {
        const result = await command(
          "appendThreadMessage",
          [threadId, body, id],
          id,
          () => fencedOperations.appendThreadMessage(threadId, body, id),
        );
        if (
          threadId === task.intent.turn.threadId &&
          body.content === task.intent.turn.content
        ) {
          const revision = (result as { thread?: { revision?: number } }).thread
            ?.revision;
          if (!Number.isSafeInteger(revision))
            teamJournalFail("team_task_main_thread_revision_invalid");
          mainThreadRevision = revision as number;
        }
        return result;
      }),
    forkThread: (threadId, body, id) =>
      track(() =>
        command("forkThread", [threadId, body, id], id, () =>
          fencedOperations.forkThread(threadId, body, id),
        ),
      ),
    createRun: (body, id) =>
      track(() =>
        command("createRun", [body, id], id, () =>
          fencedOperations.createRun(body, id),
        ),
      ),
    startTurn: (threadId, body, id) =>
      track(async () => {
        const result = await command(
          "startTurn",
          [threadId, body, id],
          id,
          () => fencedOperations.startTurn(threadId, body, id),
        );
        if (threadId === task.intent.turn.threadId) {
          const revision = (result as { thread?: { revision?: number } }).thread
            ?.revision;
          if (!Number.isSafeInteger(revision))
            teamJournalFail("team_task_main_thread_revision_invalid");
          mainThreadRevision = revision as number;
        }
        return result;
      }),
    setThreadGoalWithExecutionIntentV1: (threadId, body, id) =>
      track(() =>
        command(
          "setThreadGoalWithExecutionIntentV1",
          [threadId, body, id],
          id,
          () =>
            fencedOperations.setThreadGoalWithExecutionIntentV1(
              threadId,
              body,
              id,
            ),
        ),
      ),
    getRun: (runId) =>
      track(() =>
        observation(
          `run.${runId}`,
          async () => {
            const result = await fencedOperations.getRun(runId);
            if (result.run.runId !== runId)
              teamJournalFail("team_journal_run_identity_invalid");
            return result;
          },
          (result) =>
            ["completed", "failed", "canceled"].includes(result.run.status),
        ),
      ),
    getThread: (id) => fencedOperations.getThread(id),
    getThreadGoal: (id) => fencedOperations.getThreadGoal(id),
    listThreadMessages: (id, query) =>
      fencedOperations.listThreadMessages(id, query),
    getExecutionIntentCapability: () =>
      fencedOperations.getExecutionIntentCapability(),
    getOffice: (id) => fencedOperations.getOffice(id),
    authorizeOfficeRun: (id, body) =>
      fencedOperations.authorizeOfficeRun(id, body),
  };
  try {
    const acceptedMessage =
      task.intent.mainMessageSequence === undefined
        ? undefined
        : await checkpoint("mainMessage", async () => {
            const sequence = task.intent.mainMessageSequence!;
            const messages = await fencedOperations.listThreadMessages(
              task.intent.turn.threadId,
              {
                cursor: sequence > 1 ? formatMessageCursor(sequence - 1) : null,
                limit: 1,
              },
            );
            const message = messages.data[0];
            if (
              message === undefined ||
              message.sequence !== sequence ||
              message.threadId !== task.intent.turn.threadId ||
              message.role !== "user" ||
              message.content !== task.intent.turn.content
            )
              teamJournalFail("team_task_main_message_missing");
            const thread = await fencedOperations.getThread(
              task.intent.turn.threadId,
            );
            if (thread.thread.threadId !== task.intent.turn.threadId)
              teamJournalFail("team_task_main_thread_invalid");
            return {
              disposition: "replayed" as const,
              thread: thread.thread,
              message,
            };
          });
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
        ...(acceptedMessage === undefined ? {} : { acceptedMessage }),
        ...(task.intent.mainHistorySequence === undefined
          ? {}
          : {
              acceptedThroughHistorySequence: task.intent.mainHistorySequence,
            }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      guard();
      await store.finalAccepted(fence, result);
      return result;
    } catch (error) {
      if (input.signal?.aborted) {
        const reason = input.signal.reason;
        if (reason instanceof TeamTaskJournalError) throw reason;
        teamJournalFail("team_task_cancel_requested");
      }
      throw error;
    }
  } finally {
    stopped = true;
    await Promise.allSettled([...pending]);
  }
}
