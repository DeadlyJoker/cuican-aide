import type { JsonValue } from "@crewon/contracts/runtime";
import {
  WorkflowVersionError,
  parseCompiledWorkflowVersion,
  parseOfficeDefinition,
  parseOfficeDelegation,
  validateThreadState,
  validateWorkflowSchemaValue,
  type RunLifecycleEvent,
  type WorkflowContentDigester,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
} from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { WorkflowSchedulerWorkItemPayload } from "./durable-queue-port.ts";
import type {
  CommitOfficeDelegationStartInput,
  OfficeDelegationAdmissionAuthority,
  OfficeDelegationStartResult,
  OfficeDelegationStore,
  StartOfficeDelegationCommand,
} from "./office-delegation-store-port.ts";
import type { RunRoute, RunRouteResolverPort } from "./run-commands.ts";
import type {
  CommitRunInput,
  IdempotencyDescriptor,
} from "./run-store-port.ts";
import { validateWorkflowRunInput } from "./workflow-run-application-service.ts";
import { hasExactKeys } from "./workspace-operation-validation-common.ts";

export class OfficeDelegationApplicationService {
  readonly #store: OfficeDelegationStore;
  readonly #authorization: AuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #ids: ApplicationIdGenerator;
  readonly #digester: WorkflowContentDigester;
  readonly #routeResolver: RunRouteResolverPort;

  constructor(dependencies: {
    store: OfficeDelegationStore;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
    digester: WorkflowContentDigester;
    routeResolver: RunRouteResolverPort;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#digester = dependencies.digester;
    this.#routeResolver = dependencies.routeResolver;
  }

  async start(
    actor: ActorContext,
    command: StartOfficeDelegationCommand,
  ): Promise<OfficeDelegationStartResult> {
    validateActor(actor);
    validateStart(command);
    const workflowInput = validateWorkflowRunInput(command.input);
    await authorize(this.#authorization, {
      actor,
      action: "office:run",
      resource: {
        kind: "office",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        officeId: null,
        officeVersionId: command.officeVersionId,
      },
    });
    await authorize(this.#authorization, {
      actor,
      action: "run:create",
      resource: {
        kind: "run",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: command.threadId,
        runId: null,
      },
    });
    const idempotency = startIdempotency(actor, command, workflowInput);
    return this.#store.commitOfficeDelegationStart({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      officeVersionId: command.officeVersionId,
      workflowVersionId: command.workflowVersionId,
      threadId: command.threadId,
      workflowInput,
      idempotency,
      resolveCandidateRoute: () =>
        this.#routeResolver.resolveRoute({
          actor,
          threadId: command.threadId,
          agentVersionId: null,
        }),
      prepare: (authority) =>
        this.#prepare(actor, command, workflowInput, idempotency, authority),
    });
  }

  #prepare(
    actor: ActorContext,
    command: StartOfficeDelegationCommand,
    workflowInput: JsonValue,
    idempotency: IdempotencyDescriptor,
    authority: OfficeDelegationAdmissionAuthority,
  ) {
    const office = parseOfficeDefinition(authority.office);
    if (
      office.tenantId !== actor.tenantId ||
      office.spaceId !== actor.spaceId ||
      office.officeVersionId !== command.officeVersionId
    )
      invalidAuthority();
    const workflow = parseCompiledWorkflowVersion(
      authority.workflowVersion.definitionJson,
      this.#digester,
    );
    validateThreadState(authority.thread);
    if (
      authority.workflowVersion.tenantId !== actor.tenantId ||
      authority.workflowVersion.workflowVersionId !==
        command.workflowVersionId ||
      authority.workflowVersion.workflowId !== workflow.workflowId ||
      authority.workflowVersion.workflowVersionId !==
        workflow.workflowVersionId ||
      authority.workflowVersion.contentDigest !== workflow.contentDigest ||
      authority.thread.tenantId !== actor.tenantId ||
      authority.thread.spaceId !== actor.spaceId ||
      authority.thread.threadId !== command.threadId ||
      authority.thread.status !== "active"
    )
      invalidAuthority();
    const members = new Set(
      office.members.map((member) => member.agentVersionId),
    );
    if (
      workflow.nodes.some((node) => {
        if (node.kind === "agent") return !members.has(node.agentVersionId);
        if (node.kind === "verification")
          return !members.has(node.verifierAgentVersionId);
        return false;
      })
    ) {
      throw new ApplicationError(
        "validation",
        "office_workflow_agent_not_member",
      );
    }
    let validatedInput: JsonValue;
    try {
      validatedInput = validateWorkflowSchemaValue(
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
    const occurredAt = this.#clock.now();
    const valueId = this.#ids.nextId("workflowExecutionValue");
    const valueDigest = this.#digester.sha256(canonicalJson(validatedInput));
    const schedulerOperationId = this.#ids.nextId("workflowSchedulerOperation");
    const runId = this.#ids.nextId("run");
    const binding = {
      workflowId: workflow.workflowId,
      workflowVersionId: workflow.workflowVersionId,
      contentDigest: workflow.contentDigest,
    };
    const delegation = parseOfficeDelegation({
      schemaVersion: "crewon.office-delegation.v0",
      delegationId: this.#ids.nextId("officeDelegation"),
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      officeId: office.officeId,
      officeVersionId: office.officeVersionId,
      workflowVersionBinding: binding,
      threadId: command.threadId,
      runId,
      requestedByActorId: actor.actorId,
      createdAt: occurredAt,
    });
    const event: Extract<RunLifecycleEvent, { type: "run.created" }> = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId },
      eventId: this.#ids.nextId("runEvent"),
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
        workflowVersionBinding: binding,
        collaborationMode: "default",
        goalBinding: null,
      },
    };
    const runCommit: CommitRunInput = {
      tenantId: actor.tenantId,
      idempotency: commitIdempotency(actor, command, idempotency),
      expectedRevision: 0,
      events: [event],
      outbox: [
        {
          messageId: this.#ids.nextId("outboxMessage"),
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
          workItemId: this.#ids.nextId("workItem"),
          tenantId: actor.tenantId,
          runId,
          kind: "run.execute",
          payload: {
            schemaVersion: "crewon.workflow-scheduler-work-item.v1",
            trigger: "workflowScheduler",
            binding,
            schedulerOperationId,
            workflowInput: { valueId, valueDigest },
          } satisfies WorkflowSchedulerWorkItemPayload,
          createdAt: occurredAt,
        },
      ],
    };
    return {
      delegation,
      runCommit,
      workflowInputValue: {
        schemaVersion: "crewon.workflow-execution-value.v0" as const,
        valueId,
        value: validatedInput,
        valueDigest,
      },
    };
  }
}

function validateActor(actor: ActorContext) {
  if (!hasExactKeys(actor, ["actorId", "principalId", "spaceId", "tenantId"]))
    throw new ApplicationError("validation", "actor_context_invalid");
  for (const value of [
    actor.actorId,
    actor.principalId,
    actor.spaceId,
    actor.tenantId,
  ])
    requireId(value, "actor_context_invalid");
}

function validateStart(command: StartOfficeDelegationCommand) {
  if (
    !hasExactKeys(command, [
      "idempotencyKey",
      "input",
      "kind",
      "officeVersionId",
      "threadId",
      "workflowVersionId",
    ])
  )
    invalidCommand();
  if (command.kind !== "officeDelegation.start") invalidCommand();
  requireId(command.officeVersionId, "office_version_id_invalid");
  requireId(command.workflowVersionId, "workflow_version_id_invalid");
  requireId(command.threadId, "thread_id_invalid");
  if (
    typeof command.idempotencyKey !== "string" ||
    command.idempotencyKey.length === 0 ||
    new TextEncoder().encode(command.idempotencyKey).byteLength > 256 ||
    /[\u0000-\u001f\u007f]/u.test(command.idempotencyKey)
  )
    throw new ApplicationError("validation", "idempotency_key_invalid");
}

function startIdempotency(
  actor: ActorContext,
  command: StartOfficeDelegationCommand,
  input: JsonValue,
): IdempotencyDescriptor {
  return {
    scope: canonicalJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      namespace: "office-delegation-start",
      tenantId: actor.tenantId,
      actorId: actor.actorId,
    }),
    key: command.idempotencyKey,
    requestFingerprint: canonicalJson({
      schemaVersion: "crewon.office-delegation-start-fingerprint.v0",
      actor: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        actorId: actor.actorId,
      },
      command: {
        officeVersionId: command.officeVersionId,
        workflowVersionId: command.workflowVersionId,
        threadId: command.threadId,
        input,
      },
    }),
  };
}

function commitIdempotency(
  actor: ActorContext,
  command: StartOfficeDelegationCommand,
  admission: IdempotencyDescriptor,
): IdempotencyDescriptor {
  return {
    scope: canonicalJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      namespace: "office-delegation-run-commit",
      tenantId: actor.tenantId,
      actorId: actor.actorId,
    }),
    key: command.idempotencyKey,
    requestFingerprint: canonicalJson({
      schemaVersion: "crewon.office-delegation-run-commit-fingerprint.v0",
      admission,
    }),
  };
}

function requireId(value: unknown, code: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  )
    throw new ApplicationError("validation", code);
}

function invalidAuthority(): never {
  throw new ApplicationError("internal", "office_delegation_authority_invalid");
}
function invalidCommand(): never {
  throw new ApplicationError("validation", "office_delegation_command_invalid");
}
async function authorize(
  port: AuthorizationPort,
  request: Parameters<AuthorizationPort["authorize"]>[0],
) {
  try {
    if ((await port.authorize(request)).outcome !== "allow")
      throw new ApplicationError("authorization", "authorization_denied");
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("authorization", "authorization_unavailable", {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
