import { resolveAutomationSkillInvocation } from "@crewon/domain";
import {
  MAX_AUTOMATION_INSTRUCTION_BYTES,
  parseAutomationInvocationBinding,
  parseAutomationInvocationOrigin,
  renderAutomationInstruction,
  type AutomationInvocationBinding,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  AutomationApplicationIdKind,
  AutomationInvocationContext,
  CommitAutomationInvocationInput,
  RunAutomationNowCommand,
} from "./automation-store-port.ts";
import type { IdempotencyDescriptor } from "./run-store-port.ts";
import type { RunRoute } from "./run-commands.ts";
import { canonicalJson } from "./canonical-json.ts";

export function createAutomationInvocationInput(dependencies: {
  actor: ActorContext;
  command: RunAutomationNowCommand;
  context: AutomationInvocationContext;
  route: RunRoute;
  idempotency: IdempotencyDescriptor;
  scheduledFor?: string;
  now(): string;
  nextId(kind: AutomationApplicationIdKind): string;
  digest(value: string, code: string): string;
}): CommitAutomationInvocationInput {
  const { actor, command, context, route, idempotency, scheduledFor } =
    dependencies;
  const definition = context.record.definition;
  const occurredAt = dependencies.now();
  const runId = dependencies.nextId("run");
  const skillInvocation =
    definition.skillBinding && scheduledFor
      ? resolveAutomationSkillInvocation(
          definition.skillBinding,
          scheduledFor,
          definition.schedule.timezone,
        )
      : undefined;
  const instruction = renderAutomationInstruction(
    definition,
    scheduledFor,
    skillInvocation,
  );
  if (
    new TextEncoder().encode(instruction).byteLength >
    MAX_AUTOMATION_INSTRUCTION_BYTES
  ) {
    throw new ApplicationError("internal", "automation_instruction_too_large");
  }
  const contentDigest = dependencies.digest(
    instruction,
    "automation_instruction_digest_invalid",
  );
  const routeDigest = dependencies.digest(
    canonicalJson(route),
    "automation_route_digest_invalid",
  );
  const binding: AutomationInvocationBinding = parseAutomationInvocationBinding(
    {
      ...(scheduledFor === undefined ? {} : { scheduledFor, skillInvocation }),
      automationId: definition.automationId,
      automationRevision: definition.revision,
      definitionDigest: context.record.definitionDigest,
      instructionDigest: contentDigest,
      invocationId: dependencies.nextId("automationInvocation"),
      runId,
      routeDigest,
    },
  );
  const origin = parseAutomationInvocationOrigin({
    kind: "automation",
    binding,
  });
  const messageId = dependencies.nextId("message");
  const threadEvent = {
    schemaVersion: "crewon.thread-event.v0" as const,
    identity: { threadId: definition.threadId },
    eventId: dependencies.nextId("threadEvent"),
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
    itemId: dependencies.nextId("modelHistoryItem"),
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
    eventId: dependencies.nextId("runEvent"),
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
      messageId: dependencies.nextId("outboxMessage"),
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
      workItemId: dependencies.nextId("workItem"),
      tenantId: actor.tenantId,
      runId,
      kind: "run.execute",
      payload: {
        schemaVersion: "crewon.automation-invocation-work-item.v0",
        trigger: "automationInvocation",
        throughSequence: 1,
        binding,
      },
      createdAt: occurredAt,
    },
  };
  return input;
}
