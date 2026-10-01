/** Each branch uses the existing status-leading queue index; only leased rows may need sorting. */
export function workItemCandidatesSql(input: {
  table: string;
  now: string;
  limit: string;
  dialect: "sqlite" | "postgres";
  lock: "none" | "skipLocked";
  executionPredicate?: string;
}): string {
  const suffix = input.dialect === "sqlite" ? "_ms" : "";
  const available = `available_at${suffix}`,
    expires = `lease_expires_at${suffix}`;
  const locking = input.lock === "skipLocked" ? " FOR UPDATE SKIP LOCKED" : "";
  return `SELECT * FROM (
    SELECT * FROM (
      SELECT work_item_id,work_item_order,${available} AS ready_at
      FROM ${input.table}
      WHERE status = 'pending' AND ${available} <= ${input.now}${input.executionPredicate ?? ""}
      ORDER BY ${available},${expires},work_item_order
      LIMIT ${input.limit}${locking}
    ) AS pending_candidates
    UNION ALL
    SELECT * FROM (
      SELECT work_item_id,work_item_order,${expires} AS ready_at
      FROM ${input.table}
      WHERE status = 'leased' AND ${expires} <= ${input.now}${input.executionPredicate ?? ""}
      ORDER BY ${expires},work_item_order
      LIMIT ${input.limit}${locking}
    ) AS expired_candidates
  ) AS ready_candidates ORDER BY ready_at,work_item_order LIMIT ${input.limit}`;
}
