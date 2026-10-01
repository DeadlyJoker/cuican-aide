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
  ExternalOperationQueryStore,
  ExternalOperationQuery,
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
  validateExternalOperationQuery,
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
  first: ExternalOperationStore & ExternalOperationQueryStore;
  second: ExternalOperationStore & ExternalOperationQueryStore;
  reopen(): Promise<ExternalOperationStore & ExternalOperationQueryStore>;
  writePersisted(record: unknown): Promise<void>;
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

const query: ExternalOperationQuery = {
  tenantId: input.tenantId,
  runId: input.runId,
  bindingDigest: input.bindingDigest,
  limit: 16,
};

test("external operation queries require copied bounded scope and exact data properties", () => {
  const mutable = { ...query };
  const checked = validateExternalOperationQuery(mutable);
  mutable.tenantId = "another";
  assert.equal(checked.tenantId, input.tenantId);
  assert.ok(Object.isFrozen(checked));
  let readGetter = false;
  const getter = { ...query };
  Object.defineProperty(getter, "tenantId", {
    get() {
      readGetter = true;
      return input.tenantId;
    },
  });
  const hidden = { ...query };
  Object.defineProperty(hidden, "hidden", { value: "extra" });
  for (const invalid of [
    null,
    [],
    {},
    { ...query, extra: true },
    hidden,
    getter,
    { ...query, limit: 0 },
    { ...query, limit: 17 },
    { ...query, limit: 1.5 },
    { ...query, limit: "1" },
    { ...query, tenantId: "x".repeat(513) },
    { ...query, runId: "\ud800" },
    { ...query, runId: "run\n" },
    { ...query, bindingDigest: "invalid" },
  ])
    assert.throws(() =>
      validateExternalOperationQuery(invalid as ExternalOperationQuery),
    );
  assert.equal(readGetter, false);
});

function conformance(name: string, fixture: Fixture) {
  test(`${name}: list scopes every dimension, orders deterministically and reports truncation`, async (t) => {
    const { first, reopen } = await fixture(t);
    for (const [index, operationId] of [
      "ffffffff-0000-0000-0000-000000000001",
      input.operationId,
      "00000000-0000-0000-0000-000000000001",
    ].entries()) {
      await first.reserveExternalOperation({
        ...input,
        operationId,
        idempotencyKey: `list-${index}`,
        correlationId: randomUUID(),
      });
    }
    for (const patch of [
      { tenantId: "other" },
      { runId: "other" },
      { bindingDigest: `sha256:${"b".repeat(64)}` },
    ]) {
      await first.reserveExternalOperation({
        ...input,
        ...patch,
        idempotencyKey: "foreign",
        operationId: randomUUID(),
        correlationId: randomUUID(),
      });
    }
    const one = await first.listExternalOperations({ ...query, limit: 1 });
    assert.equal(one.truncated, true);
    assert.equal(one.operations.length, 1);
    assert.equal(
      one.operations[0]!.operationId,
      "00000000-0000-0000-0000-000000000001",
    );
    const copied = { ...query };
    const pending = first.listExternalOperations(copied);
    copied.runId = "changed-after-call";
    const all = await pending;
    assert.equal(all.truncated, false);
    assert.equal(all.operations.length, 3);
    assert.deepEqual(
      all.operations.map((operation) => operation.operationId),
      [...all.operations.map((operation) => operation.operationId)].sort(),
    );
    assert.ok(
      Object.isFrozen(all) &&
        Object.isFrozen(all.operations) &&
        all.operations.every(Object.isFrozen),
    );
    assert.deepEqual(await (await reopen()).listExternalOperations(query), all);
    assert.deepEqual(
      await first.listExternalOperations({ ...query, runId: "missing" }),
      { operations: [], truncated: false },
    );
    assert.equal(
      (await first.listExternalOperations({ ...query, limit: 3 })).truncated,
      false,
    );
  });

  test(`${name}: list validates every persisted scope including the truncation sentinel`, async (t) => {
    const { first, writePersisted } = await fixture(t);
    await first.reserveExternalOperation({
      ...input,
      operationId: "00000000-0000-0000-0000-000000000001",
      idempotencyKey: "first",
    });
    const original = (await first.reserveExternalOperation(input)).operation;
    for (const patch of [
      { tenantId: "different" },
      { runId: "different" },
      { bindingDigest: `sha256:${"b".repeat(64)}` },
      { operationId: randomUUID() },
      { schemaVersion: "crewon.external-operation.v9" },
    ]) {
      await writePersisted({ ...original, ...patch });
      await assert.rejects(
        first.listExternalOperations({ ...query, limit: 1 }),
        /external_operation_(query_scope_mismatch|version_unsupported)/u,
      );
    }
  });

  test(`${name}: list rejects invalid limits and scope before reading storage`, async (t) => {
    const { first } = await fixture(t);
    for (const patch of [
      { limit: 0 },
      { limit: 17 },
      { limit: Number.NaN },
      { runId: "" },
      { tenantId: " tenant" },
      { bindingDigest: "bad" },
    ]) {
      await assert.rejects(
        first.listExternalOperations({ ...query, ...patch }),
      );
    }
  });

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
  return {
    first: await open(),
    second: await open(),
    reopen: open,
    writePersisted: async (record) => {
      handles[0]!
        .prepare(
          "UPDATE extension_external_operations SET record_json = ? WHERE tenant_id = ? AND run_id = ? AND binding_digest = ? AND operation_id = ?",
        )
        .run(
          JSON.stringify(record),
          input.tenantId,
          input.runId,
          input.bindingDigest,
          input.operationId,
        );
    },
  };
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
    return {
      first: await open(),
      second: await open(),
      reopen: open,
      writePersisted: async (record) => {
        await pools[0]!.query(
          `UPDATE "${schema}".extension_external_operations SET record_json = $1 WHERE tenant_id = $2 AND run_id = $3 AND binding_digest = $4 AND operation_id = $5`,
          [
            record,
            input.tenantId,
            input.runId,
            input.bindingDigest,
            input.operationId,
          ],
        );
      },
    };
  });
