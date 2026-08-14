import {
  DEFAULT_THREAD_GOAL_TOKEN_BUDGET,
  MAX_TURN_KNOWLEDGE_REFERENCES,
  MAX_TURN_KNOWLEDGE_TOTAL_BYTES,
  KnowledgeError,
  RunLifecycleError,
  ThreadLifecycleError,
  isGoalRunnable,
  knowledgeContextBinding,
  type KnowledgeRecord,
  type RunGoalBinding,
  type RunLifecycleEvent,
  type ThreadGoal,
  type ThreadLifecycleEvent,
  type ThreadState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ApplicationIdKind,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type {
  ActorContext,
  AuthorizationAction,
  AuthorizationPort,
  AuthorizationResource,
} from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { KnowledgeStore } from "./knowledge-store-port.ts";
import type { ModelHistoryStore } from "./model-history-store-port.ts";
import {
  RunStoreError,
  type OutboxMessage,
  type WorkItem,
} from "./run-store-port.ts";
import type { ThreadStore } from "./thread-store-port.ts";
import type {
  ThreadGoalStore,
  TurnStartGoalMutation,
} from "./thread-goal-store-port.ts";
import type {
  StartTurnCommand,
  StartTurnRequestCommand,
} from "./turn-commands.ts";
import type {
  CommitTurnStartInput,
  CommitTurnStartResult,
  TurnStartStore,
} from "./turn-start-store-port.ts";

const MAX_MESSAGE_BYTES = 32 * 1024;

export class TurnApplicationService {
  readonly #store: ThreadStore &
    ThreadGoalStore &
    ModelHistoryStore &
    TurnStartStore;
  readonly #knowledge: Pick<KnowledgeStore, "loadKnowledge">;
  readonly #authorization: AuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #ids: ApplicationIdGenerator;
  readonly #digester: ContentDigester;

  constructor(dependencies: {
    store: ThreadStore & ThreadGoalStore & ModelHistoryStore & TurnStartStore;
    knowledge: Pick<KnowledgeStore, "loadKnowledge">;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
    digester: ContentDigester;
  }) {
    this.#store = dependencies.store;
    this.#knowledge = dependencies.knowledge;
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#digester = dependencies.digester;
  }

  async startTurn(
    actor: ActorContext,
    command: StartTurnCommand,
  ): Promise<CommitTurnStartResult> {
    validateActor(actor);
    validateRequestCommand(command);
    validateRoute(command);
    const thread = await this.#loadAuthorizedThread(
      actor,
      command.threadId,
      command.executionIntent,
    );
    const historyHead = await this.#loadHistoryHead(actor, thread.threadId);
    const currentGoal = await this.#loadGoal(actor, thread.threadId);
    const knowledge = await this.#loadKnowledge(
      actor,
      command.knowledgeReferences,
    );
    const occurredAt = this.#now();
    const runId = this.#nextId("run");
    const messageId = this.#nextId("message");
    const contentDigest = this.#digest(command.content);
    const goal = this.#prepareGoal(
      actor,
      command,
      currentGoal,
      occurredAt,
      contentDigest,
    );
    const message = {
      messageId,
      tenantId: actor.tenantId,
      threadId: thread.threadId,
      sequence: thread.lastMessageSequence + 1,
      role: "user" as const,
      content: command.content,
      contentDigest,
      createdAt: occurredAt,
      origin: null,
      proposedPlan: null,
    };
    const knowledgeHistoryItems = knowledge.map((record, index) => ({
      schemaVersion: "crewon.model-history-item.v0" as const,
      itemId: this.#nextId("modelHistoryItem"),
      tenantId: actor.tenantId,
      threadId: thread.threadId,
      sequence: historyHead.lastSequence + index + 1,
      runId: null,
      segmentId: null,
      createdAt: occurredAt,
      type: "message" as const,
      role: "user" as const,
      source: "knowledge_context" as const,
      content: record.content,
      contentDigest: record.contentDigest,
      knowledge: knowledgeContextBinding(record),
    }));
    const threadEvent: ThreadLifecycleEvent = {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: thread.threadId },
      eventId: this.#nextId("threadEvent"),
      sequence: thread.lastEventSequence + 1,
      occurredAt,
      type: "thread.message.appended",
      data: {
        messageId,
        messageSequence: message.sequence,
        role: message.role,
        contentDigest,
      },
    };
    const runEvent: Extract<RunLifecycleEvent, { type: "run.created" }> = {
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
        collaborationMode:
          command.executionIntent === "plan" ? "plan" : "default",
        goalBinding: goal.binding,
      },
    };
    const input: CommitTurnStartInput = {
      tenantId: actor.tenantId,
      idempotency: idempotencyDescriptor(actor, command),
      goal: goal.mutation,
      thread: {
        expectedRevision: command.expectedThreadRevision,
        events: [threadEvent],
        messages: [message],
        history: {
          expectedLastSequence: historyHead.lastSequence,
          items: [
            ...knowledgeHistoryItems,
            {
              schemaVersion: "crewon.model-history-item.v0",
              itemId: this.#nextId("modelHistoryItem"),
              tenantId: actor.tenantId,
              threadId: thread.threadId,
              sequence:
                historyHead.lastSequence + knowledgeHistoryItems.length + 1,
              runId: null,
              segmentId: null,
              createdAt: occurredAt,
              type: "message",
              role: "user",
              source: "thread_message",
              content: command.content,
              contentDigest,
            },
          ],
        },
      },
      run: {
        expectedRevision: 0,
        events: [runEvent],
        outbox: [this.#outbox(actor.tenantId, runEvent, occurredAt)],
        workItems: [this.#workItem(actor.tenantId, runEvent, occurredAt)],
      },
    };
    try {
      return await this.#store.commitTurnStart(input);
    } catch (error) {
      throw mapApplicationError(error);
    }
  }

  async replayTurn(
    actor: ActorContext,
    command: StartTurnRequestCommand,
  ): Promise<CommitTurnStartResult | null> {
    validateActor(actor);
    validateRequestCommand(command);
    const thread = await this.#loadAuthorizedThread(
      actor,
      command.threadId,
      command.executionIntent,
    );
    try {
      return await this.#store.loadTurnStartReceipt({
        tenantId: actor.tenantId,
        threadId: thread.threadId,
        idempotency: idempotencyDescriptor(actor, command),
      });
    } catch (error) {
      throw mapApplicationError(error);
    }
  }

  async #loadAuthorizedThread(
    actor: ActorContext,
    threadId: string,
    executionIntent: StartTurnRequestCommand["executionIntent"],
  ): Promise<ThreadState> {
    const thread = await this.#loadThread(actor, threadId);
    await this.#authorize(actor, "thread:message:append", {
      kind: "thread",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: thread.threadId,
    });
    await this.#authorize(actor, "run:create", {
      kind: "run",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: thread.threadId,
      runId: null,
    });
    if (executionIntent === "goal" || executionIntent === "plan") {
      await this.#authorize(actor, "thread:goal:write", {
        kind: "thread",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: thread.threadId,
      });
    }
    return thread;
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
      throw mapApplicationError(error);
    }
  }

  async #loadKnowledge(
    actor: ActorContext,
    references: StartTurnRequestCommand["knowledgeReferences"],
  ): Promise<readonly KnowledgeRecord[]> {
    const records: KnowledgeRecord[] = [];
    let totalBytes = 0;
    for (const reference of references) {
      const { knowledgeId } = reference;
      await this.#authorize(actor, "knowledge:read", {
        kind: "knowledge",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        knowledgeId,
      });
      let record: KnowledgeRecord | null;
      try {
        record = await this.#knowledge.loadKnowledge({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          knowledgeId,
        });
      } catch (error) {
        throw mapApplicationError(error);
      }
      if (record === null) {
        throw new ApplicationError("notFound", "knowledge_not_found");
      }
      if (
        record.tenantId !== actor.tenantId ||
        record.spaceId !== actor.spaceId ||
        record.knowledgeId !== knowledgeId
      ) {
        throw new ApplicationError("internal", "knowledge_authority_mismatch");
      }
      if (record.contentDigest !== reference.contentDigest) {
        throw new ApplicationError("conflict", "knowledge_reference_stale");
      }
      totalBytes += new TextEncoder().encode(record.content).byteLength;
      if (totalBytes > MAX_TURN_KNOWLEDGE_TOTAL_BYTES) {
        throw new ApplicationError(
          "validation",
          "knowledge_context_total_too_large",
        );
      }
      try {
        knowledgeContextBinding(record);
      } catch (error) {
        throw new ApplicationError(
          "validation",
          error instanceof KnowledgeError
            ? error.code
            : "knowledge_context_invalid",
          { cause: error },
        );
      }
      records.push(record);
    }
    return records;
  }

  #prepareGoal(
    actor: ActorContext,
    command: StartTurnCommand,
    current: ThreadGoal | null,
    occurredAt: string,
    contentDigest: string,
  ): Readonly<{
    mutation: TurnStartGoalMutation;
    binding: RunGoalBinding | null;
  }> {
    const expectedRevision = current?.revision ?? null;
    if (command.executionIntent === "plan") {
      return {
        mutation: { kind: "clear", expectedRevision, occurredAt },
        binding: null,
      };
    }
    if (command.executionIntent === "none") {
      return {
        mutation: { kind: "keep", expectedRevision },
        binding:
          current !== null && isGoalRunnable(current.status)
            ? goalBinding(current, this.#digest(current.objective))
            : null,
      };
    }

    const replaceCompleted = current?.status === "complete";
    const next: ThreadGoal = {
      schemaVersion: "crewon.thread-goal.v0",
      tenantId: actor.tenantId,
      threadId: command.threadId,
      goalId:
        current === null || replaceCompleted
          ? this.#nextId("goal")
          : current.goalId,
      revision: current === null ? 1 : current.revision + 1,
      objective: command.content,
      status: "active",
      tokenBudget: replaceCompleted
        ? DEFAULT_THREAD_GOAL_TOKEN_BUDGET
        : (current?.tokenBudget ?? DEFAULT_THREAD_GOAL_TOKEN_BUDGET),
      tokensUsed: replaceCompleted ? 0 : (current?.tokensUsed ?? 0),
      timeUsedSeconds: replaceCompleted ? 0 : (current?.timeUsedSeconds ?? 0),
      createdAt:
        current === null || replaceCompleted ? occurredAt : current.createdAt,
      updatedAt: occurredAt,
    };
    return {
      mutation: { kind: "set", expectedRevision, goal: next },
      binding: goalBinding(next, contentDigest),
    };
  }

  async #loadThread(
    actor: ActorContext,
    threadId: string,
  ): Promise<ThreadState> {
    let state: ThreadState | null;
    try {
      state = await this.#store.loadThread({
        tenantId: actor.tenantId,
        threadId,
      });
    } catch (error) {
      throw mapApplicationError(error);
    }
    if (
      state === null ||
      state.spaceId !== actor.spaceId ||
      state.status === "deleted"
    ) {
      throw new ApplicationError("notFound", "thread_not_found");
    }
    return state;
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
      throw mapApplicationError(error);
    }
  }

  async #authorize(
    actor: ActorContext,
    action: AuthorizationAction,
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

  #digest(content: string): string {
    const digest = this.#digester.sha256(content);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new ApplicationError("internal", "content_digest_invalid");
    }
    return digest;
  }

  #outbox(
    tenantId: string,
    event: RunLifecycleEvent,
    createdAt: string,
  ): OutboxMessage {
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
      createdAt,
    };
  }

  #workItem(
    tenantId: string,
    event: Extract<RunLifecycleEvent, { type: "run.created" }>,
    createdAt: string,
  ): WorkItem {
    return {
      workItemId: this.#nextId("workItem"),
      tenantId,
      runId: event.identity.runId,
      kind: "run.execute",
      payload: { throughSequence: event.sequence },
      createdAt,
    };
  }
}

function idempotencyDescriptor(
  actor: ActorContext,
  command: StartTurnRequestCommand,
) {
  const semanticCommand = {
    kind: command.kind,
    threadId: command.threadId,
    expectedThreadRevision: command.expectedThreadRevision,
    content: command.content,
    knowledgeReferences: command.knowledgeReferences,
    requestedAgentVersionId: command.requestedAgentVersionId,
    executionIntent: command.executionIntent,
  };
  return {
    scope: canonicalJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      namespace: "turn-command",
    }),
    key: command.idempotencyKey,
    requestFingerprint: canonicalJson({
      schemaVersion: "crewon.turn-command-fingerprint.v0",
      actor: {
        actorId: actor.actorId,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
      },
      command: semanticCommand,
    }),
  };
}

function validateRequestCommand(command: StartTurnRequestCommand): void {
  if (!isPlainObject(command) || command.kind !== "turn.start") {
    throw new ApplicationError("validation", "turn_command_kind_unsupported");
  }
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  requireNonEmpty(command.threadId, "thread_id_invalid");
  if (
    !Number.isSafeInteger(command.expectedThreadRevision) ||
    command.expectedThreadRevision < 1
  ) {
    throw new ApplicationError("validation", "expected_revision_invalid");
  }
  requireNonEmpty(command.content, "message_content_invalid");
  if (
    new TextEncoder().encode(command.content).byteLength > MAX_MESSAGE_BYTES
  ) {
    throw new ApplicationError("validation", "message_content_too_large");
  }
  if (
    !Array.isArray(command.knowledgeReferences) ||
    command.knowledgeReferences.length > MAX_TURN_KNOWLEDGE_REFERENCES
  ) {
    throw new ApplicationError("validation", "knowledge_references_invalid");
  }
  const knowledgeIds = new Set<string>();
  for (const reference of command.knowledgeReferences) {
    if (
      !isPlainObject(reference) ||
      Object.keys(reference).sort().join(",") !== "contentDigest,knowledgeId"
    ) {
      throw new ApplicationError("validation", "knowledge_reference_invalid");
    }
    const { knowledgeId, contentDigest } = reference;
    requireNonEmpty(knowledgeId, "knowledge_id_invalid");
    if (
      knowledgeId.length > 128 ||
      knowledgeIds.has(knowledgeId) ||
      typeof contentDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(contentDigest)
    ) {
      throw new ApplicationError("validation", "knowledge_reference_invalid");
    }
    knowledgeIds.add(knowledgeId);
  }
  if (command.requestedAgentVersionId !== null) {
    requireNonEmpty(
      command.requestedAgentVersionId,
      "agent_version_id_invalid",
    );
  }
  if (
    command.executionIntent !== "none" &&
    command.executionIntent !== "goal" &&
    command.executionIntent !== "plan"
  ) {
    throw new ApplicationError("validation", "execution_intent_invalid");
  }
}

function goalBinding(
  goal: ThreadGoal,
  objectiveDigest: string,
): RunGoalBinding {
  return {
    goalId: goal.goalId,
    revision: goal.revision,
    objectiveDigest,
  };
}

function validateRoute(command: StartTurnCommand): void {
  if (!isPlainObject(command.route)) {
    throw new ApplicationError("validation", "run_route_invalid");
  }
  requireNonEmpty(command.route.authorityId, "authority_id_invalid");
  requireNonEmpty(
    command.route.runtimeGeneration,
    "runtime_generation_invalid",
  );
  requireNonEmpty(command.route.agentVersionId, "agent_version_id_invalid");
  if (
    command.requestedAgentVersionId !== null &&
    command.route.agentVersionId !== command.requestedAgentVersionId
  ) {
    throw new ApplicationError(
      "validation",
      "agent_version_selection_mismatch",
    );
  }
  requireNonEmpty(command.route.policySnapshotId, "policy_snapshot_id_invalid");
  if (command.route.workspaceBindingId !== null) {
    requireNonEmpty(
      command.route.workspaceBindingId,
      "workspace_binding_id_invalid",
    );
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

function mapApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof RunStoreError) {
    if (error.code === "thread_not_found" || error.code === "run_not_found") {
      return new ApplicationError("notFound", error.code, { cause: error });
    }
    if (
      error.code.endsWith("_conflict") ||
      error.code === "thread_not_active"
    ) {
      return new ApplicationError("conflict", error.code, { cause: error });
    }
    if (
      error.code.endsWith("_invalid") ||
      error.code.endsWith("_too_large") ||
      error.code === "non_json_value"
    ) {
      return new ApplicationError("validation", error.code, { cause: error });
    }
    return new ApplicationError("internal", "store_unavailable", {
      cause: error,
    });
  }
  if (
    error instanceof RunLifecycleError ||
    error instanceof ThreadLifecycleError
  ) {
    const category = error.code.endsWith("_invalid")
      ? "validation"
      : "conflict";
    return new ApplicationError(category, error.code, { cause: error });
  }
  return new ApplicationError("internal", "application_internal", {
    cause: error,
  });
}
