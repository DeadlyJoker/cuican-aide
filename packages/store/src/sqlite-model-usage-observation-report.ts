import { DatabaseSync } from "node:sqlite";
import { reportModelUsageObservations } from "@crewon/domain";
import {
  decodeModelUsageEntry,
  validateModelUsagePage,
} from "./model-usage-store-support.ts";

/** Read-only, fixed high-water mark and short pages: reporting cannot pin WAL indefinitely. */
export function readSqliteModelUsageObservationsReport(input: {
  databasePath: string;
  tenantId: string;
  runId: string;
}) {
  validateModelUsagePage({ ...input, afterOrder: 0, limit: 128 });
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    database.exec("PRAGMA busy_timeout = 1000");
    if (
      database
        .prepare("SELECT 1 FROM run_snapshots WHERE tenant_id=? AND run_id=?")
        .get(input.tenantId, input.runId) === undefined
    )
      throw new Error("cache_report_run_not_found");
    if (
      database
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='model_usage_observations'",
        )
        .get() === undefined
    )
      throw new Error("model_usage_ledger_unavailable");
    const throughOrder = Number(
      database
        .prepare(
          "SELECT MAX(usage_order) AS head FROM model_usage_observations WHERE tenant_id=? AND run_id=?",
        )
        .get(input.tenantId, input.runId)?.head ?? 0,
    );
    if (!Number.isSafeInteger(throughOrder) || throughOrder < 0)
      throw new Error("model_usage_report_order_invalid");
    const page =
      database.prepare(`SELECT usage_order, CASE WHEN length(CAST(record_json AS BLOB)) <= 16384 THEN record_json ELSE NULL END AS record_json
      FROM model_usage_observations WHERE tenant_id=? AND run_id=? AND usage_order>? AND usage_order<=? ORDER BY usage_order LIMIT 128`);
    function* entries() {
      let cursor = 0;
      while (cursor < throughOrder) {
        const rows = page.all(
          input.tenantId,
          input.runId,
          cursor,
          throughOrder,
        );
        if (rows.length === 0) throw new Error("model_usage_report_incomplete");
        for (const row of rows) {
          const entry = decodeModelUsageEntry(
            row.usage_order,
            row.record_json,
            input,
          );
          if (entry.order <= cursor)
            throw new Error("model_usage_report_order_invalid");
          cursor = entry.order;
          yield entry;
        }
      }
    }
    return reportModelUsageObservations(input, entries());
  } finally {
    database.close();
  }
}
