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

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type AutomationRow = Readonly<{
  tenant_id: string;
  space_id: string;
  automation_id: string;
  thread_id: string;
  revision: string | number;
  definition_digest: string;
  definition_json: unknown;
  schedule_state_json: unknown;
  updated_at: Date | string;
}>;

type AutomationReceiptRow = Readonly<{
  tenant_id: string;
  automation_id: string;
  run_id?: string;
  fingerprint: string;
  result_json: unknown;
}>;

export async function loadAutomationRecord(
  client: Queryable,
  schema: string,
  automationId: string,
  forUpdate = false,
): Promise<AutomationDefinitionRecord | null> {
  const result = await client.query<AutomationRow>(
    `SELECT tenant_id, space_id, automation_id, thread_id, revision,
            definition_digest, definition_json, schedule_state_json, updated_at
     FROM ${schema}.automations WHERE automation_id=$1${forUpdate ? " FOR UPDATE" : ""}`,
    [automationId],
  );
  return result.rows[0] === undefined
    ? null
    : decodeAutomationRow(result.rows[0]);
}

export async function loadAutomationRecordInSpace(
  client: Queryable,
  schema: string,
  locator: AutomationLocator,
): Promise<AutomationDefinitionRecord | null> {
  const result = await client.query<AutomationRow>(
    `SELECT tenant_id, space_id, automation_id, thread_id, revision,
            definition_digest, definition_json, schedule_state_json, updated_at
     FROM ${schema}.automations
     WHERE tenant_id=$1 AND space_id=$2 AND automation_id=$3`,
    [locator.tenantId, locator.spaceId, locator.automationId],
  );
  return result.rows[0] === undefined
    ? null
    : decodeAutomationRow(result.rows[0]);
}

export function decodeAutomationRow(
  row: AutomationRow,
): AutomationDefinitionRecord {
  const definition = storedObject<AutomationDefinitionRecord["definition"]>(
    row.definition_json,
    "automation_record_invalid",
  );
  const scheduleState = storedObject<
    AutomationDefinitionRecord["scheduleState"]
  >(row.schedule_state_json, "automation_record_invalid");
  const record = {
    definition,
    definitionDigest: row.definition_digest,
    scheduleState,
  };
  validateAutomationRecord(record);
  if (
    row.tenant_id !== definition.tenantId ||
    row.space_id !== definition.spaceId ||
    row.automation_id !== definition.automationId ||
    row.thread_id !== definition.threadId ||
    safeInteger(row.revision) !== definition.revision ||
    postgresTimestamp(row.updated_at) !== Date.parse(definition.updatedAt)
  ) {
    throw new RunStoreError("automation_record_invalid");
  }
  return structuredClone(record);
}

export async function loadThread(
  client: Queryable,
  schema: string,
  locator: Readonly<{ tenantId: string; threadId: string }>,
  forUpdate = false,
): Promise<ThreadState | null> {
  const result = await client.query<PostgresThreadRow>(
    `SELECT tenant_id, space_id, thread_id, created_by_actor_id, title, status,
            revision, last_event_sequence, last_message_sequence, state_json,
            created_at, updated_at, archived_at, deleted_at,
            deleted_by_actor_id
     FROM ${schema}.threads WHERE tenant_id=$1 AND thread_id=$2${forUpdate ? " FOR UPDATE" : ""}`,
    [locator.tenantId, locator.threadId],
  );
  return result.rows[0] === undefined
    ? null
    : decodePostgresThreadState(result.rows[0], locator);
}

export async function loadRun(
  client: Queryable,
  schema: string,
  locator: Readonly<{ tenantId: string; runId: string }>,
): Promise<RunState | null> {
  const result = await client.query<PostgresRunRow>(
    `SELECT snapshots.tenant_id, snapshots.space_id, snapshots.run_id,
            snapshots.revision, snapshots.last_sequence, snapshots.state_json,
            snapshots.updated_at, bindings.thread_id
     FROM ${schema}.run_snapshots AS snapshots
     LEFT JOIN ${schema}.run_thread_bindings AS bindings
       ON bindings.tenant_id=snapshots.tenant_id AND bindings.run_id=snapshots.run_id
     WHERE snapshots.tenant_id=$1 AND snapshots.run_id=$2`,
    [locator.tenantId, locator.runId],
  );
  return result.rows[0] === undefined
    ? null
    : decodePostgresRunState(result.rows[0], locator);
}

export async function loadHistory(
  client: Queryable,
  schema: string,
  locator: Readonly<{ tenantId: string; threadId: string }>,
): Promise<ModelHistoryItem[]> {
  const result = await client.query<PostgresModelHistoryRow>(
    `SELECT tenant_id, thread_id, sequence, item_id, run_id, segment_id,
            call_id, tool_kind, item_type, item_json, created_at
     FROM ${schema}.model_history_items
     WHERE tenant_id=$1 AND thread_id=$2 ORDER BY sequence ASC`,
    [locator.tenantId, locator.threadId],
  );
  return result.rows.map((row) => decodePostgresModelHistoryItem(row, locator));
}

export async function loadCreateReceipt(
  client: Queryable,
  schema: string,
  tenantId: string,
  idempotency: CommitAutomationCreateInput["idempotency"],
): Promise<StoredAutomationCreateReceipt | null> {
  const result = await client.query<AutomationReceiptRow>(
    `SELECT tenant_id, automation_id, fingerprint, result_json
     FROM ${schema}.automation_create_receipts
     WHERE tenant_id=$1 AND scope=$2 AND idempotency_key=$3`,
    [tenantId, idempotency.scope, idempotency.key],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        tenantId: row.tenant_id,
        automationId: row.automation_id,
        fingerprint: row.fingerprint,
        result: storedObject<AutomationCreateResult>(
          row.result_json,
          "automation_create_receipt_invalid",
        ),
      };
}

export async function loadInvocationReceipt(
  client: Queryable,
  schema: string,
  tenantId: string,
  idempotency: CommitAutomationInvocationInput["idempotency"],
): Promise<StoredAutomationInvocationReceipt | null> {
  const result = await client.query<AutomationReceiptRow>(
    `SELECT tenant_id, automation_id, run_id, fingerprint, result_json
     FROM ${schema}.automation_invocation_receipts
     WHERE tenant_id=$1 AND scope=$2 AND idempotency_key=$3`,
    [tenantId, idempotency.scope, idempotency.key],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (typeof row.run_id !== "string") {
    throw new RunStoreError("automation_invocation_receipt_invalid");
  }
  return {
    tenantId: row.tenant_id,
    automationId: row.automation_id,
    runId: row.run_id,
    fingerprint: row.fingerprint,
    result: storedObject<AutomationInvocationResult>(
      row.result_json,
      "automation_invocation_receipt_invalid",
    ),
  };
}

export async function validateInvocationReceiptAuthority(
  client: Queryable,
  schema: string,
  receipt: StoredAutomationInvocationReceipt,
): Promise<void> {
  const result = receipt.result;
  const threadId = result.record.definition.threadId;
  const threadLocator = { tenantId: receipt.tenantId, threadId };
  const threadRows = await client.query<{
    tenant_id: string;
    thread_id: string;
    sequence: string | number;
    event_id: string;
    event_json: unknown;
  }>(
    `SELECT tenant_id, thread_id, sequence, event_id, event_json
     FROM ${schema}.thread_events
     WHERE tenant_id=$1 AND thread_id=$2 ORDER BY sequence ASC`,
    [receipt.tenantId, threadId],
  );
  const threadEvents = threadRows.rows.map((row) =>
    decodeStoredThreadEvent(
      {
        tenantId: row.tenant_id,
        threadId: row.thread_id,
        sequence: safeInteger(row.sequence),
        eventId: row.event_id,
        eventJson: row.event_json,
      },
      threadLocator,
    ),
  );
  validateStoredThreadEventPage(threadEvents, threadLocator, 0);
  const message = await loadMessage(
    client,
    schema,
    threadLocator,
    result.message.messageId,
  );
  const history = await loadHistoryItem(
    client,
    schema,
    threadLocator,
    result.historyItem.itemId,
  );
  const runLocator = { tenantId: receipt.tenantId, runId: receipt.runId };
  const runEventRows = await client.query<PostgresRunEventRow>(
    `SELECT tenant_id, run_id, sequence, event_id, event_json
     FROM ${schema}.run_events
     WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence ASC`,
    [receipt.tenantId, receipt.runId],
  );
  const runEvents = runEventRows.rows.map((row) =>
    decodePostgresRunEvent(row, runLocator),
  );
  validateAutomationInvocationReceiptAuthority(receipt, {
    record: await loadAutomationRecord(client, schema, receipt.automationId),
    thread: await loadThread(client, schema, threadLocator),
    threadEvents,
    message,
    historyItem: history,
    run: await loadRun(client, schema, runLocator),
    runEvents,
    outbox: await loadOutbox(client, schema, result.outbox.messageId),
    workItem: await loadWorkItem(client, schema, result.workItem.workItemId),
  });
}

export async function replayCreateReceiptSnapshot(
  client: PoolClient,
  schema: string,
  query: AutomationCreateReceiptQuery,
): Promise<AutomationCreateResult> {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  const receipt = await loadCreateReceipt(
    client,
    schema,
    query.tenantId,
    query.idempotency,
  );
  if (receipt === null) {
    throw new RunStoreError("automation_create_receipt_invalid");
  }
  validateAutomationCreateReceiptAuthority(
    receipt,
    await loadAutomationRecord(client, schema, receipt.automationId),
  );
  const replay = replayAutomationCreateReceipt(query, receipt);
  await client.query("COMMIT");
  return replay;
}

export async function replayInvocationReceiptSnapshot(
  client: PoolClient,
  schema: string,
  query: AutomationInvocationReceiptQuery,
): Promise<AutomationInvocationResult> {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  const receipt = await loadInvocationReceipt(
    client,
    schema,
    query.tenantId,
    query.idempotency,
  );
  if (receipt === null) {
    throw new RunStoreError("automation_invocation_receipt_invalid");
  }
  await validateInvocationReceiptAuthority(client, schema, receipt);
  const replay = replayAutomationInvocationReceipt(query, receipt);
  await client.query("COMMIT");
  return replay;
}

async function loadMessage(
  client: Queryable,
  schema: string,
  locator: Readonly<{ tenantId: string; threadId: string }>,
  messageId: string,
): Promise<MessageRecord | null> {
  const result = await client.query<PostgresMessageRow>(
    `SELECT messages.tenant_id, messages.thread_id, messages.sequence,
            messages.message_id, messages.role, messages.content,
            messages.content_digest, messages.created_at,
            messages.message_json, invalidations.rollback_id,
            invalidations.marker_item_id, invalidations.history_sequence,
            invalidations.invalidated_at
     FROM ${schema}.messages AS messages
     LEFT JOIN ${schema}.message_invalidations AS invalidations
       ON invalidations.tenant_id=messages.tenant_id
      AND invalidations.thread_id=messages.thread_id
      AND invalidations.message_sequence=messages.sequence
     WHERE messages.tenant_id=$1 AND messages.message_id=$2`,
    [locator.tenantId, messageId],
  );
  return result.rows[0] === undefined
    ? null
    : decodePostgresMessage(result.rows[0], locator, "audit");
}

async function loadHistoryItem(
  client: Queryable,
  schema: string,
  locator: Readonly<{ tenantId: string; threadId: string }>,
  itemId: string,
): Promise<ModelHistoryItem | null> {
  const result = await client.query<PostgresModelHistoryRow>(
    `SELECT tenant_id, thread_id, sequence, item_id, run_id, segment_id,
            call_id, tool_kind, item_type, item_json, created_at
     FROM ${schema}.model_history_items WHERE tenant_id=$1 AND item_id=$2`,
    [locator.tenantId, itemId],
  );
  return result.rows[0] === undefined
    ? null
    : decodePostgresModelHistoryItem(result.rows[0], locator);
}

async function loadOutbox(
  client: Queryable,
  schema: string,
  messageId: string,
): Promise<OutboxMessage | null> {
  const result = await client.query<PostgresQueueItemRow>(
    `SELECT tenant_id, run_id, topic, message_json AS item_json, created_at
     FROM ${schema}.outbox WHERE message_id=$1`,
    [messageId],
  );
  return result.rows[0] === undefined
    ? null
    : decodePostgresOutbox(result.rows[0]);
}

async function loadWorkItem(
  client: Queryable,
  schema: string,
  workItemId: string,
): Promise<WorkItem | null> {
  const result = await client.query<PostgresQueueItemRow>(
    `SELECT tenant_id, run_id, kind, work_item_json AS item_json, created_at
     FROM ${schema}.work_items WHERE work_item_id=$1`,
    [workItemId],
  );
  return result.rows[0] === undefined
    ? null
    : decodePostgresWorkItem(result.rows[0]);
}

function storedObject<T>(value: unknown, code: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunStoreError(code);
  }
  stableJson(value);
  return value as T;
}

function postgresTimestamp(value: Date | string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new RunStoreError("postgres_timestamp_invalid");
  return timestamp;
}

export function automationPostgresError(error: unknown): AutomationStoreError {
  if (error instanceof AutomationStoreError || error instanceof RunStoreError) {
    return normalizeAutomationStoreError(error);
  }
  return normalizeAutomationStoreError(normalizePostgresError(error));
}
