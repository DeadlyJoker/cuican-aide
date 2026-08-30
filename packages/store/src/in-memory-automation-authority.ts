import type {
  ModelHistoryItem,
  RunLifecycleEvent,
  RunState,
  ThreadLifecycleEvent,
  ThreadState,
} from "@crewon/domain";
import {
  RunStoreError,
  type AutomationCreateReceiptQuery,
  type AutomationCreateResult,
  type AutomationDefinitionRecord,
  type AutomationInvocationContext,
  type AutomationInvocationReceiptQuery,
  type AutomationInvocationResult,
  type AutomationListQuery,
  type ScheduledAutomationListQuery,
  type AutomationLocator,
  type CommitAutomationCreateInput,
  type CommitAutomationInvocationInput,
  type MessageRecord,
  type OutboxMessage,
  type PendingModelProviderSettings,
  type WorkItem,
} from "@crewon/application";

import {
  automationReceiptKey,
  normalizeAutomationStoreError,
  prepareAutomationCreate,
  prepareAutomationInvocation,
  replayAutomationCreateReceipt,
  replayAutomationInvocationReceipt,
  validateAutomationCreateReceiptAuthority,
  validateAutomationCreateReceiptQuery,
  validateAutomationInvocationReceiptAuthority,
  validateAutomationInvocationReceiptQuery,
  validateAutomationRecord,
  type StoredAutomationCreateReceipt,
  type StoredAutomationInvocationReceipt,
} from "./automation-store-support.ts";
import { queueRecord, type QueueRecord } from "./in-memory-queue.ts";
import { requireNonEmpty } from "./store-invariants.ts";

export type InMemoryAutomationState = Readonly<{
  automations: Map<string, AutomationDefinitionRecord>;
  createReceipts: Map<string, StoredAutomationCreateReceipt>;
  invocationReceipts: Map<string, StoredAutomationInvocationReceipt>;
  pendingProviderSettings: Map<string, PendingModelProviderSettings>;
  runs: Map<string, RunState>;
  runEvents: Map<string, RunLifecycleEvent[]>;
  runEventIds: Set<string>;
  threads: Map<string, ThreadState>;
  threadEvents: Map<string, ThreadLifecycleEvent[]>;
  threadEventIds: Set<string>;
  messages: Map<string, MessageRecord[]>;
  messageIds: Set<string>;
  modelHistory: Map<string, ModelHistoryItem[]>;
  modelHistoryItemIds: Set<string>;
  outbox: Map<string, QueueRecord<OutboxMessage>>;
  workItems: Map<string, QueueRecord<WorkItem>>;
  appendModelHistory: (
    threadId: string,
    items: readonly ModelHistoryItem[],
  ) => void;
}>;

/** Owns in-memory Automation reads, receipts, and atomic mutations. */
export class InMemoryAutomationAuthority {
  readonly #state: InMemoryAutomationState;

  constructor(state: InMemoryAutomationState) {
    this.#state = state;
  }

  async loadCreateReceipt(
    query: AutomationCreateReceiptQuery,
  ): Promise<AutomationCreateResult | null> {
    try {
      validateAutomationCreateReceiptQuery(query);
      const prior = this.#state.createReceipts.get(
        automationReceiptKey(query.tenantId, query.idempotency),
      );
      if (prior !== undefined) {
        validateAutomationCreateReceiptAuthority(
          prior,
          this.#state.automations.get(prior.automationId) ?? null,
        );
      }
      return prior === undefined
        ? null
        : replayAutomationCreateReceipt(query, clone(prior));
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async commitCreate(
    input: CommitAutomationCreateInput,
  ): Promise<AutomationCreateResult> {
    try {
      const key = automationReceiptKey(input.tenantId, input.idempotency);
      const prior = this.#state.createReceipts.get(key);
      if (prior !== undefined) {
        validateAutomationCreateReceiptAuthority(
          prior,
          this.#state.automations.get(prior.automationId) ?? null,
        );
        return replayAutomationCreateReceipt(
          { tenantId: input.tenantId, idempotency: input.idempotency },
          clone(prior),
        );
      }
      if (this.#state.pendingProviderSettings.has(input.tenantId)) {
        throw new RunStoreError("model_provider_settings_switch_pending");
      }
      const automationId = input.record.definition.automationId;
      if (this.#state.automations.has(automationId))
        throw new RunStoreError("automation_id_conflict");
      const result = prepareAutomationCreate(
        input,
        this.#state.threads.get(input.threadFence.threadId) ?? null,
      );
      this.#state.automations.set(automationId, clone(result.record));
      this.#state.createReceipts.set(key, {
        tenantId: input.tenantId,
        automationId,
        fingerprint: input.idempotency.requestFingerprint,
        result: clone(result),
      });
      return clone(result);
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async load(
    locator: AutomationLocator,
  ): Promise<AutomationDefinitionRecord | null> {
    try {
      requireNonEmpty(locator.tenantId, "tenant_id_invalid");
      requireNonEmpty(locator.spaceId, "space_id_invalid");
      requireNonEmpty(locator.automationId, "automation_id_invalid");
      const record = this.#state.automations.get(locator.automationId);
      if (
        record === undefined ||
        record.definition.tenantId !== locator.tenantId ||
        record.definition.spaceId !== locator.spaceId
      )
        return null;
      validateAutomationRecord(record);
      return clone(record);
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async list(
    query: AutomationListQuery,
  ): Promise<readonly AutomationDefinitionRecord[]> {
    try {
      requireNonEmpty(query.tenantId, "tenant_id_invalid");
      requireNonEmpty(query.spaceId, "space_id_invalid");
      if (
        !Number.isSafeInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > 100
      )
        throw new RunStoreError("automation_limit_invalid");
      return [...this.#state.automations.values()]
        .filter(
          (record) =>
            record.definition.tenantId === query.tenantId &&
            record.definition.spaceId === query.spaceId &&
            (query.before === null ||
              record.definition.updatedAt < query.before.updatedAt ||
              (record.definition.updatedAt === query.before.updatedAt &&
                record.definition.automationId < query.before.automationId)),
        )
        .sort(
          (left, right) =>
            right.definition.updatedAt.localeCompare(
              left.definition.updatedAt,
            ) ||
            right.definition.automationId.localeCompare(
              left.definition.automationId,
            ),
        )
        .slice(0, query.limit)
        .map((record) => {
          validateAutomationRecord(record);
          return clone(record);
        });
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async listScheduled(
    query: ScheduledAutomationListQuery,
  ): Promise<readonly AutomationDefinitionRecord[]> {
    try {
      if (
        !Number.isSafeInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > 100
      ) {
        throw new RunStoreError("automation_limit_invalid");
      }
      return [...this.#state.automations.values()]
        .filter(
          (record) =>
            record.definition.executionMode === "scheduled" &&
            (query.before === null ||
              record.definition.updatedAt < query.before.updatedAt ||
              (record.definition.updatedAt === query.before.updatedAt &&
                record.definition.automationId < query.before.automationId)),
        )
        .sort(
          (left, right) =>
            right.definition.updatedAt.localeCompare(
              left.definition.updatedAt,
            ) ||
            right.definition.automationId.localeCompare(
              left.definition.automationId,
            ),
        )
        .slice(0, query.limit)
        .map((record) => {
          validateAutomationRecord(record);
          return clone(record);
        });
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async loadInvocationReceipt(
    query: AutomationInvocationReceiptQuery,
  ): Promise<AutomationInvocationResult | null> {
    try {
      validateAutomationInvocationReceiptQuery(query);
      const prior = this.#state.invocationReceipts.get(
        automationReceiptKey(query.tenantId, query.idempotency),
      );
      if (prior !== undefined) this.#validateInvocationAuthority(prior);
      return prior === undefined
        ? null
        : replayAutomationInvocationReceipt(query, clone(prior));
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async loadInvocationContext(
    locator: AutomationLocator,
  ): Promise<AutomationInvocationContext | null> {
    try {
      const record = await this.load(locator);
      if (record === null) return null;
      const thread = this.#state.threads.get(record.definition.threadId);
      if (
        thread === undefined ||
        thread.tenantId !== locator.tenantId ||
        thread.spaceId !== locator.spaceId
      )
        throw new RunStoreError("automation_context_invalid");
      const history = this.#state.modelHistory.get(thread.threadId) ?? [];
      return {
        record,
        thread: clone(thread),
        historyHead: {
          tenantId: locator.tenantId,
          threadId: thread.threadId,
          lastSequence: history.at(-1)?.sequence ?? 0,
        },
      };
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async commitInvocation(
    input: CommitAutomationInvocationInput,
  ): Promise<AutomationInvocationResult> {
    try {
      const key = automationReceiptKey(input.tenantId, input.idempotency);
      const prior = this.#state.invocationReceipts.get(key);
      if (prior !== undefined) {
        this.#validateInvocationAuthority(prior);
        return replayAutomationInvocationReceipt(
          {
            tenantId: input.tenantId,
            automationId: input.definitionFence.automationId,
            idempotency: input.idempotency,
          },
          clone(prior),
        );
      }
      if (this.#state.pendingProviderSettings.has(input.tenantId))
        throw new RunStoreError("model_provider_settings_switch_pending");
      const record = this.#state.automations.get(
        input.definitionFence.automationId,
      );
      if (record === undefined || record.definition.tenantId !== input.tenantId)
        throw new RunStoreError("automation_not_found");
      const threadId = input.threadFence.threadId;
      const history = this.#state.modelHistory.get(threadId) ?? [];
      const activeRunExists = [...this.#state.runs.values()].some(
        (run) =>
          run.tenantId === input.tenantId &&
          run.threadId === threadId &&
          !isTerminalRunStatus(run.status),
      );
      const unsettledWorkExists = [...this.#state.workItems.values()].some(
        ({ item, status }) => {
          const run = this.#state.runs.get(item.runId);
          return (
            status !== "settled" &&
            run?.tenantId === input.tenantId &&
            run.threadId === threadId
          );
        },
      );
      const result = prepareAutomationInvocation(input, {
        record,
        thread: this.#state.threads.get(threadId) ?? null,
        history,
        activeRunExists,
        unsettledWorkExists,
        runIdExists: this.#state.runs.has(input.binding.runId),
        threadEventIdExists: (id) => this.#state.threadEventIds.has(id),
        messageIdExists: (id) => this.#state.messageIds.has(id),
        historyItemIdExists: (id) => this.#state.modelHistoryItemIds.has(id),
        runEventIdExists: (id) => this.#state.runEventIds.has(id),
        outboxIdExists: (id) => this.#state.outbox.has(id),
        workItemIdExists: (id) => this.#state.workItems.has(id),
      });
      const outboxRecord = queueRecord(input.outbox, input.outbox.createdAt);
      const workItemRecord = queueRecord(
        input.workItem,
        input.workItem.createdAt,
      );
      this.#state.threads.set(threadId, clone(result.threadState));
      this.#state.threadEvents.set(threadId, [
        ...(this.#state.threadEvents.get(threadId) ?? []),
        clone(input.threadEvent),
      ]);
      this.#state.threadEventIds.add(input.threadEvent.eventId);
      this.#state.messages.set(threadId, [
        ...(this.#state.messages.get(threadId) ?? []),
        clone(input.message),
      ]);
      this.#state.messageIds.add(input.message.messageId);
      this.#state.appendModelHistory(threadId, [input.historyItem]);
      this.#state.runs.set(input.binding.runId, clone(result.runState));
      this.#state.runEvents.set(input.binding.runId, [clone(input.runEvent)]);
      this.#state.runEventIds.add(input.runEvent.eventId);
      this.#state.outbox.set(input.outbox.messageId, outboxRecord);
      this.#state.workItems.set(input.workItem.workItemId, workItemRecord);
      this.#state.invocationReceipts.set(key, {
        tenantId: input.tenantId,
        automationId: record.definition.automationId,
        runId: input.binding.runId,
        fingerprint: input.idempotency.requestFingerprint,
        result: clone(result),
      });
      return clone(result);
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  #validateInvocationAuthority(
    receipt: StoredAutomationInvocationReceipt,
  ): void {
    const result = receipt.result;
    const threadId = result.record.definition.threadId;
    validateAutomationInvocationReceiptAuthority(receipt, {
      record: this.#state.automations.get(receipt.automationId) ?? null,
      thread: this.#state.threads.get(threadId) ?? null,
      threadEvents: this.#state.threadEvents.get(threadId) ?? [],
      message:
        (this.#state.messages.get(threadId) ?? []).find(
          ({ messageId }) => messageId === result.message.messageId,
        ) ?? null,
      historyItem:
        (this.#state.modelHistory.get(threadId) ?? []).find(
          ({ itemId }) => itemId === result.historyItem.itemId,
        ) ?? null,
      run: this.#state.runs.get(receipt.runId) ?? null,
      runEvents: this.#state.runEvents.get(receipt.runId) ?? [],
      outbox: this.#state.outbox.get(result.outbox.messageId)?.item ?? null,
      workItem:
        this.#state.workItems.get(result.workItem.workItemId)?.item ?? null,
    });
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isTerminalRunStatus(status: RunState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
