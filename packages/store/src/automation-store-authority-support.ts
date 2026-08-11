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
    ["definition", "definitionDigest"],
    "automation_record_invalid",
  );
  try {
    validateAutomationDefinition(record.definition);
  } catch (error) {
    throw new AutomationStoreError("automation_record_invalid", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (
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
    stableJson(record) !== stableJson(receipt.result.record)
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
    stableJson(authority.record) !== stableJson(result.record) ||
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

function sameImmutableMessage(
  authoritative: MessageRecord,
  receipt: MessageRecord,
): boolean {
  const { invalidation: _invalidation, ...base } = authoritative;
  return stableJson(base) === stableJson(receipt);
}

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
  let binding;
  try {
    binding = parseAutomationInvocationBinding(input.binding);
    const messageOrigin = parseAutomationInvocationOrigin(input.message.origin);
    const historyOrigin = parseAutomationInvocationOrigin(
      input.historyItem.origin,
    );
    const runOrigin = parseAutomationInvocationOrigin(
      input.runEvent.data.origin,
    );
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

function validateAutomationInvocationArtifacts(
  input: CommitAutomationInvocationInput,
  record: AutomationDefinitionRecord,
  threadState: ThreadState,
  runState: ReturnType<typeof reduceRunLifecycleEvent>,
): void {
  const definition = record.definition;
  const instruction = renderAutomationInstruction(definition);
  const instructionDigest = digest(instruction);
  const routeDigest = digest(
    stableJson({
      authorityId: input.runEvent.data.authorityId,
      runtimeGeneration: input.runEvent.data.runtimeGeneration,
      agentVersionId: input.runEvent.data.agentVersionId,
      policySnapshotId: input.runEvent.data.policySnapshotId,
      workspaceBindingId: input.runEvent.data.workspaceBindingId,
    }),
  );
  const origin = stableJson({ kind: "automation", binding: input.binding });
  if (
    input.instruction !== instruction ||
    input.binding.automationId !== definition.automationId ||
    input.binding.automationRevision !== definition.revision ||
    input.binding.definitionDigest !== record.definitionDigest ||
    input.binding.instructionDigest !== instructionDigest ||
    input.binding.routeDigest !== routeDigest ||
    input.binding.runId !== input.runEvent.identity.runId ||
    input.message.content !== instruction ||
    input.message.contentDigest !== instructionDigest ||
    input.message.role !== "user" ||
    input.message.proposedPlan !== null ||
    input.message.invalidation !== undefined ||
    input.historyItem.content !== instruction ||
    input.historyItem.contentDigest !== instructionDigest ||
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
    stableJson(input.workItem.payload) !==
      stableJson({
        schemaVersion: "crewon.automation-invocation-work-item.v0",
        trigger: "automationInvocation",
        throughSequence: 1,
        binding: input.binding,
      }) ||
    stableJson(input.outbox.payload) !==
      stableJson({
        eventId: input.runEvent.eventId,
        eventType: "run.created",
        throughSequence: 1,
      })
  ) {
    throw new AutomationStoreError("automation_invocation_authority_mismatch");
  }
}

function validateAutomationIdempotency(value: IdempotencyDescriptor): void {
  requireExactObject(
    value,
    ["key", "requestFingerprint", "scope"],
    "automation_idempotency_invalid",
  );
  requireBounded(value.scope, 512, "automation_idempotency_invalid");
  requireBounded(value.key, 256, "automation_idempotency_invalid");
  requireBounded(
    value.requestFingerprint,
    64 * 1024,
    "automation_idempotency_invalid",
  );
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function requireBounded(value: unknown, maxBytes: number, code: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new AutomationStoreError(code);
  }
}

function requireExactAutomationMessage(value: MessageRecord): void {
  requireExactObject(
    value,
    [
      "content",
      "contentDigest",
      "createdAt",
      "messageId",
      "origin",
      "proposedPlan",
      "role",
      "sequence",
      "tenantId",
      "threadId",
    ],
    "automation_invocation_input_invalid",
  );
}

function requireExactThreadState(value: ThreadState): void {
  requireExactObject(
    value,
    [
      "archivedAt",
      "createdAt",
      "createdByActorId",
      "deletedAt",
      "deletedByActorId",
      "forkedFromThreadId",
      "forkedThroughHistorySequence",
      "lastEventSequence",
      "lastMessageSequence",
      "revision",
      "spaceId",
      "status",
      "tenantId",
      "threadId",
      "title",
      "updatedAt",
    ],
    "automation_invocation_receipt_invalid",
  );
  try {
    validateThreadState(value);
  } catch (error) {
    throw new AutomationStoreError("automation_invocation_receipt_invalid", {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function requireNonEmpty(
  value: unknown,
  code: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AutomationStoreError(code);
  }
}

function requireExactObject(
  value: unknown,
  expectedKeys: readonly string[],
  code: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AutomationStoreError(code);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new AutomationStoreError(code);
  }
}
