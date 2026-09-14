import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Pool } from "pg";
import {
  RunStoreError,
  type ArtifactRetentionCandidate,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import {
  artifactRecoveryFinished,
  canRetirePostgresArtifact,
  canRetireSqliteArtifact,
} from "./artifact-retention-guard.ts";
import { runningStateFixture } from "./run-store-conformance.test-support.ts";

test("image retirement requires matching tenant, space, owner and an immutable terminal Run without a Tool receipt", () => {
  const run = terminalRun();
  const candidate = imageCandidate(run);
  assert.equal(artifactRecoveryFinished(candidate, run, null), true);
  for (const status of ["completed", "failed", "canceled"] as const)
    assert.equal(
      artifactRecoveryFinished(candidate, { ...run, status }, null),
      true,
    );
  for (const state of [
    null,
    ...["queued", "running", "waitingApproval", "suspended", "reconciling"].map(
      (status) => ({ ...run, status }) as RunState,
    ),
    { ...run, terminalAt: null },
    { ...run, terminalAt: "invalid" },
    { ...run, tenantId: "other" },
    { ...run, spaceId: "other" },
    { ...run, createdByActorId: "other" },
    { ...run, runId: "other" },
  ])
    assert.equal(artifactRecoveryFinished(candidate, state, null), false);
});

test("SQLite image guard reads one bounded Run and needs no receipt table", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE TABLE run_snapshots (tenant_id TEXT, run_id TEXT, space_id TEXT, revision INTEGER, last_sequence INTEGER, state_json TEXT, PRIMARY KEY (tenant_id, run_id))",
    );
    const run = terminalRun();
    const candidate = imageCandidate(run);
    database
      .prepare("INSERT INTO run_snapshots VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        run.tenantId,
        run.runId,
        run.spaceId,
        run.revision,
        run.lastSequence,
        JSON.stringify(run),
      );
    assert.equal(canRetireSqliteArtifact(database, candidate), true);
    database
      .prepare("UPDATE run_snapshots SET state_json=?")
      .run(JSON.stringify({ ...run, status: "running", terminalAt: null }));
    assert.equal(canRetireSqliteArtifact(database, candidate), false);
    database
      .prepare("UPDATE run_snapshots SET state_json=?")
      .run(JSON.stringify({ ...run, oversized: "x".repeat(1024 * 1024) }));
    assert.equal(canRetireSqliteArtifact(database, candidate), false);
    database.prepare("UPDATE run_snapshots SET state_json=?").run("{");
    assert.throws(
      () => canRetireSqliteArtifact(database, candidate),
      invalidEvidence,
    );
    database
      .prepare("UPDATE run_snapshots SET state_json=?")
      .run(JSON.stringify({ ...run, runId: "different" }));
    assert.throws(
      () => canRetireSqliteArtifact(database, candidate),
      invalidEvidence,
    );
    database.prepare("DELETE FROM run_snapshots").run();
    assert.equal(canRetireSqliteArtifact(database, candidate), false);
  } finally {
    database.close();
  }
});

test("Postgres image guard uses a bounded Run-only query and rejects mismatched row evidence", async () => {
  const run = terminalRun();
  const candidate = imageCandidate(run);
  const row = {
    run_json: run,
    tenant_id: run.tenantId,
    run_id: run.runId,
    space_id: run.spaceId,
    run_revision: String(run.revision),
    last_sequence: String(run.lastSequence),
  };
  let rows: Record<string, unknown>[] = [row];
  const pool = {
    async query(sql: string, params: unknown[]) {
      assert.match(sql, /octet_length\(r.state_json::text\) <= 1048576/u);
      assert.match(sql, /FROM "fixture"\.run_snapshots r/u);
      assert.match(sql, /LIMIT 1/u);
      assert.doesNotMatch(sql, /tool_execution_receipts|idempotency_key/u);
      assert.deepEqual(params, [run.tenantId, run.runId]);
      return { rows };
    },
  } as unknown as Pool;
  assert.equal(
    await canRetirePostgresArtifact(pool, '"fixture"', candidate),
    true,
  );
  rows = [{ ...row, run_json: null }];
  assert.equal(
    await canRetirePostgresArtifact(pool, '"fixture"', candidate),
    false,
  );
  rows = [{ ...row, run_revision: "900" }];
  await assert.rejects(
    canRetirePostgresArtifact(pool, '"fixture"', candidate),
    invalidEvidence,
  );
  rows = [{ ...row, tenant_id: "other" }];
  await assert.rejects(
    canRetirePostgresArtifact(pool, '"fixture"', candidate),
    invalidEvidence,
  );
  rows = [];
  assert.equal(
    await canRetirePostgresArtifact(pool, '"fixture"', candidate),
    false,
  );
});

function invalidEvidence(error: unknown): boolean {
  return (
    error instanceof RunStoreError &&
    error.code === "artifact_retention_evidence_invalid"
  );
}
function terminalRun(): RunState {
  return {
    ...runningStateFixture(),
    status: "failed",
    terminalAt: "2026-08-08T00:02:00Z",
  };
}
function imageCandidate(run: RunState): ArtifactRetentionCandidate {
  return {
    idempotencyKey: "model-image:fixture",
    record: {
      schemaVersion: "crewon.artifact.v0",
      artifactId: "artifact-image",
      tenantId: run.tenantId,
      spaceId: run.spaceId,
      ownerActorId: run.createdByActorId,
      kind: "modelImage",
      mediaType: "image/png",
      sensitivity: "workspaceSensitive",
      source: {
        kind: "modelImage",
        runId: run.runId,
        segmentId: "segment-1",
        itemId: "image-1",
      },
      byteLength: 1024,
      contentDigest: `sha256:${"b".repeat(64)}`,
      createdAt: "2026-08-08T00:01:03Z",
      retention: { kind: "run", expiresAt: "2026-08-09T00:01:03Z" },
      encryption: { scheme: "aes256gcm", keyId: "key" },
      scan: { status: "notRequired", scannedAt: null, scanner: null },
    },
  };
}
