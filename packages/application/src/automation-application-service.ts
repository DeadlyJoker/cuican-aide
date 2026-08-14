import {
  MAX_AUTOMATION_INSTRUCTION_BYTES,
  createAutomationDefinition,
  parseAutomationInvocationBinding,
  parseAutomationInvocationOrigin,
  parseAutomationScheduleState,
  reduceRunLifecycleEvent,
  renderAutomationInstruction,
  validateAutomationDefinition,
  validateModelHistoryItem,
  type AutomationDefinition,
  type AutomationInvocationBinding,
  type AutomationInvocationTrigger,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type {
  AutomationApplicationIdGenerator,
  AutomationApplicationIdKind,
  AutomationAuthorizationAction,
  AutomationAuthorizationPort,
  AutomationCreateResult,
  AutomationDefinitionRecord,
  AutomationInvocationContext,
  AutomationInvocationResult,
  AutomationListCursor,
  AutomationStore,
  CommitAutomationInvocationInput,
  CreateAutomationCommand,
  RunAutomationNowCommand,
} from "./automation-store-port.ts";
import type {
  AutomationScheduleCalculatorPort,
  AutomationScheduleClaim,
  ScheduledAutomationInvocationPreparer,
} from "./automation-scheduler-store-port.ts";
import {
  isAutomationDigest,
  isAutomationTimestamp,
  mapAutomationError,
  requireAutomationOpaqueId,
  validateAutomationActor,
  validateAutomationCreateCommand,
  validateAutomationListQuery,
  validateAutomationRoute,
  validateAutomationRunNowCommand,
} from "./automation-store-port.ts";
import type { ActorContext } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { RunRoute, RunRouteResolverPort } from "./run-commands.ts";

export type {
  AutomationApplicationIdGenerator,
  AutomationApplicationIdKind,
  AutomationAuthorizationAction,
  AutomationAuthorizationPort,
  AutomationAuthorizationResource,
  CreateAutomationCommand,
  RunAutomationNowCommand,
} from "./automation-store-port.ts";

export class AutomationApplicationService
  implements ScheduledAutomationInvocationPreparer
{
  readonly #store: AutomationStore;
  readonly #authorization: AutomationAuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #ids: AutomationApplicationIdGenerator;
  readonly #digester: ContentDigester;
  readonly #routeResolver: RunRouteResolverPort;
  readonly #scheduleCalculator: AutomationScheduleCalculatorPort;

  constructor(dependencies: {
    store: AutomationStore;
    authorization: AutomationAuthorizationPort;
    clock: ApplicationClock;
    ids: AutomationApplicationIdGenerator;
    digester: ContentDigester;
    routeResolver: RunRouteResolverPort;
    scheduleCalculator: AutomationScheduleCalculatorPort;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#digester = dependencies.digester;
    this.#routeResolver = dependencies.routeResolver;
    this.#scheduleCalculator = dependencies.scheduleCalculator;
  }

  async createAutomation(
    actor: ActorContext,
    command: CreateAutomationCommand,
  ): Promise<AutomationCreateResult> {
    validateAutomationActor(actor);
    validateAutomationCreateCommand(command);
    await this.#authorizeAutomation(actor, "automation:create", {
      automationId: null,
      threadId: command.threadId,
    });
    await this.#authorizeThreadWrite(actor, command.threadId);
    const idempotency = createIdempotency(actor, command);
    const replay = await this.#storeCall(() =>
      this.#store.loadAutomationCreateReceipt({
        tenantId: actor.tenantId,
        idempotency,
      }),
    );
    if (replay !== null) {
      this.#validateCreateResult(actor, command, replay);
      await this.#authorizeAutomation(
        actor,
        "automation:create",
        replay.record.definition,
      );
      return replay;
    }

    const route = await this.#resolveRoute(
      actor,
      command.threadId,
      command.requestedAgentVersionId,
    );
    const createdAt = this.#now();
    const definition = this.#createDefinition(actor, command, route, createdAt);
    const nextOccurrenceAt = this.#scheduleCalculator.nextOccurrence({
      schedule: definition.schedule,
      after: createdAt,
      inclusive: true,
    });
    if (nextOccurrenceAt === null) {
      throw new ApplicationError(
        "validation",
        "automation_schedule_has_no_occurrence",
      );
    }
    const record = this.#record(definition, nextOccurrenceAt);
    const result = await this.#storeCall(() =>
      this.#store.commitAutomationCreate({
        tenantId: actor.tenantId,
        idempotency,
        threadFence: {
          threadId: command.threadId,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          expectedRevision: command.expectedThreadRevision,
          expectedStatus: "active",
        },
        record,
      }),
    );
    this.#validateCreateResult(actor, command, result);
    if (canonicalJson(result.record) !== canonicalJson(record)) {
      throw new ApplicationError(
        "internal",
        "automation_create_result_invalid",
      );
    }
    return result;
  }

  async getAutomation(
    actor: ActorContext,
    automationId: string,
  ): Promise<AutomationDefinition> {
    validateAutomationActor(actor);
    requireAutomationOpaqueId(automationId, "automation_id_invalid");
    await this.#authorizeAutomation(actor, "automation:read", {
      automationId,
      threadId: null,
    });
    const record = await this.#loadRecord(actor, automationId);
    await this.#authorizeAutomation(
      actor,
      "automation:read",
      record.definition,
    );
    return structuredClone(record.definition);
  }

  async listAutomations(
    actor: ActorContext,
    query: Readonly<{ before: AutomationListCursor | null; limit: number }>,
  ): Promise<readonly AutomationDefinition[]> {
    validateAutomationActor(actor);
    validateAutomationListQuery(query);
    await this.#authorizeAutomation(actor, "automation:read", {
      automationId: null,
      threadId: null,
    });
    const records = await this.#storeCall(() =>
      this.#store.listAutomations({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        before: query.before,
        limit: query.limit,
      }),
    );
    return records.map((record) => {
      this.#validateRecord(actor, record);
      return structuredClone(record.definition);
    });
  }

  async runAutomationNow(
    actor: ActorContext,
    command: RunAutomationNowCommand,
  ): Promise<AutomationInvocationResult> {
    validateAutomationActor(actor);
    validateAutomationRunNowCommand(command);
    await this.#authorizeAutomation(actor, "automation:run", {
      automationId: command.automationId,
      threadId: null,
    });
    const idempotency = runIdempotency(actor, command);
    const replay = await this.#storeCall(() =>
      this.#store.loadAutomationInvocationReceipt({
        tenantId: actor.tenantId,
        automationId: command.automationId,
        idempotency,
      }),
    );
    if (replay !== null) {
      this.#validateInvocationResult(actor, command, replay);
      await this.#authorizeInvocation(actor, replay.record.definition);
      return replay;
    }

    const context = await this.#storeCall(() =>
      this.#store.loadAutomationInvocationContext({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        automationId: command.automationId,
      }),
    );
    if (context === null) {
      throw new ApplicationError("notFound", "automation_not_found");
    }
    this.#validateInvocationContext(actor, command, context);
    await this.#authorizeInvocation(actor, context.record.definition);
    const route = await this.#resolveRoute(
      actor,
      context.thread.threadId,
      context.record.definition.agentVersionId,
    );
    if (route.agentVersionId !== context.record.definition.agentVersionId) {
      throw new ApplicationError(
        "internal",
        "automation_frozen_agent_version_mismatch",
      );
    }
    const input = this.#invocationInput(
      actor,
      command,
      context,
      route,
      idempotency,
      { kind: "manual" },
    );
    const result = await this.#storeCall(() =>
      this.#store.commitAutomationInvocation(input),
    );
    this.#validateInvocationResult(actor, command, result, {
      input,
      route,
      record: context.record,
    });
    return result;
  }

  async prepare(
    input: Parameters<ScheduledAutomationInvocationPreparer["prepare"]>[0],
  ): Promise<CommitAutomationInvocationInput> {
    const { actor, claim } = input;
    validateAutomationActor(actor);
    this.#validateRecord(actor, claim.record);
    const definition = claim.record.definition;
    if (
      canonicalJson(definition.owner) !== canonicalJson(actor) ||
      claim.record.scheduleState.status !== "enabled" ||
      claim.record.scheduleState.nextOccurrenceAt !== claim.scheduledFor
    ) {
      throw new ApplicationError(
        "internal",
        "automation_schedule_claim_invalid",
      );
    }
    const context = await this.#storeCall(() =>
      this.#store.loadAutomationInvocationContext({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        automationId: definition.automationId,
      }),
    );
    if (
      context === null ||
      canonicalJson(context.record) !== canonicalJson(claim.record)
    ) {
      throw new ApplicationError(
        "internal",
        "automation_schedule_claim_invalid",
      );
    }
    const command = {
      kind: "automation.runNow" as const,
      idempotencyKey: claim.occurrenceDigest,
      automationId: definition.automationId,
      expectedAutomationRevision: 1 as const,
      expectedThreadRevision: context.thread.revision,
    };
    this.#validateInvocationContext(actor, command, context);
    const route = await this.#resolveRoute(
      actor,
      definition.threadId,
      definition.agentVersionId,
    );
    if (route.agentVersionId !== definition.agentVersionId) {
      throw new ApplicationError(
        "internal",
        "automation_frozen_agent_version_mismatch",
      );
    }
    return this.#invocationInput(
      actor,
      command,
      context,
      route,
      scheduledIdempotency(actor, claim),
      {
        kind: "schedule",
        scheduleRevision: claim.record.scheduleState.scheduleRevision,
        scheduledFor: claim.scheduledFor,
        occurrenceDigest: claim.occurrenceDigest,
      },
    );
  }

  #createDefinition(
    actor: ActorContext,
    command: CreateAutomationCommand,
    route: RunRoute,
    createdAt: string,
  ): AutomationDefinition {
    try {
      return createAutomationDefinition({
        automationId: this.#nextId("automation"),
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        owner: actor,
        threadId: command.threadId,
        title: command.title,
        prompt: command.prompt,
        agentVersionId: route.agentVersionId,
        schedule: command.schedule,
        createdAt,
      });
    } catch (error) {
      throw mapAutomationError(error);
    }
  }

  #invocationInput(
    actor: ActorContext,
    command: RunAutomationNowCommand,
    context: AutomationInvocationContext,
    route: RunRoute,
    idempotency: ReturnType<typeof runIdempotency>,
    trigger: AutomationInvocationTrigger,
  ): CommitAutomationInvocationInput {
    const definition = context.record.definition;
    const occurredAt = this.#now();
    const runId = this.#nextId("run");
    const instruction = renderAutomationInstruction(definition);
    if (
      new TextEncoder().encode(instruction).byteLength >
      MAX_AUTOMATION_INSTRUCTION_BYTES
    ) {
      throw new ApplicationError(
        "internal",
        "automation_instruction_too_large",
      );
    }
    const contentDigest = this.#digest(
      instruction,
      "automation_instruction_digest_invalid",
    );
    const routeDigest = this.#digest(
      canonicalJson(route),
      "automation_route_digest_invalid",
    );
    const binding: AutomationInvocationBinding =
      parseAutomationInvocationBinding({
        automationId: definition.automationId,
        automationRevision: definition.revision,
        definitionDigest: context.record.definitionDigest,
        instructionDigest: contentDigest,
        invocationId: this.#nextId("automationInvocation"),
        runId,
        routeDigest,
        trigger,
      });
    const origin = parseAutomationInvocationOrigin({
      kind: "automation",
      binding,
    });
    const messageId = this.#nextId("message");
    const threadEvent = {
      schemaVersion: "crewon.thread-event.v0" as const,
      identity: { threadId: definition.threadId },
      eventId: this.#nextId("threadEvent"),
      sequence: context.thread.lastEventSequence + 1,
      occurredAt,
      type: "thread.message.appended" as const,
      data: {
        messageId,
        messageSequence: context.thread.lastMessageSequence + 1,
        role: "user" as const,
        contentDigest,
      },
    };
    const message = {
      messageId,
      tenantId: actor.tenantId,
      threadId: definition.threadId,
      sequence: context.thread.lastMessageSequence + 1,
      role: "user" as const,
      content: instruction,
      contentDigest,
      createdAt: occurredAt,
      proposedPlan: null,
      origin,
    };
    const historyItem = {
      schemaVersion: "crewon.model-history-item.v0" as const,
      itemId: this.#nextId("modelHistoryItem"),
      tenantId: actor.tenantId,
      threadId: definition.threadId,
      sequence: context.historyHead.lastSequence + 1,
      runId,
      segmentId: null,
      createdAt: occurredAt,
      type: "message" as const,
      role: "user" as const,
      source: "automation_invocation" as const,
      content: instruction,
      contentDigest,
      origin,
    };
    const runEvent = {
      schemaVersion: "crewon.run-event.v0" as const,
      identity: { runId },
      eventId: this.#nextId("runEvent"),
      sequence: 1,
      occurredAt,
      type: "run.created" as const,
      data: {
        threadId: definition.threadId,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        createdByActorId: actor.actorId,
        authorityId: route.authorityId,
        runtimeGeneration: route.runtimeGeneration,
        agentVersionId: route.agentVersionId,
        policySnapshotId: route.policySnapshotId,
        workspaceBindingId: route.workspaceBindingId,
        collaborationMode: "default" as const,
        goalBinding: null,
        purpose: "turn" as const,
        origin,
      },
    };
    const input: CommitAutomationInvocationInput = {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      idempotency,
      definitionFence: {
        automationId: definition.automationId,
        expectedRevision: definition.revision,
        expectedDefinitionDigest: context.record.definitionDigest,
      },
      threadFence: {
        threadId: definition.threadId,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        expectedRevision: command.expectedThreadRevision,
        expectedStatus: "active",
        expectedHistorySequence: context.historyHead.lastSequence,
        expectedActiveRunId: null,
      },
      binding,
      instruction,
      threadEvent,
      message,
      historyItem,
      runEvent,
      outbox: {
        messageId: this.#nextId("outboxMessage"),
        tenantId: actor.tenantId,
        runId,
        topic: "run.updated",
        payload: {
          eventId: runEvent.eventId,
          eventType: runEvent.type,
          throughSequence: runEvent.sequence,
        },
        createdAt: occurredAt,
      },
      workItem: {
        workItemId: this.#nextId("workItem"),
        tenantId: actor.tenantId,
        runId,
        kind: "run.execute",
        payload: {
          schemaVersion: "crewon.automation-invocation-work-item.v1",
          trigger: "automationInvocation",
          throughSequence: 1,
          binding,
        },
        createdAt: occurredAt,
      },
    };
    this.#validateGeneratedInvocationInput(
      actor,
      command,
      context,
      route,
      input,
    );
    return input;
  }

  async #loadRecord(
    actor: ActorContext,
    automationId: string,
  ): Promise<AutomationDefinitionRecord> {
    const record = await this.#storeCall(() =>
      this.#store.loadAutomation({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        automationId,
      }),
    );
    if (record === null || record.definition.spaceId !== actor.spaceId) {
      throw new ApplicationError("notFound", "automation_not_found");
    }
    this.#validateRecord(actor, record);
    return record;
  }

  #record(
    definition: AutomationDefinition,
    nextOccurrenceAt: string,
  ): AutomationDefinitionRecord {
    return {
      definition,
      definitionDigest: this.#digest(
        canonicalJson(definition),
        "automation_definition_digest_invalid",
      ),
      scheduleState: parseAutomationScheduleState({
        schemaVersion: "crewon.automation-schedule-state.v1",
        automationId: definition.automationId,
        scheduleRevision: 1,
        status: "enabled",
        nextOccurrenceAt,
        lastScheduledFor: null,
        retryAt: null,
        revision: 1,
        updatedAt: definition.createdAt,
      }),
    };
  }

  #validateRecord(
    actor: ActorContext,
    record: AutomationDefinitionRecord,
  ): void {
    this.#hideCrossSpaceRecord(actor, record);
    try {
      validateAutomationDefinition(record.definition);
      parseAutomationScheduleState(record.scheduleState);
    } catch (error) {
      throw mapAutomationError(error, "internal");
    }
    if (
      record.definition.tenantId !== actor.tenantId ||
      record.definition.spaceId !== actor.spaceId ||
      record.scheduleState.automationId !== record.definition.automationId ||
      !isAutomationDigest(record.definitionDigest) ||
      this.#digest(
        canonicalJson(record.definition),
        "automation_definition_digest_invalid",
      ) !== record.definitionDigest
    ) {
      throw new ApplicationError("internal", "automation_record_invalid");
    }
  }

  #validateCreateResult(
    actor: ActorContext,
    command: CreateAutomationCommand,
    result: AutomationCreateResult,
  ): void {
    this.#hideCrossSpaceRecord(actor, result.record);
    this.#validateRecord(actor, result.record);
    const definition = result.record.definition;
    if (
      (result.disposition !== "committed" &&
        result.disposition !== "replayed") ||
      definition.threadId !== command.threadId ||
      definition.title !== command.title ||
      definition.prompt !== command.prompt ||
      canonicalJson(definition.schedule) !== canonicalJson(command.schedule) ||
      (command.requestedAgentVersionId !== null &&
        definition.agentVersionId !== command.requestedAgentVersionId)
    ) {
      throw new ApplicationError(
        "internal",
        "automation_create_receipt_invalid",
      );
    }
  }

  #validateInvocationContext(
    actor: ActorContext,
    command: RunAutomationNowCommand,
    context: AutomationInvocationContext,
  ): void {
    this.#hideCrossSpaceRecord(actor, context.record);
    this.#validateRecord(actor, context.record);
    const definition = context.record.definition;
    if (definition.automationId !== command.automationId) {
      throw new ApplicationError("internal", "automation_context_invalid");
    }
    if (definition.revision !== command.expectedAutomationRevision) {
      throw new ApplicationError("conflict", "automation_revision_conflict");
    }
    if (
      definition.agentVersionId === null ||
      context.thread.tenantId !== actor.tenantId ||
      context.thread.spaceId !== actor.spaceId ||
      context.thread.threadId !== definition.threadId ||
      context.historyHead.tenantId !== actor.tenantId ||
      context.historyHead.threadId !== definition.threadId
    ) {
      throw new ApplicationError("internal", "automation_context_invalid");
    }
    if (context.thread.status !== "active") {
      throw new ApplicationError("conflict", "automation_thread_not_active");
    }
    if (context.thread.revision !== command.expectedThreadRevision) {
      throw new ApplicationError("conflict", "revision_conflict");
    }
  }

  #validateGeneratedInvocationInput(
    actor: ActorContext,
    command: RunAutomationNowCommand,
    context: AutomationInvocationContext,
    route: RunRoute,
    input: CommitAutomationInvocationInput,
  ): void {
    this.#validateInvocationArtifacts(
      actor,
      context.record,
      route,
      {
        binding: input.binding,
        instruction: input.instruction,
        threadEvent: input.threadEvent,
        message: input.message,
        historyItem: input.historyItem,
        runEvent: input.runEvent,
        outbox: input.outbox,
        workItem: input.workItem,
      },
      "automation_invocation_input_invalid",
    );
    if (
      input.tenantId !== actor.tenantId ||
      input.spaceId !== actor.spaceId ||
      input.definitionFence.automationId !== command.automationId ||
      input.definitionFence.expectedRevision !==
        command.expectedAutomationRevision ||
      input.definitionFence.expectedDefinitionDigest !==
        context.record.definitionDigest ||
      input.threadFence.threadId !== context.record.definition.threadId ||
      input.threadFence.tenantId !== actor.tenantId ||
      input.threadFence.spaceId !== actor.spaceId ||
      input.threadFence.expectedRevision !== command.expectedThreadRevision ||
      input.threadFence.expectedStatus !== "active" ||
      input.threadFence.expectedHistorySequence !==
        context.historyHead.lastSequence ||
      input.threadFence.expectedActiveRunId !== null
    ) {
      throw new ApplicationError(
        "internal",
        "automation_invocation_input_invalid",
      );
    }
  }

  #validateInvocationArtifacts(
    actor: ActorContext,
    record: AutomationDefinitionRecord,
    route: RunRoute,
    artifacts: Pick<
      CommitAutomationInvocationInput,
      | "binding"
      | "instruction"
      | "threadEvent"
      | "message"
      | "historyItem"
      | "runEvent"
      | "outbox"
      | "workItem"
    >,
    code: string,
  ) {
    const definition = record.definition;
    const instruction = renderAutomationInstruction(definition);
    const contentDigest = this.#digest(
      instruction,
      "automation_instruction_digest_invalid",
    );
    let binding: AutomationInvocationBinding;
    let reduced;
    try {
      binding = parseAutomationInvocationBinding(artifacts.binding);
      parseAutomationInvocationOrigin(artifacts.message.origin);
      parseAutomationInvocationOrigin(artifacts.historyItem.origin);
      parseAutomationInvocationOrigin(artifacts.runEvent.data.origin);
      validateModelHistoryItem(artifacts.historyItem);
      reduced = reduceRunLifecycleEvent(null, artifacts.runEvent);
    } catch (error) {
      throw new ApplicationError("internal", code, {
        cause: error instanceof Error ? error : undefined,
      });
    }
    const origin = canonicalJson({ kind: "automation", binding });
    const runId = artifacts.runEvent.identity.runId;
    const occurredAt = artifacts.runEvent.occurredAt;
    if (
      artifacts.instruction !== instruction ||
      binding.automationId !== definition.automationId ||
      binding.automationRevision !== definition.revision ||
      binding.definitionDigest !== record.definitionDigest ||
      binding.instructionDigest !== contentDigest ||
      binding.runId !== runId ||
      binding.routeDigest !==
        this.#digest(canonicalJson(route), "automation_route_digest_invalid") ||
      artifacts.runEvent.sequence !== 1 ||
      artifacts.runEvent.data.threadId !== definition.threadId ||
      artifacts.runEvent.data.tenantId !== actor.tenantId ||
      artifacts.runEvent.data.spaceId !== actor.spaceId ||
      artifacts.runEvent.data.createdByActorId !== actor.actorId ||
      artifacts.runEvent.data.authorityId !== route.authorityId ||
      artifacts.runEvent.data.runtimeGeneration !== route.runtimeGeneration ||
      artifacts.runEvent.data.agentVersionId !== route.agentVersionId ||
      artifacts.runEvent.data.policySnapshotId !== route.policySnapshotId ||
      artifacts.runEvent.data.workspaceBindingId !== route.workspaceBindingId ||
      artifacts.runEvent.data.purpose !== "turn" ||
      artifacts.runEvent.data.goalBinding !== null ||
      artifacts.message.tenantId !== actor.tenantId ||
      artifacts.message.threadId !== definition.threadId ||
      artifacts.message.role !== "user" ||
      artifacts.message.content !== instruction ||
      artifacts.message.contentDigest !== contentDigest ||
      artifacts.message.createdAt !== occurredAt ||
      artifacts.historyItem.tenantId !== actor.tenantId ||
      artifacts.historyItem.threadId !== definition.threadId ||
      artifacts.historyItem.runId !== runId ||
      artifacts.historyItem.role !== "user" ||
      artifacts.historyItem.source !== "automation_invocation" ||
      artifacts.historyItem.content !== instruction ||
      artifacts.historyItem.contentDigest !== contentDigest ||
      artifacts.historyItem.createdAt !== occurredAt ||
      artifacts.threadEvent.identity.threadId !== definition.threadId ||
      artifacts.threadEvent.data.messageId !== artifacts.message.messageId ||
      artifacts.threadEvent.data.messageSequence !==
        artifacts.message.sequence ||
      artifacts.threadEvent.data.role !== artifacts.message.role ||
      artifacts.threadEvent.data.contentDigest !== contentDigest ||
      artifacts.threadEvent.occurredAt !== occurredAt ||
      artifacts.outbox.tenantId !== actor.tenantId ||
      artifacts.outbox.runId !== runId ||
      artifacts.outbox.topic !== "run.updated" ||
      artifacts.outbox.createdAt !== occurredAt ||
      canonicalJson(artifacts.outbox.payload) !==
        canonicalJson({
          eventId: artifacts.runEvent.eventId,
          eventType: "run.created",
          throughSequence: 1,
        }) ||
      artifacts.workItem.tenantId !== actor.tenantId ||
      artifacts.workItem.runId !== runId ||
      artifacts.workItem.kind !== "run.execute" ||
      artifacts.workItem.createdAt !== occurredAt ||
      canonicalJson(artifacts.workItem.payload) !==
        canonicalJson({
          schemaVersion: "crewon.automation-invocation-work-item.v1",
          trigger: "automationInvocation",
          throughSequence: 1,
          binding,
        }) ||
      canonicalJson(artifacts.message.origin) !== origin ||
      canonicalJson(artifacts.historyItem.origin) !== origin ||
      canonicalJson(artifacts.runEvent.data.origin) !== origin
    ) {
      throw new ApplicationError("internal", code);
    }
    return reduced;
  }

  #validateInvocationResult(
    actor: ActorContext,
    command: RunAutomationNowCommand,
    result: AutomationInvocationResult,
    fresh?: Readonly<{
      input: CommitAutomationInvocationInput;
      route: RunRoute;
      record: AutomationDefinitionRecord;
    }>,
  ): void {
    this.#hideCrossSpaceRecord(actor, result.record);
    this.#validateRecord(actor, result.record);
    const definition = result.record.definition;
    const instruction = renderAutomationInstruction(definition);
    const route =
      fresh?.route ??
      ({
        authorityId: result.runEvent.data.authorityId,
        runtimeGeneration: result.runEvent.data.runtimeGeneration,
        agentVersionId: result.runEvent.data.agentVersionId,
        policySnapshotId: result.runEvent.data.policySnapshotId,
        workspaceBindingId: result.runEvent.data.workspaceBindingId,
      } satisfies RunRoute);
    if (
      fresh !== undefined &&
      (canonicalJson(result.record) !== canonicalJson(fresh.record) ||
        canonicalJson({
          binding: result.binding,
          threadEvent: result.threadEvent,
          message: result.message,
          historyItem: result.historyItem,
          runEvent: result.runEvent,
          outbox: result.outbox,
          workItem: result.workItem,
        }) !==
          canonicalJson({
            binding: fresh.input.binding,
            threadEvent: fresh.input.threadEvent,
            message: fresh.input.message,
            historyItem: fresh.input.historyItem,
            runEvent: fresh.input.runEvent,
            outbox: fresh.input.outbox,
            workItem: fresh.input.workItem,
          }))
    ) {
      throw new ApplicationError(
        "internal",
        "automation_invocation_result_invalid",
      );
    }
    const reduced = this.#validateInvocationArtifacts(
      actor,
      result.record,
      route,
      {
        binding: result.binding,
        instruction,
        threadEvent: result.threadEvent,
        message: result.message,
        historyItem: result.historyItem,
        runEvent: result.runEvent,
        outbox: result.outbox,
        workItem: result.workItem,
      },
      "automation_invocation_receipt_invalid",
    );
    const binding = result.binding;
    if (
      (result.disposition !== "committed" &&
        result.disposition !== "replayed") ||
      binding.automationId !== command.automationId ||
      binding.automationId !== definition.automationId ||
      binding.automationRevision !== command.expectedAutomationRevision ||
      binding.trigger.kind !== "manual" ||
      canonicalJson(result.runState) !== canonicalJson(reduced) ||
      result.runState.purpose !== "turn" ||
      result.runState.threadId !== definition.threadId ||
      result.runState.tenantId !== actor.tenantId ||
      result.runState.spaceId !== actor.spaceId ||
      result.runState.agentVersionId !== definition.agentVersionId ||
      result.threadState.threadId !== definition.threadId ||
      result.threadState.tenantId !== actor.tenantId ||
      result.threadState.spaceId !== actor.spaceId ||
      result.threadState.status !== "active" ||
      result.threadState.revision !== command.expectedThreadRevision + 1 ||
      result.threadState.lastEventSequence !== result.threadEvent.sequence ||
      result.threadState.lastMessageSequence !== result.message.sequence ||
      result.threadState.updatedAt !== result.threadEvent.occurredAt ||
      result.message.threadId !== definition.threadId ||
      result.message.role !== "user" ||
      result.message.content !== instruction ||
      result.message.proposedPlan !== null ||
      result.message.invalidation !== undefined ||
      result.historyItem.threadId !== definition.threadId ||
      result.historyItem.runId !== result.runState.runId ||
      result.historyItem.role !== "user" ||
      result.historyItem.source !== "automation_invocation" ||
      result.historyItem.content !== instruction ||
      result.historyItem.segmentId !== null ||
      result.runEvent.identity.runId !== result.runState.runId ||
      result.outbox.runId !== result.runState.runId ||
      result.workItem.runId !== result.runState.runId
    ) {
      throw new ApplicationError(
        "internal",
        "automation_invocation_receipt_invalid",
      );
    }
  }

  async #resolveRoute(
    actor: ActorContext,
    threadId: string,
    agentVersionId: string | null,
  ): Promise<RunRoute> {
    let route: RunRoute;
    try {
      route = await this.#routeResolver.resolveRoute({
        actor,
        threadId,
        agentVersionId,
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("internal", "run_route_unavailable", {
        cause: error,
      });
    }
    validateAutomationRoute(route, agentVersionId);
    return route;
  }

  #hideCrossSpaceRecord(
    actor: ActorContext,
    record: AutomationDefinitionRecord,
  ): void {
    const definition = record?.definition;
    if (
      definition !== null &&
      typeof definition === "object" &&
      definition.tenantId === actor.tenantId &&
      definition.spaceId !== actor.spaceId
    ) {
      throw new ApplicationError("notFound", "automation_not_found");
    }
  }

  async #authorizeAutomation(
    actor: ActorContext,
    action: Extract<
      AutomationAuthorizationAction,
      "automation:create" | "automation:read" | "automation:run"
    >,
    resource:
      | AutomationDefinition
      | Readonly<{ automationId: string | null; threadId: string | null }>,
  ): Promise<void> {
    await this.#authorizeRequest(actor, action, {
      kind: "automation",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      automationId: resource.automationId,
      threadId: resource.threadId,
    });
  }

  async #authorizeInvocation(
    actor: ActorContext,
    definition: AutomationDefinition,
  ): Promise<void> {
    await this.#authorizeAutomation(actor, "automation:run", definition);
    await this.#authorizeThreadWrite(actor, definition.threadId);
    await this.#authorizeRequest(actor, "run:create", {
      kind: "run",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: definition.threadId,
      runId: null,
    });
  }

  async #authorizeThreadWrite(
    actor: ActorContext,
    threadId: string,
  ): Promise<void> {
    await this.#authorizeRequest(actor, "thread:message:append", {
      kind: "thread",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId,
    });
  }

  async #authorizeRequest(
    actor: ActorContext,
    action: AutomationAuthorizationAction,
    resource: Parameters<
      AutomationAuthorizationPort["authorize"]
    >[0]["resource"],
  ): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action,
        resource,
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

  async #storeCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapAutomationError(error);
    }
  }

  #nextId(kind: AutomationApplicationIdKind): string {
    const id = this.#ids.nextId(kind);
    requireAutomationOpaqueId(id, `${kind}_id_invalid`, "internal");
    return id;
  }

  #now(): string {
    const timestamp = this.#clock.now();
    if (!isAutomationTimestamp(timestamp)) {
      throw new ApplicationError("internal", "clock_timestamp_invalid");
    }
    return timestamp;
  }

  #digest(value: string, code: string): string {
    const digest = this.#digester.sha256(value);
    if (!isAutomationDigest(digest)) {
      throw new ApplicationError("internal", code);
    }
    return digest;
  }
}

function createIdempotency(
  actor: ActorContext,
  command: CreateAutomationCommand,
) {
  return idempotency(
    actor,
    "automation-create-command",
    command.idempotencyKey,
    {
      kind: command.kind,
      threadId: command.threadId,
      expectedThreadRevision: command.expectedThreadRevision,
      title: command.title,
      prompt: command.prompt,
      requestedAgentVersionId: command.requestedAgentVersionId,
      schedule: command.schedule,
    },
  );
}

function runIdempotency(actor: ActorContext, command: RunAutomationNowCommand) {
  return idempotency(actor, "automation-run-command", command.idempotencyKey, {
    kind: command.kind,
    automationId: command.automationId,
    expectedAutomationRevision: command.expectedAutomationRevision,
    expectedThreadRevision: command.expectedThreadRevision,
  });
}

function scheduledIdempotency(
  actor: ActorContext,
  claim: AutomationScheduleClaim,
) {
  return idempotency(
    actor,
    "automation-schedule-command",
    claim.occurrenceDigest,
    {
      kind: "automation.schedule",
      automationId: claim.record.definition.automationId,
      scheduleRevision: claim.record.scheduleState.scheduleRevision,
      scheduledFor: claim.scheduledFor,
      occurrenceDigest: claim.occurrenceDigest,
    },
  );
}

function idempotency(
  actor: ActorContext,
  namespace: string,
  key: string,
  semanticCommand: unknown,
) {
  return {
    scope: canonicalJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      namespace,
    }),
    key,
    requestFingerprint: canonicalJson({
      schemaVersion: "crewon.automation-command-fingerprint.v1",
      actor: {
        actorId: actor.actorId,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
      },
      command: semanticCommand,
    }),
  };
}
