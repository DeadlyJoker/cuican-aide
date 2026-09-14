import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { reportModelCalls, type ModelCallRecord } from "@crewon/domain";
import { sqliteModelCallSchemaSql } from "./model-usage-schema.ts";
import { readSqliteModelCallsReport } from "./sqlite-model-call-report.ts";

test("call report reads bounded pages, distinguishes retrievals and never turns unknown calls into zero usage", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-calls-report-"));
  context.after(() => rmSync(directory, { recursive: true }));
  const databasePath = join(directory, "runtime.sqlite");
  const input = { databasePath, tenantId: "tenant", runId: "run" };
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE run_snapshots (tenant_id TEXT, run_id TEXT, UNIQUE(tenant_id,run_id)); INSERT INTO run_snapshots VALUES ('tenant','run');",
  );
  assert.throws(() => readSqliteModelCallsReport(input), /ledger_unavailable/);
  database.exec(sqliteModelCallSchemaSql());
  const insert = database.prepare(
    "INSERT INTO model_call_observations(call_key,tenant_id,run_id,record_json) VALUES (?,?,?,?)",
  );
  for (let index = 0; index < 301; index++) {
    const record: ModelCallRecord = {
      tenantId: input.tenantId,
      runId: input.runId,
      stepId: "step",
      attemptId: "attempt",
      observation: {
        schemaVersion: "crewon.model-call-observation.v0",
        callId: `call-${index}`,
        purpose: index === 0 ? "compaction" : "agent",
        transport: "http",
        operation: index === 1 ? "retrieve" : "generate",
        agentVersionId: "agent",
        adapterName: "adapter",
        adapterVersion: "1",
        modelId: `model-${index % 40}`,
        startedAt: "2026-09-11T00:00:00Z",
        finishedAt: null,
        outcome: "unknown",
        providerResponseId: null,
        firstOutputLatencyMs: null,
        usageEventObserved: false,
      },
    };
    insert.run(
      String(index),
      input.tenantId,
      input.runId,
      JSON.stringify(record),
    );
  }
  database.close();
  const before = readFileSync(databasePath);
  const report = readSqliteModelCallsReport(input);
  assert.equal(report.generations.intents, 300);
  assert.equal(report.generations.unfinished, 300);
  assert.equal(report.generations.usageEventUnknown, 300);
  assert.equal(report.generations.withoutUsageEvent, 0);
  assert.equal(report.generations.withUsageEvent, 0);
  assert.equal(report.retrievals.intents, 1);
  assert.equal(report.compaction.intents, 1);
  assert.equal(report.models.length, 32);
  assert(report.unlistedModels.intents > 0);
  assert(!Object.hasOwn(report, "cacheReadHitRate"));
  const cli = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      new URL("../../../scripts/crewon-model-cache-report.ts", import.meta.url)
        .pathname,
      databasePath,
      input.tenantId,
      input.runId,
      "--calls",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), report);
  assert.deepEqual(readFileSync(databasePath), before);
  const corrupt = new DatabaseSync(databasePath);
  assert.throws(() =>
    corrupt
      .prepare(
        "UPDATE model_call_observations SET record_json=? WHERE call_order=1",
      )
      .run(JSON.stringify({ invalid: "x".repeat(16384) })),
  );
  corrupt
    .prepare(
      "UPDATE model_call_observations SET record_json=? WHERE call_order=1",
    )
    .run(JSON.stringify({ invalid: "private" }));
  corrupt.close();
  assert.throws(
    () => readSqliteModelCallsReport(input),
    /^RunStoreError: model_call_record_invalid$/,
  );
});

test("completed, failed and interrupted calls remain separate from missing usage and response retrieval", () => {
  const locator = { tenantId: "tenant", runId: "run" };
  const entries = (
    ["completed", "failed", "canceled", "interrupted"] as const
  ).map((outcome, index) => ({
    order: index + 1,
    record: {
      ...locator,
      stepId: "step",
      attemptId: "attempt",
      observation: {
        schemaVersion: "crewon.model-call-observation.v0",
        callId: `call-${index}`,
        purpose: index === 1 ? "compaction" : "agent",
        agentVersionId: "agent",
        adapterName: "adapter",
        adapterVersion: "1",
        modelId: "model",
        transport: "http",
        operation: index === 3 ? "retrieve" : "generate",
        startedAt: "2026-09-11T00:00:00Z",
        finishedAt: "2026-09-11T00:00:01Z",
        outcome,
        providerResponseId: "response",
        firstOutputLatencyMs: index === 0 ? 100 : null,
        usageEventObserved: index === 1,
      },
    } satisfies ModelCallRecord,
  }));
  const report = reportModelCalls(locator, entries);
  assert.equal(report.generations.intents, 3);
  assert.equal(report.generations.completed, 1);
  assert.equal(report.generations.failed, 1);
  assert.equal(report.generations.canceled, 1);
  assert.equal(report.generations.withoutUsageEvent, 2);
  assert.equal(report.generations.withUsageEvent, 1);
  assert.equal(report.generations.usageEventUnknown, 0);
  assert.equal(report.compaction.withUsageEvent, 1);
  assert.equal(report.retrievals.intents, 1);
  assert.equal(report.retrievals.interrupted, 1);
  assert.equal(report.generations.firstOutputSamples, 1);
  assert.equal(report.generations.firstOutputLatencyTotalMs, 100);
  assert.equal(report.retrievals.firstOutputSamples, 0);
});
