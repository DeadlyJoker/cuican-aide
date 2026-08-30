import {
  AutomationStoreError,
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
  type ModelHistoryItem,
  type RunLifecycleEvent,
  type RunState,
  type ThreadLifecycleEvent,
  type ThreadState,
} from "@crewon/domain";
import { type Pool, type PoolClient } from "pg";

import {
  normalizeAutomationStoreError,
  prepareAutomationCreate,
  prepareAutomationInvocation,
  replayAutomationCreateReceipt,
  replayAutomationInvocationReceipt,
  validateAutomationCreateReceiptAuthority,
  validateAutomationCreateReceiptQuery,
  validateAutomationCreateInputShape,
  validateAutomationInvocationReceiptAuthority,
  validateAutomationInvocationReceiptQuery,
  validateAutomationInvocationInputShape,
  validateAutomationRecord,
  type StoredAutomationCreateReceipt,
  type StoredAutomationInvocationReceipt,
} from "./automation-store-support.ts";
import { requireNonEmpty } from "./store-invariants.ts";
import { assertPostgresProviderSettingsAdmissionOpen } from "./postgres-model-provider-settings-store.ts";
import {
  decodePostgresOutbox,
  decodePostgresWorkItem,
  type PostgresQueueItemRow,
} from "./postgres-queue-codec.ts";
import {
  decodePostgresRunEvent,
  decodePostgresRunState,
  type PostgresRunEventRow,
  type PostgresRunRow,
} from "./postgres-run-codec.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import {
  decodePostgresMessage,
  decodePostgresModelHistoryItem,
  decodePostgresThreadState,
  safeInteger,
  type PostgresMessageRow,
  type PostgresModelHistoryRow,
  type PostgresThreadRow,
} from "./postgres-thread-codec.ts";
import {
  writePostgresOutbox,
  writePostgresRunEvents,
  writePostgresRunSnapshot,
  writePostgresWorkItems,
} from "./postgres-run-writer.ts";
import {
  writePostgresMessages,
  writePostgresModelHistory,
  writePostgresThreadEvents,
  writePostgresThreadSnapshot,
} from "./postgres-thread-writer.ts";
import { stableJson } from "./store-invariants.ts";
import {
  decodeStoredThreadEvent,
  validateStoredThreadEventPage,
} from "./thread-event-support.ts";

import {
  automationPostgresError,
  decodeAutomationRow,
  loadAutomationRecord,
  loadAutomationRecordInSpace,
  loadCreateReceipt,
  loadInvocationReceipt,
  loadThread,
  validateInvocationReceiptAuthority,
  type AutomationRow,
} from "./postgres-automation-context.ts";

export async function loadPostgresAutomationCreateReceipt(
  pool: Pool,
  schema: string,
  query: AutomationCreateReceiptQuery,
): Promise<AutomationCreateResult | null> {
  validateAutomationCreateReceiptQuery(query);
  const client = await pool.connect();
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const receipt = await loadCreateReceipt(
      client,
      schema,
      query.tenantId,
      query.idempotency,
    );
    if (receipt !== null) {
      validateAutomationCreateReceiptAuthority(
        receipt,
        await loadAutomationRecord(client, schema, receipt.automationId),
      );
    }
    const result =
      receipt === null ? null : replayAutomationCreateReceipt(query, receipt);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackPostgres(client);
    throw automationPostgresError(error);
  } finally {
    client.release();
  }
}

export async function loadPostgresAutomation(
  pool: Pool,
  schema: string,
  locator: AutomationLocator,
): Promise<AutomationDefinitionRecord | null> {
  try {
    validateAutomationLocator(locator);
    return await loadAutomationRecordInSpace(pool, schema, locator);
  } catch (error) {
    throw automationPostgresError(error);
  }
}

export async function listPostgresAutomations(
  pool: Pool,
  schema: string,
  query: AutomationListQuery,
): Promise<readonly AutomationDefinitionRecord[]> {
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100
  ) {
    throw new AutomationStoreError("automation_limit_invalid");
  }
  try {
    const rows = await pool.query<AutomationRow>(
      `SELECT tenant_id, space_id, automation_id, thread_id, revision,
              definition_digest, definition_json, updated_at
       FROM ${schema}.automations
       WHERE tenant_id=$1 AND space_id=$2
         AND ($3::timestamptz IS NULL OR updated_at < $3::timestamptz
           OR (updated_at = $3::timestamptz AND automation_id < $4))
       ORDER BY updated_at DESC, automation_id DESC LIMIT $5`,
      [
        query.tenantId,
        query.spaceId,
        query.before?.updatedAt ?? null,
        query.before?.automationId ?? null,
        query.limit,
      ],
    );
    return rows.rows.map(decodeAutomationRow);
  } catch (error) {
    throw automationPostgresError(error);
  }
}

export async function listPostgresScheduledAutomations(
  pool: Pool,
  schema: string,
  query: ScheduledAutomationListQuery,
): Promise<readonly AutomationDefinitionRecord[]> {
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100
  ) {
    throw new AutomationStoreError("automation_limit_invalid");
  }
  try {
    const rows = await pool.query<AutomationRow>(
      `SELECT tenant_id, space_id, automation_id, thread_id, revision,
              definition_digest, definition_json, updated_at
       FROM ${schema}.automations
       WHERE definition_json ->> 'executionMode' = 'scheduled'
         AND ($1::timestamptz IS NULL OR updated_at < $1::timestamptz
           OR (updated_at = $1::timestamptz AND automation_id < $2))
       ORDER BY updated_at DESC, automation_id DESC LIMIT $3`,
      [
        query.before?.updatedAt ?? null,
        query.before?.automationId ?? null,
        query.limit,
      ],
    );
    return rows.rows.map(decodeAutomationRow);
  } catch (error) {
    throw automationPostgresError(error);
  }
}

export async function loadPostgresAutomationInvocationContext(
  pool: Pool,
  schema: string,
  locator: AutomationLocator,
): Promise<AutomationInvocationContext | null> {
  try {
    validateAutomationLocator(locator);
    const record = await loadAutomationRecordInSpace(pool, schema, locator);
    if (record === null) return null;
    const thread = await loadThread(pool, schema, {
      tenantId: locator.tenantId,
      threadId: record.definition.threadId,
    });
    if (thread === null || thread.spaceId !== locator.spaceId) {
      throw new RunStoreError("automation_context_invalid");
    }
    const head = await pool.query<{ last_sequence: string | number }>(
      `SELECT COALESCE(MAX(sequence), 0) AS last_sequence
       FROM ${schema}.model_history_items
       WHERE tenant_id=$1 AND thread_id=$2`,
      [locator.tenantId, thread.threadId],
    );
    return {
      record,
      thread,
      historyHead: {
        tenantId: locator.tenantId,
        threadId: thread.threadId,
        lastSequence: safeInteger(head.rows[0]?.last_sequence ?? 0),
      },
    };
  } catch (error) {
    throw automationPostgresError(error);
  }
}

function validateAutomationLocator(locator: AutomationLocator): void {
  requireNonEmpty(locator.tenantId, "tenant_id_invalid");
  requireNonEmpty(locator.spaceId, "space_id_invalid");
  requireNonEmpty(locator.automationId, "automation_id_invalid");
}

export async function loadPostgresAutomationInvocationReceipt(
  pool: Pool,
  schema: string,
  query: AutomationInvocationReceiptQuery,
): Promise<AutomationInvocationResult | null> {
  validateAutomationInvocationReceiptQuery(query);
  const client = await pool.connect();
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const receipt = await loadInvocationReceipt(
      client,
      schema,
      query.tenantId,
      query.idempotency,
    );
    if (receipt !== null) {
      await validateInvocationReceiptAuthority(client, schema, receipt);
    }
    const result =
      receipt === null
        ? null
        : replayAutomationInvocationReceipt(query, receipt);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackPostgres(client);
    throw automationPostgresError(error);
  } finally {
    client.release();
  }
}
