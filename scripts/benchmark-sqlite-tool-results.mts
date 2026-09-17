import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { validateToolExecutionReceipt } from "../packages/domain/src/index.ts";
import {
  encodeSqliteToolReceiptState as encode,
  decodeSqliteToolReceiptState as decode,
} from "../packages/store/src/sqlite-tool-result-codec.ts";
import { stableJson } from "../packages/store/src/store-invariants.ts";

const sourcePath = process.argv[2];
if (!sourcePath || process.argv.length !== 3)
  throw new Error(
    "Usage: node --experimental-strip-types scripts/benchmark-sqlite-tool-results.mts <read-only-source.sqlite>",
  );
const maxRows = 128,
  maxSampleBytes = 8 * 1024 * 1024;
const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
let rows: Record<string, unknown>[],
  schema: string,
  version: number,
  indexes: string[];
try {
  source.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0");
  version = Number(source.prepare("PRAGMA user_version").get()!.user_version);
  schema = String(
    source
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_execution_receipts'",
      )
      .get()!.sql,
  );
  indexes = source
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tool_execution_receipts' AND sql IS NOT NULL ORDER BY name",
    )
    .all()
    .map((row) => String(row.sql));
  rows = source
    .prepare(
      `WITH recent AS (SELECT rowid AS source_order,* FROM tool_execution_receipts ORDER BY rowid DESC LIMIT ?), bounded AS (
   SELECT *,sum(length(CAST(state_json AS BLOB))) OVER (ORDER BY source_order DESC) AS sample_bytes FROM recent
 ) SELECT receipt_id,tenant_id,run_id,step_id,attempt_id,work_item_id,action_digest,idempotency_key,status,revision,state_json,prepared_at,updated_at,resolved_at
 FROM bounded WHERE sample_bytes<=? AND length(CAST(state_json AS BLOB))<=262144 ORDER BY source_order`,
    )
    .all(maxRows, maxSampleBytes);
} finally {
  source.close();
}
if (rows.length === 0) throw new Error("no_bounded_tool_receipt_sample");
const columns = Object.keys(rows[0]!);
const root = mkdtempSync(join(tmpdir(), "crewon-tool-body-benchmark-"));
const measures = {
  ordinaryWriteMs: [] as number[],
  encodedWriteMs: [] as number[],
  ordinaryReadMs: [] as number[],
  encodedReadMs: [] as number[],
};
const plainRows: Record<string, unknown>[] = [],
  encodedRows: Record<string, unknown>[] = [];
let originalBytes = 0,
  encodedBytes = 0,
  encodedCount = 0;
const timed = <T,>(samples: number[], fn: () => T): T => {
  const start = performance.now();
  const result = fn();
  samples.push(performance.now() - start);
  return result;
};
function layout(name: string, values: Record<string, unknown>[]) {
  const path = join(root, name + ".sqlite"),
    db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    // Preserve every receipt constraint/index. Minimal parent keys satisfy FKs without copying user history.
    db.exec(
      "CREATE TABLE run_snapshots(tenant_id TEXT,run_id TEXT,PRIMARY KEY(tenant_id,run_id)); CREATE TABLE run_attempts(tenant_id TEXT,run_id TEXT,step_id TEXT,attempt_id TEXT,PRIMARY KEY(tenant_id,run_id,step_id,attempt_id)); CREATE TABLE work_items(work_item_id TEXT PRIMARY KEY);",
    );
    db.exec(schema);
    for (const index of indexes) db.exec(index);
    db.exec("BEGIN");
    const run = db.prepare("INSERT OR IGNORE INTO run_snapshots VALUES (?,?)"),
      attempt = db.prepare(
        "INSERT OR IGNORE INTO run_attempts VALUES (?,?,?,?)",
      ),
      work = db.prepare("INSERT OR IGNORE INTO work_items VALUES (?)");
    for (const row of values) {
      run.run(String(row.tenant_id), String(row.run_id));
      attempt.run(
        String(row.tenant_id),
        String(row.run_id),
        String(row.step_id),
        String(row.attempt_id),
      );
      work.run(String(row.work_item_id));
    }
    const insert = db.prepare(
      `INSERT INTO tool_execution_receipts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    for (const row of values)
      insert.run(
        ...columns.map((column) => row[column] as string | number | null),
      );
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
let report: Record<string, unknown>;
try {
  for (const row of rows) {
    const state = decode(String(row.state_json));
    validateToolExecutionReceipt(state);
    const ordinary = timed(measures.ordinaryWriteMs, () => stableJson(state));
    const encoded = timed(measures.encodedWriteMs, () => encode(state));
    const plain = timed(measures.ordinaryReadMs, () => {
      const parsed = JSON.parse(ordinary);
      validateToolExecutionReceipt(parsed);
      return parsed;
    });
    const restored = timed(measures.encodedReadMs, () => {
      const parsed = decode(encoded);
      validateToolExecutionReceipt(parsed);
      return parsed;
    });
    assert.deepEqual(restored, plain);
    originalBytes += Buffer.byteLength(ordinary);
    encodedBytes += Buffer.byteLength(encoded);
    if (encoded !== ordinary) encodedCount++;
    plainRows.push({ ...row, state_json: ordinary });
    encodedRows.push({ ...row, state_json: encoded });
  }
  const ordinaryLayout = layout("ordinary", plainRows),
    encodedLayout = layout("encoded", encodedRows);
  const distributions = Object.fromEntries(
    Object.entries(measures).map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [
        name,
        {
          median: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          max: sorted.at(-1),
          total: values.reduce((sum, value) => sum + value, 0),
        },
      ];
    }),
  );
  report = {
    source: resolve(sourcePath),
    sourceSchemaVersion: version,
    readOnlySource: true,
    maxRows,
    maxSampleBytes,
    rows: rows.length,
    encodedCount,
    ordinaryStateBytes: originalBytes,
    encodedStateBytes: encodedBytes,
    stateSavingsPercent: 100 * (1 - encodedBytes / originalBytes),
    ordinaryLayout,
    encodedLayout,
    pageSavingsPercent:
      100 * (1 - encodedLayout.pageBytes / ordinaryLayout.pageBytes),
    timingsMs: distributions,
    scope:
      "Bounded page-layout sample with all receipt indexes and FK-checked minimal parent keys; excludes full parent history, WAL, concurrent writes and whole-App memory",
  };
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  JSON.stringify(
    { ...report, temporaryFilesRemoved: !existsSync(root) },
    null,
    2,
  ) + "\n",
);
