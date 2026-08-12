import type { JsonValue } from "@crewon/contracts";
import {
  WorkflowVersionError,
  parseCompiledWorkflowVersion,
  validateWorkflowSchemaValue,
  type RunLifecycleEvent,
  type WorkflowContentDigester,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ApplicationIdKind,
} from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type {
  CommitRunInput,
  IdempotencyDescriptor,
} from "./run-store-port.ts";
import { RunStoreError } from "./run-store-port.ts";
import type {
  CommitWorkflowRunStartResult,
  WorkflowRunAdmissionAuthority,
  WorkflowRunAdmissionStore,
} from "./workflow-run-admission-store-port.ts";

export const MAX_WORKFLOW_INPUT_BYTES = 32_768;
export const MAX_WORKFLOW_INPUT_DEPTH = 8;
export const MAX_WORKFLOW_INPUT_NODES = 1_024;
export const MAX_WORKFLOW_INPUT_COLLECTION_ITEMS = 256;
export const MAX_WORKFLOW_INPUT_STRING_BYTES = 8_192;

export type StartWorkflowRunCommand = Readonly<{
  kind: "workflowRun.start";
  idempotencyKey: string;
  workflowVersionId: string;
  threadId: string;
  input: JsonValue;
}>;

export class WorkflowRunApplicationService {
  readonly #store: WorkflowRunAdmissionStore;
  readonly #authorization: AuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #ids: ApplicationIdGenerator;
  readonly #workflowDigester: WorkflowContentDigester;

  constructor(dependencies: {
    store: WorkflowRunAdmissionStore;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
    workflowDigester: WorkflowContentDigester;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#workflowDigester = dependencies.workflowDigester;
  }

  async startWorkflowRun(
    actor: ActorContext,
    command: StartWorkflowRunCommand,
  ): Promise<CommitWorkflowRunStartResult> {
    validateActor(actor);
    validateCommand(command);
    const workflowInput = validateWorkflowInput(command.input);
    await this.#authorize(actor, command.threadId);
    const idempotency = idempotencyDescriptor(actor, command, workflowInput);
    try {
      return await this.#store.commitWorkflowRunStart({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: command.threadId,
        workflowVersionId: command.workflowVersionId,
        workflowInput,
        idempotency,
        prepare: (authority) =>
          this.#prepare(actor, command, workflowInput, idempotency, authority),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  #prepare(
    actor: ActorContext,
    command: StartWorkflowRunCommand,
    workflowInput: JsonValue,
    idempotency: IdempotencyDescriptor,
    authority: WorkflowRunAdmissionAuthority,
  ): CommitRunInput {
    let workflow;
    try {
      workflow = parseCompiledWorkflowVersion(
        authority.workflowVersion.definitionJson,
        this.#workflowDigester,
      );
    } catch (error) {
      if (error instanceof WorkflowVersionError) {
        throw new ApplicationError("internal", "workflow_version_corrupt", {
          cause: error,
        });
      }
      throw error;
    }
    if (
      authority.workflowVersion.tenantId !== actor.tenantId ||
      authority.workflowVersion.workflowVersionId !==
        command.workflowVersionId ||
      authority.workflowVersion.workflowId !== workflow.workflowId ||
      authority.workflowVersion.workflowVersionId !==
        workflow.workflowVersionId ||
      authority.workflowVersion.contentDigest !== workflow.contentDigest
    ) {
      throw new ApplicationError("internal", "workflow_run_authority_invalid");
    }
    let validatedWorkflowInput: JsonValue;
    try {
      validatedWorkflowInput = validateWorkflowSchemaValue(
        workflowInput,
        workflow.inputSchema,
      ) as JsonValue;
    } catch (error) {
      if (
        error instanceof WorkflowVersionError &&
        error.code === "workflow_value_schema_mismatch"
      ) {
        throw new ApplicationError(
          "validation",
          "workflow_input_schema_mismatch",
          { cause: error },
        );
      }
      throw error;
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
        threadId: command.threadId,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        createdByActorId: actor.actorId,
        ...authority.route,
        purpose: "workflow",
        workflowVersionBinding: {
          workflowId: authority.workflowVersion.workflowId,
          workflowVersionId: authority.workflowVersion.workflowVersionId,
          contentDigest: authority.workflowVersion.contentDigest,
        },
        collaborationMode: "default",
        goalBinding: null,
      },
    };
    return {
      tenantId: actor.tenantId,
      idempotency,
      expectedRevision: 0,
      events: [event],
      outbox: [
        {
          messageId: this.#nextId("outboxMessage"),
          tenantId: actor.tenantId,
          runId,
          topic: "run.updated",
          payload: {
            eventId: event.eventId,
            eventType: event.type,
            throughSequence: 1,
          },
          createdAt: occurredAt,
        },
      ],
      workItems: [
        {
          workItemId: this.#nextId("workItem"),
          tenantId: actor.tenantId,
          runId,
          kind: "run.execute",
          payload: {
            throughSequence: 1,
            workflowInput: validatedWorkflowInput,
          },
          createdAt: occurredAt,
        },
      ],
    };
  }

  async #authorize(actor: ActorContext, threadId: string): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action: "run:create",
        resource: {
          kind: "run",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId,
          runId: null,
        },
      });
      if (decision.outcome !== "allow")
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
    if (typeof id !== "string" || id.length === 0)
      throw new ApplicationError("internal", `${kind}_id_invalid`);
    return id;
  }

  #now(): string {
    const value = this.#clock.now();
    if (Number.isNaN(Date.parse(value)))
      throw new ApplicationError("internal", "clock_timestamp_invalid");
    return value;
  }
}

function validateWorkflowInput(input: JsonValue): JsonValue {
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_WORKFLOW_INPUT_NODES || depth > MAX_WORKFLOW_INPUT_DEPTH)
      invalidInput();
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (
        new TextEncoder().encode(value).byteLength <=
        MAX_WORKFLOW_INPUT_STRING_BYTES
      )
        return;
      invalidInput();
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) return;
      invalidInput();
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_WORKFLOW_INPUT_COLLECTION_ITEMS) invalidInput();
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      const items = Object.values(value);
      if (items.length > MAX_WORKFLOW_INPUT_COLLECTION_ITEMS) invalidInput();
      for (const item of items) visit(item, depth + 1);
      return;
    }
    invalidInput();
  };
  visit(input, 0);
  let serialized: string;
  try {
    serialized = canonicalJson(input);
  } catch {
    invalidInput();
  }
  if (
    new TextEncoder().encode(serialized).byteLength > MAX_WORKFLOW_INPUT_BYTES
  )
    invalidInput();
  return structuredClone(input);
}

function invalidInput(): never {
  throw new ApplicationError("validation", "workflow_input_invalid");
}

function validateActor(actor: ActorContext): void {
  if (!actor || typeof actor !== "object")
    throw new ApplicationError("validation", "actor_context_invalid");
  for (const value of [
    actor.principalId,
    actor.actorId,
    actor.tenantId,
    actor.spaceId,
  ])
    if (typeof value !== "string" || value.length === 0)
      throw new ApplicationError("validation", "actor_context_invalid");
}

function validateCommand(command: StartWorkflowRunCommand): void {
  if (
    !command ||
    typeof command !== "object" ||
    command.kind !== "workflowRun.start"
  )
    throw new ApplicationError("validation", "workflow_run_command_invalid");
  for (const value of [
    command.idempotencyKey,
    command.workflowVersionId,
    command.threadId,
  ])
    if (typeof value !== "string" || value.length === 0 || value.length > 512)
      throw new ApplicationError("validation", "workflow_run_command_invalid");
}

function idempotencyDescriptor(
  actor: ActorContext,
  command: StartWorkflowRunCommand,
  input: JsonValue,
): IdempotencyDescriptor {
  return {
    scope: canonicalJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      namespace: "workflow-run-start",
      tenantId: actor.tenantId,
      actorId: actor.actorId,
    }),
    key: command.idempotencyKey,
    requestFingerprint: canonicalJson({
      schemaVersion: "crewon.workflow-run-start-fingerprint.v0",
      actor: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        actorId: actor.actorId,
      },
      command: {
        workflowVersionId: command.workflowVersionId,
        threadId: command.threadId,
        input,
      },
    }),
  };
}

function mapStoreError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof RunStoreError) {
    if (error.code === "idempotency_conflict")
      return new ApplicationError("conflict", error.code);
    if (["thread_not_found", "workflow_version_not_found"].includes(error.code))
      return new ApplicationError("notFound", error.code);
  }
  return new ApplicationError("internal", "workflow_run_admission_failed", {
    cause: error,
  });
}
