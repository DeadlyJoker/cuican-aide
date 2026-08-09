import type {
  RunLifecycleEvent,
  RunState,
  ToolApprovalState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ApplicationIdKind,
} from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { DomainStore } from "./domain-store-port.ts";
import { RunStoreError, type OutboxMessage } from "./run-store-port.ts";

export type DecideToolApprovalCommand = Readonly<{
  kind: "toolApproval.decide";
  approvalId: string;
  expectedRevision: number;
  idempotencyKey: string;
  decision: "approved" | "rejected";
  comment: string | null;
}>;

export type ToolApprovalMutationResult = Readonly<{
  disposition: "committed" | "replayed";
  approval: ToolApprovalState;
  run: RunState;
}>;

export class ToolApprovalApplicationService {
  readonly #store: DomainStore;
  readonly #authorization: AuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #ids: ApplicationIdGenerator;

  constructor(dependencies: {
    store: DomainStore;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
  }

  async getApproval(
    actor: ActorContext,
    approvalId: string,
  ): Promise<ToolApprovalState> {
    validateActor(actor);
    requireNonEmpty(approvalId, "approval_id_invalid");
    const approval = await this.#loadApproval(actor, approvalId);
    await this.#authorize(actor, "toolApproval:read", approval);
    return approval;
  }

  async decideApproval(
    actor: ActorContext,
    command: DecideToolApprovalCommand,
  ): Promise<ToolApprovalMutationResult> {
    validateActor(actor);
    validateDecisionCommand(command);
    const approval = await this.#loadApproval(actor, command.approvalId);
    await this.#authorize(actor, "toolApproval:decide", approval);
    const run = await this.#loadRun(actor, approval.runId);
    if (run.cancelRequested) {
      throw new ApplicationError("conflict", "approval_cancel_pending");
    }
    if (approval.status !== "required") {
      if (
        approval.decision?.outcome === command.decision &&
        approval.decision.actorId === actor.actorId &&
        approval.decision.comment === command.comment
      ) {
        return { disposition: "replayed", approval, run };
      }
      throw new ApplicationError("conflict", "approval_already_terminal");
    }
    if (
      run.status !== "waitingApproval" ||
      run.waitingApproval?.approvalId !== approval.approvalId ||
      run.waitingApproval.actionDigest !== approval.actionDigest
    ) {
      throw new ApplicationError("conflict", "approval_not_current");
    }
    const decidedAt = this.#now();
    const event: RunLifecycleEvent = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: run.runId },
      eventId: this.#nextId("runEvent"),
      sequence: run.lastSequence + 1,
      occurredAt: decidedAt,
      type: "run.resumed",
      data: { reasonCode: `tool_approval_${command.decision}` },
    };
    try {
      const result = await this.#store.decideToolApproval({
        tenantId: actor.tenantId,
        approvalId: approval.approvalId,
        expectedRevision: command.expectedRevision,
        decision: {
          outcome: command.decision,
          actorId: actor.actorId,
          comment: command.comment,
          decidedAt,
        },
        commit: {
          tenantId: actor.tenantId,
          idempotency: {
            scope: canonicalJson({
              schemaVersion: "crewon.idempotency-scope.v0",
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              namespace: "tool-approval-command",
            }),
            key: command.idempotencyKey,
            requestFingerprint: canonicalJson({
              schemaVersion: "crewon.tool-approval-command.v0",
              actor: {
                actorId: actor.actorId,
                tenantId: actor.tenantId,
                spaceId: actor.spaceId,
              },
              command: {
                approvalId: command.approvalId,
                expectedRevision: command.expectedRevision,
                decision: command.decision,
                comment: command.comment,
              },
            }),
          },
          expectedRevision: run.revision,
          events: [event],
          outbox: [this.#outbox(actor.tenantId, event)],
          workItems: [],
        },
      });
      return {
        disposition: result.run.disposition,
        approval: result.approval,
        run: result.run.state,
      };
    } catch (error) {
      throw mapApprovalApplicationError(error);
    }
  }

  async #loadApproval(
    actor: ActorContext,
    approvalId: string,
  ): Promise<ToolApprovalState> {
    try {
      const approval = await this.#store.loadToolApproval({
        tenantId: actor.tenantId,
        approvalId,
      });
      if (approval === null || approval.spaceId !== actor.spaceId) {
        throw new ApplicationError("notFound", "tool_approval_not_found");
      }
      return approval;
    } catch (error) {
      throw mapApprovalApplicationError(error);
    }
  }

  async #loadRun(actor: ActorContext, runId: string): Promise<RunState> {
    try {
      const run = await this.#store.loadRun({
        tenantId: actor.tenantId,
        runId,
      });
      if (run === null || run.spaceId !== actor.spaceId) {
        throw new ApplicationError("notFound", "run_not_found");
      }
      return run;
    } catch (error) {
      throw mapApprovalApplicationError(error);
    }
  }

  async #authorize(
    actor: ActorContext,
    action: "toolApproval:read" | "toolApproval:decide",
    approval: ToolApprovalState,
  ): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action,
        resource: {
          kind: "toolApproval",
          tenantId: approval.tenantId,
          spaceId: approval.spaceId,
          runId: approval.runId,
          approvalId: approval.approvalId,
        },
      });
      if (decision.outcome !== "allow") {
        throw new ApplicationError("authorization", "authorization_denied");
      }
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
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

  #nextId(kind: ApplicationIdKind): string {
    return requireNonEmpty(this.#ids.nextId(kind), `${kind}_id_invalid`);
  }

  #now(): string {
    const value = this.#clock.now();
    if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
      throw new ApplicationError("internal", "clock_timestamp_invalid");
    }
    return value;
  }
}

function validateActor(actor: ActorContext): void {
  for (const [value, code] of [
    [actor.principalId, "principal_id_invalid"],
    [actor.actorId, "actor_id_invalid"],
    [actor.tenantId, "tenant_id_invalid"],
    [actor.spaceId, "space_id_invalid"],
  ] as const) {
    requireNonEmpty(value, code);
  }
}

function validateDecisionCommand(command: DecideToolApprovalCommand): void {
  if (command.kind !== "toolApproval.decide") {
    throw new ApplicationError("validation", "approval_command_invalid");
  }
  requireNonEmpty(command.approvalId, "approval_id_invalid");
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1
  ) {
    throw new ApplicationError("validation", "expected_revision_invalid");
  }
  if (command.decision !== "approved" && command.decision !== "rejected") {
    throw new ApplicationError("validation", "approval_decision_invalid");
  }
  if (
    command.comment !== null &&
    (command.comment.trim().length === 0 ||
      new TextEncoder().encode(command.comment).length > 2_048)
  ) {
    throw new ApplicationError("validation", "approval_comment_invalid");
  }
}

function requireNonEmpty(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApplicationError("validation", code);
  }
  return value;
}

function mapApprovalApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }
  if (error instanceof RunStoreError) {
    if (
      error.code.includes("conflict") ||
      error.code === "approval_already_terminal" ||
      error.code === "approval_expired"
    ) {
      return new ApplicationError("conflict", error.code, { cause: error });
    }
    if (error.code === "tool_approval_not_found") {
      return new ApplicationError("notFound", error.code, { cause: error });
    }
    if (error.code.endsWith("_invalid") || error.code.endsWith("_too_large")) {
      return new ApplicationError("validation", error.code, { cause: error });
    }
    return new ApplicationError("internal", "store_unavailable", {
      cause: error,
    });
  }
  return new ApplicationError("internal", "application_internal", {
    cause: error,
  });
}
