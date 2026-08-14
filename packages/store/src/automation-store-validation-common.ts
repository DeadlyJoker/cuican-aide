import { createHash } from "node:crypto";

import {
  AutomationStoreError,
  type AutomationDefinitionRecord,
  type CommitAutomationInvocationInput,
  type IdempotencyDescriptor,
  type MessageRecord,
} from "@crewon/application";
import {
  renderAutomationInstruction,
  validateThreadState,
  type ThreadState,
} from "@crewon/domain";

import { stableJson } from "./store-invariants.ts";

export function validateAutomationInvocationArtifacts(
  input: CommitAutomationInvocationInput,
  record: AutomationDefinitionRecord,
  threadState: ThreadState,
  runState: NonNullable<ReturnType<typeof import("@crewon/domain").reduceRunLifecycleEvent>>,
): void {
  const definition = record.definition;
  const instruction = renderAutomationInstruction(definition);
  const routeDigest = digest(stableJson({
    authorityId: input.runEvent.data.authorityId,
    runtimeGeneration: input.runEvent.data.runtimeGeneration,
    agentVersionId: input.runEvent.data.agentVersionId,
    policySnapshotId: input.runEvent.data.policySnapshotId,
    workspaceBindingId: input.runEvent.data.workspaceBindingId,
  }));
  const origin = stableJson({ kind: "automation", binding: input.binding });
  if (
    input.instruction !== instruction ||
    input.binding.automationId !== definition.automationId ||
    input.binding.automationRevision !== definition.revision ||
    input.binding.definitionDigest !== record.definitionDigest ||
    input.binding.instructionDigest !== digest(instruction) ||
    input.binding.routeDigest !== routeDigest ||
    input.binding.runId !== input.runEvent.identity.runId ||
    input.message.content !== instruction ||
    input.message.contentDigest !== digest(instruction) ||
    input.message.role !== "user" ||
    input.message.proposedPlan !== null ||
    input.message.invalidation !== undefined ||
    input.historyItem.content !== instruction ||
    input.historyItem.contentDigest !== digest(instruction) ||
    input.historyItem.source !== "automation_invocation" ||
    input.historyItem.role !== "user" ||
    input.historyItem.runId !== input.binding.runId ||
    input.historyItem.segmentId !== null ||
    input.runEvent.data.purpose !== "turn" ||
    input.runEvent.data.goalBinding !== null ||
    input.runEvent.data.threadId !== definition.threadId ||
    input.runEvent.data.tenantId !== definition.tenantId ||
    input.runEvent.data.spaceId !== definition.spaceId ||
    input.runEvent.data.agentVersionId !== definition.agentVersionId ||
    threadState.threadId !== definition.threadId ||
    threadState.tenantId !== definition.tenantId ||
    threadState.spaceId !== definition.spaceId ||
    runState.runId !== input.binding.runId ||
    runState.threadId !== definition.threadId ||
    runState.tenantId !== definition.tenantId ||
    runState.spaceId !== definition.spaceId ||
    stableJson(input.message.origin) !== origin ||
    stableJson(input.historyItem.origin) !== origin ||
    stableJson(input.runEvent.data.origin) !== origin ||
    stableJson(input.workItem.payload) !== stableJson({
      schemaVersion: "crewon.automation-invocation-work-item.v1",
      trigger: "automationInvocation",
      throughSequence: 1,
      binding: input.binding,
    }) ||
    stableJson(input.outbox.payload) !== stableJson({
      eventId: input.runEvent.eventId,
      eventType: "run.created",
      throughSequence: 1,
    })
  ) throw new AutomationStoreError("automation_invocation_authority_mismatch");
}

export function validateAutomationIdempotency(value: IdempotencyDescriptor): void {
  requireExactObject(value, ["key", "requestFingerprint", "scope"], "automation_idempotency_invalid");
  requireBounded(value.scope, 512, "automation_idempotency_invalid");
  requireBounded(value.key, 256, "automation_idempotency_invalid");
  requireBounded(value.requestFingerprint, 64 * 1024, "automation_idempotency_invalid");
}

export function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requireBounded(value: unknown, maxBytes: number, code: string): void {
  if (typeof value !== "string" || value.trim().length === 0 ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new AutomationStoreError(code);
  }
}

export function requireExactAutomationMessage(value: MessageRecord): void {
  requireExactObject(value, ["content", "contentDigest", "createdAt", "messageId", "origin", "proposedPlan", "role", "sequence", "tenantId", "threadId"], "automation_invocation_input_invalid");
}

export function requireExactThreadState(value: ThreadState): void {
  requireExactObject(value, ["archivedAt", "createdAt", "createdByActorId", "deletedAt", "deletedByActorId", "forkedFromThreadId", "forkedThroughHistorySequence", "lastEventSequence", "lastMessageSequence", "revision", "spaceId", "status", "tenantId", "threadId", "title", "updatedAt"], "automation_invocation_receipt_invalid");
  try { validateThreadState(value); } catch (error) {
    throw new AutomationStoreError("automation_invocation_receipt_invalid", { cause: error instanceof Error ? error : undefined });
  }
}

export function requireExactObject(value: unknown, expectedKeys: readonly string[], code: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AutomationStoreError(code);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new AutomationStoreError(code);
}
