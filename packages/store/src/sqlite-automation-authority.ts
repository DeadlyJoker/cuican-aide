import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { parseAutomationScheduleState } from "@crewon/domain";
import type {
  ModelHistoryItem,
  RunLifecycleEvent,
  RunState,
  ThreadLifecycleEvent,
  ThreadState,
} from "@crewon/domain";
import {
  RunStoreError,
  latestAutomationScheduleOccurrence,
  type AutomationCreateReceiptQuery,
  type AutomationCreateResult,
  type AutomationDefinitionRecord,
  type AutomationInvocationContext,
  type AutomationInvocationReceiptQuery,
  type AutomationInvocationResult,
  type AutomationScheduleClaim,
  type AutomationScheduleClaimInput,
  type AutomationScheduleLeaseInput,
  type CommitScheduledAutomationInvocationInput,
  type AutomationListQuery,
  type AutomationLocator,
  type CommitAutomationCreateInput,
  type CommitAutomationInvocationInput,
  type MessageRecord,
  type OutboxMessage,
  type WorkItem,
  type RetryAutomationScheduleClaimInput,
  type ScheduledAutomationReceiptQuery,
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

type SqliteScheduleClaimRow = SqliteAutomationRow &
  Readonly<{ claim_epoch: number | null }>;

type StoredScheduleClaimRow = Readonly<{
  tenant_id: string;
  automation_id: string;
  schedule_revision: number;
  scheduled_for: string;
  occurrence_digest: string;
  observed_at: string;
  lease_owner_id: string;
  lease_id: string;
  lease_epoch: number;
  lease_expires_at: string;
}>;

type ScheduledReceiptRow = Readonly<{
  tenant_id: string;
  automation_id: string;
  schedule_revision: number;
  scheduled_for: string;
  occurrence_digest: string;
  run_id: string;
  fingerprint: string;
  result_json: string;
}>;

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
        definition_digest, definition_json, schedule_state_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.definition.tenantId,
          record.definition.spaceId,
          record.definition.automationId,
          record.definition.threadId,
          record.definition.revision,
          record.definitionDigest,
          stableJson(record.definition),
          stableJson(record.scheduleState),
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
        definition_digest, definition_json, schedule_state_json, updated_at FROM automations
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
      const result = this.#commitInvocationInTransaction(input);
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeAutomationStoreError(error);
    }
  }

  async claimNextDueAutomation(
    input: AutomationScheduleClaimInput,
  ): Promise<AutomationScheduleClaim | null> {
    this.#operations.assertOpen();
    validateClaimInput(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const row = this.#database
        .prepare(
          `SELECT a.tenant_id, a.space_id, a.automation_id, a.thread_id,
                  a.revision, a.definition_digest, a.definition_json,
                  a.schedule_state_json, a.updated_at,
                  c.lease_epoch AS claim_epoch
           FROM automations AS a
           LEFT JOIN automation_schedule_claims AS c
             ON c.tenant_id = a.tenant_id AND c.automation_id = a.automation_id
           WHERE json_extract(a.schedule_state_json, '$.status') = 'enabled'
             AND json_extract(a.schedule_state_json, '$.nextOccurrenceAt') IS NOT NULL
             AND julianday(COALESCE(
                   json_extract(a.schedule_state_json, '$.retryAt'),
                   json_extract(a.schedule_state_json, '$.nextOccurrenceAt')
                 )) <= julianday(?)
             AND (c.lease_expires_at IS NULL OR julianday(c.lease_expires_at) <= julianday(?))
           ORDER BY julianday(COALESCE(
                      json_extract(a.schedule_state_json, '$.retryAt'),
                      json_extract(a.schedule_state_json, '$.nextOccurrenceAt')
                    )), a.automation_id
           LIMIT 1`,
        )
        .get(input.observedAt, input.observedAt) as
        | SqliteScheduleClaimRow
        | undefined;
      if (row === undefined) {
        this.#database.exec("COMMIT");
        return null;
      }
      const record = decodeSqliteAutomationRecord(row);
      const nextOccurrenceAt = record.scheduleState.nextOccurrenceAt;
      if (nextOccurrenceAt === null)
        throw new RunStoreError("automation_schedule_state_invalid");
      const scheduledFor =
        record.scheduleState.retryAt === null
          ? latestAutomationScheduleOccurrence({
              schedule: record.definition.schedule,
              through: input.observedAt,
            })
          : nextOccurrenceAt;
      if (
        scheduledFor === null ||
        Date.parse(scheduledFor) < Date.parse(nextOccurrenceAt)
      ) {
        throw new RunStoreError("automation_schedule_state_invalid");
      }
      const occurrenceDigest = scheduleOccurrenceDigest(record, scheduledFor);
      const leaseEpoch = (row.claim_epoch ?? 0) + 1;
      const expiresAt = new Date(
        Date.parse(input.observedAt) + input.leaseDurationMs,
      ).toISOString();
      this.#database
        .prepare(
          `INSERT INTO automation_schedule_claims (
             tenant_id, automation_id, schedule_revision, scheduled_for,
             occurrence_digest, observed_at, lease_owner_id, lease_id,
             lease_epoch, lease_expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, automation_id) DO UPDATE SET
             schedule_revision=excluded.schedule_revision,
             scheduled_for=excluded.scheduled_for,
             occurrence_digest=excluded.occurrence_digest,
             observed_at=excluded.observed_at,
             lease_owner_id=excluded.lease_owner_id,
             lease_id=excluded.lease_id,
             lease_epoch=excluded.lease_epoch,
             lease_expires_at=excluded.lease_expires_at`,
        )
        .run(
          record.definition.tenantId,
          record.definition.automationId,
          record.scheduleState.scheduleRevision,
          scheduledFor,
          occurrenceDigest,
          input.observedAt,
          input.ownerId,
          input.leaseId,
          leaseEpoch,
          expiresAt,
        );
      this.#database.exec("COMMIT");
      return {
        record: clone(record),
        scheduledFor,
        observedAt: input.observedAt,
        occurrenceDigest,
        lease: {
          ownerId: input.ownerId,
          leaseId: input.leaseId,
          epoch: leaseEpoch,
          expiresAt,
        },
      };
    } catch (error) {
      rollback(this.#database);
      throw normalizeAutomationStoreError(error);
    }
  }

  async loadScheduledAutomationReceipt(
    query: ScheduledAutomationReceiptQuery,
  ): Promise<AutomationInvocationResult | null> {
    this.#operations.assertOpen();
    validateScheduledReceiptQuery(query);
    try {
      return clone(this.#loadScheduledReceipt(query));
    } catch (error) {
      throw normalizeAutomationStoreError(error);
    }
  }

  async commitScheduledAutomationInvocation(
    input: CommitScheduledAutomationInvocationInput,
  ): Promise<AutomationInvocationResult> {
    this.#operations.assertOpen();
    validateScheduledReceiptQuery(input.receipt);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const prior = this.#loadScheduledReceipt(input.receipt);
      if (prior !== null) {
        this.#database.exec("COMMIT");
        return clone(prior);
      }
      const { claim, record } = this.#requireScheduleLease(input.lease);
      const nextState = parseAutomationScheduleState(input.nextScheduleState);
      if (
        record.definitionDigest !== input.expectedDefinitionDigest ||
        record.scheduleState.revision !== input.expectedScheduleStateRevision ||
        claim.occurrence_digest !== input.receipt.occurrenceDigest ||
        input.receipt.tenantId !== record.definition.tenantId ||
        input.receipt.automationId !== record.definition.automationId ||
        input.receipt.scheduleRevision !==
          record.scheduleState.scheduleRevision ||
        input.receipt.scheduledFor !== claim.scheduled_for ||
        nextState.automationId !== record.definition.automationId ||
        nextState.scheduleRevision !== record.scheduleState.scheduleRevision ||
        nextState.revision !== record.scheduleState.revision + 1 ||
        nextState.lastScheduledFor !== claim.scheduled_for ||
        nextState.retryAt !== null ||
        input.invocation.binding.trigger.kind !== "schedule" ||
        input.invocation.binding.trigger.scheduleRevision !==
          claim.schedule_revision ||
        input.invocation.binding.trigger.scheduledFor !== claim.scheduled_for ||
        input.invocation.binding.trigger.occurrenceDigest !==
          claim.occurrence_digest
      ) {
        throw new RunStoreError("automation_schedule_commit_invalid");
      }
      const result = this.#commitInvocationInTransaction(input.invocation);
      const updated = this.#database
        .prepare(
          `UPDATE automations SET schedule_state_json = ?
           WHERE tenant_id = ? AND automation_id = ? AND definition_digest = ?`,
        )
        .run(
          stableJson(nextState),
          record.definition.tenantId,
          record.definition.automationId,
          record.definitionDigest,
        );
      if (updated.changes !== 1)
        throw new RunStoreError("automation_schedule_commit_invalid");
      this.#database
        .prepare(
          `INSERT INTO automation_scheduled_invocation_receipts (
             tenant_id, automation_id, schedule_revision, scheduled_for,
             occurrence_digest, invocation_scope, invocation_key, run_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.receipt.tenantId,
          input.receipt.automationId,
          input.receipt.scheduleRevision,
          input.receipt.scheduledFor,
          input.receipt.occurrenceDigest,
          input.invocation.idempotency.scope,
          input.invocation.idempotency.key,
          result.runState.runId,
        );
      this.#deleteScheduleClaim(claim);
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeAutomationStoreError(error);
    }
  }

  async retryAutomationScheduleClaim(
    input: RetryAutomationScheduleClaimInput,
  ): Promise<void> {
    validateTimestamp(input.retryAt, "automation_schedule_retry_at_invalid");
    requireNonEmpty(input.reasonCode, "automation_schedule_reason_invalid");
    await this.#settleScheduleClaim(input, "retry");
  }

  async disableAutomationScheduleClaim(
    input: AutomationScheduleLeaseInput & Readonly<{ reasonCode: string }>,
  ): Promise<void> {
    requireNonEmpty(input.reasonCode, "automation_schedule_reason_invalid");
    await this.#settleScheduleClaim(input, "disable");
  }

  #loadScheduledReceipt(
    query: ScheduledAutomationReceiptQuery,
  ): AutomationInvocationResult | null {
    const row = this.#database
      .prepare(
        `SELECT scheduled.tenant_id, scheduled.automation_id,
                scheduled.schedule_revision, scheduled.scheduled_for,
                scheduled.occurrence_digest, scheduled.run_id,
                invocation.fingerprint, invocation.result_json
         FROM automation_scheduled_invocation_receipts AS scheduled
         JOIN automation_invocation_receipts AS invocation
           ON invocation.tenant_id = scheduled.tenant_id
          AND invocation.scope = scheduled.invocation_scope
          AND invocation.idempotency_key = scheduled.invocation_key
         WHERE scheduled.tenant_id = ? AND scheduled.automation_id = ?
           AND scheduled.schedule_revision = ? AND scheduled.scheduled_for = ?`,
      )
      .get(
        query.tenantId,
        query.automationId,
        query.scheduleRevision,
        query.scheduledFor,
      ) as ScheduledReceiptRow | undefined;
    if (row === undefined) return null;
    let result: AutomationInvocationResult;
    try {
      result = JSON.parse(row.result_json) as AutomationInvocationResult;
    } catch (error) {
      throw new RunStoreError("automation_scheduled_receipt_invalid", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    const stored = {
      tenantId: row.tenant_id,
      automationId: row.automation_id,
      runId: row.run_id,
      fingerprint: row.fingerprint,
      result,
    };
    validateSqliteAutomationInvocationReceipt(
      stored,
      this.#operations.loadInvocationAuthority,
    );
    const trigger = result.binding.trigger;
    if (
      row.occurrence_digest !== query.occurrenceDigest ||
      row.schedule_revision !== query.scheduleRevision ||
      row.scheduled_for !== query.scheduledFor ||
      trigger.kind !== "schedule" ||
      trigger.scheduleRevision !== query.scheduleRevision ||
      trigger.scheduledFor !== query.scheduledFor ||
      trigger.occurrenceDigest !== query.occurrenceDigest
    ) {
      throw new RunStoreError("automation_scheduled_receipt_invalid");
    }
    return { ...result, disposition: "replayed" };
  }

  #requireScheduleLease(input: AutomationScheduleLeaseInput): {
    claim: StoredScheduleClaimRow;
    record: AutomationDefinitionRecord;
  } {
    validateScheduleLease(input);
    const claim = this.#database
      .prepare(
        `SELECT tenant_id, automation_id, schedule_revision, scheduled_for,
                occurrence_digest, observed_at, lease_owner_id, lease_id,
                lease_epoch, lease_expires_at
         FROM automation_schedule_claims
         WHERE tenant_id = ? AND automation_id = ?`,
      )
      .get(input.tenantId, input.automationId) as
      | StoredScheduleClaimRow
      | undefined;
    if (
      claim === undefined ||
      claim.schedule_revision !== input.scheduleRevision ||
      claim.scheduled_for !== input.scheduledFor ||
      claim.lease_owner_id !== input.ownerId ||
      claim.lease_id !== input.leaseId ||
      claim.lease_epoch !== input.leaseEpoch
    ) {
      throw new RunStoreError("automation_schedule_lease_lost");
    }
    const record = this.#loadRecord(input.automationId);
    if (
      record === null ||
      record.definition.tenantId !== input.tenantId ||
      record.scheduleState.scheduleRevision !== input.scheduleRevision ||
      record.scheduleState.nextOccurrenceAt === null ||
      Date.parse(record.scheduleState.nextOccurrenceAt) >
        Date.parse(input.scheduledFor)
    ) {
      throw new RunStoreError("automation_schedule_lease_lost");
    }
    return { claim, record };
  }

  async #settleScheduleClaim(
    input:
      | RetryAutomationScheduleClaimInput
      | (AutomationScheduleLeaseInput & Readonly<{ reasonCode: string }>),
    disposition: "retry" | "disable",
  ): Promise<void> {
    this.#operations.assertOpen();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const { claim, record } = this.#requireScheduleLease(input);
      const retryAt =
        disposition === "retry" && "retryAt" in input ? input.retryAt : null;
      const nextState = parseAutomationScheduleState({
        ...record.scheduleState,
        status: disposition === "disable" ? "disabled" : "enabled",
        nextOccurrenceAt:
          disposition === "retry"
            ? claim.scheduled_for
            : record.scheduleState.nextOccurrenceAt,
        retryAt,
        revision: record.scheduleState.revision + 1,
        updatedAt: retryAt ?? claim.observed_at,
      });
      const updated = this.#database
        .prepare(
          `UPDATE automations SET schedule_state_json = ?
           WHERE tenant_id = ? AND automation_id = ? AND definition_digest = ?`,
        )
        .run(
          stableJson(nextState),
          record.definition.tenantId,
          record.definition.automationId,
          record.definitionDigest,
        );
      if (updated.changes !== 1)
        throw new RunStoreError("automation_schedule_lease_lost");
      this.#deleteScheduleClaim(claim);
      this.#database.exec("COMMIT");
    } catch (error) {
      rollback(this.#database);
      throw normalizeAutomationStoreError(error);
    }
  }

  #deleteScheduleClaim(claim: StoredScheduleClaimRow): void {
    const deleted = this.#database
      .prepare(
        `DELETE FROM automation_schedule_claims
         WHERE tenant_id = ? AND automation_id = ? AND lease_id = ? AND lease_epoch = ?`,
      )
      .run(
        claim.tenant_id,
        claim.automation_id,
        claim.lease_id,
        claim.lease_epoch,
      );
    if (deleted.changes !== 1)
      throw new RunStoreError("automation_schedule_lease_lost");
  }

  #commitInvocationInTransaction(
    input: CommitAutomationInvocationInput,
  ): AutomationInvocationResult {
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
      return replayAutomationInvocationReceipt(
        {
          tenantId: input.tenantId,
          automationId: input.definitionFence.automationId,
          idempotency: input.idempotency,
        },
        prior,
      );
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
      if (status !== "pending" && status !== "leased" && status !== "completed")
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
    return result;
  }

  #loadRecord(id: string): AutomationDefinitionRecord | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, space_id, automation_id, thread_id, revision, definition_digest, definition_json, schedule_state_json, updated_at FROM automations WHERE automation_id = ?`,
      )
      .get(id) as SqliteAutomationRow | undefined;
    return row === undefined ? null : decodeSqliteAutomationRecord(row);
  }
  #loadRecordInSpace(
    locator: AutomationLocator,
  ): AutomationDefinitionRecord | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, space_id, automation_id, thread_id, revision, definition_digest, definition_json, schedule_state_json, updated_at FROM automations WHERE tenant_id = ? AND space_id = ? AND automation_id = ?`,
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

function validateClaimInput(input: AutomationScheduleClaimInput): void {
  requireNonEmpty(input.ownerId, "automation_schedule_owner_invalid");
  requireNonEmpty(input.leaseId, "automation_schedule_lease_id_invalid");
  validateTimestamp(
    input.observedAt,
    "automation_schedule_observed_at_invalid",
  );
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1 ||
    input.leaseDurationMs > 24 * 60 * 60 * 1_000
  ) {
    throw new RunStoreError("automation_schedule_lease_duration_invalid");
  }
}

function validateScheduleLease(input: AutomationScheduleLeaseInput): void {
  requireNonEmpty(input.tenantId, "tenant_id_invalid");
  requireNonEmpty(input.automationId, "automation_id_invalid");
  requireNonEmpty(input.ownerId, "automation_schedule_owner_invalid");
  requireNonEmpty(input.leaseId, "automation_schedule_lease_id_invalid");
  validateTimestamp(input.scheduledFor, "automation_scheduled_for_invalid");
  if (
    input.scheduleRevision !== 1 ||
    !Number.isSafeInteger(input.leaseEpoch) ||
    input.leaseEpoch < 1
  ) {
    throw new RunStoreError("automation_schedule_lease_invalid");
  }
}

function validateScheduledReceiptQuery(
  query: ScheduledAutomationReceiptQuery,
): void {
  requireNonEmpty(query.tenantId, "tenant_id_invalid");
  requireNonEmpty(query.automationId, "automation_id_invalid");
  requireNonEmpty(
    query.occurrenceDigest,
    "automation_occurrence_digest_invalid",
  );
  validateTimestamp(query.scheduledFor, "automation_scheduled_for_invalid");
  if (
    query.scheduleRevision !== 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(query.occurrenceDigest)
  ) {
    throw new RunStoreError("automation_scheduled_receipt_query_invalid");
  }
}

function validateTimestamp(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new RunStoreError(code);
}

function scheduleOccurrenceDigest(
  record: AutomationDefinitionRecord,
  scheduledFor: string,
): string {
  return `sha256:${createHash("sha256")
    .update(
      stableJson({
        schemaVersion: "crewon.automation-schedule-occurrence.v1",
        automationId: record.definition.automationId,
        scheduleRevision: record.scheduleState.scheduleRevision,
        scheduledFor,
        definitionDigest: record.definitionDigest,
      }),
    )
    .digest("hex")}`;
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function isTerminal(status: RunState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
