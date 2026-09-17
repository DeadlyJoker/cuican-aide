import { createHash, randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ArtifactStoreError,
  type ArtifactRetentionGuard,
  type ArtifactRetentionPolicy,
  type ArtifactRetentionResult,
} from "@crewon/application";
import { parseArtifactRecord } from "@crewon/domain";
import type { ArtifactRetentionQuery } from "./artifact-retention-query.ts";

export const DEFAULT_ARTIFACT_RETENTION: ArtifactRetentionPolicy =
  Object.freeze({
    minimumIntervalMs: 30_000,
    recoveryGraceMs: 86_400_000,
    maxRecords: 25,
    maxBytes: 1024 * 1024 * 1024,
    maxDurationMs: 250,
  });
const MAX_METADATA_BYTES = 16 * 1024;

export function configureArtifactRetention(database: DatabaseSync): void {
  // New small tables only; existing metadata is indexed incrementally during maintenance.
  database.exec(`
    CREATE TABLE IF NOT EXISTS artifact_retention_queue (
      artifact_order INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
      next_check_ms INTEGER NOT NULL,
      retired_at_ms INTEGER,
      retired_fingerprint TEXT,
      deleted_at_ms INTEGER,
      UNIQUE(tenant_id, artifact_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS artifact_retention_due ON artifact_retention_queue(next_check_ms, artifact_order)
      WHERE deleted_at_ms IS NULL;
    CREATE TABLE IF NOT EXISTS artifact_maintenance (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      indexed_tenant TEXT NOT NULL, indexed_artifact TEXT NOT NULL, indexing_complete INTEGER NOT NULL,
      next_due_ms INTEGER NOT NULL,
      owner TEXT
    ) STRICT;
    INSERT OR IGNORE INTO artifact_maintenance VALUES (1,'','',0,0,NULL);
    CREATE TRIGGER IF NOT EXISTS artifact_enqueue_retention AFTER INSERT ON artifacts BEGIN
      INSERT INTO artifact_retention_queue(tenant_id,artifact_id,next_check_ms) VALUES (NEW.tenant_id,NEW.artifact_id,0);
    END;
  `);
}

export function validateArtifactRetentionPolicy(
  p: ArtifactRetentionPolicy,
): void {
  for (const [value, minimum, maximum] of [
    [p.minimumIntervalMs, 100, 86_400_000],
    [p.recoveryGraceMs, 0, 365 * 86_400_000],
    [p.maxRecords, 1, 100],
    [p.maxBytes, 1, 1024 * 1024 * 1024],
    [p.maxDurationMs, 1, 5_000],
  ])
    if (!Number.isSafeInteger(value) || value! < minimum! || value! > maximum!)
      throw new ArtifactStoreError("artifact_retention_policy_invalid");
}

export function artifactIsRetired(
  database: DatabaseSync,
  tenantId: string,
  artifactId: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 FROM artifacts a JOIN artifact_retention_queue q ON q.tenant_id=a.tenant_id AND q.artifact_id=a.artifact_id
    WHERE a.tenant_id=? AND a.artifact_id=? AND q.retired_at_ms IS NOT NULL`,
      )
      .get(tenantId, artifactId) !== undefined
  );
}

export async function maintainFilesystemArtifacts(input: {
  database: DatabaseSync;
  policy: ArtifactRetentionPolicy;
  guard: ArtifactRetentionGuard;
  authorityQuery: ArtifactRetentionQuery;
  signal: AbortSignal;
  blobDirectory: string;
  relativeBlobPath: (tenantId: string, artifactId: string) => string;
  recoverWriting: (input: {
    tenantId: string;
    artifactId: string;
    maxBytes: number;
  }) => boolean;
}): Promise<ArtifactRetentionResult> {
  const { database, policy, guard, signal } = input;
  validateArtifactRetentionPolicy(policy);
  signal.throwIfAborted();
  const result = {
    disposition: "deferred" as "deferred" | "maintained",
    indexed: 0,
    checked: 0,
    deleted: 0,
    deletedBytes: 0,
    recovered: 0,
    recoveredBytes: 0,
    recoveryDeferred: 0,
  };
  const start = performance.now();
  let processedBytes = 0;
  const now = Date.now();
  const owner = randomUUID();
  // Durable admission serializes maintenance processes. Timed-out reads retain physical admission
  // separately; expired ownership cannot admit a new retirement from a late response.
  const leaseUntil = now + Math.max(policy.minimumIntervalMs, 30_000);
  if (
    !transaction(database, () => {
      const claimed = database
        .prepare(
          `UPDATE artifact_maintenance SET owner=?, next_due_ms=? WHERE singleton=1 AND next_due_ms<=?`,
        )
        .run(owner, leaseUntil, now);
      return claimed.changes === 1;
    })
  )
    return result;
  result.disposition = "maintained";
  const owned = () =>
    database
      .prepare(
        "SELECT 1 FROM artifact_maintenance WHERE singleton=1 AND owner=? AND next_due_ms>?",
      )
      .get(owner, Date.now()) !== undefined;
  const due = Date.now();
  try {
    // Legacy metadata walks its existing stable composite key, never an implicit SQLite rowid.
    transaction(database, () => {
      if (!owned()) return;
      const cursor = database
        .prepare(
          "SELECT indexed_tenant,indexed_artifact,indexing_complete FROM artifact_maintenance WHERE singleton=1",
        )
        .get()!;
      if (cursor.indexing_complete === 1) return;
      const rows = database
        .prepare(
          "SELECT tenant_id,artifact_id FROM artifacts WHERE (tenant_id,artifact_id)>(?,?) ORDER BY tenant_id,artifact_id LIMIT ?",
        )
        .all(
          cursor.indexed_tenant!,
          cursor.indexed_artifact!,
          policy.maxRecords,
        );
      const insert = database.prepare(
        "INSERT OR IGNORE INTO artifact_retention_queue(tenant_id,artifact_id,next_check_ms) VALUES (?,?,?)",
      );
      for (const row of rows) insert.run(row.tenant_id!, row.artifact_id!, due);
      if (rows.length)
        database
          .prepare(
            "UPDATE artifact_maintenance SET indexed_tenant=?,indexed_artifact=? WHERE singleton=1 AND owner=?",
          )
          .run(rows.at(-1)!.tenant_id!, rows.at(-1)!.artifact_id!, owner);
      else
        database
          .prepare(
            "UPDATE artifact_maintenance SET indexing_complete=1 WHERE singleton=1 AND owner=?",
          )
          .run(owner);
      result.indexed = rows.length;
    });
    const ids = database
      .prepare(
        `SELECT artifact_order FROM artifact_retention_queue INDEXED BY artifact_retention_due
      WHERE deleted_at_ms IS NULL AND next_check_ms<=? ORDER BY next_check_ms, artifact_order LIMIT ?`,
      )
      .all(due, policy.maxRecords);
    for (const id of ids) {
      signal.throwIfAborted();
      if (performance.now() - start >= policy.maxDurationMs || !owned()) break;
      const row = database
        .prepare(
          `SELECT
        CASE WHEN length(CAST(a.tenant_id AS BLOB))<=512 THEN a.tenant_id ELSE NULL END AS tenant_id,
        CASE WHEN length(CAST(a.artifact_id AS BLOB))<=512 THEN a.artifact_id ELSE NULL END AS artifact_id,
        CASE WHEN length(CAST(a.idempotency_key AS BLOB))<=1024 THEN a.idempotency_key ELSE NULL END AS idempotency_key,
        a.state, CASE WHEN length(CAST(a.relative_path AS BLOB))<=256 THEN a.relative_path ELSE NULL END AS relative_path,
        CASE WHEN length(CAST(a.record_json AS BLOB))<=${MAX_METADATA_BYTES} THEN a.record_json ELSE NULL END AS record_json,
        q.retired_at_ms, q.retired_fingerprint FROM artifacts a JOIN artifact_retention_queue q ON q.tenant_id=a.tenant_id AND q.artifact_id=a.artifact_id WHERE q.artifact_order=?`,
        )
        .get(id.artifact_order!);
      result.checked++;
      // Rotate retained/corrupt/writing entries so one old active Run cannot starve the tail.
      const defer = (next: number) =>
        transaction(database, () => {
          if (owned())
            database
              .prepare(
                "UPDATE artifact_retention_queue SET next_check_ms=? WHERE artifact_order=? AND deleted_at_ms IS NULL",
              )
              .run(next, id.artifact_order!);
        });
      defer(Date.now() + Math.max(policy.minimumIntervalMs, 60_000));
      if (
        !row ||
        typeof row.record_json !== "string" ||
        typeof row.idempotency_key !== "string"
      )
        continue;
      let record;
      try {
        record = parseArtifactRecord(JSON.parse(row.record_json));
      } catch {
        continue;
      }
      if (
        record.tenantId !== row.tenant_id ||
        record.artifactId !== row.artifact_id
      )
        continue;
      if (record.byteLength > policy.maxBytes - processedBytes) continue;
      if (row.state === "writing") {
        // Only a bounded, authenticated staged/final blob can complete an interrupted write.
        // Unknown/partial content stays available for recovery; no tool or model is called.
        const maximum = Math.min(policy.maxBytes - processedBytes, 1024 * 1024);
        if (record.byteLength > maximum) {
          result.recoveryDeferred++;
          continue;
        }
        processedBytes += record.byteLength;
        if (
          input.recoverWriting({
            tenantId: record.tenantId,
            artifactId: record.artifactId,
            maxBytes: maximum,
          })
        ) {
          result.recovered++;
          result.recoveredBytes += record.byteLength;
        } else result.recoveryDeferred++;
        // Retirement is a separate future pass with the canonical Run/Tool guard.
        continue;
      }
      if (row.state !== "ready") continue;
      const eligibleAt =
        Date.parse(record.retention.expiresAt) + policy.recoveryGraceMs;
      if (eligibleAt > Date.now()) {
        defer(eligibleAt);
        continue;
      }
      const relativePath = input.relativeBlobPath(
        record.tenantId,
        record.artifactId,
      );
      if (row.relative_path !== relativePath) continue;
      const fingerprint = createHash("sha256")
        .update(row.record_json)
        .digest("hex");
      if (row.retired_at_ms !== null && row.retired_fingerprint !== fingerprint)
        continue;
      if (row.retired_at_ms === null) {
        const eligible = await input.authorityQuery.check({
          candidate: { record, idempotencyKey: String(row.idempotency_key) },
          guard,
          signal,
          maxDurationMs: policy.maxDurationMs - (performance.now() - start),
        });
        signal.throwIfAborted();
        if (
          eligible !== true ||
          Date.now() < eligibleAt ||
          performance.now() - start >= policy.maxDurationMs
        )
          continue;
        const sealed = transaction(database, () => {
          if (!owned()) return false;
          const updated = database
            .prepare(
              `UPDATE artifact_retention_queue SET retired_at_ms=?, retired_fingerprint=?
            WHERE artifact_order=? AND retired_at_ms IS NULL
            AND EXISTS (SELECT 1 FROM artifacts a WHERE a.tenant_id=artifact_retention_queue.tenant_id AND a.artifact_id=artifact_retention_queue.artifact_id AND a.state='ready' AND a.record_json=?)`,
            )
            .run(Date.now(), fingerprint, id.artifact_order!, row.record_json);
          return updated.changes === 1;
        });
        if (!sealed) continue;
      }
      // Charge physical work even when a concurrent writer prevents its confirmation.
      processedBytes += record.byteLength;
      // A sealed tombstone permanently blocks re-creation. Repeated unlink after a crash is safe.
      const filename = path.join(input.blobDirectory, relativePath);
      for (const directory of [
        path.dirname(input.blobDirectory),
        input.blobDirectory,
        path.dirname(path.dirname(filename)),
        path.dirname(filename),
      ]) {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new ArtifactStoreError("artifact_retention_path_invalid");
      }
      signal.throwIfAborted();
      try {
        await unlink(filename);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      signal.throwIfAborted();
      transaction(database, () => {
        if (!owned()) return;
        const removed = database
          .prepare(
            "UPDATE artifact_retention_queue SET deleted_at_ms=? WHERE artifact_order=? AND retired_at_ms IS NOT NULL AND deleted_at_ms IS NULL",
          )
          .run(Date.now(), id.artifact_order!);
        if (removed.changes === 1) {
          result.deleted++;
          result.deletedBytes += record.byteLength;
        }
      });
    }
  } finally {
    transaction(database, () => {
      database
        .prepare(
          "UPDATE artifact_maintenance SET owner=NULL, next_due_ms=? WHERE singleton=1 AND owner=?",
        )
        .run(Date.now() + policy.minimumIntervalMs, owner);
    });
  }
  return result;
}

function transaction<T>(database: DatabaseSync, work: () => T): T | undefined {
  const prior = Number(database.prepare("PRAGMA busy_timeout").get()!.timeout);
  database.exec("PRAGMA busy_timeout=0");
  try {
    database.exec("BEGIN IMMEDIATE");
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* no acquired transaction */
    }
    if (
      error instanceof Error &&
      /database is (?:locked|busy)/i.test(error.message)
    )
      return undefined;
    throw error;
  } finally {
    database.exec(`PRAGMA busy_timeout=${prior}`);
  }
}
