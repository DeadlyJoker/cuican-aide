import {
  RunStoreError,
  type OutboxMessage,
  type WorkItem,
} from "@crewon/application";
import { type RunLifecycleEvent, type RunState } from "@crewon/domain";
import { type PoolClient } from "pg";

import { stableJson } from "./store-invariants.ts";

export async function writePostgresRunSnapshot(
  client: PoolClient,
  schema: string,
  current: RunState | null,
  next: RunState,
  expectedRevision: number,
): Promise<void> {
  if (current === null) {
    await client.query(
      `INSERT INTO ${table(schema, "run_snapshots")}
         (tenant_id, space_id, run_id, revision, last_sequence, state_json, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        next.tenantId,
        next.spaceId,
        next.runId,
        next.revision,
        next.lastSequence,
        stableJson(next),
        next.updatedAt,
      ],
    );
    await client.query(
      `INSERT INTO ${table(schema, "run_thread_bindings")}
         (tenant_id, run_id, thread_id) VALUES ($1,$2,$3)`,
      [next.tenantId, next.runId, next.threadId],
    );
    return;
  }
  const binding = await client.query<{ tenant_id: string; thread_id: string }>(
    `SELECT tenant_id, thread_id FROM ${table(schema, "run_thread_bindings")}
     WHERE run_id = $1`,
    [next.runId],
  );
  if (
    binding.rows[0]?.tenant_id !== next.tenantId ||
    binding.rows[0]?.thread_id !== next.threadId
  ) {
    throw new RunStoreError("stored_run_thread_binding_invalid");
  }
  const updated = await client.query(
    `UPDATE ${table(schema, "run_snapshots")}
     SET space_id=$1, revision=$2, last_sequence=$3, state_json=$4, updated_at=$5
     WHERE tenant_id=$6 AND run_id=$7 AND revision=$8`,
    [
      next.spaceId,
      next.revision,
      next.lastSequence,
      stableJson(next),
      next.updatedAt,
      next.tenantId,
      next.runId,
      expectedRevision,
    ],
  );
  if (updated.rowCount !== 1) throw new RunStoreError("revision_conflict");
}

export async function writePostgresRunEvents(
  client: PoolClient,
  schema: string,
  events: readonly RunLifecycleEvent[],
  tenantId: string,
): Promise<void> {
  for (const event of events) {
    await client.query(
      `INSERT INTO ${table(schema, "run_events")}
         (tenant_id, run_id, sequence, event_id, event_json)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        tenantId,
        event.identity.runId,
        event.sequence,
        event.eventId,
        stableJson(event),
      ],
    );
  }
}

export async function writePostgresOutbox(
  client: PoolClient,
  schema: string,
  messages: readonly OutboxMessage[],
): Promise<void> {
  for (const message of messages) {
    await client.query(
      `INSERT INTO ${table(schema, "outbox")}
         (message_id, tenant_id, run_id, topic, message_json, created_at, available_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [
        message.messageId,
        message.tenantId,
        message.runId,
        message.topic,
        stableJson(message),
        message.createdAt,
      ],
    );
  }
}

export async function writePostgresWorkItems(
  client: PoolClient,
  schema: string,
  items: readonly WorkItem[],
): Promise<void> {
  for (const item of items) {
    await client.query(
      `INSERT INTO ${table(schema, "work_items")}
         (work_item_id, tenant_id, run_id, kind, work_item_json, created_at, available_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [
        item.workItemId,
        item.tenantId,
        item.runId,
        item.kind,
        stableJson(item),
        item.createdAt,
      ],
    );
  }
}

function table(schema: string, name: string): string {
  return `${schema}."${name}"`;
}
