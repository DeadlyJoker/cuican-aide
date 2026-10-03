import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type { ExternalOperationStore } from "@crewon/application";
import { compositionFixture } from "./runtime-composition.test-support.ts";
import { readinessFixture } from "./installed-plugin-execution-readiness.test-support.ts";
import type { InstalledPluginExecutionConfig } from "./plugins/installed-plugin-runtime-composition.ts";

/** Captures the actual parent Store while delegating every production method; owns its own schemas/DB fixture. */
export async function readinessCompositionFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const metadata = await readinessFixture(t);
  const f = compositionFixture(t, backend);
  await f.activate();
  f.observeStoreClose();
  let actualStore: SqliteRunStore | PostgresDomainStore | null = null;
  let schema: string | null = null;
  if (backend === "postgres") {
    const open = PostgresDomainStore.open;
    t.mock.method(
      PostgresDomainStore,
      "open",
      async (input: Parameters<typeof open>[0]) => {
        const store = await open.call(PostgresDomainStore, input);
        actualStore = store;
        schema = input.schema ?? null;
        return store;
      },
    );
  }
  const prototype =
    backend === "sqlite"
      ? SqliteRunStore.prototype
      : PostgresDomainStore.prototype;
  const operations: () => ExternalOperationStore =
    prototype.externalOperationStore;
  t.mock.method(
    prototype,
    "externalOperationStore",
    function (this: SqliteRunStore | PostgresDomainStore) {
      actualStore = this;
      return operations.call(this);
    },
  );
  const pool =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 1,
        })
      : null;
  t.after(async () => {
    await pool?.end();
  });
  const config: InstalledPluginExecutionConfig = {
    installRoot: metadata.installRoot,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    resolveActor: async () => ({
      tenantId: "tenant-1",
      spaceId: "space-1",
      principalId: "principal-1",
      actorId: "actor-1",
    }),
    authorizePackage: async () => "allow",
  };
  let modelCalls = 0;
  const modelStream = f.config.transport.stream.bind(f.config.transport);
  const transport = {
    ...f.config.transport,
    async *stream(...args: Parameters<typeof modelStream>) {
      modelCalls++;
      yield* modelStream(...args);
    },
  };
  async function assertStoreLive() {
    assert.ok(actualStore);
    assert.ok(
      await actualStore.loadActiveAgentVersionRelease({
        tenantId: f.config.runtimeTenantId,
      }),
    );
  }
  async function countRuns() {
    if (pool !== null) {
      assert.ok(schema && /^crewon_composition_[A-Za-z0-9_]+$/u.test(schema));
      return Number(
        (
          await pool.query(
            `SELECT COUNT(*) AS count FROM "${schema}".run_snapshots`,
          )
        ).rows[0].count,
      );
    }
    const database = new DatabaseSync(join(f.root, "control.sqlite"));
    try {
      return Number(
        database.prepare("SELECT COUNT(*) AS count FROM run_snapshots").get()!
          .count,
      );
    } finally {
      database.close();
    }
  }
  return {
    ...f,
    metadata,
    config,
    transport,
    assertStoreLive,
    countRuns,
    actualStore: () => {
      assert.ok(actualStore);
      return actualStore;
    },
    modelCalls: () => modelCalls,
  };
}
