import {
  parseExecutionProviderCheckpoint,
  RunStoreError,
  type CommitTextRunCompletionInput,
  type ThreadContinuationCheckpoint,
  type ThreadContinuationLocator,
} from "@crewon/application";
import { type Pool, type PoolClient } from "pg";

import { safeInteger } from "./postgres-thread-codec.ts";
import { stableJson } from "./store-invariants.ts";

type ThreadContinuationRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  agent_version_id: string;
  adapter_name: string;
  adapter_version: string;
  model_id: string;
  through_history_sequence: string | number;
  context_revision: string;
  checkpoint_json: unknown;
  continuation_json: unknown;
  updated_at: Date | string;
  history_item_type: string;
  history_message_role: string | null;
}>;

export async function loadPostgresThreadContinuation(
  connection: Pool | PoolClient,
  schema: string,
  locator: ThreadContinuationLocator,
): Promise<ThreadContinuationCheckpoint | null> {
  const result = await connection.query<ThreadContinuationRow>(
    `SELECT c.tenant_id, c.thread_id, c.agent_version_id, c.adapter_name,
            c.adapter_version, c.model_id, c.through_history_sequence,
            c.context_revision, c.checkpoint_json, c.continuation_json,
            c.updated_at, h.item_type AS history_item_type,
            h.item_json->>'role' AS history_message_role
     FROM ${schema}.thread_continuations AS c
     JOIN ${schema}.model_history_items AS h
       ON h.thread_id=c.thread_id AND h.sequence=c.through_history_sequence
     WHERE c.tenant_id=$1 AND c.thread_id=$2 AND c.agent_version_id=$3
       AND c.adapter_name=$4 AND c.adapter_version=$5 AND c.model_id=$6`,
    [
      locator.tenantId,
      locator.threadId,
      locator.agentVersionId,
      locator.adapterName,
      locator.adapterVersion,
      locator.modelId,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? null : decode(row, locator);
}

export async function writePostgresThreadContinuation(
  client: PoolClient,
  schema: string,
  input: CommitTextRunCompletionInput,
  continuation: ThreadContinuationCheckpoint | null,
): Promise<void> {
  const identity = input.continuation;
  const threadId = input.thread.messages[0]?.threadId;
  if (threadId === undefined) {
    throw new RunStoreError("text_completion_message_missing");
  }
  await client.query(
    `DELETE FROM ${schema}.thread_continuations
     WHERE tenant_id=$1 AND thread_id=$2 AND agent_version_id=$3
       AND adapter_name=$4 AND adapter_version=$5 AND model_id=$6`,
    [
      input.tenantId,
      threadId,
      identity.agentVersionId,
      identity.adapterName,
      identity.adapterVersion,
      identity.modelId,
    ],
  );
  if (continuation === null) return;
  await client.query(
    `INSERT INTO ${schema}.thread_continuations
       (tenant_id, thread_id, agent_version_id, adapter_name, adapter_version,
        model_id, through_history_sequence, context_revision, checkpoint_json,
        continuation_json, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      continuation.tenantId,
      continuation.threadId,
      continuation.agentVersionId,
      continuation.adapterName,
      continuation.adapterVersion,
      continuation.modelId,
      continuation.throughHistorySequence,
      continuation.contextRevision,
      stableJson(continuation.checkpoint),
      stableJson(continuation),
      continuation.updatedAt,
    ],
  );
}

export function createPostgresThreadContinuation(
  input: CommitTextRunCompletionInput,
): ThreadContinuationCheckpoint | null {
  if (input.continuation.checkpoint === null) return null;
  const historyItem = input.history.items[0];
  if (historyItem?.type !== "message" || historyItem.role !== "assistant") {
    throw new RunStoreError("text_completion_history_missing");
  }
  return {
    tenantId: input.tenantId,
    threadId: historyItem.threadId,
    agentVersionId: input.continuation.agentVersionId,
    adapterName: input.continuation.adapterName,
    adapterVersion: input.continuation.adapterVersion,
    modelId: input.continuation.modelId,
    throughHistorySequence: historyItem.sequence,
    contextRevision: input.continuation.contextRevision,
    checkpoint: structuredClone(input.continuation.checkpoint),
    updatedAt: historyItem.createdAt,
  };
}

function decode(
  row: ThreadContinuationRow,
  locator: ThreadContinuationLocator,
): ThreadContinuationCheckpoint {
  const continuation = storedObject<ThreadContinuationCheckpoint>(
    row.continuation_json,
  );
  const checkpoint = parseCheckpoint(row.checkpoint_json);
  if (
    row.tenant_id !== locator.tenantId ||
    row.thread_id !== locator.threadId ||
    row.agent_version_id !== locator.agentVersionId ||
    row.adapter_name !== locator.adapterName ||
    row.adapter_version !== locator.adapterVersion ||
    row.model_id !== locator.modelId ||
    row.history_item_type !== "message" ||
    row.history_message_role !== "assistant" ||
    continuation.tenantId !== row.tenant_id ||
    continuation.threadId !== row.thread_id ||
    continuation.agentVersionId !== row.agent_version_id ||
    continuation.adapterName !== row.adapter_name ||
    continuation.adapterVersion !== row.adapter_version ||
    continuation.modelId !== row.model_id ||
    continuation.throughHistorySequence !==
      safeInteger(row.through_history_sequence) ||
    continuation.contextRevision !== row.context_revision ||
    stableJson(continuation.checkpoint) !== stableJson(checkpoint) ||
    Date.parse(continuation.updatedAt) !== timestamp(row.updated_at)
  ) {
    throw invalid();
  }
  return structuredClone(continuation);
}

function parseCheckpoint(value: unknown) {
  try {
    return parseExecutionProviderCheckpoint(value);
  } catch (error) {
    throw invalid(error);
  }
}

function storedObject<T>(value: unknown): T {
  try {
    stableJson(value);
  } catch (error) {
    throw invalid(error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid();
  }
  return value as T;
}

function timestamp(value: Date | string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw invalid();
  return parsed;
}

function invalid(cause?: unknown): RunStoreError {
  return new RunStoreError("stored_thread_continuation_invalid", {
    cause: cause instanceof Error ? cause : undefined,
  });
}
