import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { publicationFixture } from "./project-generation-publication.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";

type Fixture = Awaited<ReturnType<typeof publicationFixture>>;
async function mutate(
  f: Fixture,
  owner: "source" | "target",
  operation: "disabled" | "uninstalled" | "replacement",
) {
  const current = owner === "source" ? f.source.selection : f.enabled.selection;
  const store = f.second.parent.pluginInstallationStore();
  if (operation !== "replacement")
    return store.commitSelection(
      selectionRecipe(current, `${owner}-${operation}`, {
        actor: f.actor,
        state: operation,
      }),
    );
  const recipe = installationRecipe(`${owner}-replace-package`, {
    scope: {
      tenantId: current.tenantId,
      spaceId: current.spaceId,
      profileId: current.profileId,
    },
    actor: f.actor,
    pluginId: current.pluginId,
    version: "9.0.0",
    expectedSelectionRevision: current.revision,
  });
  const installed = await store.recordInstalledPackage(recipe);
  return store.commitSelection(
    selectionRecipe(installed.selection, `${owner}-replace-enable`, {
      actor: f.actor,
    }),
  );
}
async function waitBlocked(
  client: Client,
  blockerPid: number,
  queryPattern: string,
): Promise<number> {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    // The gate owns a transaction; refresh its statistics snapshot before each server-side observation.
    await client.query("SELECT pg_stat_clear_snapshot()");
    const rows = (
      await client.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE $2 AND wait_event_type='Lock'",
        [blockerPid, queryPattern],
      )
    ).rows;
    if (rows.length === 1) return Number(rows[0]!.pid);
    assert.ok(
      rows.length <= 1,
      "fixture gate unexpectedly blocked more than one matching backend",
    );
    await delay(5);
  }
  assert.fail(
    `actual backend did not block behind ${blockerPid}: ${queryPattern}`,
  );
}

for (const owner of ["source", "target"] as const)
  for (const operation of ["disabled", "uninstalled", "replacement"] as const) {
    test(
      `postgres generation holds actual ${owner} selection SHARE until atomic commit before queued ${operation}`,
      { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 15_000 },
      async (t) => {
        const f = await publicationFixture(t, "postgres");
        const gate = new Client({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        });
        await gate.connect();
        let generation: ReturnType<typeof f.commit> | undefined;
        let mutation: ReturnType<typeof mutate> | undefined;
        try {
          await gate.query("BEGIN");
          const schema = f.prefix.slice(1, -2);
          const lock = JSON.stringify([
            "creative-project-project",
            schema,
            f.actor.tenantId,
            f.actor.spaceId,
            f.reference.projectId,
          ]);
          await gate.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [lock],
          );
          const pid = Number(
            (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
          );
          generation = f.commit();
          void generation.catch(() => {});
          // Reaching the later project mutex proves both installed selection/package SHARE locks were taken.
          const generationPid = await waitBlocked(
            gate,
            pid,
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          );
          mutation = mutate(f, owner, operation);
          void mutation.catch(() => {});
          const mutationPid = await waitBlocked(
            gate,
            generationPid,
            `UPDATE ${f.prefix}plugin_profile_selections%`,
          );
          assert.notEqual(mutationPid, generationPid);
          await gate.query("COMMIT");
          const [saved, changed] = await Promise.all([generation, mutation]);
          assert.equal(saved.run.disposition, "committed");
          assert.equal(
            changed.selection.state,
            operation === "replacement" ? "enabled" : operation,
          );
          assert.equal(await f.count("creative_project_generation_links"), 1);
          assert.equal(await f.count("messages"), 1);
          assert.equal(
            (await f.credits.getAccount(f.creditScope))?.reservedCredits,
            "30",
          );
        } finally {
          await gate.query("ROLLBACK").catch(() => {});
          await Promise.allSettled([generation, mutation]);
          await gate.end();
        }
      },
    );

    test(
      `postgres ${owner} ${operation} owns the real row lock first and denies stale generation with no paid writes`,
      { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 15_000 },
      async (t) => {
        const f = await publicationFixture(t, "postgres");
        const before = await f.counts();
        const current =
          owner === "source" ? f.source.selection : f.enabled.selection;
        const schema = f.prefix.slice(1, -2);
        const lock = `${schema}:publication-selection`;
        await f.sql(
          `CREATE FUNCTION ${f.prefix}publication_selection_gate() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || ':publication-selection')); RETURN NEW; END $body$; CREATE TRIGGER publication_selection_gate AFTER UPDATE ON ${f.prefix}plugin_profile_selections FOR EACH ROW WHEN (NEW.plugin_id='${current.pluginId}') EXECUTE FUNCTION ${f.prefix}publication_selection_gate();`,
        );
        const gate = new Client({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        });
        await gate.connect();
        let generation: ReturnType<typeof f.commit> | undefined;
        let mutation: ReturnType<typeof mutate> | undefined;
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
          generation = f.commit();
          void generation.catch(() => {});
          const generationPid = await waitBlocked(
            gate,
            mutationPid,
            `%${f.prefix}plugin_profile_selections%FOR SHARE OF s,p`,
          );
          assert.notEqual(generationPid, mutationPid);
          await gate.query("COMMIT");
          const [changed, saved] = await Promise.allSettled([
            mutation,
            generation,
          ]);
          assert.equal(changed.status, "fulfilled");
          assert.ok(saved.status === "rejected");
          assert.match(String(saved.reason), /plugin_task_admission_conflict/u);
          assert.deepEqual(await f.counts(), before);
          assert.equal(
            (await f.credits.getAccount(f.creditScope))?.reservedCredits,
            "0",
          );
        } finally {
          await gate.query("ROLLBACK").catch(() => {});
          await Promise.allSettled([generation, mutation]);
          await gate.end();
        }
      },
    );
  }
