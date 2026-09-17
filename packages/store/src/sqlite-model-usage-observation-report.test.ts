import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readSqliteModelUsageObservationsReport } from "./sqlite-model-usage-observation-report.ts";
import { sqliteModelUsageSchemaSql } from "./model-usage-schema.ts";
import type { ModelUsageRecord } from "@crewon/domain";

test("observation report and CLI read bounded pages with a high-water mark without changing the database", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-usage-report-"));
  context.after(() => rmSync(directory, { recursive: true }));
  const databasePath = join(directory, "runtime.sqlite");
  const input = { databasePath, tenantId: "tenant-1", runId: "run-1" };
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE run_snapshots (tenant_id TEXT, run_id TEXT, UNIQUE (tenant_id, run_id)); INSERT INTO run_snapshots VALUES ('tenant-1','run-1'),('tenant-2','run-2');",
  );
  assert.throws(
    () => readSqliteModelUsageObservationsReport(input),
    /ledger_unavailable/,
  );
  database.exec(sqliteModelUsageSchemaSql());
  const insert = database.prepare(
    "INSERT INTO model_usage_observations(usage_key,tenant_id,run_id,record_json) VALUES (?,?,?,?)",
  );
  for (let index = 1; index <= 301; index += 1) {
    for (const tenant of [1, 2]) {
      const record: ModelUsageRecord = {
        tenantId: `tenant-${tenant}`,
        runId: `run-${tenant}`,
        stepId: "step-1",
        attemptId: "attempt-1",
        observedAt: "2026-08-08T00:00:00Z",
        observation: {
          schemaVersion: "crewon.model-usage-observation.v0",
          observationId: `observation-${index}`,
          providerResponseId: `response-${index}`,
          responseStatus: index === 1 ? "failed" : null,
          purpose: index === 1 ? "compaction" : "agent",
          agentVersionId: "agent-1",
          adapterName: "adapter-1",
          adapterVersion: "1",
          modelId: "model-1",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 80,
            cachedInputTokensReported: true,
            outputTokens: 10,
            totalTokens: 110,
          },
        },
      };
      insert.run(
        `${tenant}-${index}`,
        record.tenantId,
        record.runId,
        JSON.stringify(record),
      );
    }
  }
  database.close();
  const before = readFileSync(databasePath);
  const report = readSqliteModelUsageObservationsReport(input);
  assert.equal(report.total.usageReports, 301);
  assert.equal(report.compaction.usageReports, 1);
  assert.equal(report.total.cacheReadHitRate, 0.8);
  assert.equal(report.throughOrder, 601);
  assert.throws(
    () =>
      readSqliteModelUsageObservationsReport({
        ...input,
        tenantId: "tenant-2",
      }),
    /run_not_found/,
  );
  const cli = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      new URL("../../../scripts/crewon-model-cache-report.ts", import.meta.url)
        .pathname,
      databasePath,
      input.tenantId,
      input.runId,
      "--observations",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), report);
  assert.deepEqual(readFileSync(databasePath), before);
  const corrupt = new DatabaseSync(databasePath);
  corrupt
    .prepare(
      "UPDATE model_usage_observations SET record_json=? WHERE usage_order=1",
    )
    .run(JSON.stringify({ secret: "private".repeat(4000) }));
  corrupt.close();
  assert.throws(
    () => readSqliteModelUsageObservationsReport(input),
    /^RunStoreError: model_usage_record_invalid$/,
  );
});
