import {
  RunLifecycleError,
  type RunLifecycleEvent,
  type ThreadState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ApplicationIdKind,
} from "./application-runtime-ports.ts";
import type {
  ActorContext,
  AuthorizationPort,
  AuthorizationResource,
} from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { ModelHistoryStore } from "./model-history-store-port.ts";
import type {
  CommitRunInput,
  CommitRunResult,
  OutboxMessage,
  RunReceiptStore,
  RunStore,
  WorkItem,
} from "./run-store-port.ts";
import type {
  StartThreadCompactionCommand,
  StartThreadCompactionRequestCommand,
} from "./thread-compaction-commands.ts";
import type { ThreadGoalStore } from "./thread-goal-store-port.ts";
import type { ThreadStore } from "./thread-store-port.ts";

type ThreadCompactionStore = RunStore &
  RunReceiptStore &
  ThreadStore &
  ThreadGoalStore &
  ModelHistoryStore;

/** Admits durable, Goal-neutral manual context compaction maintenance Runs. */
export class ThreadCompactionApplicationService {
  readonly #store: ThreadCompactionStore;
  readonly #authorization: AuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #ids: ApplicationIdGenerator;

  constructor(dependencies: {
    store: ThreadCompactionStore;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
  }

  async replay(
    actor: ActorContext,
    command: StartThreadCompactionRequestCommand,
  ): Promise<CommitRunResult | null> {
    validateActor(actor);
    validateRequest(command);
    await this.#loadAuthorizedThread(actor, command.threadId);
    try {
      const result = await this.#store.loadRunReceipt({
        tenantId: actor.tenantId,
        threadId: command.threadId,
        idempotency: idempotencyDescriptor(actor, command),
      });
      if (result !== null) validateResult(actor, command, result);
      return result;
    } catch (error) {
      throw mapError(error);
    }
  }

  async start(
    actor: ActorContext,
    command: StartThreadCompactionCommand,
  ): Promise<CommitRunResult> {
    validateActor(actor);
    validateRequest(command);
    validateRoute(command);
    const thread = await this.#loadAuthorizedThread(actor, command.threadId);
    const historyHead = await this.#loadHistoryHead(actor, thread.threadId);
    if (historyHead.lastSequence < 1) {
      throw new ApplicationError(
        "conflict",
        "context_compaction_not_applicable",
      );
    }
    const goal = await this.#loadGoal(actor, thread.threadId);
    if (goal?.status === "active") {
      throw new ApplicationError("conflict", "context_compaction_goal_active");
    }
    const occurredAt = this.#now();
    const runId = this.#nextId("run");
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
        authorityId: command.route.authorityId,
        runtimeGeneration: command.route.runtimeGeneration,
        agentVersionId: command.route.agentVersionId,
        policySnapshotId: command.route.policySnapshotId,
        workspaceBindingId: command.route.workspaceBindingId,
        collaborationMode: "default",
        goalBinding: null,
        purpose: "manualCompaction",
      },
    };
    const input: CommitRunInput = {
      tenantId: actor.tenantId,
      idempotency: idempotencyDescriptor(actor, command),
      expectedRevision: 0,
      events: [event],
      outbox: [this.#outbox(actor.tenantId, event)],
      workItems: [
        this.#workItem(actor.tenantId, event, historyHead.lastSequence),
      ],
      threadAdmission: {
        kind: "manualCompaction",
        threadId: thread.threadId,
        expectedThreadRevision: command.expectedThreadRevision,
        expectedHistorySequence: historyHead.lastSequence,
        expectedGoalRevision: goal?.revision ?? null,
      },
    };
    try {
      const result = await this.#store.commitRun(input);
      validateResult(actor, command, result);
      return result;
    } catch (error) {
      throw mapError(error);
    }
  }

  async #loadAuthorizedThread(
    actor: ActorContext,
    threadId: string,
  ): Promise<ThreadState> {
    let thread;
    try {
      thread = await this.#store.loadThreadInSpace({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId,
      });
    } catch (error) {
      throw mapError(error);
    }
    if (
      thread === null ||
      thread.spaceId !== actor.spaceId ||
      thread.status === "deleted"
    ) {
      throw new ApplicationError("notFound", "thread_not_found");
    }
    if (thread.status !== "active") {
      throw new ApplicationError("conflict", "thread_not_active");
    }
    await this.#authorize(actor, "thread:compact", {
      kind: "thread",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId,
    });
    await this.#authorize(actor, "run:create", {
      kind: "run",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId,
      runId: null,
    });
    return thread;
  }

  async #loadHistoryHead(actor: ActorContext, threadId: string) {
    try {
      const head = await this.#store.loadModelHistoryHead({
        tenantId: actor.tenantId,
        threadId,
      });
      if (head === null) {
        throw new ApplicationError("notFound", "thread_not_found");
      }
      return head;
    } catch (error) {
      throw mapError(error);
    }
  }

  async #loadGoal(actor: ActorContext, threadId: string) {
    try {
      return await this.#store.loadThreadGoal({
        tenantId: actor.tenantId,
        threadId,
      });
    } catch (error) {
      throw mapError(error);
    }
  }

  async #authorize(
    actor: ActorContext,
    action: "thread:compact" | "run:create",
    resource: AuthorizationResource,
  ): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action,
        resource,
      });
      if (decision.outcome === "allow") return;
      throw new ApplicationError("authorization", "authorization_denied");
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
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

  #workItem(
    tenantId: string,
    event: Extract<RunLifecycleEvent, { type: "run.created" }>,
    expectedHistorySequence: number,
  ): WorkItem {
    return {
      workItemId: this.#nextId("workItem"),
      tenantId,
      runId: event.identity.runId,
      kind: "run.execute",
      payload: {
        schemaVersion: "crewon.manual-compaction-work-item.v0",
        trigger: "manualCompaction",
        throughSequence: event.sequence,
        expectedHistorySequence,
      },
      createdAt: event.occurredAt,
    };
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

function idempotencyDescriptor(
  actor: ActorContext,
  command: StartThreadCompactionRequestCommand,
) {
  return {
    scope: canonicalJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      namespace: "thread-compaction-command",
    }),
    key: command.idempotencyKey,
    requestFingerprint: canonicalJson({
      schemaVersion: "crewon.thread-compaction-command-fingerprint.v0",
      actor,
      command: {
        kind: command.kind,
        threadId: command.threadId,
        expectedThreadRevision: command.expectedThreadRevision,
        requestedAgentVersionId: command.requestedAgentVersionId,
      },
    }),
  };
}

function validateResult(
  actor: ActorContext,
  command: StartThreadCompactionRequestCommand,
  result: CommitRunResult,
): void {
  const created = result.events[0];
  const workItem = result.workItems[0];
  if (
    result.events.length !== 1 ||
    created?.type !== "run.created" ||
    result.state.tenantId !== actor.tenantId ||
    result.state.spaceId !== actor.spaceId ||
    result.state.threadId !== command.threadId ||
    result.state.purpose !== "manualCompaction" ||
    result.state.goalBinding !== null ||
    result.state.status !== "queued" ||
    result.outbox.length !== 1 ||
    result.workItems.length !== 1 ||
    workItem?.runId !== result.state.runId ||
    workItem.payload.schemaVersion !==
      "crewon.manual-compaction-work-item.v0" ||
    workItem.payload.trigger !== "manualCompaction"
  ) {
    throw new ApplicationError("internal", "thread_compaction_receipt_invalid");
  }
}

function validateRequest(command: StartThreadCompactionRequestCommand): void {
  if (!isPlainObject(command) || command.kind !== "thread.compact") {
    throw new ApplicationError(
      "validation",
      "thread_compaction_command_invalid",
    );
  }
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  requireNonEmpty(command.threadId, "thread_id_invalid");
  if (
    !Number.isSafeInteger(command.expectedThreadRevision) ||
    command.expectedThreadRevision < 1
  ) {
    throw new ApplicationError("validation", "expected_revision_invalid");
  }
  if (command.requestedAgentVersionId !== null) {
    requireNonEmpty(
      command.requestedAgentVersionId,
      "agent_version_id_invalid",
    );
  }
}

function validateRoute(command: StartThreadCompactionCommand): void {
  requireNonEmpty(command.route.authorityId, "authority_id_invalid");
  requireNonEmpty(
    command.route.runtimeGeneration,
    "runtime_generation_invalid",
  );
  requireNonEmpty(command.route.agentVersionId, "agent_version_id_invalid");
  requireNonEmpty(command.route.policySnapshotId, "policy_snapshot_id_invalid");
  if (command.route.workspaceBindingId !== null) {
    requireNonEmpty(
      command.route.workspaceBindingId,
      "workspace_binding_id_invalid",
    );
  }
  if (
    command.requestedAgentVersionId !== null &&
    command.route.agentVersionId !== command.requestedAgentVersionId
  ) {
    throw new ApplicationError("conflict", "agent_version_route_mismatch");
  }
}

function validateActor(actor: ActorContext): void {
  if (!isPlainObject(actor)) {
    throw new ApplicationError("validation", "actor_invalid");
  }
  requireNonEmpty(actor.principalId, "principal_id_invalid");
  requireNonEmpty(actor.actorId, "actor_id_invalid");
  requireNonEmpty(actor.tenantId, "tenant_id_invalid");
  requireNonEmpty(actor.spaceId, "space_id_invalid");
}

function requireNonEmpty(value: string, code: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApplicationError("validation", code);
  }
}

function isRfc3339Utc(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mapError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof RunLifecycleError) {
    return new ApplicationError("conflict", error.code, { cause: error });
  }
  if (error instanceof Error) {
    if (
      error.message === "idempotency_conflict" ||
      error.message === "revision_conflict" ||
      error.message === "manual_compaction_admission_conflict" ||
      error.message === "thread_active_run_conflict"
    ) {
      return new ApplicationError("conflict", error.message, {
        cause: error,
      });
    }
    if (error.message === "thread_not_found") {
      return new ApplicationError("notFound", error.message, {
        cause: error,
      });
    }
  }
  return new ApplicationError("internal", "thread_compaction_internal", {
    cause: error,
  });
}
