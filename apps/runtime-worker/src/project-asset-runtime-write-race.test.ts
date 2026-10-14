import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { ProjectAssetApplicationService } from "@crewon/application";
import { PostgresProjectAssetStore } from "../../../packages/store/src/project-asset-postgres-store.ts";
import { assetToolsFixture } from "./project-asset-tools-service-owner.test-support.ts";
import { markAssetToolsOwnedProject } from "./project-asset-owned.test-support.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import { deferred } from "./plugin-tool-runtime-adapter.test-support.ts";

test(
  "postgres: actual startup observation waits behind the original asset Run lock and both complete without reverse-lock deadlock",
  {
    skip: !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15_000,
  },
  async (t) => {
    const f = await assetToolsFixture(t, "postgres");
    assert.ok(f.pool);
    assert.ok(f.schema);
    const entered = deferred(),
      release = deferred();
    let gated = false,
      writerPid = 0;
    const controlled = (client: PoolClient) =>
      new Proxy(client, {
        get(target, key) {
          if (key === "query")
            return async (sql: string, values?: unknown[]) => {
              const result = await target.query(sql, values);
              if (
                !gated &&
                sql ===
                  "SELECT pg_advisory_xact_lock(hashtextextended($1,0))" &&
                values?.[0] === `run:${f.actor.tenantId}:${f.admission.runId}`
              ) {
                gated = true;
                writerPid = Number(
                  (await target.query("SELECT pg_backend_pid() AS pid"))
                    .rows[0]!.pid,
                );
                entered.resolve();
                await release.promise;
              }
              return result;
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    // The production class and all original SQL plans remain unchanged. This named
    // observer only pauses an actual borrowed writer connection after its Run lock.
    const pool = new Proxy(f.pool, {
      get(target, key) {
        if (key === "connect")
          return async () => controlled(await target.connect());
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Pool;
    const store = new PostgresProjectAssetStore({
      pool,
      schema: f.schema,
      assertOpen: () => {},
    });
    const assets = new ProjectAssetApplicationService({
      store,
      projects: f.metadata,
      texts: f.texts,
      authorization: f.dependencies.authorization,
      clock: { now: () => new Date().toISOString() },
      ids: { nextId: () => randomUUID() },
      digester: f.digester,
    });
    const owner = f.owner({ assets }),
      tools = f.services(owner).tools;
    const request = {
      projectId: f.admitted!.assetStageAdmission.projectId,
      assetId: null,
      kind: "character" as const,
      expectedAssetRevision: 0,
      briefRevision: 1,
      script: null,
      content: {
        name: "并行验收",
        setting: "真实锁等待",
        visualPrompt: "Portrait",
      },
    };
    const operation = await f.prepareTool("asset_save", request);
    await markAssetToolsOwnedProject(f, "matching");
    const reader = new InstalledPluginRunContext({
      extensions: f.first.store,
      runs: f.parent,
      installations: f.installs,
      assetStages: f.stages,
      projectOwnership: "plugin-project-v1",
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      resolveActor: async () => f.actor,
    });
    const stats = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      max: 1,
    });
    t.after(() => stats.end());
    const saving = f.invoke(owner, operation, (command) =>
      tools.saveCandidate({ command, request }),
    );
    let loading: ReturnType<typeof reader.load> | undefined;
    try {
      await Promise.race([
        entered.promise,
        saving.then(() => {
          throw Error("asset_writer_completed_before_observed_run_lock");
        }),
      ]);
      let loaded = false;
      loading = reader
        .load({
          locator: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            runId: f.admission.runId,
          },
          expectedTarget: f.binding.target,
          purpose: "submit",
          signal: new AbortController().signal,
        })
        .then((snapshot) => {
          loaded = true;
          return snapshot;
        });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = (
          await stats.query(
            "SELECT pid,wait_event FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))",
            [writerPid],
          )
        ).rows;
        if (rows.some((row) => row.wait_event === "advisory")) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(
        blocked,
        true,
        "The genuine runtime transaction must wait for this original writer's Run advisory lock",
      );
      assert.equal(loaded, false);
      release.resolve();
      const [saved, snapshot] = await Promise.all([saving, loading]);
      assert.equal(saved.disposition, "committed");
      assert.ok(snapshot);
      assert.deepEqual(
        reader.verifiedProjectAssetStage(snapshot),
        f.admitted!.assetStageAdmission,
      );
      assert.equal(
        Number(
          (
            await f.sql(`SELECT COUNT(*) AS n FROM ${f.prefix}project_assets`)
          )[0]!.n,
        ),
        1,
      );
    } finally {
      release.resolve();
      await Promise.allSettled([
        saving,
        ...(loading === undefined ? [] : [loading]),
      ]);
    }
  },
);
