import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "@crewon/application";
import {
  configuration,
  receipt as extensionReceipt,
} from "./extension-store.test-support.ts";
import {
  actor,
  application,
  command,
  conceptRecipe,
  creationRecipe,
  fixture,
  owner,
  projectTables,
  receipt,
  timestamp,
  withDigest,
} from "./creative-project-store.test-support.ts";

// Real SQLite/PostgreSQL conformance for the S0 project foundation only.
// No project HTTP, UI, generation, result selection or charging is exercised.
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };

  test(
    `${backend} creative projects: explicit independent migration preserves existing authorities`,
    options,
    async (t) => {
      const f = await fixture(t, backend, { migrate: false });
      assert.equal(
        (await f.tableNames()).some((name) => name.startsWith("creative_")),
        false,
      );
      const extensions = f.first.parent.extensionStore();
      await extensions.migrate();
      await extensions.migrateCredits();
      const config = configuration();
      await extensions.saveExtensionConfiguration({
        configuration: config,
        expectedRevision: 0,
        receipt: extensionReceipt("configuration-existing"),
      });
      const credits = f.first.parent.pluginCreditStore();
      const creditScope = {
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        poolId: "test-only-pool",
      };
      await credits.grant({
        scope: creditScope,
        grantId: "test-only-funds",
        credits: "100",
      });
      const originalAccount = await credits.getAccount(creditScope);
      const versions = await f.versions();
      await f.first.store.migrate();
      await f.second.store.migrate();
      await f.first.store.migrate();
      assert.deepEqual(await f.versions(), versions);
      assert.deepEqual(await credits.getAccount(creditScope), originalAccount);
      assert.deepEqual(
        await extensions.loadExtensionConfiguration({
          tenantId: config.tenantId,
          spaceId: config.spaceId,
          pluginId: config.pluginId,
          revision: config.revision,
        }),
        config,
      );
      assert.deepEqual(
        await f.query(
          `SELECT id, version FROM ${f.prefix}creative_project_schema_version`,
        ),
        [{ id: 1, version: 1 }],
      );
      assert.equal(await f.count("plugin_credit_entries"), 1);
      assert.equal(await f.count("extension_credit_admissions"), 0);
      assert.deepEqual(await f.counts(), zeroCounts());
    },
  );

  test(
    `${backend} creative projects: immutable inputs and metadata survive both host closures and reopen`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const first = application(f.first.store);
      const created = await first.service.createProject(actor, command());
      const concept = await first.service.createConcept(actor, {
        projectId: created.project.projectId,
        briefRevision: 1,
        name: "雨夜概念图",
        prompt: "雨夜街道，写实质感",
        expectedProjectRevision: created.project.revision,
        idempotencyKey: "concept-1",
      });
      const nextBrief = await first.service.appendBrief(actor, {
        projectId: created.project.projectId,
        text: "清晨重逢的第二版需求",
        expectedProjectRevision: concept.project.revision,
        idempotencyKey: "brief-2",
      });
      const renamed = await first.service.renameProject(actor, {
        projectId: created.project.projectId,
        title: "项目列表新名称",
        expectedProjectRevision: nextBrief.project.revision,
        idempotencyKey: "rename-1",
      });
      const nextConcept = await first.service.appendConceptRevision(actor, {
        projectId: created.project.projectId,
        assetId: concept.asset.assetId,
        briefRevision: 2,
        prompt: "清晨街道，写实质感",
        expectedProjectRevision: renamed.project.revision,
        expectedAssetMetadataRevision: concept.asset.revision,
        idempotencyKey: "concept-2",
      });
      await f.first.parent.close();
      await f.second.parent.close();
      const reopened = await f.open();
      const restored = application(reopened.store, "reopened");
      const projectId = created.project.projectId;
      assert.deepEqual(
        await restored.service.getProject(actor, { projectId }),
        nextConcept.project,
      );
      assert.deepEqual(
        await restored.service.listBriefs(actor, {
          projectId,
          afterBriefRevision: 0,
          limit: 50,
        }),
        [created.brief, nextBrief.brief],
      );
      assert.deepEqual(
        await restored.service.listConceptRevisions(actor, {
          projectId,
          assetId: concept.asset.assetId,
          afterAssetRevision: 0,
          limit: 50,
        }),
        [concept.assetRevision, nextConcept.assetRevision],
      );
      const replay = await restored.service.createProject(actor, command());
      assert.deepEqual(replay, { ...created, disposition: "replayed" });
      assert.equal(restored.idCalls.length, 0);
      assert.equal(restored.clockCalls, 0);
      assert.deepEqual(await f.counts(), {
        creative_projects: 1,
        creative_project_briefs: 2,
        creative_concept_assets: 1,
        creative_concept_revisions: 2,
        creative_project_mutation_receipts: 5,
      });
    },
  );

  test(
    `${backend} creative projects: owner reads and receipts remain isolated by principal, space and audit actor`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const creation = creationRecipe("project-owner", "shared-key");
      const first = await f.first.store.commitProjectCreation(creation);
      const concept = await f.first.store.commitConceptRevision(
        conceptRecipe(first.project, first.brief, "shared-key"),
      );
      const projectId = first.project.projectId;
      for (const who of [
        { ...actor, principalId: "principal-other" },
        { ...actor, spaceId: "space-other" },
        { ...actor, tenantId: "tenant-other" },
      ]) {
        const scope = owner(who);
        assert.equal(
          await f.second.store.loadProject({ owner: scope, projectId }),
          null,
        );
        assert.equal(
          await f.second.store.loadBrief({
            owner: scope,
            projectId,
            briefRevision: 1,
          }),
          null,
        );
        assert.equal(
          await f.second.store.loadConceptAsset({
            owner: scope,
            projectId,
            assetId: concept.asset.assetId,
          }),
          null,
        );
        assert.equal(
          await f.second.store.loadConceptRevision({
            owner: scope,
            projectId,
            assetId: concept.asset.assetId,
            assetRevision: 1,
          }),
          null,
        );
        assert.deepEqual(
          await f.second.store.listBriefs({
            owner: scope,
            projectId,
            afterBriefRevision: 0,
            limit: 50,
          }),
          [],
        );
        assert.deepEqual(
          (
            await f.second.store.listProjects({
              owner: scope,
              state: "all",
              after: null,
              limit: 50,
            })
          ).projects,
          [],
        );
        assert.equal(
          await f.second.store.loadMutationReceipt({
            actor: who,
            kind: "create-project",
            receipt: creation.receipt,
          }),
          null,
        );
      }
      const otherActor = { ...actor, actorId: "actor-second" };
      assert.deepEqual(
        await application(f.second.store).service.getProject(otherActor, {
          projectId,
        }),
        concept.project,
      );
      assert.equal(
        await f.second.store.loadMutationReceipt({
          actor: otherActor,
          kind: "create-project",
          receipt: creation.receipt,
        }),
        null,
      );
      const second = await f.second.store.commitProjectCreation(
        creationRecipe("project-second-actor", "shared-key", otherActor),
      );
      const otherPrincipal = { ...actor, principalId: "principal-second" };
      const third = await f.second.store.commitProjectCreation(
        creationRecipe(
          "project-second-principal",
          "shared-key",
          otherPrincipal,
        ),
      );
      assert.equal(second.disposition, "committed");
      assert.equal(third.disposition, "committed");
      await assert.rejects(
        f.second.store.commitProjectCreation({
          ...creation,
          actor: otherPrincipal,
        }),
        /creative_project_owner_mismatch/,
      );
      await assert.rejects(
        f.second.store.loadMutationReceipt({
          actor,
          kind: "create-project",
          receipt: {
            ...creation.receipt,
            requestDigest: receipt("different-input").requestDigest,
          },
        }),
        /creative_project_idempotency_conflict/,
      );
      assert.equal(await f.count("creative_projects"), 3);
    },
  );

  test(
    `${backend} creative projects: same-key competing server IDs commit one original snapshot`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const recipeA = creationRecipe(
        "server-project-a",
        "same-key",
        actor,
        timestamp,
      );
      const recipeB = creationRecipe(
        "server-project-b",
        "same-key",
        actor,
        "2026-10-02T00:00:01.000Z",
      );
      const results = await Promise.all([
        f.first.store.commitProjectCreation(recipeA),
        f.second.store.commitProjectCreation(recipeB),
      ]);
      assert.deepEqual(results.map((result) => result.disposition).sort(), [
        "committed",
        "replayed",
      ]);
      assert.deepEqual(results[0].project, results[1].project);
      assert.deepEqual(results[0].brief, results[1].brief);
      assert.deepEqual(await f.counts(), {
        ...zeroCounts(),
        creative_projects: 1,
        creative_project_briefs: 1,
        creative_project_mutation_receipts: 1,
      });
      const reopened = await f.open();
      assert.deepEqual(await reopened.store.commitProjectCreation(recipeB), {
        ...results[0],
        disposition: "replayed",
      });
      await assert.rejects(
        reopened.store.commitProjectCreation({
          ...recipeB,
          receipt: {
            ...recipeB.receipt,
            requestDigest: receipt("changed-request").requestDigest,
          },
        }),
        /creative_project_idempotency_conflict/,
      );
      assert.equal(await f.count("creative_project_mutation_receipts"), 1);
    },
  );

  test(
    `${backend} creative projects: competing metadata and concept CAS each permit one write`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const a = application(f.first.store, "a").service;
      const b = application(f.second.store, "b").service;
      const created = await a.createProject(actor, command());
      const projectId = created.project.projectId;
      const renameResults = await Promise.allSettled(
        [a, b].map((service, index) =>
          service.renameProject(actor, {
            projectId,
            title: `标题${index}`,
            expectedProjectRevision: created.project.revision,
            idempotencyKey: `rename-${index}`,
          }),
        ),
      );
      assertOneCas(renameResults);
      const renamed = await a.getProject(actor, { projectId });
      const concept = await a.createConcept(actor, {
        projectId,
        briefRevision: 1,
        name: "概念图",
        prompt: "初版输入",
        expectedProjectRevision: renamed.revision,
        idempotencyKey: "concept-1",
      });
      const conceptResults = await Promise.allSettled(
        [a, b].map((service, index) =>
          service.appendConceptRevision(actor, {
            projectId,
            assetId: concept.asset.assetId,
            briefRevision: 1,
            prompt: `新版输入${index}`,
            expectedProjectRevision: concept.project.revision,
            expectedAssetMetadataRevision: concept.asset.revision,
            idempotencyKey: `concept-next-${index}`,
          }),
        ),
      );
      assertOneCas(conceptResults);
      assert.equal(await f.count("creative_project_mutation_receipts"), 4);
      assert.equal(await f.count("creative_concept_revisions"), 2);
      assert.deepEqual(
        await a.getBrief(actor, { projectId, briefRevision: 1 }),
        created.brief,
      );
      assert.deepEqual(
        await a.getConceptRevision(actor, {
          projectId,
          assetId: concept.asset.assetId,
          assetRevision: 1,
        }),
        concept.assetRevision,
      );
    },
  );

  test(
    `${backend} creative projects: archived metadata and history remain accessible while new input is blocked`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const service = application(f.first.store).service;
      const created = await service.createProject(actor, command());
      const projectId = created.project.projectId;
      const concept = await service.createConcept(actor, {
        projectId,
        briefRevision: 1,
        name: "概念图",
        prompt: "初版输入",
        expectedProjectRevision: created.project.revision,
        idempotencyKey: "concept-1",
      });
      const archived = await service.setProjectState(actor, {
        projectId,
        state: "archived",
        expectedProjectRevision: concept.project.revision,
        idempotencyKey: "archive-1",
      });
      const renamed = await service.renameProject(actor, {
        projectId,
        title: "归档项目新名称",
        expectedProjectRevision: archived.project.revision,
        idempotencyKey: "rename-archived",
      });
      const before = await f.counts();
      await assert.rejects(
        service.appendBrief(actor, {
          projectId,
          text: "不允许新增",
          expectedProjectRevision: renamed.project.revision,
          idempotencyKey: "blocked-brief",
        }),
        applicationError("conflict", "creative_project_archived"),
      );
      await assert.rejects(
        service.appendConceptRevision(actor, {
          projectId,
          assetId: concept.asset.assetId,
          briefRevision: 1,
          prompt: "不允许新增",
          expectedProjectRevision: renamed.project.revision,
          expectedAssetMetadataRevision: concept.asset.revision,
          idempotencyKey: "blocked-concept",
        }),
        applicationError("conflict", "creative_project_archived"),
      );
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(
        await service.getBrief(actor, { projectId, briefRevision: 1 }),
        created.brief,
      );
      assert.deepEqual(
        await service.getConceptRevision(actor, {
          projectId,
          assetId: concept.asset.assetId,
          assetRevision: 1,
        }),
        concept.assetRevision,
      );
      const restored = await service.setProjectState(actor, {
        projectId,
        state: "active",
        expectedProjectRevision: renamed.project.revision,
        idempotencyKey: "restore-1",
      });
      assert.equal(
        (
          await service.appendBrief(actor, {
            projectId,
            text: "恢复后的需求",
            expectedProjectRevision: restored.project.revision,
            idempotencyKey: "brief-restored",
          })
        ).brief.briefRevision,
        2,
      );
    },
  );

  test(
    `${backend} creative projects: concept commits re-read the exact persisted brief inside their transaction`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const created = await f.first.store.commitProjectCreation(
        creationRecipe("project-brief-authority"),
      );
      const forged = withDigest({
        ...created.brief,
        text: "合法摘要但没有保存的替代需求",
      });
      const before = await f.counts();
      await assert.rejects(
        f.second.store.commitConceptRevision(
          conceptRecipe(created.project, forged, "forged-brief"),
        ),
        /creative_project_brief_reference_invalid/,
      );
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(
        await f.first.store.loadProject({
          owner: owner(),
          projectId: created.project.projectId,
        }),
        created.project,
      );
      const valid = await f.second.store.commitConceptRevision(
        conceptRecipe(created.project, created.brief, "stored-brief"),
      );
      assert.equal(
        valid.assetRevision.briefContentDigest,
        created.brief.contentDigest,
      );
    },
  );

  test(
    `${backend} creative projects: failure at project, initial brief or receipt insertion rolls creation back`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const service = application(f.first.store).service;
      for (const table of [
        "creative_projects",
        "creative_project_briefs",
        "creative_project_mutation_receipts",
      ] as const) {
        await f.failInserts(table, true);
        try {
          await assert.rejects(
            service.createProject(actor, command(`failure-${table}`)),
            insertionFailure,
          );
          assert.deepEqual(await f.counts(), zeroCounts());
        } finally {
          await f.failInserts(table, false);
        }
      }
      assert.equal(
        (await service.createProject(actor, command("retry-success")))
          .disposition,
        "committed",
      );
      assert.equal(await f.count("creative_project_mutation_receipts"), 1);
    },
  );

  test(
    `${backend} creative projects: later revision and receipt failures roll metadata and history back`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const service = application(f.first.store).service;
      const created = await service.createProject(actor, command());
      const projectId = created.project.projectId;
      for (const table of [
        "creative_project_briefs",
        "creative_project_mutation_receipts",
      ] as const) {
        const before = await f.counts();
        await f.failInserts(table, true);
        try {
          await assert.rejects(
            service.appendBrief(actor, {
              projectId,
              text: "不能留下的需求",
              expectedProjectRevision: created.project.revision,
              idempotencyKey: `failed-brief-${table}`,
            }),
            insertionFailure,
          );
          assert.deepEqual(await f.counts(), before);
          assert.deepEqual(
            await service.getProject(actor, { projectId }),
            created.project,
          );
        } finally {
          await f.failInserts(table, false);
        }
      }
      for (const table of [
        "creative_concept_assets",
        "creative_concept_revisions",
        "creative_project_mutation_receipts",
      ] as const) {
        const before = await f.counts();
        await f.failInserts(table, true);
        try {
          await assert.rejects(
            service.createConcept(actor, {
              projectId,
              briefRevision: 1,
              name: "不能留下的资产",
              prompt: "不能留下的输入",
              expectedProjectRevision: created.project.revision,
              idempotencyKey: `failed-concept-${table}`,
            }),
            insertionFailure,
          );
          assert.deepEqual(await f.counts(), before);
          assert.deepEqual(
            await service.getProject(actor, { projectId }),
            created.project,
          );
        } finally {
          await f.failInserts(table, false);
        }
      }
      const concept = await service.createConcept(actor, {
        projectId,
        briefRevision: 1,
        name: "已保存的资产",
        prompt: "原输入",
        expectedProjectRevision: created.project.revision,
        idempotencyKey: "concept-existing",
      });
      for (const table of [
        "creative_concept_revisions",
        "creative_project_mutation_receipts",
      ] as const) {
        const before = await f.counts();
        await f.failInserts(table, true);
        try {
          await assert.rejects(
            service.appendConceptRevision(actor, {
              projectId,
              assetId: concept.asset.assetId,
              briefRevision: 1,
              prompt: "不能留下的新修订",
              expectedProjectRevision: concept.project.revision,
              expectedAssetMetadataRevision: concept.asset.revision,
              idempotencyKey: `failed-existing-concept-${table}`,
            }),
            insertionFailure,
          );
          assert.deepEqual(await f.counts(), before);
          assert.deepEqual(
            await service.getProject(actor, { projectId }),
            concept.project,
          );
          assert.deepEqual(
            await service.getConceptAsset(actor, {
              projectId,
              assetId: concept.asset.assetId,
            }),
            concept.asset,
          );
          assert.deepEqual(
            await service.getConceptRevision(actor, {
              projectId,
              assetId: concept.asset.assetId,
              assetRevision: 1,
            }),
            concept.assetRevision,
          );
        } finally {
          await f.failInserts(table, false);
        }
      }
    },
  );

  test(
    `${backend} creative projects: immutable database triggers protect briefs, concept revisions and receipts`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const created = await f.first.store.commitProjectCreation(
        creationRecipe("project-immutable"),
      );
      const concept = await f.first.store.commitConceptRevision(
        conceptRecipe(created.project, created.brief, "concept-immutable"),
      );
      const before = await f.counts();
      for (const table of [
        "creative_project_briefs",
        "creative_concept_revisions",
        "creative_project_mutation_receipts",
      ]) {
        const column =
          table === "creative_project_mutation_receipts"
            ? "result_json"
            : "record_json";
        await assert.rejects(
          f.execute(`UPDATE ${f.prefix}${table} SET ${column}=${column}`),
          /immutable/,
        );
        await assert.rejects(
          f.execute(`DELETE FROM ${f.prefix}${table}`),
          /immutable/,
        );
      }
      for (const [table, column] of [
        ["creative_projects", "owner_principal_id"],
        ["creative_concept_assets", "asset_id"],
      ]) {
        await assert.rejects(
          f.execute(
            `UPDATE ${f.prefix}${table} SET ${column}='substituted-identity'`,
          ),
          /creative_project_identity_immutable/,
        );
        await assert.rejects(
          f.execute(`DELETE FROM ${f.prefix}${table}`),
          /creative_project_identity_immutable/,
        );
      }
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(
        await f.second.store.loadBrief({
          owner: owner(),
          projectId: created.project.projectId,
          briefRevision: 1,
        }),
        created.brief,
      );
      assert.deepEqual(
        await f.second.store.loadConceptRevision({
          owner: owner(),
          projectId: created.project.projectId,
          assetId: concept.asset.assetId,
          assetRevision: 1,
        }),
        concept.assetRevision,
      );
    },
  );

  test(
    `${backend} creative projects: real database pages use stable Unicode scalar order and bounded cursors`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const services = application(f.first.store, "unicode", {
        ids: [
          "project-a",
          "project-\ue000",
          "project-\u{10000}",
          "asset-\ue000",
          "asset-\u{10000}",
        ],
      });
      const service = services.service;
      const ascii = await service.createProject(actor, command("create-ascii"));
      const bmp = await service.createProject(actor, command("create-bmp"));
      const nonBmp = await service.createProject(
        actor,
        command("create-non-bmp"),
      );
      const pageOne = await service.listProjects(actor, {
        state: "all",
        after: null,
        limit: 1,
      });
      assert.deepEqual(pageOne.projects, [nonBmp.project]);
      assert.deepEqual(pageOne.next, {
        projectId: nonBmp.project.projectId,
        updatedAt: timestamp,
      });
      const pageTwo = await service.listProjects(actor, {
        state: "all",
        after: pageOne.next,
        limit: 1,
      });
      assert.deepEqual(pageTwo.projects, [bmp.project]);
      const pageThree = await service.listProjects(actor, {
        state: "all",
        after: pageTwo.next,
        limit: 1,
      });
      assert.deepEqual(pageThree.projects, [ascii.project]);
      assert.equal(pageThree.next, null);
      const assetOne = await service.createConcept(actor, {
        projectId: ascii.project.projectId,
        briefRevision: 1,
        name: "BMP概念",
        prompt: "合法输入",
        expectedProjectRevision: ascii.project.revision,
        idempotencyKey: "asset-bmp",
      });
      const assetTwo = await service.createConcept(actor, {
        projectId: ascii.project.projectId,
        briefRevision: 1,
        name: "非BMP概念",
        prompt: "合法输入",
        expectedProjectRevision: assetOne.project.revision,
        idempotencyKey: "asset-non-bmp",
      });
      assert.deepEqual(
        await service.listConceptAssets(actor, {
          projectId: ascii.project.projectId,
          afterAssetId: null,
          limit: 1,
        }),
        [assetOne.asset],
      );
      assert.deepEqual(
        await service.listConceptAssets(actor, {
          projectId: ascii.project.projectId,
          afterAssetId: assetOne.asset.assetId,
          limit: 50,
        }),
        [assetTwo.asset],
      );
      const empty = await service.listProjects(actor, {
        state: "all",
        after: { projectId: "0", updatedAt: timestamp },
        limit: 50,
      });
      assert.deepEqual(empty, { projects: [], next: null });
    },
  );

  test(
    `${backend} creative projects: unsupported future migration refuses without changing records or versions`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const created = await f.first.store.commitProjectCreation(
        creationRecipe("project-future"),
      );
      const before = await f.counts();
      const versions = await f.versions();
      await f.execute(
        `UPDATE ${f.prefix}creative_project_schema_version SET version=99 WHERE id=1`,
      );
      await assert.rejects(
        f.second.store.migrate(),
        /creative_project_schema_version_unsupported/,
      );
      assert.deepEqual(
        await f.query(
          `SELECT id, version FROM ${f.prefix}creative_project_schema_version`,
        ),
        [{ id: 1, version: 99 }],
      );
      assert.deepEqual(await f.versions(), versions);
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(
        await f.first.store.loadProject({
          owner: owner(),
          projectId: created.project.projectId,
        }),
        created.project,
      );
    },
  );

  test(
    `${backend} creative projects: retained child authority closes with its host`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.first.store.commitProjectCreation(
        creationRecipe("project-close"),
      );
      await f.first.parent.close();
      await assert.rejects(
        f.first.store.loadProject({
          owner: owner(),
          projectId: "project-close",
        }),
        /store_closed/,
      );
      await assert.rejects(f.first.store.migrate(), /store_closed/);
      await assert.rejects(
        f.first.store.commitProjectCreation(
          creationRecipe("project-after-close", "after-close"),
        ),
        /store_closed/,
      );
      assert.equal(await f.count("creative_projects"), 1);
      assert.ok(
        await f.second.store.loadProject({
          owner: owner(),
          projectId: "project-close",
        }),
      );
    },
  );
}

function zeroCounts() {
  return Object.fromEntries(projectTables.map((table) => [table, 0]));
}
function applicationError(category: string, code: string) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
function insertionFailure(error: unknown) {
  return (
    error instanceof ApplicationError &&
    error.category === "internal" &&
    error.code === "creative_project_service_unavailable" &&
    error.cause instanceof Error &&
    error.cause.message.includes("creative_fixture_insert_failure")
  );
}
function assertOneCas(results: readonly PromiseSettledResult<unknown>[]) {
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" &&
      rejected.reason instanceof ApplicationError &&
      rejected.reason.category === "conflict" &&
      [
        "creative_project_revision_conflict",
        "creative_project_asset_revision_conflict",
      ].includes(rejected.reason.code),
  );
}
