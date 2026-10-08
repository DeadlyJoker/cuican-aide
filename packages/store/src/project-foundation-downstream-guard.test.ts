import assert from "node:assert/strict";
import test from "node:test";
import { setProjectFoundationCreativeStartMode } from "@crewon/domain";
import { creationRecipe } from "./creative-project-store.test-support.ts";
import {
  actor,
  confirmationRecipe,
  foundationCreationRecipe,
  ordinaryAuthority,
  parameterChangeRecipe,
  proposalRecipe,
  receipt,
  time,
  type Backend,
} from "./project-foundation-store.test-support.ts";
import { downstreamFixture } from "./project-foundation-downstream.test-support.ts";
import {
  capturePostgresProjectFoundationDownstream,
  captureSqliteProjectFoundationDownstream,
} from "./project-foundation-downstream-guard.ts";

for (const backend of [
  "sqlite",
  "postgres",
] as const satisfies readonly Backend[]) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 10_000,
  };
  test(
    `${backend}: downstream legacy reads do not migrate or classify v0 projects`,
    options,
    async (t) => {
      const f = await downstreamFixture(t, backend, { migrate: false });
      const created = await f.first.projects.commitProjectCreation(
        creationRecipe("legacy-downstream"),
      );
      const before = await f.tableNames();
      assert.equal(
        await f.capture(f.atProject(created.project.projectId)),
        null,
      );
      assert.deepEqual(await f.tableNames(), before);
      await f.first.foundation.migrate();
      assert.equal(
        await f.capture(f.atProject(created.project.projectId)),
        null,
      );
      assert.equal(await f.count("project_foundations"), 0);
    },
  );

  test(
    `${backend}: downstream rejects unconfirmed creative and novel foundations; stored direct-script is explicit`,
    options,
    async (t) => {
      const f = await downstreamFixture(t, backend);
      const authority = ordinaryAuthority().authority;
      for (const origin of ["creative", "novel"] as const) {
        const created = await f.first.foundation.commitCreation(
          foundationCreationRecipe(`pending-${origin}`, undefined, origin),
          { authority },
        );
        await assert.rejects(
          f.capture(f.atProject(created.project.projectId)),
          /project_foundation_proposal_confirmation_required/u,
        );
        if (origin === "creative") {
          const foundation = setProjectFoundationCreativeStartMode({
            project: created.project,
            foundation: created.foundation,
            actor,
            expectedFoundationRevision: created.foundation.revision,
            creativeStartMode: "direct-script",
            at: time(1),
          });
          await f.first.foundation.commitFoundationChange(
            {
              actor,
              receipt: receipt("explicit-direct"),
              kind: "choose-direct-script",
              expectedFoundationRevision: created.foundation.revision,
              foundation,
              source: null,
              chunks: [],
              chapters: [],
              proposal: null,
            },
            { authority },
          );
          const snapshot = await f.capture(
            f.atProject(created.project.projectId),
          );
          assert.equal(snapshot?.foundation.creativeStartMode, "direct-script");
          assert.equal(snapshot?.proposal, null);
        }
      }
    },
  );

  test(
    `${backend}: downstream resolves actual exact source and confirmed proposal; updates invalidate confirmation`,
    options,
    async (t) => {
      const f = await downstreamFixture(t, backend);
      const authority = ordinaryAuthority().authority;
      for (const origin of ["creative", "novel"] as const) {
        const created = await f.first.foundation.commitCreation(
          foundationCreationRecipe(`confirmed-${origin}`, undefined, origin),
          { authority },
        );
        const saved = await f.first.foundation.commitProposal(
          proposalRecipe(
            created.project,
            created.foundation,
            `proposal-${origin}`,
          ),
          { authority },
        );
        assert.ok(saved.proposal);
        const confirmed = await f.first.foundation.commitFoundationChange(
          confirmationRecipe(
            created.project,
            created.foundation,
            saved.proposal,
            `confirm-${origin}`,
          ),
          { authority },
        );
        const input = f.atProject(created.project.projectId);
        const snapshot = await f.capture(input);
        assert.equal(
          snapshot?.foundation.revision,
          confirmed.foundation.revision,
        );
        assert.deepEqual(snapshot?.proposal, saved.proposal);
        assert.deepEqual(snapshot?.source, created.source);
        await f.assertUnchanged(input, snapshot);
        await f.first.foundation.commitFoundationChange(
          parameterChangeRecipe(
            created.project,
            confirmed.foundation,
            `edit-${origin}`,
          ),
          { authority },
        );
        await assert.rejects(
          f.capture(input),
          /project_foundation_proposal_confirmation_required/u,
        );
        await assert.rejects(
          f.assertUnchanged(input, snapshot),
          /project_foundation_proposal_confirmation_required/u,
        );
      }
    },
  );

  test(
    `${backend}: final same-connection snapshot rejects a changed foundation even when direct-script remains allowed`,
    options,
    async (t) => {
      const f = await downstreamFixture(t, backend);
      const recipe = foundationCreationRecipe("changed-direct-downstream");
      const created = await f.first.foundation.commitCreation({
        ...recipe,
        foundation: {
          ...recipe.foundation,
          creativeStartMode: "direct-script",
        },
      });
      const input = f.atProject(created.project.projectId);
      const snapshot = await f.capture(input);
      assert.ok(snapshot);
      await f.first.foundation.commitFoundationChange(
        parameterChangeRecipe(
          created.project,
          created.foundation,
          "changed-direct-parameters",
        ),
      );
      const current = await f.capture(input);
      assert.equal(current?.foundation.creativeStartMode, "direct-script");
      await assert.rejects(
        f.assertUnchanged(input, snapshot),
        /project_foundation_downstream_changed/u,
      );
    },
  );

  test(
    `${backend}: downstream never follows a dangling source or proposal pointer`,
    options,
    async (t) => {
      const f = await downstreamFixture(t, backend);
      for (const pointer of ["source", "confirmedProposal"] as const) {
        const created = await f.first.foundation.commitCreation(
          foundationCreationRecipe(`dangling-${pointer}`, undefined, "novel"),
        );
        const foundation = {
          ...created.foundation,
          revision: 2,
          [pointer]: { revision: 99, digest: `sha256:${"a".repeat(64)}` },
        };
        const json = JSON.stringify(foundation).replaceAll("'", "''");
        // Deliberate corrupt persisted pointer, while all independent schema fences remain installed.
        await f.execute(
          `UPDATE ${f.prefix}project_foundations SET revision=${foundation.revision},record_json='${json}' WHERE project_id='${created.project.projectId}'`,
        );
        await assert.rejects(
          f.capture(f.atProject(created.project.projectId)),
          pointer === "source"
            ? /project_foundation_source_not_found/u
            : /project_foundation_confirmed_proposal_mismatch/u,
        );
      }
    },
  );

  test(
    `${backend}: downstream rejects foreign owners and SQL rejects relational/body disagreement`,
    options,
    async (t) => {
      const f = await downstreamFixture(t, backend);
      const created = await f.first.foundation.commitCreation(
        foundationCreationRecipe("owned-downstream"),
      );
      await assert.rejects(
        f.capture({
          ...f.atProject(created.project.projectId),
          actor: { ...actor, principalId: "foreign-owner" },
        }),
        /creative_project_not_found/u,
      );
      const json = JSON.stringify({
        ...created.foundation,
        revision: 2,
        ownerPrincipalId: "foreign-owner",
      }).replaceAll("'", "''");
      await assert.rejects(
        f.execute(
          `UPDATE ${f.prefix}project_foundations SET revision=2,record_json='${json}' WHERE project_id='${created.project.projectId}'`,
        ),
        /check constraint/iu,
      );
      assert.deepEqual(
        await f.first.foundation.loadFoundation({
          owner: {
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            principalId: actor.principalId,
          },
          projectId: created.project.projectId,
        }),
        created.foundation,
      );
    },
  );

  test(
    `${backend}: downstream partial and future schemas fail closed without repair`,
    options,
    async (t) => {
      const f = await downstreamFixture(t, backend);
      const created = await f.first.projects.commitProjectCreation(
        creationRecipe("schema-downstream"),
      );
      await f.execute(
        `UPDATE ${f.prefix}project_foundation_schema_version SET version=99 WHERE id=1`,
      );
      await assert.rejects(
        f.capture(f.atProject(created.project.projectId)),
        /project_foundation_schema_version_unsupported/u,
      );
      assert.equal(
        (
          await f.query(
            `SELECT version FROM ${f.prefix}project_foundation_schema_version`,
          )
        )[0]?.version,
        99,
      );
      await f.execute(
        `UPDATE ${f.prefix}project_foundation_schema_version SET version=1 WHERE id=1`,
      );
      await f.execute(`DROP TABLE ${f.prefix}project_source_chapters`);
      await assert.rejects(
        f.capture(f.atProject(created.project.projectId)),
        /project_foundation_schema_incomplete/u,
      );
    },
  );

  test(
    `${backend}: downstream uses the borrowed transaction and leaves no half-write on denial`,
    options,
    async (t) => {
      const f = await downstreamFixture(t, backend);
      const created = await f.first.foundation.commitCreation(
        foundationCreationRecipe("rollback-downstream", undefined, "novel"),
      );
      const input = f.atProject(created.project.projectId);
      await f.execute(
        `CREATE TABLE ${f.prefix}downstream_probe (id INTEGER PRIMARY KEY)`,
      );
      if (f.database !== null) {
        f.database.exec("BEGIN IMMEDIATE");
        try {
          f.database.exec("INSERT INTO downstream_probe VALUES(1)");
          assert.throws(
            () => captureSqliteProjectFoundationDownstream(f.database!, input),
            /project_foundation_proposal_confirmation_required/u,
          );
        } finally {
          f.database.exec("ROLLBACK");
        }
      } else {
        const client = await f.pool!.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO ${f.prefix}downstream_probe VALUES(1)`,
          );
          await assert.rejects(
            capturePostgresProjectFoundationDownstream(client, f.schema, input),
            /project_foundation_proposal_confirmation_required/u,
          );
          assert.equal(f.pool!.totalCount, 1);
          assert.equal(f.pool!.waitingCount, 0);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
      assert.equal(await f.count("downstream_probe"), 0);
    },
  );
}
