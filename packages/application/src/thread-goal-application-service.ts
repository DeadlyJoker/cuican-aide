import {
  accountThreadGoalProgress,
  advanceRunGoalAccounting,
  computeRunGoalAccountingDelta,
  DEFAULT_THREAD_GOAL_TOKEN_BUDGET,
  RunGoalAccountingError,
  THREAD_GOAL_STATUSES,
  ThreadGoalError,
  threadGoalContinuationPrompt,
  validateThreadGoal,
  type RunGoalBinding,
  type RunLifecycleEvent,
  type RunState,
  type RunGoalSteeringHandoff,
  type ThreadGoal,
  type ThreadGoalEvent,
  type ThreadGoalStatus,
  type ThreadState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ApplicationIdKind,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { ModelHistoryStore } from "./model-history-store-port.ts";
import type { RunRoute, RunRouteResolverPort } from "./run-commands.ts";
import { RunStoreError, type OutboxMessage } from "./run-store-port.ts";
import type {
  CommitThreadGoalMutationInput,
  CommitThreadGoalMutationResult,
  ThreadGoalEventStore,
  ThreadGoalMutationStore,
  ThreadGoalSnapshotStore,
  ThreadGoalStore,
  ThreadGoalSnapshot,
  TurnStartGoalMutation,
} from "./thread-goal-store-port.ts";
import type { ThreadStore } from "./thread-store-port.ts";

export type ThreadGoalTokenBudgetUpdate =
  | Readonly<{ kind: "keep" }>
  | Readonly<{ kind: "set"; value: number | null }>;

export type SetThreadGoalCommand = Readonly<{
  kind: "thread.goal.set";
  threadId: string;
  idempotencyKey: string;
  expectedRevision: number | null;
  objective: string | null;
  status: ThreadGoalStatus | null;
  tokenBudget: ThreadGoalTokenBudgetUpdate;
}>;

export type ClearThreadGoalCommand = Readonly<{
  kind: "thread.goal.clear";
  threadId: string;
  idempotencyKey: string;
  expectedRevision: number | null;
}>;

type GoalCommand = SetThreadGoalCommand | ClearThreadGoalCommand;

/** Authorized user-facing access to the persistent Thread Goal authority. */
export class ThreadGoalApplicationService {
  readonly #store: ThreadStore &
    ThreadGoalStore &
    ThreadGoalSnapshotStore &
    ThreadGoalEventStore &
    ThreadGoalMutationStore &
    ModelHistoryStore;
  readonly #authorization: AuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #ids: ApplicationIdGenerator;
  readonly #digester: ContentDigester;
  readonly #routeResolver: RunRouteResolverPort;

  constructor(dependencies: {
    store: ThreadStore &
      ThreadGoalStore &
      ThreadGoalSnapshotStore &
      ThreadGoalEventStore &
      ThreadGoalMutationStore &
      ModelHistoryStore;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
    digester: ContentDigester;
    routeResolver: RunRouteResolverPort;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#digester = dependencies.digester;
    this.#routeResolver = dependencies.routeResolver;
  }

  async getGoal(
    actor: ActorContext,
    threadId: string,
  ): Promise<ThreadGoalSnapshot> {
    validateActor(actor);
    requireNonEmpty(threadId, "thread_id_invalid");
    const thread = await this.#loadThread(actor, threadId);
    await this.#authorize(actor, thread, "thread:goal:read");
    try {
      return await this.#store.loadThreadGoalSnapshot({
        tenantId: actor.tenantId,
        threadId: thread.threadId,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async listGoalEvents(
    actor: ActorContext,
    query: Readonly<{
      threadId: string;
      afterSequence: number;
      limit: number;
    }>,
  ): Promise<readonly ThreadGoalEvent[]> {
    validateActor(actor);
    requireNonEmpty(query.threadId, "thread_id_invalid");
    if (!Number.isSafeInteger(query.afterSequence) || query.afterSequence < 0) {
      throw new ApplicationError("validation", "goal_event_cursor_invalid");
    }
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 1_000
    ) {
      throw new ApplicationError("validation", "goal_event_limit_invalid");
    }
    const thread = await this.#loadThread(actor, query.threadId);
    await this.#authorize(actor, thread, "thread:goal:read");
    try {
      return await this.#store.listThreadGoalEvents(
        { tenantId: actor.tenantId, threadId: thread.threadId },
        query.afterSequence,
        query.limit,
      );
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async setGoal(
    actor: ActorContext,
    command: SetThreadGoalCommand,
  ): Promise<CommitThreadGoalMutationResult> {
    validateActor(actor);
    validateSetCommand(command);
    const thread = await this.#loadThread(actor, command.threadId);
    await this.#authorize(actor, thread, "thread:goal:write");
    const idempotency = idempotencyDescriptor(actor, command);
    const replay = await this.#loadReplay(actor, thread.threadId, idempotency);
    if (replay !== null) return replay;

    const current = await this.#loadGoal(actor, thread.threadId);
    validateExpectedGoalRevision(command.expectedRevision, current);
    const occurredAt = this.#now();
    return this.#commitMutation(
      actor,
      thread,
      command,
      idempotency,
      current,
      occurredAt,
    );
  }

  async clearGoal(
    actor: ActorContext,
    command: ClearThreadGoalCommand,
  ): Promise<CommitThreadGoalMutationResult> {
    validateActor(actor);
    validateClearCommand(command);
    const thread = await this.#loadThread(actor, command.threadId);
    await this.#authorize(actor, thread, "thread:goal:write");
    const idempotency = idempotencyDescriptor(actor, command);
    const replay = await this.#loadReplay(actor, thread.threadId, idempotency);
    if (replay !== null) return replay;

    const current = await this.#loadGoal(actor, thread.threadId);
    validateExpectedGoalRevision(command.expectedRevision, current);
    return this.#commitMutation(
      actor,
      thread,
      command,
      idempotency,
      current,
      this.#now(),
    );
  }

  async #commitMutation(
    actor: ActorContext,
    thread: ThreadState,
    command: GoalCommand,
    idempotency: CommitThreadGoalMutationInput["idempotency"],
    currentGoal: ThreadGoal | null,
    occurredAt: string,
  ): Promise<CommitThreadGoalMutationResult> {
    const active = await this.#loadActiveRun(actor, thread.threadId);
    const activeRun = active?.state ?? null;
    if (activeRun?.purpose === "manualCompaction") {
      throw new ApplicationError("conflict", "thread_manual_compaction_active");
    }
    const accountedGoal = this.#accountCurrentGoal(
      currentGoal,
      activeRun,
      occurredAt,
    );
    const mutation: TurnStartGoalMutation =
      command.kind === "thread.goal.set"
        ? setGoalMutation(
            actor,
            command,
            accountedGoal,
            occurredAt,
            this.#nextId.bind(this),
            !sameGoalState(currentGoal, accountedGoal),
          )
        : {
            kind: "clear",
            expectedRevision: currentGoal?.revision ?? null,
            occurredAt,
          };
    const nextGoal =
      mutation.kind === "set"
        ? mutation.goal
        : mutation.kind === "clear"
          ? null
          : currentGoal;
    const cancelQueuedRun = shouldCancelQueuedRun(
      activeRun,
      nextGoal,
      this.#digester,
      active?.trigger ?? "default",
    );
    const shouldContinue =
      nextGoal?.status === "active" && (activeRun === null || cancelQueuedRun);
    const continuation = shouldContinue
      ? await this.#goalActivation(
          actor,
          thread,
          nextGoal,
          activeRun,
          occurredAt,
        )
      : null;
    const input: CommitThreadGoalMutationInput = {
      tenantId: actor.tenantId,
      threadId: thread.threadId,
      idempotency,
      goal: mutation,
      expectedActiveRun:
        activeRun === null
          ? null
          : { runId: activeRun.runId, expectedRevision: activeRun.revision },
      queuedRunCancellation: cancelQueuedRun
        ? this.#queuedRunCancellation(actor, activeRun!, occurredAt)
        : null,
      retainedRunUpdate:
        activeRun !== null &&
        !cancelQueuedRun &&
        activeRun.collaborationMode === "default" &&
        mutation.kind !== "keep"
          ? this.#retainedRunUpdate(
              actor,
              activeRun,
              currentGoal,
              nextGoal,
              occurredAt,
            )
          : null,
      continuation,
    };
    try {
      return await this.#store.commitThreadGoalMutation(input);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  #accountCurrentGoal(
    currentGoal: ThreadGoal | null,
    run: RunState | null,
    occurredAt: string,
  ): ThreadGoal | null {
    if (run?.goalAccounting === null) {
      if (run.goalBinding !== null && run.status !== "queued") {
        throw new ApplicationError(
          "conflict",
          "goal_accounting_cursor_missing",
        );
      }
      return currentGoal;
    }
    if (run?.goalAccounting === undefined) return currentGoal;
    try {
      const delta = computeRunGoalAccountingDelta(
        run.goalAccounting,
        run.usage,
        run.lastSequence,
        occurredAt,
      );
      return accountThreadGoalProgress(
        currentGoal,
        run.goalAccounting,
        delta,
        occurredAt,
      );
    } catch (error) {
      throw mapGoalAccountingError(error);
    }
  }

  #retainedRunUpdate(
    actor: ActorContext,
    run: RunState,
    currentGoal: ThreadGoal | null,
    nextGoal: ThreadGoal | null,
    occurredAt: string,
  ): NonNullable<CommitThreadGoalMutationInput["retainedRunUpdate"]> {
    const nextBinding =
      nextGoal?.status === "active" || nextGoal?.status === "budgetLimited"
        ? goalBinding(nextGoal, this.#digester)
        : null;
    const pendingSteering = this.#goalSteering(
      run,
      currentGoal,
      nextGoal,
      nextBinding,
      occurredAt,
    );
    let nextAccounting;
    try {
      nextAccounting = advanceRunGoalAccounting(run.goalAccounting, {
        currentUsage: run.usage,
        throughRunSequence: run.lastSequence,
        occurredAt,
        nextBinding,
        pendingSteering,
        trackTime: nextBinding !== null && run.status !== "queued",
      }).next;
    } catch (error) {
      throw mapGoalAccountingError(error);
    }
    const event: Extract<
      RunLifecycleEvent,
      { type: "run.goal.accounting.updated" }
    > = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: run.runId },
      eventId: this.#nextId("runEvent"),
      sequence: run.lastSequence + 1,
      occurredAt,
      type: "run.goal.accounting.updated",
      data: { next: nextAccounting },
    };
    return {
      events: [event],
      outbox: [this.#outbox(actor.tenantId, event)],
    };
  }

  #goalSteering(
    run: RunState,
    currentGoal: ThreadGoal | null,
    nextGoal: ThreadGoal | null,
    nextBinding: RunGoalBinding | null,
    occurredAt: string,
  ): RunGoalSteeringHandoff | null {
    if (nextGoal === null || nextBinding === null) return null;
    const prior = run.goalAccounting?.pendingSteering ?? null;
    const kind =
      nextGoal.status === "budgetLimited"
        ? "budgetLimited"
        : currentGoal?.objective !== nextGoal.objective ||
            currentGoal?.status !== "active" ||
            run.goalAccounting?.attribution === null
          ? "objectiveUpdated"
          : prior?.kind;
    return kind === undefined
      ? null
      : {
          handoffId: this.#nextId("runEvent"),
          kind,
          target: nextBinding,
          createdAt: occurredAt,
        };
  }

  async #goalActivation(
    actor: ActorContext,
    thread: ThreadState,
    goal: ThreadGoal,
    replacedRun: RunState | null,
    occurredAt: string,
  ): Promise<NonNullable<CommitThreadGoalMutationInput["continuation"]>> {
    const historyHead = await this.#loadHistoryHead(actor, thread.threadId);
    const runId = this.#nextId("run");
    const resolvedRoute =
      replacedRun === null
        ? await this.#resolveRoute(actor, thread.threadId)
        : {
            authorityId: replacedRun.authorityId,
            runtimeGeneration: replacedRun.runtimeGeneration,
            agentVersionId: replacedRun.agentVersionId,
            policySnapshotId: replacedRun.policySnapshotId,
            workspaceBindingId: replacedRun.workspaceBindingId,
          };
    const event: Extract<RunLifecycleEvent, { type: "run.created" }> = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId },
      eventId: this.#nextId("runEvent"),
      sequence: 1,
      occurredAt,
      type: "run.created",
      data: {
        threadId: thread.threadId,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        createdByActorId: actor.actorId,
        ...resolvedRoute,
        collaborationMode: "default",
        goalBinding: goalBinding(goal, this.#digester),
      },
    };
    const prompt = threadGoalContinuationPrompt(goal);
    return {
      history: {
        expectedLastSequence: historyHead.lastSequence,
        items: [
          {
            schemaVersion: "crewon.model-history-item.v0",
            itemId: this.#nextId("modelHistoryItem"),
            tenantId: actor.tenantId,
            threadId: thread.threadId,
            sequence: historyHead.lastSequence + 1,
            runId,
            segmentId: null,
            createdAt: occurredAt,
            type: "message",
            role: "user",
            source: "goal_continuation",
            content: prompt,
            contentDigest: this.#digester.sha256(prompt),
          },
        ],
      },
      events: [event],
      outbox: [this.#outbox(actor.tenantId, event)],
      workItems: [
        {
          workItemId: this.#nextId("workItem"),
          tenantId: actor.tenantId,
          runId,
          kind: "run.execute",
          payload: {
            throughSequence: 1,
            trigger: "goalActivation",
            goalId: goal.goalId,
            goalRevision: goal.revision,
          },
          createdAt: occurredAt,
        },
      ],
    };
  }

  #queuedRunCancellation(
    actor: ActorContext,
    run: RunState,
    occurredAt: string,
  ): NonNullable<CommitThreadGoalMutationInput["queuedRunCancellation"]> {
    const events: readonly RunLifecycleEvent[] = [
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: run.runId },
        eventId: this.#nextId("runEvent"),
        sequence: run.lastSequence + 1,
        occurredAt,
        type: "run.cancel.requested",
        data: { actorId: actor.actorId },
      },
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: run.runId },
        eventId: this.#nextId("runEvent"),
        sequence: run.lastSequence + 2,
        occurredAt,
        type: "run.canceled",
        data: { reasonCode: "goal_mutated" },
      },
    ];
    return {
      events,
      outbox: events.map((event) => this.#outbox(actor.tenantId, event)),
    };
  }

  #outbox(tenantId: string, event: RunLifecycleEvent): OutboxMessage {
    return {
      messageId: this.#nextId("outboxMessage"),
      tenantId,
      runId: event.identity.runId,
      topic: "run.updated",
      payload: {
        eventId: event.eventId,
        eventType: event.type,
        throughSequence: event.sequence,
      },
      createdAt: event.occurredAt,
    };
  }

  async #loadReplay(
    actor: ActorContext,
    threadId: string,
    idempotency: CommitThreadGoalMutationInput["idempotency"],
  ): Promise<CommitThreadGoalMutationResult | null> {
    try {
      return await this.#store.loadThreadGoalMutationReceipt({
        tenantId: actor.tenantId,
        threadId,
        idempotency,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #loadGoal(
    actor: ActorContext,
    threadId: string,
  ): Promise<ThreadGoal | null> {
    try {
      return await this.#store.loadThreadGoal({
        tenantId: actor.tenantId,
        threadId,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #loadActiveRun(
    actor: ActorContext,
    threadId: string,
  ): Promise<import("./thread-goal-store-port.ts").ThreadGoalActiveRun | null> {
    try {
      return await this.#store.loadThreadActiveRun({
        tenantId: actor.tenantId,
        threadId,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #loadHistoryHead(actor: ActorContext, threadId: string) {
    try {
      const head = await this.#store.loadModelHistoryHead({
        tenantId: actor.tenantId,
        threadId,
      });
      if (head === null) {
        throw new ApplicationError("internal", "model_history_missing");
      }
      return head;
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #resolveRoute(
    actor: ActorContext,
    threadId: string,
  ): Promise<RunRoute> {
    try {
      return await this.#routeResolver.resolveRoute({
        actor,
        threadId,
        agentVersionId: null,
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("internal", "goal_route_unavailable", {
        cause: error,
      });
    }
  }

  async #loadThread(
    actor: ActorContext,
    threadId: string,
  ): Promise<ThreadState> {
    try {
      const thread = await this.#store.loadThread({
        tenantId: actor.tenantId,
        threadId,
      });
      if (
        thread === null ||
        thread.spaceId !== actor.spaceId ||
        thread.status === "deleted"
      ) {
        throw new ApplicationError("notFound", "thread_not_found");
      }
      return thread;
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #authorize(
    actor: ActorContext,
    thread: ThreadState,
    action: "thread:goal:read" | "thread:goal:write",
  ): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action,
        resource: {
          kind: "thread",
          tenantId: thread.tenantId,
          spaceId: thread.spaceId,
          threadId: thread.threadId,
        },
      });
      if (decision.outcome !== "allow") {
        throw new ApplicationError("authorization", "authorization_denied");
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }

  #nextId(kind: ApplicationIdKind): string {
    const id = this.#ids.nextId(kind);
    requireNonEmpty(id, `${kind}_id_invalid`);
    return id;
  }

  #now(): string {
    const timestamp = this.#clock.now();
    if (!isRfc3339Utc(timestamp)) {
      throw new ApplicationError("internal", "clock_timestamp_invalid");
    }
    return timestamp;
  }
}

function setGoalMutation(
  actor: ActorContext,
  command: SetThreadGoalCommand,
  current: ThreadGoal | null,
  occurredAt: string,
  nextId: (kind: ApplicationIdKind) => string,
  forceWrite = false,
): TurnStartGoalMutation {
  if (
    current !== null &&
    Date.parse(occurredAt) < Date.parse(current.updatedAt)
  ) {
    throw new ApplicationError("internal", "clock_timestamp_invalid");
  }
  const objective =
    command.objective === null ? null : command.objective.trim();
  if (current === null && objective === null) {
    throw new ApplicationError("validation", "goal_objective_required");
  }
  const tokenBudget =
    command.tokenBudget.kind === "set"
      ? command.tokenBudget.value
      : current === null
        ? DEFAULT_THREAD_GOAL_TOKEN_BUDGET
        : current.tokenBudget;
  const requestedStatus = command.status ?? current?.status ?? "active";
  const status = externalGoalStatus(current, requestedStatus, tokenBudget);
  const next: ThreadGoal = {
    schemaVersion: "crewon.thread-goal.v0",
    tenantId: actor.tenantId,
    threadId: command.threadId,
    goalId: current?.goalId ?? nextId("goal"),
    revision: (current?.revision ?? 0) + 1,
    objective: objective ?? current!.objective,
    status,
    tokenBudget,
    tokensUsed: current?.tokensUsed ?? 0,
    timeUsedSeconds: current?.timeUsedSeconds ?? 0,
    createdAt: current?.createdAt ?? occurredAt,
    updatedAt: occurredAt,
  };
  try {
    validateThreadGoal(next);
  } catch (error) {
    throw error instanceof ThreadGoalError
      ? new ApplicationError("validation", error.code, { cause: error })
      : error;
  }
  if (
    !forceWrite &&
    current !== null &&
    current.objective === next.objective &&
    current.status === next.status &&
    current.tokenBudget === next.tokenBudget
  ) {
    return { kind: "keep", expectedRevision: current.revision };
  }
  return {
    kind: "set",
    expectedRevision: current?.revision ?? null,
    goal: next,
  };
}

function sameGoalState(
  left: ThreadGoal | null,
  right: ThreadGoal | null,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function externalGoalStatus(
  current: ThreadGoal | null,
  requested: ThreadGoalStatus,
  tokenBudget: number | null,
): ThreadGoalStatus {
  if (
    current?.status === "budgetLimited" &&
    (requested === "paused" || requested === "blocked")
  ) {
    return "budgetLimited";
  }
  if (
    requested === "active" &&
    tokenBudget !== null &&
    (current?.tokensUsed ?? 0) >= tokenBudget
  ) {
    return "budgetLimited";
  }
  return requested;
}

function shouldCancelQueuedRun(
  run: RunState | null,
  goal: ThreadGoal | null,
  digester: ContentDigester,
  trigger: "default" | "goalContinuation" | "goalActivation",
): boolean {
  if (
    run === null ||
    run.status !== "queued" ||
    run.collaborationMode !== "default" ||
    trigger === "default"
  ) {
    return false;
  }
  if (goal?.status !== "active") return run.goalBinding !== null;
  return (
    canonicalJson(run.goalBinding) !==
    canonicalJson(goalBinding(goal, digester))
  );
}

function goalBinding(
  goal: ThreadGoal,
  digester: ContentDigester,
): RunGoalBinding {
  return {
    goalId: goal.goalId,
    revision: goal.revision,
    objectiveDigest: digester.sha256(goal.objective),
  };
}

function idempotencyDescriptor(
  actor: ActorContext,
  command: GoalCommand,
): CommitThreadGoalMutationInput["idempotency"] {
  const { idempotencyKey: _key, ...semantic } = command;
  return {
    scope: canonicalJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      namespace: "thread-goal-command",
    }),
    key: command.idempotencyKey,
    requestFingerprint: canonicalJson({
      schemaVersion: "crewon.thread-goal-command-fingerprint.v0",
      actor: {
        actorId: actor.actorId,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
      },
      command: semantic,
    }),
  };
}

function validateExpectedGoalRevision(
  expected: number | null,
  current: ThreadGoal | null,
): void {
  if (expected !== (current?.revision ?? null)) {
    throw new ApplicationError("conflict", "goal_revision_conflict");
  }
}

function validateSetCommand(command: SetThreadGoalCommand): void {
  if (!isPlainObject(command) || command.kind !== "thread.goal.set") {
    throw new ApplicationError("validation", "goal_command_invalid");
  }
  validateGoalCommandBase(command);
  if (command.objective !== null) {
    requireNonEmpty(command.objective, "goal_objective_invalid");
  }
  if (
    command.status !== null &&
    !THREAD_GOAL_STATUSES.includes(command.status)
  ) {
    throw new ApplicationError("validation", "goal_status_invalid");
  }
  if (
    !isPlainObject(command.tokenBudget) ||
    (command.tokenBudget.kind !== "keep" && command.tokenBudget.kind !== "set")
  ) {
    throw new ApplicationError("validation", "goal_token_budget_invalid");
  }
  if (
    command.tokenBudget.kind === "set" &&
    command.tokenBudget.value !== null &&
    (!Number.isSafeInteger(command.tokenBudget.value) ||
      command.tokenBudget.value < 1)
  ) {
    throw new ApplicationError("validation", "goal_token_budget_invalid");
  }
}

function validateClearCommand(command: ClearThreadGoalCommand): void {
  if (!isPlainObject(command) || command.kind !== "thread.goal.clear") {
    throw new ApplicationError("validation", "goal_command_invalid");
  }
  validateGoalCommandBase(command);
}

function validateGoalCommandBase(command: {
  threadId: unknown;
  idempotencyKey: unknown;
  expectedRevision: unknown;
}): void {
  requireNonEmpty(command.threadId, "thread_id_invalid");
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  if (
    command.expectedRevision !== null &&
    (!Number.isSafeInteger(command.expectedRevision) ||
      Number(command.expectedRevision) < 1)
  ) {
    throw new ApplicationError("validation", "expected_revision_invalid");
  }
}

function validateActor(actor: ActorContext): void {
  if (!isPlainObject(actor)) {
    throw new ApplicationError("validation", "actor_context_invalid");
  }
  requireNonEmpty(actor.principalId, "principal_id_invalid");
  requireNonEmpty(actor.actorId, "actor_id_invalid");
  requireNonEmpty(actor.tenantId, "tenant_id_invalid");
  requireNonEmpty(actor.spaceId, "space_id_invalid");
}

function requireNonEmpty(
  value: unknown,
  code: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApplicationError("validation", code);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRfc3339Utc(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function mapStoreError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof RunStoreError) {
    if (
      error.code === "idempotency_conflict" ||
      error.code === "goal_revision_conflict" ||
      error.code === "goal_active_run_conflict"
    ) {
      return new ApplicationError("conflict", error.code, { cause: error });
    }
    if (error.code === "thread_not_found") {
      return new ApplicationError("notFound", error.code, { cause: error });
    }
    if (error.code.endsWith("_invalid")) {
      return new ApplicationError("validation", error.code, { cause: error });
    }
    return new ApplicationError("internal", "store_unavailable", {
      cause: error,
    });
  }
  return new ApplicationError("internal", "goal_internal", {
    cause: error,
  });
}

function mapGoalAccountingError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof RunGoalAccountingError) {
    const category = error.code.endsWith("_mismatch") ? "conflict" : "internal";
    return new ApplicationError(category, error.code, { cause: error });
  }
  return new ApplicationError("internal", "goal_accounting_failed", {
    cause: error,
  });
}
