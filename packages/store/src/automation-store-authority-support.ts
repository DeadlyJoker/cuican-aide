import { createHash } from "node:crypto";

import {
  AutomationStoreError,
  RunStoreError,
  type AutomationCreateReceiptQuery,
  type AutomationCreateResult,
  type AutomationDefinitionRecord,
  type AutomationInvocationReceiptQuery,
  type AutomationInvocationResult,
  type CommitAutomationCreateInput,
  type CommitAutomationInvocationInput,
  type IdempotencyDescriptor,
  type MessageRecord,
  type OutboxMessage,
  type WorkItem,
} from "@crewon/application";
import {
  parseAutomationInvocationBinding,
  parseAutomationInvocationOrigin,
  parseAutomationScheduleState,
  reduceRunLifecycleEvent,
  reduceThreadLifecycleEvent,
  renderAutomationInstruction,
  validateAutomationDefinition,
  validateModelHistoryItem,
  validateThreadState,
  type ModelHistoryItem,
  type RunLifecycleEvent,
  type RunState,
  type ThreadLifecycleEvent,
  type ThreadState,
} from "@crewon/domain";

import {
  stableJson,
  validateEvents,
  validateMessages,
  validateModelHistoryAppend,
  validateOutbox,
  validateThreadEvents,
  validateWorkItems,
} from "./store-invariants.ts";
import {
  validateAutomationInvocationInputShape,
  validateAutomationInvocationResult,
} from "./automation-store-invocation-validation.ts";
import {
  digest,
  requireExactObject,
  validateAutomationIdempotency,
  validateAutomationInvocationArtifacts,
} from "./automation-store-validation-common.ts";

export type StoredAutomationCreateReceipt = Readonly<{
  tenantId: string;
  automationId: string;
  fingerprint: string;
  result: AutomationCreateResult;
}>;

export type StoredAutomationInvocationReceipt = Readonly<{
  tenantId: string;
  automationId: string;
  runId: string;
  fingerprint: string;
  result: AutomationInvocationResult;
}>;

export function normalizeAutomationStoreError(
  error: unknown,
): AutomationStoreError {
  if (error instanceof AutomationStoreError) return error;
  if (error instanceof RunStoreError) {
    return new AutomationStoreError(error.code, { cause: error });
  }
  return new AutomationStoreError("automation_store_error", {
    cause: error instanceof Error ? error : undefined,
  });
}

export function automationReceiptKey(
  tenantId: string,
  idempotency: IdempotencyDescriptor,
): string {
  requireNonEmpty(tenantId, "tenant_id_invalid");
  validateAutomationIdempotency(idempotency);
  return stableJson([tenantId, idempotency.scope, idempotency.key]);
}

export function validateAutomationCreateReceiptQuery(
  query: AutomationCreateReceiptQuery,
): void {
  requireExactObject(
    query,
    ["idempotency", "tenantId"],
    "automation_create_receipt_query_invalid",
  );
  requireNonEmpty(query.tenantId, "tenant_id_invalid");
  validateAutomationIdempotency(query.idempotency);
}

export function validateAutomationInvocationReceiptQuery(
  query: AutomationInvocationReceiptQuery,
): void {
  requireExactObject(
    query,
    ["automationId", "idempotency", "tenantId"],
    "automation_invocation_receipt_query_invalid",
  );
  requireNonEmpty(query.tenantId, "tenant_id_invalid");
  requireNonEmpty(query.automationId, "automation_id_invalid");
  validateAutomationIdempotency(query.idempotency);
}

export function validateAutomationRecord(
  record: AutomationDefinitionRecord,
): void {
  requireExactObject(
    record,
    ["definition", "definitionDigest", "scheduleState"],
    "automation_record_invalid",
  );
  try {
    validateAutomationDefinition(record.definition);
    parseAutomationScheduleState(record.scheduleState);
  } catch (error) {
    throw new AutomationStoreError("automation_record_invalid", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (
    record.scheduleState.automationId !== record.definition.automationId ||
    !isDigest(record.definitionDigest) ||
    digest(stableJson(record.definition)) !== record.definitionDigest
  ) {
    throw new AutomationStoreError("automation_record_invalid");
  }
}

export function prepareAutomationCreate(
  input: CommitAutomationCreateInput,
  thread: ThreadState | null,
): AutomationCreateResult {
  validateAutomationCreateInputShape(input);
  validateAutomationRecord(input.record);
  const definition = input.record.definition;
  const fence = input.threadFence;
  if (
    input.tenantId !== definition.tenantId ||
    fence.tenantId !== input.tenantId ||
    fence.threadId !== definition.threadId ||
    fence.spaceId !== definition.spaceId ||
    fence.expectedStatus !== "active"
  ) {
    throw new AutomationStoreError("automation_create_authority_mismatch");
  }
  if (thread === null || thread.tenantId !== input.tenantId) {
    throw new AutomationStoreError("thread_not_found");
  }
  if (thread.spaceId !== fence.spaceId) {
    throw new AutomationStoreError("thread_space_mismatch");
  }
  if (thread.status !== "active") {
    throw new AutomationStoreError("thread_not_active");
  }
  if (thread.revision !== fence.expectedRevision) {
    throw new AutomationStoreError("revision_conflict");
  }
  return { disposition: "committed", record: structuredClone(input.record) };
}

export function validateAutomationCreateInputShape(
  input: CommitAutomationCreateInput,
): void {
  requireExactObject(
    input,
    ["idempotency", "record", "tenantId", "threadFence"],
    "automation_create_input_invalid",
  );
  requireExactObject(
    input.threadFence,
    ["expectedRevision", "expectedStatus", "spaceId", "tenantId", "threadId"],
    "automation_create_input_invalid",
  );
  validateAutomationIdempotency(input.idempotency);
}

export function prepareAutomationInvocation(
  input: CommitAutomationInvocationInput,
  authority: Readonly<{
    record: AutomationDefinitionRecord;
    thread: ThreadState | null;
    history: readonly ModelHistoryItem[];
    activeRunExists: boolean;
    unsettledWorkExists: boolean;
    runIdExists: boolean;
    threadEventIdExists: (id: string) => boolean;
    messageIdExists: (id: string) => boolean;
    historyItemIdExists: (id: string) => boolean;
    runEventIdExists: (id: string) => boolean;
    outboxIdExists: (id: string) => boolean;
    workItemIdExists: (id: string) => boolean;
  }>,
): AutomationInvocationResult {
  validateAutomationRecord(authority.record);
  validateAutomationInvocationInputShape(input);
  const definition = authority.record.definition;
  const fence = input.threadFence;
  if (
    input.tenantId !== definition.tenantId ||
    input.spaceId !== definition.spaceId ||
    input.definitionFence.automationId !== definition.automationId ||
    input.definitionFence.expectedRevision !== definition.revision ||
    input.definitionFence.expectedDefinitionDigest !==
      authority.record.definitionDigest ||
    fence.tenantId !== definition.tenantId ||
    fence.spaceId !== definition.spaceId ||
    fence.threadId !== definition.threadId ||
    fence.expectedStatus !== "active" ||
    fence.expectedActiveRunId !== null
  ) {
    throw new AutomationStoreError("automation_invocation_authority_mismatch");
  }
  const currentThread = authority.thread;
  if (currentThread === null || currentThread.tenantId !== input.tenantId) {
    throw new AutomationStoreError("thread_not_found");
  }
  if (currentThread.spaceId !== input.spaceId) {
    throw new AutomationStoreError("thread_space_mismatch");
  }
  if (currentThread.status !== "active") {
    throw new AutomationStoreError("thread_not_active");
  }
  if (currentThread.revision !== fence.expectedRevision) {
    throw new AutomationStoreError("revision_conflict");
  }
  if (authority.activeRunExists) {
    throw new AutomationStoreError("thread_active_run_conflict");
  }
  if (authority.unsettledWorkExists) {
    throw new AutomationStoreError("thread_unsettled_work_conflict");
  }
  if (authority.runIdExists) {
    throw new AutomationStoreError("run_id_conflict");
  }
  if (fence.expectedHistorySequence !== authority.history.length) {
    throw new AutomationStoreError("model_history_sequence_conflict");
  }

  validateThreadEvents([input.threadEvent], definition.threadId, (id) =>
    authority.threadEventIdExists(id),
  );
  validateMessages(
    [input.message],
    [input.threadEvent],
    definition.threadId,
    definition.tenantId,
    authority.messageIdExists,
  );
  validateModelHistoryAppend(
    {
      expectedLastSequence: fence.expectedHistorySequence,
      items: [input.historyItem],
    },
    { tenantId: definition.tenantId, threadId: definition.threadId },
    authority.history,
    authority.historyItemIdExists,
  );
  validateEvents([input.runEvent], input.binding.runId, (id) =>
    authority.runEventIdExists(id),
  );
  validateOutbox(
    [input.outbox],
    input.binding.runId,
    definition.tenantId,
    authority.outboxIdExists,
  );
  validateWorkItems(
    [input.workItem],
    input.binding.runId,
    definition.tenantId,
    1,
    authority.workItemIdExists,
    "automationInvocation",
  );

  const nextThread = reduceThreadLifecycleEvent(
    currentThread,
    input.threadEvent,
  );
  const nextRun = reduceRunLifecycleEvent(null, input.runEvent);
  validateAutomationInvocationArtifacts(
    input,
    authority.record,
    nextThread,
    nextRun,
  );
  return {
    disposition: "committed",
    record: structuredClone(authority.record),
    binding: structuredClone(input.binding),
    threadState: structuredClone(nextThread),
    runState: structuredClone(
      nextRun,
    ) as AutomationInvocationResult["runState"],
    threadEvent: structuredClone(input.threadEvent),
    message: structuredClone(input.message),
    historyItem: structuredClone(input.historyItem),
    runEvent: structuredClone(input.runEvent),
    outbox: structuredClone(input.outbox),
    workItem: structuredClone(input.workItem),
  };
}

export function replayAutomationCreateReceipt(
  query: AutomationCreateReceiptQuery,
  receipt: StoredAutomationCreateReceipt,
): AutomationCreateResult {
  validateAutomationCreateReceiptQuery(query);
  validateAutomationCreateResult(receipt.result);
  if (
    receipt.tenantId !== query.tenantId ||
    receipt.fingerprint !== query.idempotency.requestFingerprint ||
    receipt.automationId !== receipt.result.record.definition.automationId ||
    receipt.result.record.definition.tenantId !== query.tenantId
  ) {
    throw receipt.fingerprint !== query.idempotency.requestFingerprint
      ? new AutomationStoreError("idempotency_conflict")
      : new AutomationStoreError("automation_create_receipt_invalid");
  }
  return structuredClone({ ...receipt.result, disposition: "replayed" });
}

export function replayAutomationInvocationReceipt(
  query: AutomationInvocationReceiptQuery,
  receipt: StoredAutomationInvocationReceipt,
): AutomationInvocationResult {
  validateAutomationInvocationReceiptQuery(query);
  validateAutomationInvocationResult(receipt.result);
  if (
    receipt.tenantId !== query.tenantId ||
    receipt.fingerprint !== query.idempotency.requestFingerprint ||
    receipt.automationId !== query.automationId ||
    receipt.automationId !== receipt.result.binding.automationId ||
    receipt.runId !== receipt.result.binding.runId
  ) {
    throw receipt.fingerprint !== query.idempotency.requestFingerprint
      ? new AutomationStoreError("idempotency_conflict")
      : new AutomationStoreError("automation_invocation_receipt_invalid");
  }
  return structuredClone({ ...receipt.result, disposition: "replayed" });
}

export function validateAutomationCreateResult(
  result: AutomationCreateResult,
): void {
  requireExactObject(
    result,
    ["disposition", "record"],
    "automation_create_receipt_invalid",
  );
  if (result.disposition !== "committed" && result.disposition !== "replayed") {
    throw new AutomationStoreError("automation_create_receipt_invalid");
  }
  validateAutomationRecord(result.record);
}

export function validateAutomationCreateReceiptAuthority(
  receipt: StoredAutomationCreateReceipt,
  record: AutomationDefinitionRecord | null,
): void {
  validateAutomationCreateResult(receipt.result);
  if (
    record === null ||
    !isAutomationRecordEvolution(receipt.result.record, record)
  ) {
    throw new AutomationStoreError("automation_create_receipt_invalid");
  }
}

export function validateAutomationInvocationReceiptAuthority(
  receipt: StoredAutomationInvocationReceipt,
  authority: Readonly<{
    record: AutomationDefinitionRecord | null;
    thread: ThreadState | null;
    threadEvents: readonly ThreadLifecycleEvent[];
    message: MessageRecord | null;
    historyItem: ModelHistoryItem | null;
    run: RunState | null;
    runEvents: readonly RunLifecycleEvent[];
    outbox: OutboxMessage | null;
    workItem: WorkItem | null;
  }>,
): void {
  validateAutomationInvocationResult(receipt.result);
  let reducedThread: ThreadState | null = null;
  let receiptThreadState: ThreadState | null = null;
  let reducedRun: RunState | null = null;
  let receiptRunState: RunState | null = null;
  try {
    for (const event of authority.threadEvents) {
      reducedThread = reduceThreadLifecycleEvent(reducedThread, event);
      if (event.eventId === receipt.result.threadEvent.eventId) {
        receiptThreadState = structuredClone(reducedThread);
      }
    }
    for (const event of authority.runEvents) {
      reducedRun = reduceRunLifecycleEvent(reducedRun, event);
      if (event.eventId === receipt.result.runEvent.eventId) {
        receiptRunState = structuredClone(reducedRun);
      }
    }
  } catch (error) {
    throw new AutomationStoreError("automation_invocation_receipt_invalid", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  const result = receipt.result;
  const receiptThreadEvent = authority.threadEvents.find(
    (event) => event.eventId === result.threadEvent.eventId,
  );
  const receiptRunEvent = authority.runEvents.find(
    (event) => event.eventId === result.runEvent.eventId,
  );
  if (
    authority.record === null ||
    !isAutomationRecordEvolution(result.record, authority.record) ||
    authority.thread === null ||
    reducedThread === null ||
    stableJson(authority.thread) !== stableJson(reducedThread) ||
    receiptThreadState === null ||
    stableJson(receiptThreadState) !== stableJson(result.threadState) ||
    receiptThreadEvent === undefined ||
    stableJson(receiptThreadEvent) !== stableJson(result.threadEvent) ||
    authority.message === null ||
    !sameImmutableMessage(authority.message, result.message) ||
    authority.historyItem === null ||
    stableJson(authority.historyItem) !== stableJson(result.historyItem) ||
    authority.run === null ||
    reducedRun === null ||
    stableJson(authority.run) !== stableJson(reducedRun) ||
    receiptRunState === null ||
    stableJson(receiptRunState) !== stableJson(result.runState) ||
    receiptRunEvent === undefined ||
    stableJson(receiptRunEvent) !== stableJson(result.runEvent) ||
    authority.outbox === null ||
    stableJson(authority.outbox) !== stableJson(result.outbox) ||
    authority.workItem === null ||
    stableJson(authority.workItem) !== stableJson(result.workItem)
  ) {
    throw new AutomationStoreError("automation_invocation_receipt_invalid");
  }
}

function isAutomationRecordEvolution(
  receipt: AutomationDefinitionRecord,
  current: AutomationDefinitionRecord,
): boolean {
  return (
    stableJson(current.definition) === stableJson(receipt.definition) &&
    current.definitionDigest === receipt.definitionDigest &&
    current.scheduleState.automationId === receipt.scheduleState.automationId &&
    current.scheduleState.scheduleRevision ===
      receipt.scheduleState.scheduleRevision &&
    current.scheduleState.revision >= receipt.scheduleState.revision
  );
}

function sameImmutableMessage(
  authoritative: MessageRecord,
  receipt: MessageRecord,
): boolean {
  const { invalidation: _invalidation, ...base } = authoritative;
  return stableJson(base) === stableJson(receipt);
}
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function requireNonEmpty(
  value: unknown,
  code: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AutomationStoreError(code);
  }
}
