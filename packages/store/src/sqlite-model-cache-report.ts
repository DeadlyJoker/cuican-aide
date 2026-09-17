import { DatabaseSync } from "node:sqlite";

import {
  reportModelCacheUsage,
  type ModelCacheUsageReport,
  type PersistedModelUsageEvent,
} from "@crewon/domain";

export type SqliteModelCacheUsageReport = ModelCacheUsageReport &
  Readonly<{
    throughSequence: number;
    limitations: readonly string[];
  }>;

/** Explicit offline diagnostic; never migrates or writes to the supplied database. */
export function readSqliteModelCacheUsageReport(
  input: Readonly<{
    databasePath: string;
    tenantId: string;
    runId: string;
  }>,
): SqliteModelCacheUsageReport {
  for (const id of [input.tenantId, input.runId]) {
    if (id.trim().length === 0 || id.length > 512)
      throw new Error("cache_report_identity_invalid");
  }
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    database.exec("PRAGMA busy_timeout = 1000");
    const run = database
      .prepare(
        "SELECT last_sequence FROM run_snapshots WHERE tenant_id = ? AND run_id = ?",
      )
      .get(input.tenantId, input.runId);
    if (run === undefined) throw new Error("cache_report_run_not_found");
    const throughSequence = Number(run.last_sequence);
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1)
      throw new Error("cache_report_run_sequence_invalid");
    // Each bounded page releases its read transaction. A long diagnostic must
    // not pin an app's WAL for the duration of the complete history scan.
    const page = database.prepare(`
      SELECT sequence,
        CASE WHEN json_extract(event_json, '$.type') IN ('usage.recorded', 'context.compacted')
          THEN event_json ELSE NULL END AS usage_json
      FROM run_events
      WHERE tenant_id = ? AND run_id = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence LIMIT 128
    `);
    function* usageEvents(): Iterable<PersistedModelUsageEvent> {
      let afterSequence = 0;
      while (afterSequence < throughSequence) {
        const rows = page.all(
          input.tenantId,
          input.runId,
          afterSequence,
          throughSequence,
        );
        if (rows.length === 0)
          throw new Error("cache_report_history_incomplete");
        for (const row of rows) {
          const sequence = Number(row.sequence);
          if (
            !Number.isSafeInteger(sequence) ||
            sequence !== afterSequence + 1 ||
            sequence > throughSequence
          )
            throw new Error("cache_report_history_incomplete");
          afterSequence = sequence;
          if (row.usage_json === null) continue;
          if (typeof row.usage_json !== "string")
            throw new Error("cache_report_event_invalid");
          const event = JSON.parse(row.usage_json) as PersistedModelUsageEvent;
          if (event.sequence !== row.sequence)
            throw new Error("cache_report_event_sequence_invalid");
          yield event;
        }
      }
    }
    return {
      ...reportModelCacheUsage(input.runId, usageEvents()),
      throughSequence,
      limitations: [
        "Calls without durable usage reports are not counted; this is not complete billing.",
        "Cache writes, prices and Provider/model-specific eligibility are not measured.",
        "Legacy cache numbers without reporting metadata are excluded from hit-rate calculations.",
      ],
    };
  } finally {
    database.close();
  }
}
