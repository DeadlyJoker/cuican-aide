import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool } from "pg";

import { PostgresQueueStore } from "./postgres-queue-store.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const fixturePath = fileURLToPath(
  new URL("../test-fixtures/postgres-work-item-process.ts", import.meta.url),
);

test(
  "two PostgreSQL worker processes hold sibling leases and recover after SIGKILL",
  {
    skip:
      connectionString === undefined
        ? "CREWON_TEST_POSTGRES_URL is not configured"
        : false,
  },
  async () => {
    assert.ok(connectionString !== undefined);
    const schema = `workflow_process_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString, max: 4 });
    const queue = new PostgresQueueStore({ connectionString, schema });
    try {
      await queue.migrate();
      await seedSibling(pool, schema, "node-left");
      await seedSibling(pool, schema, "node-right");

      const left = child(connectionString, schema, "worker-left", "hold");
      const right = child(connectionString, schema, "worker-right", "hold");
      const [leftClaim, rightClaim] = await Promise.all([
        firstRecord(left),
        firstRecord(right),
      ]);
      assert.equal(leftClaim.status, "claimed");
      assert.equal(rightClaim.status, "claimed");
      assert.notEqual(leftClaim.workItemId, rightClaim.workItemId);
      assert.notEqual(leftClaim.leaseId, rightClaim.leaseId);
      assert.equal(leftClaim.leaseEpoch, 1);
      assert.equal(rightClaim.leaseEpoch, 1);

      left.kill("SIGKILL");
      right.kill("SIGKILL");
      await Promise.all([once(left, "exit"), once(right, "exit")]);
      await pool.query(
        `UPDATE "${schema}".work_items SET lease_expires_at=clock_timestamp()-interval '1 second'
         WHERE status='leased'`,
      );

      const recovered = await runChild(
        connectionString,
        schema,
        "worker-restarted",
        "complete",
      );
      assert.deepEqual(
        recovered.map((record) => record.status),
        ["claimed", "completed"],
      );
      assert.equal(recovered[0]?.leaseEpoch, 2);
      const remaining = await runChild(
        connectionString,
        schema,
        "worker-restarted-2",
        "complete",
      );
      assert.deepEqual(
        remaining.map((record) => record.status),
        ["claimed", "completed"],
      );
      assert.equal(remaining[0]?.leaseEpoch, 2);

      const rows = await pool.query<{
        work_item_id: string;
        status: string;
        lease_epoch: number | string;
        attempt_count: number | string;
      }>(
        `SELECT work_item_id,status,lease_epoch,attempt_count
         FROM "${schema}".work_items ORDER BY work_item_id`,
      );
      assert.deepEqual(
        rows.rows.map((row) => ({
          ...row,
          lease_epoch: Number(row.lease_epoch),
          attempt_count: Number(row.attempt_count),
        })),
        [
          {
            work_item_id: "node-left",
            status: "completed",
            lease_epoch: 2,
            attempt_count: 2,
          },
          {
            work_item_id: "node-right",
            status: "completed",
            lease_epoch: 2,
            attempt_count: 2,
          },
        ],
      );
    } finally {
      await queue.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  },
);

async function seedSibling(pool: Pool, schema: string, workItemId: string) {
  const item = {
    workItemId,
    tenantId: "tenant-process",
    runId: "run-process",
    kind: "run.execute",
    payload: {
      schemaVersion: "crewon.workflow-node-work-item.v0",
      trigger: "workflowNode",
      binding: {
        workflowId: "workflow-process",
        workflowVersionId: "workflow-version-process",
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
      nodeId: workItemId,
      claimId: `claim-${workItemId}`,
      claimEpoch: 1,
      schedulerOperationId: "scheduler-process",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
  };
  await pool.query(
    `INSERT INTO "${schema}".work_items
     (work_item_id,tenant_id,run_id,kind,work_item_json,created_at,available_at)
     VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '1 second')`,
    [
      item.workItemId,
      item.tenantId,
      item.runId,
      item.kind,
      item,
      item.createdAt,
    ],
  );
}

function child(url: string, schema: string, ownerId: string, mode: string) {
  return spawn(process.execPath, ["--experimental-strip-types", fixturePath], {
    env: {
      ...process.env,
      CREWON_TEST_POSTGRES_URL: url,
      CREWON_TEST_POSTGRES_SCHEMA: schema,
      CREWON_TEST_WORKER_ID: ownerId,
      CREWON_TEST_LEASE_ID: randomUUID(),
      CREWON_TEST_WORKER_MODE: mode,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
}

async function firstRecord(
  process: ChildProcess,
): Promise<Record<string, unknown>> {
  assert.ok(process.stdout !== null);
  for await (const chunk of process.stdout) {
    const line = String(chunk).trim().split("\n")[0];
    if (line) return JSON.parse(line) as Record<string, unknown>;
  }
  throw new Error("worker_process_exited_without_record");
}

async function runChild(
  url: string,
  schema: string,
  ownerId: string,
  mode: string,
) {
  const process = child(url, schema, ownerId, mode);
  let stdout = "";
  process.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  const [code] = (await once(process, "exit")) as [number | null];
  assert.equal(code, 0);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
