import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import type {
  ExternalOperationStore,
  ReserveExternalOperation,
} from "@crewon/application";
import {
  migrateSqliteExternalOperations,
  SqliteExternalOperationStore,
} from "./sqlite-external-operation-store.ts";
import { PostgresExternalOperationStore } from "./postgres-external-operation-store.ts";
import {
  initialExternalOperation,
  parseExternalOperation,
} from "./external-operation-record.ts";

const digest = `sha256:${"a".repeat(64)}`;
const input: ReserveExternalOperation = {
  tenantId: "tenant-1",
  runId: "run-1",
  bindingDigest: digest,
  operationId: "da7b2922-e9a1-4dda-9020-528bfbe197d0",
  correlationId: "da7b2922-e9a1-4dda-9020-528bfbe197d0",
  executionId: "execution-1",
  idempotencyKey: "key-1",
  actionDigest: digest,
  requestDigest: digest,
  createdAt: "2026-09-30T00:00:00.000Z",
};
type Fixture = (t: TestContext) => Promise<{
  first: ExternalOperationStore;
  second: ExternalOperationStore;
  reopen(): Promise<ExternalOperationStore>;
}>;

test("external operation persisted schema fails closed for corruption and unknown versions", () => {
  const record = initialExternalOperation(input);
  assert.deepEqual(parseExternalOperation(record), record);
  assert.throws(
    () =>
      parseExternalOperation({
        ...record,
        schemaVersion: "crewon.external-operation.v9",
      }),
    /version_unsupported/u,
  );
  for (const patch of [
    { status: "notSent" },
    { revision: 0 },
    { unexpected: true },
    { resultJson: "{}" },
    { updatedAt: "invalid" },
  ])
    assert.throws(() => parseExternalOperation({ ...record, ...patch }));
});

function conformance(name: string, fixture: Fixture) {
  test(`${name}: only one independent owner can reserve a request`, async (t) => {
    const { first, second } = await fixture(t);
    const results = await Promise.all([
      first.reserveExternalOperation(input),
      second.reserveExternalOperation({
        ...input,
        operationId: randomUUID(),
        correlationId: randomUUID(),
      }),
    ]);
    assert.deepEqual(results.map((r) => r.disposition).sort(), [
      "created",
      "existing",
    ]);
    assert.deepEqual(results[0]!.operation, results[1]!.operation);
  });
  test(`${name}: pre-dispatch fence and terminal output survive reopen`, async (t) => {
    const { first, reopen } = await fixture(t);
    const claimed = await first.reserveExternalOperation(input);
    const reopened = await reopen();
    assert.deepEqual(
      await reopened.loadExternalOperation(input),
      claimed.operation,
    );
    assert.equal(
      (await reopened.reserveExternalOperation(input)).disposition,
      "existing",
    );
    const resultJson = JSON.stringify({ images: [{ filename: "image.png" }] });
    const saved = await reopened.advanceExternalOperation({
      ...input,
      expectedRevision: 1,
      status: "succeeded",
      resultJson,
      providerOperationId: input.correlationId,
      updatedAt: input.createdAt,
    });
    const again = await reopen();
    assert.deepEqual(await again.loadExternalOperation(input), saved.operation);
    await assert.rejects(
      again.advanceExternalOperation({
        ...saved.operation,
        expectedRevision: 2,
        status: "unknownOutcome",
        resultJson: null,
      }),
      /external_operation_terminal/u,
    );
  });
  test(`${name}: stale observers cannot overwrite a newer receipt`, async (t) => {
    const { first, second } = await fixture(t);
    await first.reserveExternalOperation(input);
    const updates = await Promise.all(
      [first, second].map((store, index) =>
        store.advanceExternalOperation({
          ...input,
          expectedRevision: 1,
          status: index === 0 ? "running" : "queued",
          resultJson: null,
          providerOperationId: input.correlationId,
          updatedAt: input.createdAt,
        }),
      ),
    );
    assert.deepEqual(updates.map((r) => r.disposition).sort(), [
      "conflict",
      "updated",
    ]);
    assert.deepEqual(updates[0]!.operation, updates[1]!.operation);
  });
  test(`${name}: tenant, Run and immutable binding scope all fail closed`, async (t) => {
    const { first } = await fixture(t);
    await first.reserveExternalOperation(input);
    for (const patch of [
      { tenantId: "another" },
      { runId: "another" },
      { bindingDigest: `sha256:${"b".repeat(64)}` },
    ]) {
      assert.equal(
        await first.loadExternalOperation({ ...input, ...patch }),
        null,
      );
      await assert.rejects(
        first.advanceExternalOperation({
          ...input,
          ...patch,
          expectedRevision: 1,
          status: "failed",
          resultJson: null,
          providerOperationId: null,
          updatedAt: input.createdAt,
        }),
        /external_operation_not_found/u,
      );
    }
  });
  test(`${name}: changed execution identity cannot reuse a dispatch reservation`, async (t) => {
    const { first } = await fixture(t);
    await first.reserveExternalOperation(input);
    for (const patch of [
      { executionId: "other" },
      { requestDigest: `sha256:${"b".repeat(64)}` },
      { actionDigest: `sha256:${"b".repeat(64)}` },
    ])
      await assert.rejects(
        first.reserveExternalOperation({ ...input, ...patch }),
        /external_operation_identity_conflict/u,
      );
    await first.advanceExternalOperation({
      ...input,
      expectedRevision: 1,
      status: "submitted",
      providerOperationId: "provider-1",
      resultJson: null,
      updatedAt: input.createdAt,
    });
    await assert.rejects(
      first.advanceExternalOperation({
        ...input,
        expectedRevision: 2,
        status: "running",
        providerOperationId: "provider-2",
        resultJson: null,
        updatedAt: input.createdAt,
      }),
      /external_operation_provider_identity_conflict/u,
    );
  });
  test(`${name}: invalid or excessive persisted state is rejected`, async (t) => {
    const { first } = await fixture(t);
    await first.reserveExternalOperation(input);
    await assert.rejects(
      first.advanceExternalOperation({
        ...input,
        expectedRevision: 1,
        status: "succeeded",
        providerOperationId: input.correlationId,
        resultJson: JSON.stringify({ data: "x".repeat(16_384) }),
        updatedAt: input.createdAt,
      }),
      /external_operation_result_invalid/u,
    );
    await assert.rejects(
      first.reserveExternalOperation({ ...input, runId: "" }),
      /external_operation_identity_invalid/u,
    );
    assert.equal((await first.loadExternalOperation(input))!.revision, 1);
  });
}

conformance("SQLite external operations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "crewon-external-"));
  const handles: DatabaseSync[] = [];
  t.after(async () => {
    for (const db of handles) db.close();
    await rm(dir, { force: true, recursive: true });
  });
  const open = async () => {
    const db = new DatabaseSync(join(dir, "operations.sqlite"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    handles.push(db);
    migrateSqliteExternalOperations(db);
    return new SqliteExternalOperationStore(db);
  };
  return { first: await open(), second: await open(), reopen: open };
});

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
if (connectionString === undefined)
  test.skip("PostgreSQL external operations require CREWON_TEST_POSTGRES_URL", () => {});
else
  conformance("PostgreSQL external operations", async (t) => {
    const schema = `extension_${randomUUID().replaceAll("-", "")}`;
    const pools: Pool[] = [];
    const admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    t.after(async () => {
      for (const pool of pools) await pool.end();
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    const open = async () => {
      const pool = new Pool({ connectionString, max: 1 });
      pools.push(pool);
      const store = new PostgresExternalOperationStore(pool, schema);
      await store.migrate();
      return store;
    };
    return { first: await open(), second: await open(), reopen: open };
  });
