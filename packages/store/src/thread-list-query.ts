import type { ThreadListQuery } from "@crewon/application";
import type { ThreadState } from "@crewon/domain";

/** Table identifiers come exclusively from the adapter's validated schema. Values are bound. */
export function threadListSql(
  query: ThreadListQuery,
  table: string,
  dialect: "sqlite" | "postgres",
): { sql: string; values: (string | number)[] } {
  const values: (string | number)[] = [];
  const bind = (value: string | number) => {
    values.push(value);
    return dialect === "sqlite" ? "?" : `$${values.length}`;
  };
  const conditions = [
    `tenant_id = ${bind(query.tenantId)}`,
    `space_id = ${bind(query.spaceId)}`,
    "status != 'deleted'",
  ];
  if (query.filter !== undefined) {
    conditions.push(`status = ${bind(query.filter.status)}`);
    if (query.filter.excludeForks)
      conditions.push(
        dialect === "sqlite"
          ? "json_extract(state_json, '$.forkedFromThreadId') IS NULL"
          : "state_json->>'forkedFromThreadId' IS NULL",
      );
  }
  const reverse = query.after != null;
  const cursor = query.after ?? query.before;
  if (cursor !== null) {
    const timestamp =
      bind(cursor.updatedAt) + (dialect === "postgres" ? "::timestamptz" : "");
    conditions.push(
      `(updated_at, thread_id) ${reverse ? ">" : "<"} (${timestamp}, ${bind(cursor.threadId)})`,
    );
  }
  const order = reverse ? "ASC" : "DESC";
  return {
    sql: `SELECT tenant_id, space_id, thread_id, created_by_actor_id, title, status,
      revision, last_event_sequence, last_message_sequence, state_json,
      created_at, updated_at, archived_at, deleted_at, deleted_by_actor_id
      FROM ${table} WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at ${order}, thread_id ${order} LIMIT ${bind(query.limit)}`,
    values,
  };
}

/** Bounded scratch space even though the in-memory adapter must visit its existing snapshots. */
export function selectMemoryThreadList(
  threads: Iterable<ThreadState>,
  query: ThreadListQuery,
): ThreadState[] {
  const reverse = query.after != null;
  const cursor = query.after ?? query.before;
  const selected: ThreadState[] = [];
  const compare = (left: ThreadState, right: ThreadState) => {
    const result = compareThreadPosition(left, right);
    return reverse ? result : -result;
  };
  for (const thread of threads) {
    if (
      thread.tenantId !== query.tenantId ||
      thread.spaceId !== query.spaceId ||
      thread.status === "deleted"
    )
      continue;
    if (
      query.filter !== undefined &&
      (thread.status !== query.filter.status ||
        (query.filter.excludeForks && thread.forkedFromThreadId !== null))
    )
      continue;
    if (cursor !== null) {
      const relative = compareThreadPosition(thread, cursor);
      if (reverse ? relative <= 0 : relative >= 0) continue;
    }
    let low = 0;
    let high = selected.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(thread, selected[middle]!) < 0) high = middle;
      else low = middle + 1;
    }
    if (low >= query.limit) continue;
    selected.splice(low, 0, thread);
    if (selected.length > query.limit) selected.pop();
  }
  return reverse ? selected.reverse() : selected;
}

function compareThreadPosition(
  left: { updatedAt: string; threadId: string },
  right: { updatedAt: string; threadId: string },
): number {
  // SQLite and legacy in-memory cursors compare the persisted UTC timestamp text.
  const time =
    left.updatedAt === right.updatedAt
      ? 0
      : left.updatedAt < right.updatedAt
        ? -1
        : 1;
  return (
    time ||
    (left.threadId === right.threadId
      ? 0
      : left.threadId < right.threadId
        ? -1
        : 1)
  );
}
