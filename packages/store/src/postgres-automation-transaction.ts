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

import {
  automationPostgresError,
  loadAutomationRecord,
  loadCreateReceipt,
  loadHistory,
  loadInvocationReceipt,
  loadThread,
  replayCreateReceiptSnapshot,
  replayInvocationReceiptSnapshot,
} from "./postgres-automation-context.ts";

export async function commitPostgresAutomationCreate(
  pool: Pool,
  schema: string,
  input: CommitAutomationCreateInput,
): Promise<AutomationCreateResult> {
  validateAutomationCreateInputShape(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await advisoryLock(
      client,
      `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
    );
    const prior = await loadCreateReceipt(
      client,
      schema,
      input.tenantId,
      input.idempotency,
    );
    if (prior !== null) {
      await client.query("COMMIT");
      return replayCreateReceiptSnapshot(client, schema, {
        tenantId: input.tenantId,
        idempotency: input.idempotency,
      });
    }
    await assertPostgresProviderSettingsAdmissionOpen(
      client,
      schema,
      input.tenantId,
    );
    await advisoryLock(
      client,
      `thread:${input.tenantId}:${input.threadFence.threadId}`,
    );
    const thread = await loadThread(
      client,
      schema,
      {
        tenantId: input.tenantId,
        threadId: input.threadFence.threadId,
      },
      true,
    );
    if (
      (await loadAutomationRecord(
        client,
        schema,
        input.record.definition.automationId,
        true,
      )) !== null
    ) {
      throw new RunStoreError("automation_id_conflict");
    }
    const result = prepareAutomationCreate(input, thread);
    const record = result.record;
    await client.query(
      `INSERT INTO ${schema}.automations (
         tenant_id, space_id, automation_id, thread_id, revision,
         definition_digest, definition_json, schedule_state_json, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        record.definition.tenantId,
        record.definition.spaceId,
        record.definition.automationId,
        record.definition.threadId,
        record.definition.revision,
        record.definitionDigest,
        stableJson(record.definition),
        stableJson(record.scheduleState),
        record.definition.updatedAt,
      ],
    );
    await client.query(
      `INSERT INTO ${schema}.automation_create_receipts (
         tenant_id, scope, idempotency_key, automation_id, fingerprint,
         result_json
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        input.tenantId,
        input.idempotency.scope,
        input.idempotency.key,
        record.definition.automationId,
        input.idempotency.requestFingerprint,
        stableJson(result),
      ],
    );
    await client.query("COMMIT");
    return structuredClone(result);
  } catch (error) {
    await rollbackPostgres(client);
    throw automationPostgresError(error);
  } finally {
    client.release();
  }
}

export async function commitPostgresAutomationInvocation(
  pool: Pool,
  schema: string,
  input: CommitAutomationInvocationInput,
): Promise<AutomationInvocationResult> {
  validateAutomationInvocationInputShape(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await advisoryLock(
      client,
      `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
    );
    const prior = await loadInvocationReceipt(
      client,
      schema,
      input.tenantId,
      input.idempotency,
    );
    if (prior !== null) {
      await client.query("COMMIT");
      return replayInvocationReceiptSnapshot(client, schema, {
        tenantId: input.tenantId,
        automationId: input.definitionFence.automationId,
        idempotency: input.idempotency,
      });
    }
    await assertPostgresProviderSettingsAdmissionOpen(
      client,
      schema,
      input.tenantId,
    );
    await advisoryLock(client, `run:${input.tenantId}:${input.binding.runId}`);
    await advisoryLock(
      client,
      `thread:${input.tenantId}:${input.threadFence.threadId}`,
    );

    const record = await loadAutomationRecord(
      client,
      schema,
      input.definitionFence.automationId,
      true,
    );
    if (record === null || record.definition.tenantId !== input.tenantId) {
      throw new RunStoreError("automation_not_found");
    }
    const threadId = input.threadFence.threadId;
    const thread = await loadThread(
      client,
      schema,
      { tenantId: input.tenantId, threadId },
      true,
    );
    const history = await loadHistory(client, schema, {
      tenantId: input.tenantId,
      threadId,
    });
    const runRows = await client.query<PostgresRunRow>(
      `SELECT snapshots.tenant_id, snapshots.space_id, snapshots.run_id,
              snapshots.revision, snapshots.last_sequence, snapshots.state_json,
              snapshots.updated_at, bindings.thread_id
       FROM ${schema}.run_snapshots AS snapshots
       JOIN ${schema}.run_thread_bindings AS bindings
         ON bindings.tenant_id=snapshots.tenant_id
        AND bindings.run_id=snapshots.run_id
       WHERE snapshots.tenant_id=$1 AND bindings.thread_id=$2`,
      [input.tenantId, threadId],
    );
    const threadRuns = runRows.rows.map((row) =>
      decodePostgresRunState(row, {
        tenantId: input.tenantId,
        runId: row.run_id,
      }),
    );
    const activeRunExists = threadRuns.some(
      ({ status }) =>
        status !== "completed" && status !== "failed" && status !== "canceled",
    );
    const workRows = await client.query<{ status: string }>(
      `SELECT work.status FROM ${schema}.work_items AS work
       JOIN ${schema}.run_thread_bindings AS bindings
         ON bindings.tenant_id=work.tenant_id AND bindings.run_id=work.run_id
       WHERE work.tenant_id=$1 AND bindings.thread_id=$2`,
      [input.tenantId, threadId],
    );
    const unsettledWorkExists = workRows.rows.some(({ status }) => {
      if (
        status !== "pending" &&
        status !== "leased" &&
        status !== "completed"
      ) {
        throw new RunStoreError("stored_work_item_status_invalid");
      }
      return status !== "completed";
    });
    const runIdExists =
      (
        await client.query(
          `SELECT 1 FROM ${schema}.run_snapshots
           WHERE tenant_id=$1 AND run_id=$2`,
          [input.tenantId, input.binding.runId],
        )
      ).rowCount !== 0;
    const ids = await existingArtifactIds(client, schema, input);
    const result = prepareAutomationInvocation(input, {
      record,
      thread,
      history,
      activeRunExists,
      unsettledWorkExists,
      runIdExists,
      threadEventIdExists: (id) => ids.threadEvents.has(id),
      messageIdExists: (id) => ids.messages.has(id),
      historyItemIdExists: (id) => ids.history.has(id),
      runEventIdExists: (id) => ids.runEvents.has(id),
      outboxIdExists: (id) => ids.outbox.has(id),
      workItemIdExists: (id) => ids.work.has(id),
    });
    await writePostgresThreadSnapshot(
      client,
      schema,
      thread,
      result.threadState,
      input.threadFence.expectedRevision,
    );
    await writePostgresThreadEvents(
      client,
      schema,
      [input.threadEvent],
      input.tenantId,
    );
    await writePostgresMessages(client, schema, [input.message]);
    await writePostgresModelHistory(client, schema, [input.historyItem]);
    await writePostgresRunSnapshot(client, schema, null, result.runState, 0);
    await writePostgresRunEvents(
      client,
      schema,
      [input.runEvent],
      input.tenantId,
    );
    await writePostgresOutbox(client, schema, [input.outbox]);
    await writePostgresWorkItems(client, schema, [input.workItem]);
    await client.query(
      `INSERT INTO ${schema}.automation_invocation_receipts (
         tenant_id, scope, idempotency_key, automation_id, run_id, fingerprint,
         result_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.tenantId,
        input.idempotency.scope,
        input.idempotency.key,
        record.definition.automationId,
        input.binding.runId,
        input.idempotency.requestFingerprint,
        stableJson(result),
      ],
    );
    await client.query("COMMIT");
    return structuredClone(result);
  } catch (error) {
    await rollbackPostgres(client);
    throw automationPostgresError(error);
  } finally {
    client.release();
  }
}

async function existingArtifactIds(
  client: PoolClient,
  schema: string,
  input: CommitAutomationInvocationInput,
) {
  const specs = [
    ["thread_events", "event_id", input.threadEvent.eventId],
    ["messages", "message_id", input.message.messageId],
    ["model_history_items", "item_id", input.historyItem.itemId],
    ["run_events", "event_id", input.runEvent.eventId],
    ["outbox", "message_id", input.outbox.messageId],
    ["work_items", "work_item_id", input.workItem.workItemId],
  ] as const;
  const result = {
    threadEvents: new Set<string>(),
    messages: new Set<string>(),
    history: new Set<string>(),
    runEvents: new Set<string>(),
    outbox: new Set<string>(),
    work: new Set<string>(),
  };
  const targets = [
    result.threadEvents,
    result.messages,
    result.history,
    result.runEvents,
    result.outbox,
    result.work,
  ];
  for (const [index, [table, column, id]] of specs.entries()) {
    const found = await client.query(
      `SELECT 1 FROM ${schema}.${table} WHERE ${column}=$1`,
      [id],
    );
    if (found.rowCount !== 0) targets[index]?.add(id);
  }
  return result;
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
}
