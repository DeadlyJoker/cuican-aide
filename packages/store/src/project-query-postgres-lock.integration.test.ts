import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { projectQueryFixture } from "./project-query.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
type Fixture = Awaited<ReturnType<typeof projectQueryFixture>>;
async function mutate(
  f: Fixture,
  owner: "source" | "execution",
  operation: "disabled" | "uninstalled" | "replacement",
) {
  const current = owner === "source" ? f.source.selection : f.current.selection,
    store = f.second.parent.pluginInstallationStore();
  if (operation !== "replacement")
    return store.commitSelection(
      selectionRecipe(current, `${owner}-${operation}`, {
        actor: f.actor,
        state: operation,
      }),
    );
  const installed = await store.recordInstalledPackage(
    installationRecipe(`${owner}-replacement-package`, {
      scope: {
        tenantId: current.tenantId,
        spaceId: current.spaceId,
        profileId: current.profileId,
      },
      actor: f.actor,
      pluginId: current.pluginId,
      version: "9.0.0",
      expectedSelectionRevision: current.revision,
    }),
  );
  return store.commitSelection(
    selectionRecipe(installed.selection, `${owner}-replacement-enable`, {
      actor: f.actor,
      packageDigest: installed.package.packageDigest,
    }),
  );
}
async function waitBlocked(
  client: Client,
  blockerPid: number,
  pattern: string,
): Promise<number> {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    await client.query("SELECT pg_stat_clear_snapshot()");
    const rows = (
      await client.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE $2 AND wait_event_type='Lock'",
        [blockerPid, pattern],
      )
    ).rows;
    if (rows.length === 1) return Number(rows[0]!.pid);
    assert.ok(rows.length <= 1);
    await delay(5);
  }
  assert.fail(`actual backend never blocked behind ${blockerPid}: ${pattern}`);
}
for (const owner of ["source", "execution"] as const)
  for (const operation of ["disabled", "uninstalled", "replacement"] as const) {
    test(
      `postgres maxPool=1 query holds current ${owner} SHARE through physical COMMIT before queued ${operation}`,
      { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 15_000 },
      async (t) => {
        const f = await projectQueryFixture(t, "postgres"),
          input = await f.queryInput(),
          schema = f.prefix.slice(1, -2),
          lock = `${schema}:query-sidecar-gate`;
        await f.sql(
          `CREATE FUNCTION ${f.prefix}query_sidecar_gate() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || ':query-sidecar-gate')); RETURN NEW; END $body$; CREATE TRIGGER query_sidecar_gate AFTER INSERT ON ${f.prefix}creative_project_query_links FOR EACH ROW EXECUTE FUNCTION ${f.prefix}query_sidecar_gate();`,
        );
        const gate = new Client({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        });
        await gate.connect();
        let query:
            | ReturnType<typeof f.first.store.commitExtensionTurn>
            | undefined,
          mutation: ReturnType<typeof mutate> | undefined;
        try {
          await gate.query("BEGIN");
          await gate.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            lock,
          ]);
          const pid = Number(
            (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
          );
          query = f.first.store.commitExtensionTurn(input, f.commitOptions);
          void query.catch(() => {});
          const queryPid = await waitBlocked(
            gate,
            pid,
            `INSERT INTO ${f.prefix}creative_project_query_links%`,
          );
          mutation = mutate(f, owner, operation);
          void mutation.catch(() => {});
          const mutationPid = await waitBlocked(
            gate,
            queryPid,
            `UPDATE ${f.prefix}plugin_profile_selections%`,
          );
          assert.notEqual(queryPid, mutationPid);
          await gate.query("COMMIT");
          const [saved, changed] = await Promise.all([query, mutation]);
          assert.equal(saved.run.disposition, "committed");
          assert.equal(
            changed.selection.state,
            operation === "replacement" ? "enabled" : operation,
          );
          assert.equal(await f.count("creative_project_query_links"), 1);
          assert.equal(await f.count("plugin_query_task_admissions"), 1);
          assert.equal(await f.count("creative_project_generation_links"), 1);
          assert.equal(
            (await f.credits.getAccount(f.creditScope))?.reservedCredits,
            "30",
          );
        } finally {
          await gate.query("ROLLBACK").catch(() => {});
          await Promise.allSettled([query, mutation]);
          await gate.end();
        }
      },
    );
    test(
      `postgres ${owner} ${operation} wins the actual row lock and refuses stale query without writes`,
      { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 15_000 },
      async (t) => {
        const f = await projectQueryFixture(t, "postgres"),
          input = await f.queryInput(),
          before = await f.counts(),
          current =
            owner === "source" ? f.source.selection : f.current.selection,
          schema = f.prefix.slice(1, -2),
          lock = `${schema}:query-selection-gate`;
        await f.sql(
          `CREATE FUNCTION ${f.prefix}query_selection_gate() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || ':query-selection-gate')); RETURN NEW; END $body$; CREATE TRIGGER query_selection_gate AFTER UPDATE ON ${f.prefix}plugin_profile_selections FOR EACH ROW WHEN (NEW.plugin_id='${current.pluginId}') EXECUTE FUNCTION ${f.prefix}query_selection_gate();`,
        );
        const gate = new Client({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        });
        await gate.connect();
        let query:
            | ReturnType<typeof f.first.store.commitExtensionTurn>
            | undefined,
          mutation: ReturnType<typeof mutate> | undefined;
        try {
          await gate.query("BEGIN");
          await gate.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            lock,
          ]);
          const pid = Number(
            (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
          );
          mutation = mutate(f, owner, operation);
          void mutation.catch(() => {});
          const mutationPid = await waitBlocked(
            gate,
            pid,
            `UPDATE ${f.prefix}plugin_profile_selections%`,
          );
          query = f.first.store.commitExtensionTurn(input, f.commitOptions);
          void query.catch(() => {});
          const queryPid = await waitBlocked(
            gate,
            mutationPid,
            `%${f.prefix}plugin_profile_selections%FOR SHARE OF s,p`,
          );
          assert.notEqual(queryPid, mutationPid);
          await gate.query("COMMIT");
          const [changed, saved] = await Promise.allSettled([mutation, query]);
          assert.equal(changed.status, "fulfilled");
          assert.equal(saved.status, "rejected");
          if (saved.status === "rejected")
            assert.match(
              String(saved.reason),
              /plugin_task_admission_conflict/u,
            );
          assert.deepEqual(await f.counts(), before);
          assert.equal(
            (await f.credits.getAccount(f.creditScope))?.reservedCredits,
            "30",
          );
        } finally {
          await gate.query("ROLLBACK").catch(() => {});
          await Promise.allSettled([query, mutation]);
          await gate.end();
        }
      },
    );
  }
for (const owner of ["source", "execution"] as const)
  test(
    `postgres replay retains actual current ${owner} SHARE until its external policy fence and commit finish`,
    { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 15_000 },
    async (t) => {
      const f = await projectQueryFixture(t, "postgres"),
        input = await f.queryInput();
      await f.first.store.commitExtensionTurn(input, f.commitOptions);
      const before = await f.counts();
      let release!: () => void, entered!: () => void;
      const gatePromise = new Promise<void>((resolve) => {
          release = resolve;
        }),
        enteredPromise = new Promise<void>((resolve) => {
          entered = resolve;
        });
      let calls = 0;
      const authority = {
        async assertCurrent() {
          calls++;
          if (calls === 2) {
            entered();
            await gatePromise;
          }
        },
        assertActive() {},
      };
      const observer = new Client({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      });
      await observer.connect();
      let replay:
          | ReturnType<typeof f.first.store.commitExtensionTurn>
          | undefined,
        mutation: ReturnType<typeof mutate> | undefined;
      try {
        replay = f.first.store.commitExtensionTurn(input, {
          ...f.commitOptions,
          projectQueryAuthority: authority,
        });
        void replay.catch(() => {});
        await enteredPromise;
        mutation = mutate(f, owner, "disabled");
        void mutation.catch(() => {});
        let blocker: number | undefined;
        const until = Date.now() + 3_000;
        while (Date.now() < until) {
          const rows = (
            await observer.query<{ blockers: number[] }>(
              "SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE query LIKE $1 AND wait_event_type='Lock'",
              [`UPDATE ${f.prefix}plugin_profile_selections%`],
            )
          ).rows;
          if (rows.length === 1 && rows[0]!.blockers.length === 1) {
            blocker = Number(rows[0]!.blockers[0]);
            break;
          }
          await delay(5);
        }
        assert.ok(
          blocker,
          "current installation UPDATE must physically wait for the replay's row lock",
        );
        release();
        const [saved, changed] = await Promise.all([replay, mutation]);
        assert.equal(saved.run.disposition, "replayed");
        assert.equal(changed.selection.state, "disabled");
        assert.deepEqual(await f.counts(), before);
      } finally {
        release();
        await Promise.allSettled([replay, mutation]);
        await observer.end();
      }
    },
  );
