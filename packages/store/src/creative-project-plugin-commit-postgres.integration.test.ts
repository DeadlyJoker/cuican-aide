import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";
import {
  creationRecipe,
  projectTables,
} from "./creative-project-store.test-support.ts";
import { installationRecipe } from "./plugin-installation-store.test-support.ts";
import {
  actor,
  optionsFor,
  pluginCommitFixture,
  selectionRecipe,
} from "./creative-project-plugin-commit.test-support.ts";

type Fixture = Awaited<ReturnType<typeof pluginCommitFixture>>;
type SourceChange = "disabled" | "uninstalled" | "changed-package";
async function changeSource(f: Fixture, change: SourceChange) {
  let selection = f.source.selection;
  if (change === "changed-package") {
    const next = await f.otherInstallations.recordInstalledPackage(
      installationRecipe("source-package-replace", {
        scope: f.scope,
        actor,
        pluginId: selection.pluginId,
        version: "6.0.0",
        expectedSelectionRevision: selection.revision,
      }),
    );
    selection = next.selection;
  }
  return f.otherInstallations.commitSelection(
    selectionRecipe(selection, `source-${change}`, {
      actor,
      state: change === "changed-package" ? "enabled" : change,
    }),
  );
}

/** Observe an actual server row-lock dependency, not a timer-based assumption about completion. */
async function waitBlocked(
  client: PoolClient,
  blockerPid: number,
  pattern: string,
): Promise<number> {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    await client.query("SELECT pg_stat_clear_snapshot()");
    const rows = (
      await client.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE $2 AND wait_event_type='Lock'",
        [blockerPid, pattern],
      )
    ).rows;
    if (rows.length === 1) return Number(rows[0]!.pid);
    assert.ok(rows.length <= 1, "fixture must block only one matching backend");
    await delay(5);
  }
  assert.fail(`actual SQL did not wait on backend ${blockerPid}: ${pattern}`);
}

for (const change of ["disabled", "uninstalled", "changed-package"] as const) {
  test(
    `PostgreSQL maxPoolSize1 qualified metadata holds the actual source SHARE until COMMIT before ${change}`,
    optionsFor("postgres"),
    async (t) => {
      const f = await pluginCommitFixture(t, "postgres"),
        g = f.grant(),
        gate = f.arm("source");
      const saving = f.track(
        f.projects.commitProjectCreation(
          creationRecipe("source-lock", "source-lock-create"),
          { authority: g.authority },
        ),
      );
      void saving.catch(() => {});
      await gate.entered.promise;
      assert.equal(g.state.fullCalls, 1);
      assert.ok(f.metadataPid !== null);
      const changing = f.track(changeSource(f, change));
      void changing.catch(() => {});
      const observer = await f.observerPool!.connect();
      try {
        const writerPid = await waitBlocked(
          observer,
          f.metadataPid,
          `UPDATE ${f.prefix}plugin_profile_selections%`,
        );
        assert.notEqual(writerPid, f.metadataPid);
        gate.resume.resolve();
        const [saved, changed] = await Promise.all([saving, changing]);
        assert.equal(saved.disposition, "committed");
        assert.equal(
          changed.selection.state,
          change === "changed-package" ? "enabled" : change,
        );
        assert.equal(
          g.state.fullCalls,
          1,
          "transaction qualification cannot reread through the one-connection pool",
        );
        assert.equal(g.state.transactionCalls, 2);
        assert.deepEqual(await f.counts(), {
          creative_projects: 1,
          creative_project_briefs: 1,
          creative_concept_assets: 0,
          creative_concept_revisions: 0,
          creative_project_mutation_receipts: 1,
        });
      } finally {
        gate.resume.resolve();
        observer.release();
      }
    },
  );

  test(
    `PostgreSQL maxPoolSize1 source ${change} owns the real row first and stale qualified metadata writes nothing`,
    optionsFor("postgres"),
    async (t) => {
      const f = await pluginCommitFixture(t, "postgres"),
        g = f.grant();
      const gate = await f.observerPool!.connect();
      const lock = `${f.schema}:metadata-source-change`;
      await f.execute(
        `CREATE FUNCTION ${f.prefix}source_change_gate() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || ':metadata-source-change')); RETURN NEW; END $body$;CREATE TRIGGER source_change_gate AFTER UPDATE ON ${f.prefix}plugin_profile_selections FOR EACH ROW EXECUTE FUNCTION ${f.prefix}source_change_gate();`,
      );
      let changing: ReturnType<typeof changeSource> | undefined;
      let saving:
        | ReturnType<typeof f.projects.commitProjectCreation>
        | undefined;
      try {
        await gate.query("BEGIN");
        await gate.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
        const gatePid = Number(
          (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
            .rows[0]!.pid,
        );
        changing = f.track(changeSource(f, change));
        void changing.catch(() => {});
        const writerPid = await waitBlocked(
          gate,
          gatePid,
          `UPDATE ${f.prefix}plugin_profile_selections%`,
        );
        saving = f.track(
          f.projects.commitProjectCreation(
            creationRecipe("source-late", "source-late-create"),
            { authority: g.authority },
          ),
        );
        void saving.catch(() => {});
        const metadataPid = await waitBlocked(
          gate,
          writerPid,
          `%${f.prefix}plugin_profile_selections%FOR SHARE OF s,p`,
        );
        assert.notEqual(metadataPid, writerPid);
        await gate.query("COMMIT");
        await changing;
        await assert.rejects(saving, /plugin_installation_pin_conflict/u);
        assert.equal(g.state.fullCalls, 1);
        assert.deepEqual(
          await f.counts(),
          Object.fromEntries(projectTables.map((table) => [table, 0])),
        );
      } finally {
        await gate.query("ROLLBACK").catch(() => {});
        await Promise.allSettled([changing, saving]);
        gate.release();
      }
    },
  );
}

for (const withdrawal of ["permission", "owner-close"] as const)
  test(
    `PostgreSQL qualified metadata rechecks ${withdrawal} after the real receipt write and rolls back all rows`,
    optionsFor("postgres"),
    async (t) => {
      const f = await pluginCommitFixture(t, "postgres"),
        g = f.grant(),
        gate = f.arm("receipt");
      const saving = f.track(
        f.projects.commitProjectCreation(
          creationRecipe("late-withdrawal", `late-${withdrawal}`),
          { authority: g.authority },
        ),
      );
      void saving.catch(() => {});
      await gate.entered.promise;
      if (withdrawal === "permission") g.state.current = false;
      else f.closeOwner();
      gate.resume.resolve();
      await assert.rejects(saving, /metadata_invocation_withdrawn/u);
      assert.equal(g.state.fullCalls, 1);
      assert.equal(g.state.transactionCalls, 2);
      assert.deepEqual(
        await f.counts(),
        Object.fromEntries(projectTables.map((table) => [table, 0])),
      );
    },
  );

test(
  "PostgreSQL confirmed qualified metadata COMMIT remains accepted when permission, source and actual store close during its reply",
  optionsFor("postgres"),
  async (t) => {
    const f = await pluginCommitFixture(t, "postgres"),
      g = f.grant(),
      gate = f.arm("commit");
    const saving = f.track(
      f.projects.commitProjectCreation(
        creationRecipe("committed", "committed-late-reply"),
        { authority: g.authority },
      ),
    );
    void saving.catch(() => {});
    await gate.entered.promise;
    assert.equal(
      (await f.counts()).creative_projects,
      1,
      "the real COMMIT is already durable before its response is delayed",
    );
    g.state.active = false;
    g.state.current = false;
    f.closeOwner();
    await changeSource(f, "uninstalled");
    await f.parent.close();
    gate.resume.resolve();
    const saved = await saving;
    assert.equal(saved.disposition, "committed");
    assert.equal(saved.project.projectId, "committed");
    assert.equal(g.state.fullCalls, 1);
    assert.equal(g.state.transactionCalls, 2);
    assert.deepEqual(await f.counts(), {
      creative_projects: 1,
      creative_project_briefs: 1,
      creative_concept_assets: 0,
      creative_concept_revisions: 0,
      creative_project_mutation_receipts: 1,
    });
  },
);
