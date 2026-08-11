import {
  AutomationStoreError,
  type AutomationInvocationResult,
  type CommitAutomationInvocationInput,
} from "@crewon/application";
import {
  parseAutomationInvocationBinding,
  parseAutomationInvocationOrigin,
  reduceRunLifecycleEvent,
  validateModelHistoryItem,
} from "@crewon/domain";

import {
  stableJson,
} from "./store-invariants.ts";
import {
  validateAutomationRecord,
} from "./automation-store-authority-support.ts";
import {
  validateAutomationIdempotency,
  validateAutomationInvocationArtifacts,
  requireExactAutomationMessage,
  requireExactObject,
  requireExactThreadState,
} from "./automation-store-validation-common.ts";

export function validateAutomationInvocationResult(
  result: AutomationInvocationResult,
): void {
  requireExactObject(
    result,
    [
      "binding",
      "disposition",
      "historyItem",
      "message",
      "outbox",
      "record",
      "runEvent",
      "runState",
      "threadEvent",
      "threadState",
      "workItem",
    ],
    "automation_invocation_receipt_invalid",
  );
  validateAutomationRecord(result.record);
  if (result.disposition !== "committed" && result.disposition !== "replayed") {
    throw new AutomationStoreError("automation_invocation_receipt_invalid");
  }
  requireExactThreadState(result.threadState);
  requireExactAutomationMessage(result.message);
  requireExactObject(
    result.outbox,
    ["createdAt", "messageId", "payload", "runId", "tenantId", "topic"],
    "automation_invocation_receipt_invalid",
  );
  requireExactObject(
    result.workItem,
    ["createdAt", "kind", "payload", "runId", "tenantId", "workItemId"],
    "automation_invocation_receipt_invalid",
  );
  const input = {
    tenantId: result.record.definition.tenantId,
    spaceId: result.record.definition.spaceId,
    idempotency: {
      scope: "receipt-validation",
      key: "receipt-validation",
      requestFingerprint: "receipt-validation",
    },
    definitionFence: {
      automationId: result.record.definition.automationId,
      expectedRevision: result.record.definition.revision,
      expectedDefinitionDigest: result.record.definitionDigest,
    },
    threadFence: {
      threadId: result.record.definition.threadId,
      tenantId: result.record.definition.tenantId,
      spaceId: result.record.definition.spaceId,
      expectedRevision: result.threadState.revision - 1,
      expectedStatus: "active" as const,
      expectedHistorySequence: result.historyItem.sequence - 1,
      expectedActiveRunId: null,
    },
    binding: result.binding,
    instruction: result.message.content,
    threadEvent: result.threadEvent,
    message: result.message,
    historyItem: result.historyItem,
    runEvent: result.runEvent,
    outbox: result.outbox,
    workItem: result.workItem,
  } satisfies CommitAutomationInvocationInput;
  validateAutomationInvocationInputShape(input);
  const reducedRun = reduceRunLifecycleEvent(null, result.runEvent);
  validateAutomationInvocationArtifacts(
    input,
    result.record,
    result.threadState,
    reducedRun,
  );
  if (
    stableJson(result.runState) !== stableJson(reducedRun) ||
    result.threadState.status !== "active" ||
    result.threadState.lastEventSequence !== result.threadEvent.sequence ||
    result.threadState.lastMessageSequence !== result.message.sequence ||
    result.threadState.updatedAt !== result.threadEvent.occurredAt
  ) {
    throw new AutomationStoreError("automation_invocation_receipt_invalid");
  }
}

export function validateAutomationInvocationInputShape(
  input: CommitAutomationInvocationInput,
): void {
  requireExactObject(
    input,
    [
      "binding",
      "definitionFence",
      "historyItem",
      "idempotency",
      "instruction",
      "message",
      "outbox",
      "runEvent",
      "spaceId",
      "tenantId",
      "threadEvent",
      "threadFence",
      "workItem",
    ],
    "automation_invocation_input_invalid",
  );
  requireExactObject(
    input.definitionFence,
    ["automationId", "expectedDefinitionDigest", "expectedRevision"],
    "automation_invocation_input_invalid",
  );
  requireExactObject(
    input.threadFence,
    [
      "expectedActiveRunId",
      "expectedHistorySequence",
      "expectedRevision",
      "expectedStatus",
      "spaceId",
      "tenantId",
      "threadId",
    ],
    "automation_invocation_input_invalid",
  );
  requireExactAutomationMessage(input.message);
  requireExactObject(
    input.outbox,
    ["createdAt", "messageId", "payload", "runId", "tenantId", "topic"],
    "automation_invocation_input_invalid",
  );
  requireExactObject(
    input.workItem,
    ["createdAt", "kind", "payload", "runId", "tenantId", "workItemId"],
    "automation_invocation_input_invalid",
  );
  validateAutomationIdempotency(input.idempotency);
  try {
    const binding = parseAutomationInvocationBinding(input.binding);
    const messageOrigin = parseAutomationInvocationOrigin(input.message.origin);
    const historyOrigin = parseAutomationInvocationOrigin(input.historyItem.origin);
    const runOrigin = parseAutomationInvocationOrigin(input.runEvent.data.origin);
    validateModelHistoryItem(input.historyItem);
    if (
      stableJson(messageOrigin.binding) !== stableJson(binding) ||
      stableJson(historyOrigin.binding) !== stableJson(binding) ||
      stableJson(runOrigin.binding) !== stableJson(binding)
    ) {
      throw new Error("origin mismatch");
    }
  } catch (error) {
    throw new AutomationStoreError("automation_invocation_input_invalid", {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
