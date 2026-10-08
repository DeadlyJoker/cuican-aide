import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { updateProjectFoundationParameters } from "@crewon/domain";
import {
  projectAssetFixture,
  assetContent,
  hasAssetCause,
} from "./project-asset.test-support.ts";
import { seedDownstreamFoundation } from "./project-foundation-downstream-integration.test-support.ts";
import { planFixture } from "./project-text-plan.test-support.ts";

const pgOptions = {
  skip: !process.env.CREWON_TEST_POSTGRES_URL,
  timeout: 15_000,
};
const outline = {
  title: "雨中的信",
  logline: "修复师找到信",
  synopsis: "三封信揭开往事",
  episodes: [{ episodeId: "episode-1", title: "来信", summary: "画中藏着信" }],
};
const confirmationRequired = hasAssetCause(
  "project_foundation_proposal_confirmation_required",
);

test(
  "postgres: a real original project lock wait sees an upstream invalidation before candidate admission",
  pgOptions,
  async (t) => {
    const f = await projectAssetFixture(t, "postgres");
    const foundation = await seedDownstreamFoundation({
      parent: f.parent,
      project: f.project.project,
      actor: f.actor,
      prefix: f.prefix,
      execute: f.execute,
    });
    await foundation.confirm();
    const gate = new Client({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    await gate.connect();
    let pending: Promise<unknown> | null = null;
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([
          "creative-project-project",
          f.schema,
          f.actor.tenantId,
          f.actor.spaceId,
          f.project.project.projectId,
        ]),
      ]);
      const changed = updateProjectFoundationParameters({
        project: f.project.project,
        foundation: foundation.foundation,
        actor: f.actor,
        expectedFoundationRevision: foundation.foundation.revision,
        parameters: { ...foundation.foundation.parameters, episodeCount: 121 },
        at: new Date(
          Date.parse(foundation.foundation.updatedAt) + 1_000,
        ).toISOString(),
      });
      // Real same-lock upstream SQL transition, committed before the waiting candidate can read it.
      await gate.query(
        `UPDATE ${f.prefix}project_foundations SET revision=$1,parameters_revision=$2,record_json=$3 WHERE project_id=$4`,
        [
          changed.revision,
          changed.parametersRevision,
          JSON.stringify(changed),
          changed.projectId,
        ],
      );
      const before = await f.textCounts();
      const result = f.track(
        f.text.saveOutlineCandidate(f.actor, {
          projectId: changed.projectId,
          expectedArtifactRevision: 0,
          briefRevision: 1,
          content: outline,
          idempotencyKey: "locked-novel-outline",
        }),
      );
      pending = result;
      void result.catch(() => {});
      // Observe the actual backend's lock wait, rather than use a timer as evidence.
      const blockerPid = Number(
        (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      let waiter: number | undefined;
      for (let i = 0; i < 100 && waiter === undefined; i++) {
        const rows = await gate.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND datname=current_database()",
          [blockerPid],
        );
        waiter = rows.rows[0]?.pid;
        if (waiter === undefined)
          await new Promise<void>((done) => setTimeout(done, 10));
      }
      assert.ok(
        waiter,
        "the candidate actually waits for the shared original project lock",
      );
      await gate.query("COMMIT");
      await assert.rejects(result, confirmationRequired);
      assert.deepEqual(await f.textCounts(), before);
      assert.equal(f.pool?.totalCount, 1);
      assert.equal(f.pool?.waitingCount, 0);
    } finally {
      await gate.query("ROLLBACK");
      await pending?.catch(() => {});
      await gate.end();
    }
  },
);

test(
  "postgres: the final text guard detects a test-only native metadata edit after business writes and rolls back the receipt",
  pgOptions,
  async (t) => {
    const f = await projectAssetFixture(t, "postgres");
    const foundation = await seedDownstreamFoundation({
      parent: f.parent,
      project: f.project.project,
      actor: f.actor,
      prefix: f.prefix,
      execute: f.execute,
    });
    await foundation.confirm();
    const changed = updateProjectFoundationParameters({
      project: f.project.project,
      foundation: foundation.foundation,
      actor: f.actor,
      expectedFoundationRevision: foundation.foundation.revision,
      parameters: { ...foundation.foundation.parameters, episodeCount: 121 },
      at: new Date(
        Date.parse(foundation.foundation.updatedAt) + 1_000,
      ).toISOString(),
    });
    let edited = false;
    f.observeTextSql(async (sql) => {
      if (edited || !/INSERT INTO .*project_text_mutation_receipts/u.test(sql))
        return;
      edited = true;
      // Adversarial native SQL fixture deliberately ignores the cooperative project advisory lock.
      // It uses the independent observer, never a nested borrow of the committing one-client pool.
      await f.query(
        `UPDATE ${f.prefix}project_foundations SET revision=$1,parameters_revision=$2,record_json=$3 WHERE project_id=$4`,
        [
          changed.revision,
          changed.parametersRevision,
          JSON.stringify(changed),
          changed.projectId,
        ],
      );
    });
    try {
      await assert.rejects(
        f.text.saveOutlineCandidate(f.actor, {
          projectId: changed.projectId,
          expectedArtifactRevision: 0,
          briefRevision: 1,
          content: outline,
          idempotencyKey: "final-novel-outline",
        }),
        confirmationRequired,
      );
      assert.equal(edited, true);
      assert.deepEqual(await f.textCounts(), {
        project_text_artifacts: 0,
        project_text_revisions: 0,
        project_text_mutation_receipts: 0,
      });
      assert.equal(f.pool?.totalCount, 1);
      assert.equal(f.pool?.waitingCount, 0);
    } finally {
      f.observeTextSql(null);
    }
  },
);

test(
  "postgres: the final asset guard runs after the final external callback on the same committing client",
  pgOptions,
  async (t) => {
    const f = await projectAssetFixture(t, "postgres");
    const foundation = await seedDownstreamFoundation({
      parent: f.parent,
      project: f.project.project,
      actor: f.actor,
      prefix: f.prefix,
      execute: f.execute,
    });
    await foundation.confirm();
    const changed = updateProjectFoundationParameters({
      project: f.project.project,
      foundation: foundation.foundation,
      actor: f.actor,
      expectedFoundationRevision: foundation.foundation.revision,
      parameters: { ...foundation.foundation.parameters, episodeCount: 121 },
      at: new Date(
        Date.parse(foundation.foundation.updatedAt) + 1_000,
      ).toISOString(),
    });
    const g = f.mutation(
      "crewon.project-assets.v1.saveCandidate",
      {
        projectId: changed.projectId,
        assetId: null,
        request: {
          kind: "character",
          expectedAssetRevision: 0,
          briefRevision: 1,
          script: null,
          content: assetContent,
        },
        idempotencyKey: "final-novel-character",
      },
      false,
    );
    let edited = false;
    g.state.transactionHook = async () => {
      if (
        edited ||
        !f.commands.some((sql) =>
          /INSERT INTO .*project_asset_mutation_receipts/u.test(sql),
        )
      )
        return;
      edited = true;
      // Explicit negative fixture injection after the real candidate/receipt writes.
      await f.query(
        `UPDATE ${f.prefix}project_foundations SET revision=$1,parameters_revision=$2,record_json=$3 WHERE project_id=$4`,
        [
          changed.revision,
          changed.parametersRevision,
          JSON.stringify(changed),
          changed.projectId,
        ],
      );
    };
    await assert.rejects(f.write(g), confirmationRequired);
    assert.equal(edited, true);
    for (const table of [
      "project_assets",
      "project_asset_revisions",
      "project_asset_mutation_receipts",
    ])
      assert.equal(
        Number(
          (await f.query(`SELECT COUNT(*) AS n FROM ${f.prefix}${table}`))[0]
            ?.n,
        ),
        0,
      );
    assert.equal(f.pool?.totalCount, 1);
    assert.equal(f.pool?.waitingCount, 0);
  },
);

test(
  "postgres: the final plan guard rolls back a start invalidated by a test-only native SQL edit during final external checks",
  pgOptions,
  async (t) => {
    const f = await planFixture(t, "postgres");
    const project = await f.metadata.loadProject({
      owner: {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        principalId: f.actor.principalId,
      },
      projectId: f.binding.projectId,
    });
    assert.ok(project);
    const foundation = await seedDownstreamFoundation({
      parent: f.parent,
      project,
      actor: f.actor,
      prefix: f.prefix,
      execute: (sql) => f.rows(sql),
    });
    await foundation.confirm();
    const changed = updateProjectFoundationParameters({
      project,
      foundation: foundation.foundation,
      actor: f.actor,
      expectedFoundationRevision: foundation.foundation.revision,
      parameters: { ...foundation.foundation.parameters, episodeCount: 121 },
      at: new Date(
        Date.parse(foundation.foundation.updatedAt) + 1_000,
      ).toISOString(),
    });
    const json = JSON.stringify(changed).replaceAll("'", "''");
    let edited = false;
    f.state.beforeTransaction = async () => {
      if (edited) return;
      edited = true;
      // This observer is separate from the real maxPool=1 parent and is a negative SQL fixture.
      await f.rows(
        `UPDATE ${f.prefix}project_foundations SET revision=${changed.revision},parameters_revision=${changed.parametersRevision},record_json='${json}' WHERE project_id='${project.projectId}'`,
      );
    };
    await assert.rejects(f.start(), confirmationRequired);
    assert.equal(edited, true);
    for (const table of [
      "project_text_plans",
      "project_text_plan_revisions",
      "project_text_plan_steps",
      "project_text_plan_receipts",
      "run_snapshots",
    ])
      assert.equal(
        Number(
          (await f.rows(`SELECT COUNT(*) AS n FROM ${f.prefix}${table}`))[0]?.n,
        ),
        0,
      );
  },
);
