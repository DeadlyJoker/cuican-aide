import {
  ApplicationError,
  AutomationStoreError,
  validateAutomationListQuery,
  type ScheduledAutomationListQuery,
} from "@crewon/application";

export function validateScheduledAutomationQuery(
  query: ScheduledAutomationListQuery,
): void {
  try {
    validateAutomationListQuery(query);
  } catch (error) {
    if (error instanceof ApplicationError)
      throw new AutomationStoreError(error.code, { cause: error });
    throw error;
  }
}

/** Separate first-page and seek shapes so nullable cursor predicates cannot force a prefix scan. */
export function scheduledAutomationQuery(
  query: ScheduledAutomationListQuery,
  database: { kind: "sqlite" } | { kind: "postgres"; schema: string },
): { sql: string; parameters: (string | number)[] } {
  validateScheduledAutomationQuery(query);
  const postgres = database.kind === "postgres";
  const table = postgres ? `${database.schema}.automations` : "automations";
  const filter = postgres
    ? "definition_json ->> 'executionMode' = 'scheduled'"
    : "json_extract(definition_json, '$.executionMode') = 'scheduled'";
  const id = postgres ? 'automation_id COLLATE "C"' : "automation_id";
  const cursor = query.before;
  const seek =
    cursor === null
      ? ""
      : postgres
        ? ` AND (updated_at, ${id}) < ($1::timestamptz, $2::text COLLATE "C")`
        : " AND (updated_at, automation_id) < (?, ?)";
  const limit = postgres ? (cursor === null ? "$1" : "$3") : "?";
  return {
    sql: `SELECT tenant_id, space_id, automation_id, thread_id, revision,
      definition_digest, definition_json, updated_at FROM ${table}
      WHERE ${filter}${seek}
      ORDER BY updated_at DESC, ${id} DESC LIMIT ${limit}`,
    parameters:
      cursor === null
        ? [query.limit]
        : [cursor.updatedAt, cursor.automationId, query.limit],
  };
}
