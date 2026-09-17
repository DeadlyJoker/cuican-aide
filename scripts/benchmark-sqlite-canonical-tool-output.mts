import assert from "node:assert/strict";
import {
  DatabaseSync,
  type SQLOutputValue,
  type SQLInputValue,
} from "node:sqlite";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  encodeSqliteModelHistoryItem,
  decodeSqliteModelHistoryItem,
  encodeSqliteRunEvent,
  decodeSqliteRunEvent,
} from "../packages/store/src/sqlite-canonical-tool-output-codec.ts";
import { stableJson } from "../packages/store/src/store-invariants.ts";

const sourcePath = process.argv[2];
if (!sourcePath || process.argv.length !== 3)
  throw new Error(
    "Usage: node --experimental-strip-types scripts/benchmark-sqlite-canonical-tool-output.mts <read-only-source.sqlite>",
  );
const maxRows = 128,
  maxScannedRows = 2048,
  maxSampleBytes = 8 * 1024 * 1024,
  maxRecordBytes = 512 * 1024;
type Row = Record<string, SQLOutputValue>;
const specifications = [
  {
    table: "model_history_items",
    column: "item_json",
    kind: "tool_result",
    decode: decodeSqliteModelHistoryItem,
    encode: (record: unknown) =>
      encodeSqliteModelHistoryItem(
        record as Parameters<typeof encodeSqliteModelHistoryItem>[0],
      ),
  },
  {
    table: "run_events",
    column: "event_json",
    kind: "tool.completed",
    decode: decodeSqliteRunEvent,
    encode: (record: unknown) =>
      encodeSqliteRunEvent(
        record as Parameters<typeof encodeSqliteRunEvent>[0],
      ),
  },
] as const;
const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
const samples: {
  specification: (typeof specifications)[number];
  schema: string;
  indexes: string[];
  columns: string[];
  rows: Row[];
  scannedRows: number;
  readMs: number;
}[] = [];
let version: number;
try {
  source.exec(
    "PRAGMA query_only=ON; PRAGMA busy_timeout=0; PRAGMA cache_size=-2048",
  );
  version = Number(source.prepare("PRAGMA user_version").get()!.user_version);
  for (const specification of specifications) {
    const { table, column, kind } = specification;
    const columns = source
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name));
    assert(columns.every((name) => /^[a-z_]+$/.test(name)));
    const schema = String(
      source
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)!.sql,
    );
    const indexes = source
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name",
      )
      .all(table)
      .map((row) => String(row.sql));
    const select = columns
      .map((name) =>
        name === column
          ? `CASE WHEN length(CAST(${column} AS BLOB))<=${maxRecordBytes} THEN ${column} ELSE NULL END AS ${column}`
          : name,
      )
      .join(",");
    const rows: Row[] = [];
    let scannedRows = 0,
      bytes = 0;
    const start = performance.now();
    // A bounded iterator closes the read transaction before compression or layout writes.
    for (const row of source
      .prepare(`SELECT ${select} FROM ${table} ORDER BY rowid DESC LIMIT ?`)
      .iterate(maxScannedRows)) {
      scannedRows++;
      if (performance.now() - start > 2000) break;
      const stored = row[column];
      if (typeof stored !== "string" || JSON.parse(stored).type !== kind)
        continue;
      bytes += Buffer.byteLength(stored);
      if (bytes > maxSampleBytes) break;
      rows.push(row);
      if (rows.length === maxRows) break;
    }
    if (!rows.length) throw new Error(`no_bounded_sample:${table}`);
    samples.push({
      specification,
      schema,
      indexes,
      columns,
      rows: rows.reverse(),
      scannedRows,
      readMs: performance.now() - start,
    });
  }
} finally {
  source.close();
}

const root = mkdtempSync(join(tmpdir(), "crewon-canonical-body-benchmark-"));
function layout(sample: (typeof samples)[number], name: string, rows: Row[]) {
  const path = join(root, `${sample.specification.table}-${name}.sqlite`),
    db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE threads(tenant_id TEXT,thread_id TEXT,PRIMARY KEY(tenant_id,thread_id)); CREATE TABLE run_snapshots(tenant_id TEXT,run_id TEXT,PRIMARY KEY(tenant_id,run_id));",
    );
    db.exec(sample.schema);
    for (const index of sample.indexes) db.exec(index);
    db.exec("BEGIN");
    const parent =
      sample.specification.table === "model_history_items"
        ? db.prepare("INSERT OR IGNORE INTO threads VALUES (?,?)")
        : db.prepare("INSERT OR IGNORE INTO run_snapshots VALUES (?,?)");
    const statement = db.prepare(
      `INSERT INTO ${sample.specification.table}(${sample.columns.join(",")}) VALUES (${sample.columns.map(() => "?").join(",")})`,
    );
    for (const row of rows) {
      parent.run(
        row.tenant_id as SQLInputValue,
        (sample.specification.table === "model_history_items"
          ? row.thread_id
          : row.run_id) as SQLInputValue,
      );
      statement.run(
        ...sample.columns.map((name) => row[name] as SQLInputValue),
      );
    }
    db.exec("COMMIT");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    return {
      fileBytes: statSync(path).size,
      pageBytes:
        Number(db.prepare("PRAGMA page_count").get()!.page_count) *
        Number(db.prepare("PRAGMA page_size").get()!.page_size),
    };
  } finally {
    db.close();
  }
}
const reports: Record<string, unknown>[] = [];
try {
  for (const sample of samples) {
    const { column, encode, decode } = sample.specification;
    const plainRows: Row[] = [],
      encodedRows: Row[] = [];
    const timings = {
      ordinaryWrite: [] as number[],
      encodedWrite: [] as number[],
      ordinaryRead: [] as number[],
      encodedRead: [] as number[],
    };
    const timed = <T,>(samples: number[], fn: () => T): T => {
      const start = performance.now();
      const value = fn();
      samples.push(performance.now() - start);
      return value;
    };
    let sourceStoredBytes = 0,
      ordinaryBytes = 0,
      encodedBytes = 0,
      sourceEncodedCount = 0,
      encodedCount = 0;
    for (const row of sample.rows) {
      const stored = String(row[column]),
        record = decode(stored);
      const ordinary = timed(timings.ordinaryWrite, () => stableJson(record));
      const encoded = timed(timings.encodedWrite, () => encode(record));
      const restored = timed(timings.encodedRead, () => decode(encoded));
      const plain = timed(timings.ordinaryRead, () => JSON.parse(ordinary));
      assert.deepEqual(restored, plain);
      sourceStoredBytes += Buffer.byteLength(stored);
      ordinaryBytes += Buffer.byteLength(ordinary);
      encodedBytes += Buffer.byteLength(encoded);
      const sourceRecord = JSON.parse(stored);
      if (
        typeof (sample.specification.table === "model_history_items"
          ? sourceRecord.output
          : sourceRecord.data.output) === "object"
      )
        sourceEncodedCount++;
      if (encoded !== ordinary) encodedCount++;
      plainRows.push({ ...row, [column]: ordinary });
      encodedRows.push({ ...row, [column]: encoded });
    }
    const sourceLayout = layout(sample, "source", sample.rows),
      ordinaryLayout = layout(sample, "ordinary", plainRows),
      encodedLayout = layout(sample, "encoded", encodedRows);
    reports.push({
      table: sample.specification.table,
      rows: sample.rows.length,
      scannedRows: sample.scannedRows,
      sourceReadMs: sample.readMs,
      sourceEncodedCount,
      encodedCount,
      sourceStoredBytes,
      ordinaryBytes,
      encodedBytes,
      sourceLayout,
      ordinaryLayout,
      encodedLayout,
      savingsAgainstSourcePercent: 100 * (1 - encodedBytes / sourceStoredBytes),
      pageSavingsAgainstSourcePercent:
        100 * (1 - encodedLayout.pageBytes / sourceLayout.pageBytes),
      timingsMs: Object.fromEntries(
        Object.entries(timings).map(([key, values]) => {
          const sorted = [...values].sort((a, b) => a - b);
          return [
            key,
            {
              median: sorted[Math.floor(sorted.length / 2)],
              p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
              max: sorted.at(-1),
            },
          ];
        }),
      ),
    });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.stdout.write(
  JSON.stringify(
    {
      source: resolve(sourcePath),
      sourceSchemaVersion: version,
      readOnlySource: true,
      maxRowsPerTable: maxRows,
      maxScannedRowsPerTable: maxScannedRows,
      maxSampleBytesPerTable: maxSampleBytes,
      maxRecordBytes,
      reports,
      temporaryFilesRemoved: !existsSync(root),
      scope:
        "Bounded tool-only sample, original table constraints/indexes and FK-checked minimal parent keys. Source layout is reconstructed from actual stored bytes. Excludes full history, triggers, WAL, concurrency, retention and whole-App memory.",
    },
    null,
    2,
  ) + "\n",
);
