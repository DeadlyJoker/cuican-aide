import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { renameCreativeProject } from "@crewon/domain";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";
import { conceptSelectionFixture } from "./project-concept-selection.test-support.ts";
import { receipt as projectReceipt } from "./creative-project-store.test-support.ts";
async function blocked(observer: Client, pattern: string) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const rows = (
      await observer.query<{ pid: number; blockers: number[] }>(
        "SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE query LIKE $1 AND wait_event_type='Lock'",
        [pattern],
      )
    ).rows;
    if (rows.length === 1) {
      assert.equal(rows[0]?.blockers.length, 1);
      return rows[0]!;
    }
    await delay(5);
  }
  assert.fail("physical backend lock was never observed: " + pattern);
}
for (const replay of [false, true])
  for (const mutation of [
    "source-ui",
    "exact-operation",
    "project",
    "execution-activation",
  ] as const)
    test(
      `postgres maxPool=1 ${replay ? "replay" : "fresh"} retains actual ${mutation} lock through final policy and physical COMMIT`,
      { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 15000 },
      async (t) => {
        const f = await conceptSelectionFixture(t, "postgres");
        if (replay)
          await f.selectionStore.commitConceptImageSelection(
            f.selectionInput,
            f.selectionCommitOptions,
          );
        let entered!: () => void,
          release!: () => void,
          calls = 0;
        const arrived = new Promise<void>((r) => (entered = r)),
          gate = new Promise<void>((r) => (release = r)),
          observer = new Client({
            connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          });
        await observer.connect();
        const pending = f.selectionStore.commitConceptImageSelection(
          f.selectionInput,
          {
            ...f.selectionCommitOptions,
            authority: {
              async assertCurrent() {
                if (++calls === 2) {
                  entered();
                  await gate;
                }
              },
              assertActive() {},
            },
          },
        );
        void pending.catch(() => {});
        let change: Promise<unknown> | undefined;
        try {
          await Promise.race([
            arrived,
            pending.then(() => assert.fail("final policy fence not entered")),
          ]);
          if (mutation === "source-ui")
            change = f.second.parent.pluginInstallationStore().commitSelection(
              selectionRecipe(f.source.selection, "lock-source-disabled", {
                actor: f.actor,
                state: "disabled",
              }),
            );
          else if (mutation === "exact-operation")
            change = f.sql(
              `UPDATE ${f.prefix}extension_external_operations SET revision=revision WHERE operation_id='${f.operation.operationId}'`,
            );
          else if (mutation === "execution-activation")
            change = f.sql(
              `UPDATE ${f.prefix}extension_activations SET revision=revision WHERE plugin_id='${f.link.binding.pluginId}'`,
            );
          else {
            const p = await f.second.parent.creativeProjectStore().loadProject({
              owner: f.selectionReadInput.owner,
              projectId: f.reference.projectId,
            });
            assert.ok(p);
            const renamed = renameCreativeProject({
              project: p,
              actor: f.actor,
              expectedProjectRevision: p.revision,
              title: "After exact selection",
              at: f.selectionInput.at,
            });
            change = f.second.parent
              .creativeProjectStore()
              .commitProjectMetadata({
                actor: f.actor,
                kind: "rename-project",
                expectedProjectRevision: p.revision,
                project: renamed,
                receipt: projectReceipt("locked-project-rename"),
              });
          }
          void change.catch(() => {});
          const pattern =
            mutation === "source-ui"
              ? `UPDATE ${f.prefix}plugin_profile_selections%`
              : mutation === "exact-operation"
                ? `UPDATE ${f.prefix}extension_external_operations%`
                : mutation === "execution-activation"
                  ? `UPDATE ${f.prefix}extension_activations%`
                  : "SELECT pg_advisory_xact_lock%";
          const actual = await blocked(observer, pattern);
          assert.ok(actual.blockers[0]);
          release();
          const selected = await pending;
          await change;
          assert.equal(selected.disposition, replay ? "replayed" : "committed");
          assert.equal(await f.count("creative_concept_selection_receipts"), 1);
          assert.equal(await f.count("creative_current_concept_selections"), 1);
        } finally {
          release();
          await Promise.allSettled([pending, change]);
          await observer.end();
        }
      },
    );
test(
  "postgres actual operation writer wins row lock and stale operation revision never publishes",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 15000 },
  async (t) => {
    const f = await conceptSelectionFixture(t, "postgres"),
      writer = new Client({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      }),
      observer = new Client({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      });
    await writer.connect();
    await observer.connect();
    let selection:
      | ReturnType<typeof f.selectionStore.commitConceptImageSelection>
      | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query(
        `UPDATE ${f.prefix}extension_external_operations SET revision=revision+1,record_json=jsonb_set(record_json,'{revision}',to_jsonb(revision+1)) WHERE operation_id=$1`,
        [f.operation.operationId],
      );
      selection = f.selectionStore.commitConceptImageSelection(
        f.selectionInput,
        f.selectionCommitOptions,
      );
      void selection.catch(() => {});
      await blocked(
        observer,
        `SELECT * FROM ${f.prefix}extension_external_operations%FOR UPDATE`,
      );
      await writer.query("COMMIT");
      await assert.rejects(selection, /operation_revision_conflict/);
      for (const table of [
        "creative_operation_result_links",
        "creative_current_concept_selections",
        "creative_concept_selection_receipts",
      ])
        assert.equal(await f.count(table), 0);
    } finally {
      await writer.query("ROLLBACK").catch(() => {});
      await Promise.allSettled([selection]);
      await writer.end();
      await observer.end();
    }
  },
);
test(
  "postgres final transaction policy revocation rolls back persisted pointer/link/receipt on maxPool=1",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const f = await conceptSelectionFixture(t, "postgres");
    let calls = 0;
    await assert.rejects(
      f.selectionStore.commitConceptImageSelection(f.selectionInput, {
        ...f.selectionCommitOptions,
        authority: {
          async assertCurrent() {
            if (++calls === 2) throw new Error("policy_final_revoked");
          },
          assertActive() {},
        },
      }),
      /policy_final_revoked/,
    );
    for (const table of [
      "creative_operation_result_links",
      "creative_current_concept_selections",
      "creative_concept_selection_receipts",
    ])
      assert.equal(await f.count(table), 0);
  },
);
