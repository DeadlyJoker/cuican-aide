import {
  RunLifecycleError,
  type RunLifecycleEvent,
  type RunState,
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
  RunAuthorizationAction,
  RunAuthorizationResource,
} from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { CreateRunCommand, RunTransitionCommand } from "./run-commands.ts";
import {
  RunStoreError,
  type CommitRunResult,
  type IdempotencyDescriptor,
  type OutboxMessage,
  type RunLocator,
  type RunStore,
  type ThreadRunListCursor,
  type WorkItem,
} from "./run-store-port.ts";

export class RunApplicationService {
  readonly #store: RunStore;
  readonly #authorization: AuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #ids: ApplicationIdGenerator;

  constructor(dependencies: {
    store: RunStore;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
  }

  async createRun(
    actor: ActorContext,
    command: CreateRunCommand,
  ): Promise<CommitRunResult> {
    validateActor(actor);
    validateCreateCommand(command);
    const resource: RunAuthorizationResource = {
      kind: "run",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: command.threadId,
      runId: null,
    };
    await this.#authorize(actor, "run:create", resource);

    const runId = this.#nextId("run");
    const occurredAt = this.#now();
    const event: Extract<RunLifecycleEvent, { type: "run.created" }> = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId },
      eventId: this.#nextId("runEvent"),
      sequence: 1,
      occurredAt,
      type: "run.created",
      data: {
        threadId: command.threadId,
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
      },
    };
    const outbox = this.#outbox(actor.tenantId, event, occurredAt);
    const workItem = this.#workItem(actor.tenantId, event, occurredAt);

    return this.#commit({
      tenantId: actor.tenantId,
      idempotency: idempotencyDescriptor(actor, command),
      expectedRevision: 0,
      events: [event],
      outbox: [outbox],
      workItems: [workItem],
    });
  }

  async transitionRun(
    actor: ActorContext,
    command: RunTransitionCommand,
  ): Promise<CommitRunResult> {
    validateActor(actor);
    validateTransitionCommand(command);
    const state = await this.#loadAuthorizedRun(
      actor,
      command.runId,
      transitionAuthorizationAction(command),
    );
    const occurredAt = this.#now();
    const event = createTransitionEvent(
      command,
      state.lastSequence + 1,
      occurredAt,
      this.#nextId("runEvent"),
      actor.actorId,
    );
    const outbox = this.#outbox(actor.tenantId, event, occurredAt);
    const workflowCancel = command.kind === "run.requestCancel" &&
      state.purpose === "workflow" && state.workflowVersionBinding !== undefined
      ? [{ workItemId: this.#nextId("workItem"), tenantId: actor.tenantId,
          runId: state.runId, kind: "run.execute" as const, createdAt: occurredAt,
          payload: { schemaVersion: "crewon.workflow-cancel-work-item.v0",
            trigger: "workflowCancel", binding: state.workflowVersionBinding,
            cancellationOperationId: event.eventId } }]
      : [];

    return this.#commit({
      tenantId: actor.tenantId,
      idempotency: idempotencyDescriptor(actor, command),
      expectedRevision: command.expectedRevision,
      events: [event],
      outbox: [outbox],
      workItems: workflowCancel,
    });
  }

  async getRun(actor: ActorContext, runId: string): Promise<RunState> {
    validateActor(actor);
    requireNonEmpty(runId, "run_id_invalid");
    return this.#loadAuthorizedRun(actor, runId, "run:read");
  }

  async listThreadRuns(
    actor: ActorContext,
    query: {
      threadId: string;
      before: ThreadRunListCursor | null;
      limit: number;
    },
  ): Promise<readonly RunState[]> {
    validateActor(actor);
    requireNonEmpty(query.threadId, "thread_id_invalid");
    validateResourceListQuery(query, "run_cursor_invalid");
    await this.#authorize(actor, "run:read", {
      kind: "run",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: query.threadId,
      runId: null,
    });
    try {
      return await this.#store.listThreadRuns({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: query.threadId,
        before: query.before,
        limit: query.limit,
      });
    } catch (error) {
      throw mapApplicationError(error);
    }
  }

  async listRunEvents(
    actor: ActorContext,
    query: { runId: string; afterSequence: number; limit: number },
  ): Promise<readonly RunLifecycleEvent[]> {
    validateActor(actor);
    if (!isPlainObject(query)) {
      throw new ApplicationError("validation", "run_event_query_invalid");
    }
    requireNonEmpty(query.runId, "run_id_invalid");
    await this.#loadAuthorizedRun(actor, query.runId, "run:read");
    try {
      return await this.#store.listRunEvents(
        locator(actor, query.runId),
        query.afterSequence,
        query.limit,
      );
    } catch (error) {
      throw mapApplicationError(error);
    }
  }

  async #loadAuthorizedRun(
    actor: ActorContext,
    runId: string,
    action: RunAuthorizationAction,
  ): Promise<RunState> {
    let state: RunState | null;
    try {
      state = await this.#store.loadRun(locator(actor, runId));
    } catch (error) {
      throw mapApplicationError(error);
    }
    if (state === null || state.spaceId !== actor.spaceId) {
      throw new ApplicationError("notFound", "run_not_found");
    }
    await this.#authorize(actor, action, {
      kind: "run",
      tenantId: state.tenantId,
      spaceId: state.spaceId,
      threadId: state.threadId,
      runId: state.runId,
    });
    return state;
  }

  async #authorize(
    actor: ActorContext,
    action: RunAuthorizationAction,
    resource: RunAuthorizationResource,
  ): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action,
        resource,
      });
      if (decision.outcome === "allow") {
        return;
      }
      throw new ApplicationError("authorization", "authorization_denied");
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }

  async #commit(
    input: Parameters<RunStore["commitRun"]>[0],
  ): Promise<CommitRunResult> {
    try {
      return await this.#store.commitRun(input);
    } catch (error) {
      throw mapApplicationError(error);
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
  command: CreateRunCommand | RunTransitionCommand,
): IdempotencyDescriptor {
  const { idempotencyKey: _idempotencyKey, ...semanticCommand } = command;
  return {
    scope: canonicalJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      namespace: "run-command",
    }),
    key: command.idempotencyKey,
    requestFingerprint: canonicalJson({
      schemaVersion: "crewon.run-command-fingerprint.v0",
      actor: {
        actorId: actor.actorId,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
      },
      command: semanticCommand,
    }),
  };
}

function locator(actor: ActorContext, runId: string): RunLocator {
  return { tenantId: actor.tenantId, runId };
}

function transitionAuthorizationAction(
  command: RunTransitionCommand,
): RunAuthorizationAction {
  return command.kind === "run.requestCancel" ? "run:cancel" : "run:execute";
}

function createTransitionEvent(
  command: RunTransitionCommand,
  sequence: number,
  occurredAt: string,
  eventId: string,
  actorId: string,
): RunLifecycleEvent {
  const envelope = {
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId: command.runId },
    eventId,
    sequence,
    occurredAt,
  };
  switch (command.kind) {
    case "run.start":
      return { ...envelope, type: "run.started", data: {} };
    case "run.requireApproval":
      return {
        ...envelope,
        type: "run.approval.required",
        data: {
          approvalId: command.approvalId,
          actionDigest: command.actionDigest,
        },
      };
    case "run.resume":
      return {
        ...envelope,
        type: "run.resumed",
        data: { reasonCode: command.reasonCode },
      };
    case "run.suspend":
      return {
        ...envelope,
        type: "run.suspended",
        data: { reasonCode: command.reasonCode },
      };
    case "run.requireReconciliation":
      return {
        ...envelope,
        type: "run.reconciliation.required",
        data: { receiptId: command.receiptId },
      };
    case "run.requestCancel":
      return {
        ...envelope,
        type: "run.cancel.requested",
        data: { actorId },
      };
    case "run.complete":
      return {
        ...envelope,
        type: "run.completed",
        data: { outputRef: command.outputRef },
      };
    case "run.fail":
      return {
        ...envelope,
        type: "run.failed",
        data: { code: command.code, retryable: command.retryable },
      };
    case "run.confirmCanceled":
      return {
        ...envelope,
        type: "run.canceled",
        data: { reasonCode: command.reasonCode },
      };
    default:
      throw new ApplicationError("internal", "run_command_kind_unreachable");
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

function validateCreateCommand(command: CreateRunCommand): void {
  if (!isPlainObject(command) || command.kind !== "run.create") {
    throw new ApplicationError("validation", "run_command_kind_unsupported");
  }
  if (!isPlainObject(command.route)) {
    throw new ApplicationError("validation", "run_route_invalid");
  }
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  requireNonEmpty(command.threadId, "thread_id_invalid");
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
}

function validateTransitionCommand(command: RunTransitionCommand): void {
  if (
    !isPlainObject(command) ||
    typeof command.kind !== "string" ||
    !RUN_TRANSITION_COMMAND_KINDS.includes(
      command.kind as RunTransitionCommand["kind"],
    )
  ) {
    throw new ApplicationError("validation", "run_command_kind_unsupported");
  }
  requireNonEmpty(command.runId, "run_id_invalid");
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1
  ) {
    throw new ApplicationError("validation", "expected_revision_invalid");
  }
  switch (command.kind) {
    case "run.start":
    case "run.requestCancel":
      return;
    case "run.requireApproval":
      requireNonEmpty(command.approvalId, "approval_id_invalid");
      requireNonEmpty(command.actionDigest, "action_digest_invalid");
      return;
    case "run.resume":
    case "run.suspend":
    case "run.confirmCanceled":
      requireNonEmpty(command.reasonCode, "reason_code_invalid");
      return;
    case "run.requireReconciliation":
      requireNonEmpty(command.receiptId, "receipt_id_invalid");
      return;
    case "run.complete":
      if (command.outputRef !== null) {
        requireNonEmpty(command.outputRef, "output_ref_invalid");
      }
      return;
    case "run.fail":
      requireNonEmpty(command.code, "failure_code_invalid");
      return;
    default:
      throw new ApplicationError("validation", "run_command_kind_unsupported");
  }
}

function validateResourceListQuery(
  query: { before: ThreadRunListCursor | null; limit: number },
  cursorCode: string,
): void {
  if (
    !isPlainObject(query) ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100
  ) {
    throw new ApplicationError("validation", "page_limit_invalid");
  }
  if (
    query.before !== null &&
    (!isPlainObject(query.before) ||
      !isRfc3339Utc(query.before.updatedAt) ||
      typeof query.before.runId !== "string" ||
      query.before.runId.trim().length === 0)
  ) {
    throw new ApplicationError("validation", cursorCode);
  }
}

function requireNonEmpty(
  value: unknown,
  code: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApplicationError("validation", code);
  }
}

const RUN_TRANSITION_COMMAND_KINDS: readonly RunTransitionCommand["kind"][] = [
  "run.start",
  "run.requireApproval",
  "run.resume",
  "run.suspend",
  "run.requireReconciliation",
  "run.requestCancel",
  "run.complete",
  "run.fail",
  "run.confirmCanceled",
];

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
  if (error instanceof ApplicationError) {
    return error;
  }
  if (error instanceof RunStoreError) {
    if (
      error.code === "idempotency_conflict" ||
      error.code === "revision_conflict" ||
      error.code === "event_id_conflict" ||
      error.code === "outbox_message_conflict" ||
      error.code === "work_item_conflict" ||
      error.code === "thread_not_active"
    ) {
      return new ApplicationError("conflict", error.code, { cause: error });
    }
    if (error.code === "thread_not_found") {
      return new ApplicationError("notFound", error.code, { cause: error });
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
  if (error instanceof RunLifecycleError) {
    const category =
      error.code.endsWith("_invalid") ||
      error.code === "event_schema_version_unsupported" ||
      error.code === "sequence_invalid"
        ? "validation"
        : "conflict";
    return new ApplicationError(category, error.code, { cause: error });
  }
  return new ApplicationError("internal", "application_internal", {
    cause: error,
  });
}
