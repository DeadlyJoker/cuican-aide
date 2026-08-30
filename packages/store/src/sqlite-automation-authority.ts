import type { DatabaseSync } from "node:sqlite";

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
  type WorkItem,
} from "@crewon/application";

import {
  normalizeAutomationStoreError,
  prepareAutomationCreate,
  prepareAutomationInvocation,
  replayAutomationCreateReceipt,
  replayAutomationInvocationReceipt,
  validateAutomationCreateReceiptQuery,
  validateAutomationInvocationReceiptQuery,
  type StoredAutomationInvocationReceipt,
} from "./automation-store-support.ts";
import {
  decodeSqliteAutomationRecord,
  type SqliteAutomationRow,
} from "./sqlite-automation-codec.ts";
import {
  loadSqliteAutomationCreateReceipt,
  loadSqliteAutomationInvocationReceipt,
  validateSqliteAutomationCreateReceipt,
  validateSqliteAutomationInvocationReceipt,
} from "./sqlite-automation-receipts.ts";
import { rollback } from "./sqlite-schema.ts";
import { requireNonEmpty, stableJson } from "./store-invariants.ts";

type InvocationAuthority = Parameters<
  typeof validateSqliteAutomationInvocationReceipt
>[1] extends (receipt: StoredAutomationInvocationReceipt) => infer T
  ? T
  : never;

export type SqliteAutomationOperations = Readonly<{
  assertOpen: () => void;
  hasPendingProviderSwitch: (tenantId: string) => boolean;
  loadThread: (locator: {
    tenantId: string;
    threadId: string;
  }) => ThreadState | null;
  loadRun: (locator: { tenantId: string; runId: string }) => RunState | null;
  loadHistory: (locator: {
    tenantId: string;
    threadId: string;
  }) => ModelHistoryItem[];
  threadEventIdExists: (id: string) => boolean;
  messageIdExists: (id: string) => boolean;
  historyItemIdExists: (id: string) => boolean;
  runEventIdExists: (id: string) => boolean;
  outboxIdExists: (id: string) => boolean;
  workItemIdExists: (id: string) => boolean;
  loadInvocationAuthority: (
    receipt: StoredAutomationInvocationReceipt,
  ) => InvocationAuthority;
  writeThreadSnapshot: (
    current: ThreadState | null,
    next: ThreadState,
    expectedRevision: number,
  ) => void;
  writeThreadEvents: (
    events: readonly ThreadLifecycleEvent[],
    tenantId: string,
  ) => void;
  writeMessages: (messages: readonly MessageRecord[]) => void;
  writeHistory: (items: readonly ModelHistoryItem[]) => void;
  writeRunSnapshot: (
    current: RunState | null,
    next: RunState,
    expectedRevision: number,
  ) => void;
  writeRunThreadBinding: (current: RunState | null, next: RunState) => void;
  writeRunEvents: (
    events: readonly RunLifecycleEvent[],
    tenantId: string,
  ) => void;
  writeOutbox: (messages: readonly OutboxMessage[]) => void;
  writeWorkItems: (items: readonly WorkItem[]) => void;
}>;

/** SQLite Automation authority with transaction boundaries kept beside its SQL. */
export class SqliteAutomationAuthority {
  readonly #database: DatabaseSync;
  readonly #operations: SqliteAutomationOperations;

  constructor(database: DatabaseSync, operations: SqliteAutomationOperations) {
    this.#database = database;
    this.#operations = operations;
  }

  async loadCreateReceipt(
    query: AutomationCreateReceiptQuery,
  ): Promise<AutomationCreateResult | null> {
    this.#operations.assertOpen();
    validateAutomationCreateReceiptQuery(query);
    try {
      this.#database.exec("BEGIN");
      const receipt = loadSqliteAutomationCreateReceipt(
        this.#database,
        query.tenantId,
        query.idempotency,
      );
      if (receipt !== null)
        validateSqliteAutomationCreateReceipt(receipt, (id) =>
          this.#loadRecord(id),
        );
      const result =
        receipt === null ? null : replayAutomationCreateReceipt(query, receipt);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw normalizeAutomationStoreError(error);
    }
  }

  async commitCreate(
    input: CommitAutomationCreateInput,
  ): Promise<AutomationCreateResult> {
    this.#operations.assertOpen();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const prior = loadSqliteAutomationCreateReceipt(
        this.#database,
        input.tenantId,
        input.idempotency,
      );
      if (prior !== null) {
        validateSqliteAutomationCreateReceipt(prior, (id) =>
          this.#loadRecord(id),
        );
        const replay = replayAutomationCreateReceipt(
          { tenantId: input.tenantId, idempotency: input.idempotency },
          prior,
        );
        this.#database.exec("COMMIT");
        return replay;
      }
      if (this.#operations.hasPendingProviderSwitch(input.tenantId))
        throw new RunStoreError("model_provider_settings_switch_pending");
      if (this.#loadRecord(input.record.definition.automationId) !== null)
        throw new RunStoreError("automation_id_conflict");
      const result = prepareAutomationCreate(
        input,
        this.#operations.loadThread({
          tenantId: input.tenantId,
          threadId: input.threadFence.threadId,
        }),
      );
      const record = result.record;
      this.#database
        .prepare(
          `INSERT INTO automations (
        tenant_id, space_id, automation_id, thread_id, revision,
        definition_digest, definition_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.definition.tenantId,
          record.definition.spaceId,
          record.definition.automationId,
          record.definition.threadId,
          record.definition.revision,
          record.definitionDigest,
          stableJson(record.definition),
          record.definition.updatedAt,
        );
      this.#database
        .prepare(
          `INSERT INTO automation_create_receipts (
        tenant_id, scope, idempotency_key, automation_id, fingerprint, result_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          record.definition.automationId,
          input.idempotency.requestFingerprint,
          stableJson(result),
        );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeAutomationStoreError(error);
    }
  }

  async load(
    locator: AutomationLocator,
  ): Promise<AutomationDefinitionRecord | null> {
    this.#operations.assertOpen();
    validateLocator(locator);
    try {
      return clone(this.#loadRecordInSpace(locator));
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async list(
    query: AutomationListQuery,
  ): Promise<readonly AutomationDefinitionRecord[]> {
    this.#operations.assertOpen();
    requireNonEmpty(query.tenantId, "tenant_id_invalid");
    requireNonEmpty(query.spaceId, "space_id_invalid");
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100
    )
      throw normalizeAutomationStoreError(
        new RunStoreError("automation_limit_invalid"),
      );
    try {
      const rows = this.#database
        .prepare(
          `SELECT tenant_id, space_id, automation_id, thread_id, revision,
        definition_digest, definition_json, updated_at FROM automations
        WHERE tenant_id = ? AND space_id = ? AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND automation_id < ?))
        ORDER BY updated_at DESC, automation_id DESC LIMIT ?`,
        )
        .all(
          query.tenantId,
          query.spaceId,
          query.before?.updatedAt ?? null,
          query.before?.updatedAt ?? null,
          query.before?.updatedAt ?? null,
          query.before?.automationId ?? null,
          query.limit,
        ) as unknown as SqliteAutomationRow[];
      return rows.map(decodeSqliteAutomationRecord);
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async listScheduled(
    query: ScheduledAutomationListQuery,
  ): Promise<readonly AutomationDefinitionRecord[]> {
    this.#operations.assertOpen();
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100
    ) {
      throw normalizeAutomationStoreError(
        new RunStoreError("automation_limit_invalid"),
      );
    }
    try {
      const rows = this.#database
        .prepare(
          `SELECT tenant_id, space_id, automation_id, thread_id, revision,
        definition_digest, definition_json, updated_at FROM automations
        WHERE json_extract(definition_json, '$.executionMode') = 'scheduled'
          AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND automation_id < ?))
        ORDER BY updated_at DESC, automation_id DESC LIMIT ?`,
        )
        .all(
          query.before?.updatedAt ?? null,
          query.before?.updatedAt ?? null,
          query.before?.updatedAt ?? null,
          query.before?.automationId ?? null,
          query.limit,
        ) as unknown as SqliteAutomationRow[];
      return rows.map(decodeSqliteAutomationRecord);
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async loadInvocationReceipt(
    query: AutomationInvocationReceiptQuery,
  ): Promise<AutomationInvocationResult | null> {
    this.#operations.assertOpen();
    validateAutomationInvocationReceiptQuery(query);
    try {
      this.#database.exec("BEGIN");
      const receipt = loadSqliteAutomationInvocationReceipt(
        this.#database,
        query.tenantId,
        query.idempotency,
      );
      if (receipt !== null)
        validateSqliteAutomationInvocationReceipt(
          receipt,
          this.#operations.loadInvocationAuthority,
        );
      const result =
        receipt === null
          ? null
          : replayAutomationInvocationReceipt(query, receipt);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw normalizeAutomationStoreError(error);
    }
  }

  async loadInvocationContext(
    locator: AutomationLocator,
  ): Promise<AutomationInvocationContext | null> {
    this.#operations.assertOpen();
    validateLocator(locator);
    try {
      const record = this.#loadRecordInSpace(locator);
      if (record === null) return null;
      const thread = this.#operations.loadThread({
        tenantId: locator.tenantId,
        threadId: record.definition.threadId,
      });
      if (thread === null || thread.spaceId !== locator.spaceId)
        throw new RunStoreError("automation_context_invalid");
      const row = this.#database
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM model_history_items WHERE tenant_id = ? AND thread_id = ?`,
        )
        .get(locator.tenantId, thread.threadId) as
        | { last_sequence: number }
        | undefined;
      const lastSequence = row?.last_sequence ?? 0;
      if (!Number.isSafeInteger(lastSequence) || lastSequence < 0)
        throw new RunStoreError("automation_context_invalid");
      return {
        record: clone(record),
        thread: clone(thread),
        historyHead: {
          tenantId: locator.tenantId,
          threadId: thread.threadId,
          lastSequence,
        },
      };
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async commitInvocation(
    input: CommitAutomationInvocationInput,
  ): Promise<AutomationInvocationResult> {
    this.#operations.assertOpen();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const prior = loadSqliteAutomationInvocationReceipt(
        this.#database,
        input.tenantId,
        input.idempotency,
      );
      if (prior !== null) {
        validateSqliteAutomationInvocationReceipt(
          prior,
          this.#operations.loadInvocationAuthority,
        );
        const replay = replayAutomationInvocationReceipt(
          {
            tenantId: input.tenantId,
            automationId: input.definitionFence.automationId,
            idempotency: input.idempotency,
          },
          prior,
        );
        this.#database.exec("COMMIT");
        return replay;
      }
      if (this.#operations.hasPendingProviderSwitch(input.tenantId))
        throw new RunStoreError("model_provider_settings_switch_pending");
      const record = this.#loadRecord(input.definitionFence.automationId);
      if (record === null || record.definition.tenantId !== input.tenantId)
        throw new RunStoreError("automation_not_found");
      const threadId = input.threadFence.threadId;
      const currentThread = this.#operations.loadThread({
        tenantId: input.tenantId,
        threadId,
      });
      const history = this.#operations.loadHistory({
        tenantId: input.tenantId,
        threadId,
      });
      const runRows = this.#database
        .prepare(
          `SELECT bindings.run_id FROM run_thread_bindings AS bindings WHERE bindings.tenant_id = ? AND bindings.thread_id = ?`,
        )
        .all(input.tenantId, threadId) as unknown as { run_id: string }[];
      const activeRunExists = runRows.some(({ run_id }) => {
        const run = this.#operations.loadRun({
          tenantId: input.tenantId,
          runId: run_id,
        });
        if (run === null)
          throw new RunStoreError("stored_run_thread_binding_invalid");
        return !isTerminal(run.status);
      });
      const workRows = this.#database
        .prepare(
          `SELECT work.status FROM work_items AS work JOIN run_thread_bindings AS bindings ON bindings.tenant_id = work.tenant_id AND bindings.run_id = work.run_id WHERE work.tenant_id = ? AND bindings.thread_id = ?`,
        )
        .all(input.tenantId, threadId) as unknown as { status: string }[];
      const unsettledWorkExists = workRows.some(({ status }) => {
        if (
          status !== "pending" &&
          status !== "leased" &&
          status !== "completed"
        )
          throw new RunStoreError("stored_work_item_status_invalid");
        return status !== "completed";
      });
      const result = prepareAutomationInvocation(input, {
        record,
        thread: currentThread,
        history,
        activeRunExists,
        unsettledWorkExists,
        runIdExists:
          this.#operations.loadRun({
            tenantId: input.tenantId,
            runId: input.binding.runId,
          }) !== null,
        threadEventIdExists: this.#operations.threadEventIdExists,
        messageIdExists: this.#operations.messageIdExists,
        historyItemIdExists: this.#operations.historyItemIdExists,
        runEventIdExists: this.#operations.runEventIdExists,
        outboxIdExists: this.#operations.outboxIdExists,
        workItemIdExists: this.#operations.workItemIdExists,
      });
      this.#operations.writeThreadSnapshot(
        currentThread,
        result.threadState,
        input.threadFence.expectedRevision,
      );
      this.#operations.writeThreadEvents([input.threadEvent], input.tenantId);
      this.#operations.writeMessages([input.message]);
      this.#operations.writeHistory([input.historyItem]);
      this.#operations.writeRunSnapshot(null, result.runState, 0);
      this.#operations.writeRunThreadBinding(null, result.runState);
      this.#operations.writeRunEvents([input.runEvent], input.tenantId);
      this.#operations.writeOutbox([input.outbox]);
      this.#operations.writeWorkItems([input.workItem]);
      this.#database
        .prepare(
          `INSERT INTO automation_invocation_receipts (tenant_id, scope, idempotency_key, automation_id, run_id, fingerprint, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          record.definition.automationId,
          input.binding.runId,
          input.idempotency.requestFingerprint,
          stableJson(result),
        );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeAutomationStoreError(error);
    }
  }

  #loadRecord(id: string): AutomationDefinitionRecord | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, space_id, automation_id, thread_id, revision, definition_digest, definition_json, updated_at FROM automations WHERE automation_id = ?`,
      )
      .get(id) as SqliteAutomationRow | undefined;
    return row === undefined ? null : decodeSqliteAutomationRecord(row);
  }
  #loadRecordInSpace(
    locator: AutomationLocator,
  ): AutomationDefinitionRecord | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, space_id, automation_id, thread_id, revision, definition_digest, definition_json, updated_at FROM automations WHERE tenant_id = ? AND space_id = ? AND automation_id = ?`,
      )
      .get(locator.tenantId, locator.spaceId, locator.automationId) as
      | SqliteAutomationRow
      | undefined;
    return row === undefined ? null : decodeSqliteAutomationRecord(row);
  }
}

function validateLocator(locator: AutomationLocator): void {
  requireNonEmpty(locator.tenantId, "tenant_id_invalid");
  requireNonEmpty(locator.spaceId, "space_id_invalid");
  requireNonEmpty(locator.automationId, "automation_id_invalid");
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function isTerminal(status: RunState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
