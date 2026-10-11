import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import {
  capturePostgresCreativeProjectLegacyAccess,
  captureSqliteCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
} from "./creative-project-legacy-access.ts";
import {
  legacyAccessFixture,
  constraintOwnerInsert,
  preparedLegacyMutations,
  protectRunProjectFixture,
} from "./creative-project-legacy-access.test-support.ts";
import { projectRunCommitFixture } from "./creative-project-run-commit.test-support.ts";
import {
  actor,
  application,
  conceptRecipe,
  creationRecipe,
  owner,
  receipt,
} from "./creative-project-store.test-support.ts";

const table = "plugin_project_metadata_owners";
const marker = "plugin_project_metadata_owner_schema_version";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };

  test(
    `${backend}: same-principal ordinary queries hide protected metadata, briefs and concept history`,
    options,
    async (t) => {
      const f = await legacyAccessFixture(t, backend);
      const { recipe, result: created } = await f.create("protected-project");
      const concept = await f.store.commitConceptRevision(
        conceptRecipe(created.project, created.brief, "concept-history"),
      );
      const scope = { owner: owner(), projectId: created.project.projectId };
      assert.deepEqual(await f.store.loadProject(scope), concept.project);
      assert.deepEqual(
        await f.store.loadBrief({ ...scope, briefRevision: 1 }),
        created.brief,
      );
      await f.migrate();
      await f.rawFixtureInsert(scope.projectId);
      for (const who of [
        actor,
        { ...actor, actorId: "other-audit-actor" },
        { ...actor, principalId: "foreign-principal" },
        { ...actor, tenantId: "foreign-tenant" },
        { ...actor, spaceId: "foreign-space" },
      ]) {
        const q = { ...scope, owner: owner(who) };
        assert.equal(await f.store.loadProject(q), null);
        assert.equal(await f.store.loadBrief({ ...q, briefRevision: 1 }), null);
        assert.deepEqual(
          await f.store.listBriefs({ ...q, afterBriefRevision: 0, limit: 1 }),
          [],
        );
        assert.equal(
          await f.store.loadConceptAsset({
            ...q,
            assetId: concept.asset.assetId,
          }),
          null,
        );
        assert.deepEqual(
          await f.store.listConceptAssets({
            ...q,
            afterAssetId: null,
            limit: 1,
          }),
          [],
        );
        assert.equal(
          await f.store.loadConceptRevision({
            ...q,
            assetId: concept.asset.assetId,
            assetRevision: 1,
          }),
          null,
        );
        assert.deepEqual(
          await f.store.listConceptRevisions({
            ...q,
            assetId: concept.asset.assetId,
            afterAssetRevision: 0,
            limit: 1,
          }),
          [],
        );
        assert.equal(
          await f.store.loadMutationReceipt({
            actor: who,
            kind: "create-project",
            receipt: recipe.receipt,
          }),
          null,
        );
      }
      assert.equal(
        await f.store.loadMutationReceipt({
          actor,
          kind: "create-project",
          receipt: {
            ...recipe.receipt,
            requestDigest: receipt("different-body").requestDigest,
          },
        }),
        null,
      );
    },
  );

  test(
    `${backend}: SQL filters protected projects before ordering, cursor and LIMIT`,
    options,
    async (t) => {
      const f = await legacyAccessFixture(t, backend);
      const ids = ["😀", "雨", "中", "é", "z", "y", "x", "w", "v", "u"];
      for (const id of ids) await f.create(id);
      await f.migrate();
      const protectedIds = ["😀", "雨", "z", "y", "x", "v"];
      for (const id of protectedIds) await f.rawFixtureInsert(id);
      const expected = ids
        .filter((id) => !protectedIds.includes(id))
        .sort((a, b) => Buffer.compare(Buffer.from(b), Buffer.from(a)));
      const seen: string[] = [];
      let after = null as { updatedAt: string; projectId: string } | null;
      do {
        const page = await f.store.listProjects({
          owner: owner(),
          state: "all",
          after,
          limit: 1,
        });
        assert.equal(page.projects.length, 1);
        seen.push(page.projects[0]!.projectId);
        after = page.next;
      } while (after !== null);
      assert.deepEqual(seen, expected);
      assert.deepEqual(
        await f.store.listProjects({
          owner: owner({ ...actor, principalId: "foreign" }),
          state: "all",
          after: null,
          limit: 1,
        }),
        { projects: [], next: null },
      );
    },
  );

  test(
    `${backend}: all ordinary mutation kinds and protected creation replay reject without changing SQL history`,
    options,
    async (t) => {
      const f = await legacyAccessFixture(t, backend);
      const { recipe, result: created } = await f.create("protected-write");
      const concept = await f.store.commitConceptRevision(
        conceptRecipe(created.project, created.brief, "concept-history"),
      );
      const mutations = preparedLegacyMutations(
        concept.project,
        created.brief,
        concept.asset,
      );
      await f.migrate();
      await f.rawFixtureInsert(created.project.projectId);
      const before = await f.snapshot();
      for (const run of [
        () =>
          f.store.commitProjectCreation(
            creationRecipe(
              "different-server-id",
              recipe.receipt.idempotencyKey,
            ),
          ),
        () => f.store.commitProjectMetadata(mutations.rename),
        () => f.store.commitProjectMetadata(mutations.archive),
        () => f.store.commitProjectBrief(mutations.brief),
        () => f.store.commitConceptRevision(mutations.createConcept),
        () => f.store.commitConceptRevision(mutations.appendConcept),
        () =>
          f.store.commitConceptRevision(
            conceptRecipe(created.project, created.brief, "concept-history"),
          ),
      ]) {
        await assert.rejects(run(), /creative_project_not_found/u);
        assert.deepEqual(await f.snapshot(), before);
      }
      await assert.rejects(
        application(f.store).service.getProject(actor, {
          projectId: created.project.projectId,
        }),
      );
    },
  );

  test(
    `${backend}: schema opt-in does not adopt ordinary legacy metadata or alter its mutations and replay`,
    options,
    async (t) => {
      const f = await legacyAccessFixture(t, backend);
      const { recipe, result: created } = await f.create("ordinary-project");
      const before = await f.snapshot();
      assert.equal(await f.hasSchema(), false);
      await f.migrate();
      assert.deepEqual(await f.snapshot(), before);
      assert.deepEqual(
        await f.store.loadProject({
          owner: owner(),
          projectId: created.project.projectId,
        }),
        created.project,
      );
      assert.deepEqual(
        await f.store.commitProjectCreation(
          creationRecipe("retry-id", recipe.receipt.idempotencyKey),
        ),
        { ...created, disposition: "replayed" },
      );
      const changed = await application(f.store).service.renameProject(actor, {
        projectId: created.project.projectId,
        title: "普通项目继续使用",
        expectedProjectRevision: created.project.revision,
        idempotencyKey: "ordinary-rename",
      });
      assert.equal(changed.project.title, "普通项目继续使用");
      assert.equal(
        Number(
          (await f.query(`SELECT COUNT(*) AS n FROM $schema.${table}`))[0]!.n,
        ),
        0,
      );
    },
  );

  for (const partial of ["marker-only", "table-only", "index-only"] as const) {
    test(
      `${backend}: ${partial} never falls back to ordinary reads, writes or receipt publication`,
      options,
      async (t) => {
        const f = await legacyAccessFixture(t, backend);
        const { recipe, result: created } = await f.create("partial-project");
        await f.execute(
          partial === "marker-only"
            ? `CREATE TABLE $schema.${marker}(id INTEGER)`
            : partial === "table-only"
              ? `CREATE TABLE $schema.${table}(id INTEGER)`
              : `CREATE TABLE $schema.unrelated(x INTEGER); CREATE INDEX ${table} ON $schema.unrelated(x)`,
        );
        const before = await f.snapshot();
        for (const run of [
          () =>
            f.store.loadProject({
              owner: owner(),
              projectId: created.project.projectId,
            }),
          () =>
            f.store.listProjects({
              owner: owner(),
              state: "all",
              after: null,
              limit: 1,
            }),
          () =>
            f.store.loadMutationReceipt({
              actor,
              kind: "create-project",
              receipt: recipe.receipt,
            }),
          () =>
            f.store.commitProjectCreation(
              creationRecipe("retry-new-id", recipe.receipt.idempotencyKey),
            ),
        ])
          await assert.rejects(run(), /schema_invalid/u);
        assert.deepEqual(await f.snapshot(), before);
      },
    );
  }

  test(
    `${backend}: unknown or damaged schema cannot publish legacy receipt or repair itself`,
    options,
    async (t) => {
      const f = await legacyAccessFixture(t, backend);
      const { recipe } = await f.create("damaged-project");
      await f.migrate();
      await f.execute(
        `DROP TRIGGER ${marker}_immutable${backend === "postgres" ? ` ON $schema.${marker}` : ""}`,
      );
      await f.execute(`UPDATE $schema.${marker} SET version=2`);
      const before = await f.catalog();
      await assert.rejects(
        f.store.loadMutationReceipt({
          actor,
          kind: "create-project",
          receipt: recipe.receipt,
        }),
        /schema_invalid/u,
      );
      await assert.rejects(
        f.store.commitProjectCreation(
          creationRecipe("new-id", recipe.receipt.idempotencyKey),
        ),
        /schema_invalid/u,
      );
      assert.deepEqual(await f.catalog(), before);
      assert.equal(
        (await f.query(`SELECT version FROM $schema.${marker}`))[0]!.version,
        2,
      );
    },
  );

  test(
    `${backend}: negative access guard rejects protected facts and SQL alias injection without granting ownership`,
    options,
    async (t) => {
      const f = await legacyAccessFixture(t, backend);
      const { result: created } = await f.create("guarded-facts");
      await f.migrate();
      await f.rawFixtureInsert(created.project.projectId);
      await f.transaction(async () => {
        if (f.client)
          await lockPostgresCreativeProjectLegacySchema(f.client, f.schema);
        const access = f.database
          ? captureSqliteCreativeProjectLegacyAccess(f.database)
          : await capturePostgresCreativeProjectLegacyAccess(
              f.client!,
              f.schema,
            );
        const scope = {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          projectId: created.project.projectId,
        };
        if (f.database)
          assert.throws(
            () => access.assertProject(scope),
            /creative_project_not_found/u,
          );
        else
          await assert.rejects(async () => {
            await access.assertProject(scope);
          }, /creative_project_not_found/u);
        assert.throws(
          () => access.predicate("p) OR TRUE --"),
          /legacy_alias_invalid/u,
        );
      });
    },
  );

  test(
    `${backend}: actual SQL project mutation followed by ownership insertion rolls the ordinary transaction back`,
    options,
    async (t) => {
      const f = await legacyAccessFixture(t, backend);
      const { result: created } = await f.create("withdraw-project");
      const concept = await f.store.commitConceptRevision(
        conceptRecipe(created.project, created.brief, "before-protection"),
      );
      const mutation = preparedLegacyMutations(
        concept.project,
        created.brief,
        concept.asset,
      ).rename;
      await f.migrate();
      const before = await f.snapshot();
      if (f.database) {
        const raw = constraintOwnerInsert(created.project.projectId);
        const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
        await f.execute(
          `CREATE TRIGGER fixture_owner_after_actual_update AFTER UPDATE ON creative_projects WHEN NEW.project_id=${quote(created.project.projectId)} BEGIN INSERT INTO ${table}(${raw.columns.join(",")}) VALUES(${raw.values.map(quote).join(",")}); END`,
        );
        await assert.rejects(
          f.store.commitProjectMetadata(mutation),
          /creative_project_not_found/u,
        );
        assert.equal(
          Number(
            (await f.query(`SELECT COUNT(*) AS n FROM $schema.${table}`))[0]!.n,
          ),
          0,
        );
      } else {
        let checks = 0;
        await assert.rejects(
          f.store.commitProjectMetadata(mutation, {
            authority: {
              async assertCurrent() {
                if (++checks === 2)
                  await f.rawFixtureInsert(created.project.projectId);
              },
              assertActive() {},
            },
          }),
          /creative_project_not_found/u,
        );
        assert.equal(checks, 2);
      }
      assert.deepEqual(await f.snapshot(), before);
    },
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: genuine Run qualification cannot replay a protected original project through the ordinary metadata API`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await projectRunCommitFixture(t, backend);
      const op = await f.prepareOperation("project_create", {
        title: "原 Run 项目",
        briefText: "测试原项目回放隔离。",
      });
      const saved = await f.projects.createProject(
        f.actor,
        op.commandBody as never,
        op.options,
      );
      const rows = await f.sql(
        `SELECT idempotency_key,request_digest FROM ${f.prefix}creative_project_mutation_receipts WHERE project_id=${backend === "sqlite" ? "?" : "$1"}`,
        [saved.project.projectId],
      );
      const actualReceipt = {
        idempotencyKey: String(rows[0]!.idempotency_key),
        requestDigest: String(rows[0]!.request_digest),
      };
      assert.equal(
        (
          await f.metadata.loadMutationReceipt(
            { actor: f.actor, kind: "create-project", receipt: actualReceipt },
            op.options,
          )
        )?.project.projectId,
        saved.project.projectId,
      );
      await protectRunProjectFixture(f, saved.project.projectId);
      const before = await f.counts();
      assert.equal(
        await f.metadata.loadMutationReceipt(
          { actor: f.actor, kind: "create-project", receipt: actualReceipt },
          op.options,
        ),
        null,
      );
      await assert.rejects(
        f.projects.createProject(f.actor, op.commandBody as never, op.options),
        (error) =>
          error instanceof Error &&
          /creative_project_not_found/u.test(
            error.message + String(error.cause),
          ),
      );
      assert.deepEqual(await f.counts(), before);
    },
  );
}

test(
  "postgres: a reader waiting for the real first migration sees its completed schema and protected fixture",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const f = await legacyAccessFixture(t, "postgres");
    const { result: created } = await f.create("migration-wait");
    await f.execute("BEGIN");
    await f.migrateDirect();
    await f.rawFixtureInsert(created.project.projectId);
    let settled = false;
    const read = f.store
      .loadProject({ owner: owner(), projectId: created.project.projectId })
      .finally(() => {
        settled = true;
      });
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = await f.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock_shared%'",
        );
        if (rows.length !== 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true);
      assert.equal(settled, false);
      await f.execute("COMMIT");
      assert.equal(await read, null);
    } finally {
      if (!settled) await f.execute("ROLLBACK");
      await read;
    }
  },
);

test("sqlite: temporary sidecar shadows cannot turn ordinary metadata or receipts into a legacy fallback", async (t) => {
  const f = await legacyAccessFixture(t, "sqlite");
  const { recipe, result: created } = await f.create("shadow-project");
  await f.execute(`CREATE TEMP VIEW ${table} AS SELECT 1 AS id`);
  await assert.rejects(
    f.store.loadProject({
      owner: owner(),
      projectId: created.project.projectId,
    }),
    /schema_invalid/u,
  );
  await assert.rejects(
    f.store.loadMutationReceipt({
      actor,
      kind: "create-project",
      receipt: recipe.receipt,
    }),
    /schema_invalid/u,
  );
});

test(
  "postgres: the shared schema lock requires a genuine caller transaction and supports READ ONLY",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const f = await legacyAccessFixture(t, "postgres");
    await assert.rejects(
      lockPostgresCreativeProjectLegacySchema(f.client!, f.schema),
      /creative_project_legacy_transaction_required/u,
    );
    await f.execute("BEGIN READ ONLY");
    await lockPostgresCreativeProjectLegacySchema(f.client!, f.schema);
    assert.equal(
      (await f.query("SHOW transaction_read_only"))[0]!.transaction_read_only,
      "on",
    );
    const other = await f.pool!.connect();
    let settled = false;
    const wait = other.query("BEGIN").then(async () => {
      await other.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify([marker, f.schema])],
      );
      settled = true;
    });
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = await f.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(%'",
        );
        if (rows.length !== 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        waiting,
        true,
        "RELEASE SAVEPOINT must retain the shared lock in the original outer transaction",
      );
      assert.equal(settled, false);
      await f.execute("COMMIT");
      await wait;
      assert.equal(settled, true);
    } finally {
      await f.execute("ROLLBACK");
      await wait;
      await other.query("ROLLBACK");
      other.release();
    }
  },
);

test(
  "postgres: borrowed REPEATABLE READ and SERIALIZABLE transactions refuse schema-dependent legacy access",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const f = await legacyAccessFixture(t, "postgres");
    for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"] as const) {
      await f.execute(`BEGIN ISOLATION LEVEL ${isolation}`);
      await assert.rejects(
        lockPostgresCreativeProjectLegacySchema(f.client!, f.schema),
        /creative_project_legacy_isolation_invalid/u,
      );
      assert.equal(
        (await f.query("SHOW transaction_isolation"))[0]!.transaction_isolation,
        isolation.toLowerCase(),
      );
      await f.execute("ROLLBACK");
    }
  },
);

for (const operation of ["read", "mutation"] as const) {
  test(
    `postgres: owned ${operation} uses READ COMMITTED under a REPEATABLE READ session default after first migration wait`,
    { skip: !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await legacyAccessFixture(t, "postgres");
      const { result: created } = await f.create("default-rr-protected");
      const concept = await f.store.commitConceptRevision(
        conceptRecipe(created.project, created.brief, "default-rr-concept"),
      );
      const mutation = preparedLegacyMutations(
        concept.project,
        created.brief,
        concept.asset,
      ).rename;
      const before = await f.snapshot();
      // This pool's only client is an actual test session; no global role/database setting changes.
      const session = await f.pool!.connect();
      await session.query(
        "SET default_transaction_isolation='repeatable read'",
      );
      const transactionQueries: string[] = [];
      const query = session.query.bind(session);
      session.query = ((...args: Parameters<typeof session.query>) => {
        if (typeof args[0] === "string" && args[0].startsWith("BEGIN"))
          transactionQueries.push(args[0]);
        return query(...args);
      }) as typeof session.query;
      session.release();
      await f.execute("BEGIN");
      await f.migrateDirect();
      await f.rawFixtureInsert(created.project.projectId);
      let settled = false;
      const pending = (
        operation === "read"
          ? f.store.loadProject({
              owner: owner(),
              projectId: created.project.projectId,
            })
          : f.store.commitProjectMetadata(mutation)
      ).finally(() => {
        settled = true;
      });
      void pending.catch(() => {});
      try {
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const rows = await f.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock_shared%'",
          );
          if (rows.length !== 0) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true);
        assert.equal(settled, false);
        await f.execute("COMMIT");
        if (operation === "read") assert.equal(await pending, null);
        else await assert.rejects(pending, /creative_project_not_found/u);
        assert.deepEqual(transactionQueries, [
          operation === "read"
            ? "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"
            : "BEGIN ISOLATION LEVEL READ COMMITTED",
        ]);
        assert.deepEqual(await f.snapshot(), before);
      } finally {
        await f.execute("ROLLBACK");
        await pending.catch(() => {});
      }
    },
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: an orphan legacy receipt remains corruption, not a hidden or absent result`,
    options,
    async (t) => {
      const f = await legacyAccessFixture(t, backend);
      const { recipe } = await f.create("orphan-original");
      if (f.database) {
        await f.execute(
          "DROP TRIGGER creative_project_mutation_receipts_no_update; PRAGMA foreign_keys=OFF",
        );
        await f.execute(
          "UPDATE creative_project_mutation_receipts SET project_id='orphan-missing'",
        );
        await f.execute("PRAGMA foreign_keys=ON");
      } else {
        await f.execute(
          "ALTER TABLE $schema.creative_project_mutation_receipts DISABLE TRIGGER ALL",
        );
        await f.execute(
          "UPDATE $schema.creative_project_mutation_receipts SET project_id='orphan-missing'",
        );
        await f.execute(
          "ALTER TABLE $schema.creative_project_mutation_receipts ENABLE TRIGGER ALL",
        );
      }
      await assert.rejects(
        f.store.loadMutationReceipt({
          actor,
          kind: "create-project",
          receipt: recipe.receipt,
        }),
        /creative_project_receipt_invalid/u,
      );
      await assert.rejects(
        f.store.commitProjectCreation(
          creationRecipe("orphan-retry", recipe.receipt.idempotencyKey),
        ),
        /creative_project_receipt_invalid/u,
      );
    },
  );

  test(
    `${backend}: repeated ordinary reads quantify absent and present schema inspection cost`,
    options,
    async (t) => {
      const f = await legacyAccessFixture(t, backend);
      const { result } = await f.create("performance-ordinary");
      for (let i = 0; i < 64; i++) await f.create(`performance-owner-${i}`);
      const query = { owner: owner(), projectId: result.project.projectId };
      async function measure() {
        const times: number[] = [];
        for (let i = 0; i < 100; i++) {
          const started = performance.now();
          assert.deepEqual(await f.store.loadProject(query), result.project);
          times.push(performance.now() - started);
        }
        times.sort((a, b) => a - b);
        return {
          meanMs: Number(
            (times.reduce((a, b) => a + b, 0) / times.length).toFixed(3),
          ),
          p95Ms: Number(times[94]!.toFixed(3)),
        };
      }
      const absent = await measure();
      await f.migrate();
      for (let i = 0; i < 64; i++)
        await f.rawFixtureInsert(`performance-owner-${i}`);
      const present = await measure();
      t.diagnostic(
        JSON.stringify({
          backend,
          readsPerPhase: 100,
          presentOwnerRows: 64,
          absent,
          present,
        }),
      );
    },
  );
}
