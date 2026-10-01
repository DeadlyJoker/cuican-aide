import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import type { ReserveExternalOperation } from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { SqliteExternalOperationStore } from "./sqlite-external-operation-store.ts";
import { PostgresExternalOperationStore } from "./postgres-external-operation-store.ts";

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

async function fixture(t: TestContext, backend: "sqlite" | "postgres") {
  const dir = await mkdtemp(join(tmpdir(), "crewon-owned-extension-"));
  const path = join(dir, "control.sqlite");
  const schema = `extension_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  const opened: (SqliteRunStore | PostgresDomainStore)[] = [];
  t.after(async () => {
    for (const store of opened) await store.close();
    if (backend === "postgres") {
      const admin = new Pool({ connectionString, max: 1 });
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  const open = async () => {
    const parent =
      backend === "sqlite"
        ? new SqliteRunStore(path)
        : await PostgresDomainStore.open({
            connectionString: connectionString!,
            schema,
            maxPoolSize: 2,
          });
    opened.push(parent);
    return parent;
  };
  return { parent: await open(), open };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: owned external operation accessor does not migrate plugin tables`,
    options,
    async (t) => {
      const { parent } = await fixture(t, backend);
      const operations = parent.externalOperationStore();
      assert.ok(
        operations instanceof
          (backend === "sqlite"
            ? SqliteExternalOperationStore
            : PostgresExternalOperationStore),
      );
      await assert.rejects(operations.loadExternalOperation(input));
      await operations.migrate();
      assert.equal(await operations.loadExternalOperation(input), null);
      assert.equal(await parent.loadRun(input), null);
    },
  );

  test(
    `${backend}: owned operation reservations and terminal outputs survive parent reopen`,
    options,
    async (t) => {
      const { parent, open } = await fixture(t, backend);
      await parent.extensionStore().migrate();
      const operations = parent.externalOperationStore();
      const reserved = await operations.reserveExternalOperation(input);
      assert.equal(reserved.disposition, "created");
      await parent.close();

      const reopened = await open();
      const recoveredOperations = reopened.externalOperationStore();
      assert.deepEqual(
        await recoveredOperations.loadExternalOperation(input),
        reserved.operation,
      );
      assert.equal(
        (await recoveredOperations.reserveExternalOperation(input)).disposition,
        "existing",
      );
      const settled = await recoveredOperations.advanceExternalOperation({
        ...input,
        expectedRevision: 1,
        status: "succeeded",
        providerOperationId: input.correlationId,
        resultJson: JSON.stringify({ images: [{ filename: "image.png" }] }),
        updatedAt: input.createdAt,
      });
      assert.equal(settled.disposition, "updated");
      await reopened.close();

      const final = await open();
      assert.deepEqual(
        await final.externalOperationStore().loadExternalOperation(input),
        settled.operation,
      );
    },
  );

  test(
    `${backend}: parent close rejects both new and retained plugin stores`,
    options,
    async (t) => {
      const { parent } = await fixture(t, backend);
      const extensions = parent.extensionStore();
      await extensions.migrate();
      const operations = parent.externalOperationStore();
      await operations.reserveExternalOperation(input);
      await parent.close();
      assert.throws(() => parent.externalOperationStore(), /store_closed/u);
      assert.throws(() => parent.extensionStore(), /store_closed/u);
      await assert.rejects(extensions.migrate(), /store_closed/u);
      await assert.rejects(
        operations.loadExternalOperation(input),
        /store_closed/u,
      );
      await assert.rejects(
        operations.reserveExternalOperation(input),
        /store_closed/u,
      );
      await assert.rejects(
        operations.advanceExternalOperation({
          ...input,
          expectedRevision: 1,
          status: "running",
          providerOperationId: input.correlationId,
          resultJson: null,
          updatedAt: input.createdAt,
        }),
        /store_closed/u,
      );
      await assert.rejects(operations.migrate(), /store_closed/u);
    },
  );
}
