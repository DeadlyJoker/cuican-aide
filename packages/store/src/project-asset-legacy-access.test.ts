import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { projectAssetMutationReceipt } from "@crewon/application";
import { assetLegacyAccessFixture } from "./project-asset-legacy-access.test-support.ts";
import {
  assetAt,
  assetContent,
  assetTestOptions,
  hasAssetCause,
} from "./project-asset.test-support.ts";
import { SqliteProjectAssetStore } from "./project-asset-sqlite-store.ts";
import { PostgresProjectAssetStore } from "./project-asset-postgres-store.ts";

test(
  "postgres asset owned mutation preserves ordinary access and rejects saved protected receipt under a REPEATABLE READ session default",
  assetTestOptions("postgres"),
  async (t) => {
    const f = await assetLegacyAccessFixture(t, "postgres");
    const command = {
      projectId: f.project.project.projectId,
      assetId: null,
      kind: "character" as const,
      expectedAssetRevision: 0,
      briefRevision: 1,
      script: null,
      content: assetContent,
      idempotencyKey: "asset-session-default",
    };
    const identity = {
      actor: f.actor,
      kind: "save-content" as const,
      receipt: projectAssetMutationReceipt(
        f.actor,
        "save-content",
        command,
        f.digester,
      ),
    };
    const pool = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      max: 1,
    });
    t.after(() => pool.end());
    const session = await pool.connect();
    try {
      await session.query(
        "SET default_transaction_isolation TO 'repeatable read'",
      );
      assert.equal(
        (await session.query("SHOW default_transaction_isolation")).rows[0]
          .default_transaction_isolation,
        "repeatable read",
      );
    } finally {
      session.release();
    }
    const store = new PostgresProjectAssetStore({
      pool,
      schema: f.schema,
      assertOpen() {},
    });
    const saved = await store.commitMutation({
      ...identity,
      command,
      at: assetAt,
      createdAssetId: randomUUID(),
    });
    assert.equal(saved.asset.projectId, command.projectId);
    assert.ok(await store.loadMutationReceipt(identity));
    await f.protectProject(command.projectId, "fixture.default-isolation");
    const before = await f.snapshot();
    await assert.rejects(
      store.loadMutationReceipt(identity),
      hasAssetCause("creative_project_not_found"),
    );
    assert.deepEqual(await f.snapshot(), before);
  },
);

test("sqlite asset reads borrow and preserve the actual caller transaction on success and rejection", async (t) => {
  const f = await assetLegacyAccessFixture(t, "sqlite");
  const projectId = f.project.project.projectId;
  const saved = await f.assets.saveCandidate(f.actor, {
    projectId,
    assetId: null,
    kind: "character",
    expectedAssetRevision: 0,
    briefRevision: 1,
    script: null,
    content: assetContent,
    idempotencyKey: "borrowed-read",
  });
  assert.ok(f.database);
  const db = f.database;
  const store = new SqliteProjectAssetStore({ database: db, assertOpen() {} });
  const query = {
    owner: {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      principalId: f.actor.principalId,
    },
    projectId,
    assetId: saved.asset.assetId,
  };
  db.exec("BEGIN");
  try {
    assert.equal((await store.loadAsset(query))?.assetId, saved.asset.assetId);
    assert.equal(db.isTransaction, true);
    db.exec("CREATE TABLE plugin_project_metadata_owners(broken INTEGER)");
    await assert.rejects(
      store.loadAsset(query),
      /plugin_project_metadata_owner_schema_invalid/u,
    );
    assert.equal(db.isTransaction, true);
  } finally {
    db.exec("ROLLBACK");
  }
  assert.equal((await store.loadAsset(query))?.assetId, saved.asset.assetId);
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} ordinary asset reads and pages cannot publish metadata-owned project data`,
    assetTestOptions(backend),
    async (t) => {
      const f = await assetLegacyAccessFixture(t, backend),
        projectId = f.project.project.projectId;
      const saved = await f.assets.saveCandidate(f.actor, {
        projectId,
        assetId: null,
        kind: "character",
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: assetContent,
        idempotencyKey: "protected-asset",
      });
      const scope = {
        owner: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        },
        projectId,
      };
      await f.protectProject(projectId, "fixture.plugin-a");
      const before = await f.snapshot();
      const reads = [
        () =>
          f.assetStore.loadAsset({ ...scope, assetId: saved.asset.assetId }),
        () =>
          f.assetStore.loadRevision({
            ...scope,
            assetId: saved.asset.assetId,
            contentRevision: 1,
          }),
        () =>
          f.assetStore.loadReferenceRevision({
            ...scope,
            assetId: saved.asset.assetId,
            referenceRevision: 1,
          }),
        () =>
          f.assetStore.listAssets({
            ...scope,
            kind: null,
            afterAssetId: null,
            limit: 1,
          }),
        () =>
          f.assetStore.listRevisions({
            ...scope,
            assetId: saved.asset.assetId,
            afterContentRevision: 0,
            limit: 1,
          }),
        () =>
          f.assetStore.listReferences({
            ...scope,
            assetId: saved.asset.assetId,
            afterReferenceRevision: 0,
            limit: 1,
          }),
        () =>
          f.assetStore.loadReferenceImageSource({
            actor: f.actor,
            query: {
              projectId,
              assetId: saved.asset.assetId,
              kind: "character",
              expectedAssetRevision: 1,
              contentRevision: 1,
              referenceRevision: 1,
            },
          }),
      ];
      for (const read of reads)
        await assert.rejects(
          read(),
          hasAssetCause("creative_project_not_found"),
        );
      assert.deepEqual(await f.snapshot(), before);
    },
  );

  test(
    `${backend} actual saved receipt project is fenced before conflict decoding or new-target replay`,
    assetTestOptions(backend),
    async (t) => {
      const f = await assetLegacyAccessFixture(t, backend),
        projectId = f.project.project.projectId;
      const command = {
        projectId,
        assetId: null,
        kind: "character" as const,
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: assetContent,
        idempotencyKey: "owned-receipt",
      };
      await f.assets.saveCandidate(f.actor, command);
      const identity = {
        actor: f.actor,
        kind: "save-content" as const,
        receipt: projectAssetMutationReceipt(
          f.actor,
          "save-content",
          command,
          f.digester,
        ),
      };
      await f.protectProject(projectId, "fixture.plugin-b");
      const ordinary = await f.projects.createProject(f.actor, {
        title: "普通项目",
        briefText: "保留原有管理能力",
        idempotencyKey: "ordinary-project",
      });
      const changed = { ...command, projectId: ordinary.project.projectId };
      const before = await f.snapshot();
      for (const receipt of [
        identity.receipt,
        { ...identity.receipt, requestDigest: f.digester.sha256("changed") },
      ])
        await assert.rejects(
          f.assetStore.loadMutationReceipt({ ...identity, receipt }),
          hasAssetCause("creative_project_not_found"),
        );
      await assert.rejects(
        f.assetStore.commitMutation({
          ...identity,
          command: changed,
          receipt: projectAssetMutationReceipt(
            f.actor,
            "save-content",
            changed,
            f.digester,
          ),
          at: assetAt,
          createdAssetId: randomUUID(),
        }),
        hasAssetCause("creative_project_not_found"),
      );
      await assert.rejects(
        f.assetStore.commitMutation({
          ...identity,
          command: { ...command, idempotencyKey: "fresh-owned" },
          receipt: projectAssetMutationReceipt(
            f.actor,
            "save-content",
            { ...command, idempotencyKey: "fresh-owned" },
            f.digester,
          ),
          at: assetAt,
          createdAssetId: randomUUID(),
        }),
        hasAssetCause("creative_project_not_found"),
      );
      assert.deepEqual(await f.snapshot(), before);
      const normal = await f.assets.saveCandidate(f.actor, {
        ...changed,
        idempotencyKey: "ordinary-asset",
      });
      assert.equal(normal.asset.projectId, ordinary.project.projectId);
      assert.equal(
        (
          await f.assetStore.loadAsset({
            owner: {
              tenantId: f.actor.tenantId,
              spaceId: f.actor.spaceId,
              principalId: f.actor.principalId,
            },
            projectId: ordinary.project.projectId,
            assetId: normal.asset.assetId,
          })
        )?.assetId,
        normal.asset.assetId,
      );
    },
  );

  test(
    `${backend} partial metadata-owner schema cannot become legacy asset access`,
    assetTestOptions(backend),
    async (t) => {
      const f = await assetLegacyAccessFixture(t, backend);
      await f.execute(
        `CREATE TABLE ${f.prefix}plugin_project_metadata_owners(broken INTEGER)`,
      );
      await assert.rejects(
        f.assetStore.listAssets({
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId: f.project.project.projectId,
          kind: null,
          afterAssetId: null,
          limit: 1,
        }),
        /plugin_project_metadata_owner_schema_invalid/u,
      );
    },
  );
}
