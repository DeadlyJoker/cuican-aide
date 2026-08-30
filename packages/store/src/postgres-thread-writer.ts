import { RunStoreError, type MessageRecord } from "@crewon/application";
import {
  type ModelHistoryItem,
  type ThreadLifecycleEvent,
  type ThreadState,
} from "@crewon/domain";
import { type PoolClient } from "pg";

import { stableJson } from "./store-invariants.ts";

export async function writePostgresThreadSnapshot(
  client: PoolClient,
  schema: string,
  current: ThreadState | null,
  next: ThreadState,
  expectedRevision: number,
): Promise<void> {
  if (current === null) {
    await client.query(
      `INSERT INTO ${table(schema, "threads")}
         (tenant_id, space_id, thread_id, created_by_actor_id, title, status,
          revision, last_event_sequence, last_message_sequence, state_json,
          created_at, updated_at, archived_at, deleted_at, deleted_by_actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        next.tenantId,
        next.spaceId,
        next.threadId,
        next.createdByActorId,
        next.title,
        next.status,
        next.revision,
        next.lastEventSequence,
        next.lastMessageSequence,
        stableJson(next),
        next.createdAt,
        next.updatedAt,
        next.archivedAt,
        next.deletedAt,
        next.deletedByActorId,
      ],
    );
    return;
  }
  const updated = await client.query(
    `UPDATE ${table(schema, "threads")}
     SET title=$1, status=$2, revision=$3, last_event_sequence=$4,
         last_message_sequence=$5, state_json=$6, updated_at=$7, archived_at=$8,
         deleted_at=$9, deleted_by_actor_id=$10
     WHERE tenant_id=$11 AND thread_id=$12 AND revision=$13`,
    [
      next.title,
      next.status,
      next.revision,
      next.lastEventSequence,
      next.lastMessageSequence,
      stableJson(next),
      next.updatedAt,
      next.archivedAt,
      next.deletedAt,
      next.deletedByActorId,
      next.tenantId,
      next.threadId,
      expectedRevision,
    ],
  );
  if (updated.rowCount !== 1) throw new RunStoreError("revision_conflict");
}

export async function writePostgresThreadEvents(
  client: PoolClient,
  schema: string,
  events: readonly ThreadLifecycleEvent[],
  tenantId: string,
): Promise<void> {
  for (const event of events) {
    await client.query(
      `INSERT INTO ${table(schema, "thread_events")}
         (tenant_id, thread_id, sequence, event_id, event_json)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        tenantId,
        event.identity.threadId,
        event.sequence,
        event.eventId,
        stableJson(event),
      ],
    );
  }
}

export async function writePostgresMessages(
  client: PoolClient,
  schema: string,
  messages: readonly MessageRecord[],
): Promise<void> {
  for (const message of messages) {
    await client.query(
      `INSERT INTO ${table(schema, "messages")}
         (tenant_id, thread_id, sequence, message_id, role, content,
          content_digest, created_at, message_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        message.tenantId,
        message.threadId,
        message.sequence,
        message.messageId,
        message.role,
        message.content,
        message.contentDigest,
        message.createdAt,
        stableJson(message),
      ],
    );
  }
}

export async function writePostgresModelHistory(
  client: PoolClient,
  schema: string,
  items: readonly ModelHistoryItem[],
): Promise<void> {
  for (const item of items) {
    await client.query(
      `INSERT INTO ${table(schema, "model_history_items")}
         (tenant_id, thread_id, sequence, item_id, run_id, segment_id,
          call_id, tool_kind, item_type, item_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        item.tenantId,
        item.threadId,
        item.sequence,
        item.itemId,
        item.runId,
        item.segmentId,
        item.type === "tool_call" || item.type === "tool_result"
          ? item.callId
          : null,
        item.type === "tool_call" || item.type === "tool_result"
          ? item.kind
          : null,
        item.type,
        stableJson(item),
        item.createdAt,
      ],
    );
  }
}

function table(schema: string, name: string): string {
  return `${schema}."${name}"`;
}
