import { setImmediate } from "node:timers/promises";
import {
  createModelAccountingReport,
  type ModelCallRecord,
} from "@crewon/domain";
import {
  decodeModelCallEntry,
  modelCallKey,
} from "./model-call-store-support.ts";
import {
  decodeModelUsageEntry,
  modelUsageKey,
  modelUsageLookupKey,
  validateModelUsagePage,
} from "./model-usage-store-support.ts";
import { accountingCallIdentity } from "./model-accounting-index.ts";

type Row = Record<string, unknown>;
type Parameter = string | number | null;
export type AccountingDatabase = {
  postgres: boolean;
  /** Empty for SQLite, a validated and quoted schema followed by a dot for PostgreSQL. */
  schema: string;
  query(sql: string, parameters: readonly Parameter[]): Promise<Row[]>;
  transaction<T>(work: () => Promise<T>): Promise<T>;
};
export type ModelAccountingReportInput = {
  tenantId: string;
  runId: string;
  signal?: AbortSignal;
  maxDurationMs?: number;
};
const PAGE_SIZE = 64;
function parameters(postgres: boolean) {
  const values: Parameter[] = [];
  return {
    values,
    bind(value: Parameter) {
      values.push(value);
      return postgres ? `$${values.length}` : "?";
    },
  };
}
function bounded(column: string, postgres: boolean) {
  return `CASE WHEN ${postgres ? `octet_length(${column}::text)` : `length(CAST(${column} AS BLOB))`}<=16384 THEN ${column} ELSE NULL END`;
}
function order(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("model_accounting_order_invalid");
  return n;
}

/** Two bounded indexed direct matches reveal ambiguity; one unique response match supports recovery. */
export function accountingUsageEvidenceQuery(
  db: Pick<AccountingDatabase, "postgres" | "schema">,
  locator: { tenantId: string; runId: string },
  throughUsageOrder: number,
  calls: readonly ModelCallRecord[],
) {
  order(throughUsageOrder);
  const p = parameters(db.postgres),
    table = `${db.schema}model_usage_observations`;
  const wanted = calls
    .map((call, i) => {
      const o = call.observation;
      const key = modelUsageLookupKey({
        ...call,
        identity:
          o.providerResponseId === null
            ? ["call", o.callId]
            : ["response", o.providerResponseId],
      });
      return `(${p.bind(i)},${p.bind(o.callId)},${p.bind(key)})`;
    })
    .join(",");
  const direct = (
    offset: number,
  ) => `SELECT usage_order FROM ${table} ${db.postgres ? "" : "INDEXED BY model_usage_call_identity"}
    WHERE tenant_id=${p.bind(locator.tenantId)} AND run_id=${p.bind(locator.runId)}
    AND ${accountingCallIdentity(db.postgres)}=w.call_id AND usage_order<=${throughUsageOrder}
    ORDER BY usage_order LIMIT 1 OFFSET ${offset}`;
  const sql = `WITH wanted(i,call_id,usage_key) AS (VALUES ${wanted}), links AS (
    SELECT w.i, (${direct(0)}) AS direct0, (${direct(1)}) AS direct1,
    (SELECT usage_order FROM ${table} WHERE usage_key=w.usage_key AND usage_order<=${throughUsageOrder}) AS response_order FROM wanted w)
    SELECT l.i,u.usage_order,u.usage_key,${bounded("u.record_json", db.postgres)} AS record_json
    FROM links l JOIN ${table} u ON u.usage_order IN (l.direct0,l.direct1,l.response_order)
    ORDER BY l.i,u.usage_order`;
  return { sql, parameters: p.values };
}

export async function readModelAccountingReport(
  db: AccountingDatabase,
  input: ModelAccountingReportInput,
) {
  validateModelUsagePage({ ...input, afterOrder: 0, limit: PAGE_SIZE });
  const duration = input.maxDurationMs ?? 30_000;
  if (!Number.isSafeInteger(duration) || duration < 100 || duration > 300_000)
    throw new Error("model_accounting_deadline_invalid");
  const started = performance.now();
  const check = () => {
    input.signal?.throwIfAborted();
    if (performance.now() - started > duration)
      throw new Error("model_accounting_report_deadline");
  };
  check();
  const p = parameters(db.postgres);
  const head = (table: string, column: string) =>
    `(SELECT MAX(${column}) FROM ${db.schema}${table} WHERE tenant_id=${p.bind(input.tenantId)} AND run_id=${p.bind(input.runId)})`;
  const headSql = `SELECT ${head("model_call_observations", "call_order")} AS call_head,
    ${head("model_usage_observations", "usage_order")} AS usage_head
    FROM ${db.schema}run_snapshots WHERE tenant_id=${p.bind(input.tenantId)} AND run_id=${p.bind(input.runId)}`;
  const heads = (await db.query(headSql, p.values))[0];
  if (!heads) throw new Error("cache_report_run_not_found");
  const throughCallOrder = order(heads.call_head ?? 0),
    throughUsageOrder = order(heads.usage_head ?? 0);
  const accumulator = createModelAccountingReport(input);
  async function page(
    table: string,
    column: string,
    key: string,
    cursor: number,
    through: number,
  ) {
    const p = parameters(db.postgres);
    const sql = `SELECT ${column},${key},${bounded("record_json", db.postgres)} AS record_json FROM ${db.schema}${table}
      WHERE tenant_id=${p.bind(input.tenantId)} AND run_id=${p.bind(input.runId)} AND ${column}>${p.bind(cursor)}
      AND ${column}<=${p.bind(through)} ORDER BY ${column} LIMIT ${PAGE_SIZE}`;
    const rows = await db.query(sql, p.values);
    if (rows.length === 0 || rows.length > PAGE_SIZE)
      throw new Error("model_accounting_report_incomplete");
    let previous = cursor;
    for (const row of rows) {
      const n = order(row[column]);
      if (n <= previous || n > through)
        throw new Error("model_accounting_order_invalid");
      previous = n;
    }
    return rows;
  }
  const call = (row: Row) => {
    const entry = decodeModelCallEntry(row.call_order, row.record_json, input);
    if (modelCallKey(entry.record) !== row.call_key)
      throw new Error("model_accounting_identity_invalid");
    return entry;
  };
  const usage = (row: Row) => {
    const entry = decodeModelUsageEntry(
      row.usage_order,
      row.record_json,
      input,
    );
    if (modelUsageKey(entry.record) !== row.usage_key)
      throw new Error("model_accounting_identity_invalid");
    return entry;
  };
  let callsCursor = 0,
    usageCursor = 0;
  while (callsCursor < throughCallOrder) {
    check();
    await db.transaction(async () => {
      const calls = (
        await page(
          "model_call_observations",
          "call_order",
          "call_key",
          callsCursor,
          throughCallOrder,
        )
      ).map(call);
      const q = accountingUsageEvidenceQuery(
        db,
        input,
        throughUsageOrder,
        calls.map((e) => e.record),
      );
      const evidence = await db.query(q.sql, q.parameters);
      if (evidence.length > calls.length * 3)
        throw new Error("model_accounting_evidence_limit");
      const byCall = calls.map(() => [] as ReturnType<typeof usage>[]);
      for (const row of evidence) {
        const i = order(row.i);
        if (!byCall[i] || byCall[i]!.length >= 3)
          throw new Error("model_accounting_evidence_limit");
        byCall[i]!.push(usage(row));
      }
      for (const [i, entry] of calls.entries())
        accumulator.addCall({
          call: entry.record,
          usage: byCall[i]!.map((e) => e.record),
        });
      callsCursor = calls.at(-1)!.order;
    });
    await setImmediate();
  }
  while (usageCursor < throughUsageOrder) {
    check();
    await db.transaction(async () => {
      const entries = (
        await page(
          "model_usage_observations",
          "usage_order",
          "usage_key",
          usageCursor,
          throughUsageOrder,
        )
      ).map(usage);
      const p = parameters(db.postgres);
      const wanted = entries
        .map((entry, i) => {
          const callId = entry.record.observation.callId;
          const key =
            callId === undefined
              ? null
              : modelCallKey({ ...entry.record, observation: { callId } });
          return `(${p.bind(i)},${p.bind(key)})`;
        })
        .join(",");
      const origins = await db.query(
        `WITH wanted(i,call_key) AS (VALUES ${wanted})
        SELECT w.i,c.call_order,c.call_key,${bounded("c.record_json", db.postgres)} AS record_json
        FROM wanted w JOIN ${db.schema}model_call_observations c ON c.call_key=w.call_key AND c.call_order<=${throughCallOrder}`,
        p.values,
      );
      if (origins.length > entries.length)
        throw new Error("model_accounting_evidence_limit");
      const byUsage = new Map<number, ModelCallRecord>();
      for (const row of origins) {
        const i = order(row.i);
        if (i >= entries.length || byUsage.has(i))
          throw new Error("model_accounting_evidence_limit");
        byUsage.set(i, call(row).record);
      }
      for (const [i, entry] of entries.entries())
        accumulator.addUsage(entry.record, byUsage.get(i) ?? null);
      usageCursor = entries.at(-1)!.order;
    });
    await setImmediate();
  }
  check();
  return {
    ...accumulator.snapshot(),
    throughCallOrder,
    throughUsageOrder,
    consistency: "pageSnapshots" as const,
  };
}
