import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { readSqliteModelCacheUsageReport } from "./sqlite-model-cache-report.ts";

test("reads several bounded usage pages without changing data and isolates tenant/run", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-cache-report-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "runtime.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE run_snapshots (tenant_id TEXT, run_id TEXT PRIMARY KEY, last_sequence INTEGER);
    CREATE TABLE run_events (tenant_id TEXT, run_id TEXT, sequence INTEGER, event_json TEXT, PRIMARY KEY (run_id, sequence));
    INSERT INTO run_snapshots VALUES ('tenant-1', 'run-1', 602), ('tenant-2', 'run-2', 1), ('tenant-1', 'incomplete-run', 2);`);
  const insert = database.prepare("INSERT INTO run_events VALUES (?, ?, ?, ?)");
  for (let sequence = 1; sequence <= 602; sequence += 1) {
    insert.run(
      "tenant-1",
      "run-1",
      sequence,
      JSON.stringify({
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: "run-1" },
        sequence,
        type:
          sequence > 300 && sequence <= 600
            ? "usage.recorded"
            : sequence === 601
              ? "context.compacted"
              : "model.output.delta",
        data:
          sequence > 300 && sequence <= 601
            ? {
                inputTokens: 100,
                cachedInputTokens: 80,
                cachedInputTokensReported: true,
                outputTokens: 10,
                totalTokens: 110,
              }
            : { delta: "private output not in report" },
      }),
    );
  }
  insert.run(
    "tenant-2",
    "run-2",
    1,
    JSON.stringify({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-2" },
      sequence: 1,
      type: "usage.recorded",
      data: { inputTokens: 9000, outputTokens: 0, totalTokens: 9000 },
    }),
  );
  database.close();
  const before = readFileSync(databasePath);
  const report = readSqliteModelCacheUsageReport({
    databasePath,
    tenantId: "tenant-1",
    runId: "run-1",
  });
  assert.equal(report.total.usageReports, 301);
  assert.equal(report.total.cacheReadHitRate, 0.8);
  assert.equal(report.sampling.usageReports, 300);
  assert.equal(report.compaction.usageReports, 1);
  assert.equal(report.throughSequence, 602);
  const cli = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      new URL("../../../scripts/crewon-model-cache-report.ts", import.meta.url)
        .pathname,
      databasePath,
      "tenant-1",
      "run-1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), report);
  assert.doesNotMatch(JSON.stringify(report), /private output/);
  assert.throws(
    () =>
      readSqliteModelCacheUsageReport({
        databasePath,
        tenantId: "tenant-2",
        runId: "run-1",
      }),
    /run_not_found/,
  );
  const legacy = readSqliteModelCacheUsageReport({
    databasePath,
    tenantId: "tenant-2",
    runId: "run-2",
  });
  assert.equal(legacy.total.cacheReadHitRate, null);
  assert.equal(legacy.total.cacheReadLegacyUsageReports, 1);
  assert.equal(legacy.total.cacheReadInputCoverage, 0);
  assert.throws(
    () =>
      readSqliteModelCacheUsageReport({
        databasePath,
        tenantId: "tenant-1",
        runId: "incomplete-run",
      }),
    /history_incomplete/,
  );
  assert.deepEqual(readFileSync(databasePath), before);
});
