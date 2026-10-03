import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import {
  CreativeProjectApplicationService,
  ExtensionReadApplicationService,
  ProjectGenerationReadApplicationService,
} from "@crewon/application";
import {
  appendConceptAssetRevision,
  appendProjectBriefRevision,
  setCreativeProjectState,
} from "@crewon/domain";
import { receipt as projectReceipt } from "./creative-project-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { timestamp } from "./extension-store.test-support.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import {
  activeAuthority,
  projectGenerationFixture,
} from "./project-generation.test-support.ts";

type Backend = "sqlite" | "postgres";
type Fixture = Awaited<ReturnType<typeof projectGenerationFixture>>;

function sourceLocator(f: Fixture, actor = f.actor) {
  return {
    owner: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      principalId: actor.principalId,
    },
    projectId: f.reference.projectId,
    assetId: f.reference.assetId,
    assetRevision: f.reference.assetRevision,
  };
}

async function committedFixture(t: TestContext, backend: Backend) {
  const f = await projectGenerationFixture(t, backend);
  const admittedInput = await f.input();
  const accepted = await f.first.store.commitExtensionTurn(
    admittedInput,
    activeAuthority,
  );
  const link = await f.first.store.loadProjectGenerationLink(
    admittedInput.binding,
  );
  assert.ok(link);
  return { ...f, admittedInput, accepted, link };
}

async function coldReader(t: TestContext, f: Fixture, backend: Backend) {
  if (backend === "sqlite") return f.open();
  const parent = await PostgresDomainStore.open({
    connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
    schema: f.prefix.slice(1, -2),
    maxPoolSize: 1,
  });
  t.after(() => parent.close());
  return { parent, store: parent.extensionStore() };
}

/** Real Application services and SQL adapters; the observer never supplies a task or receipt. */
async function applicationFixture(
  t: TestContext,
  backend: Backend,
  existing?: Awaited<ReturnType<typeof committedFixture>>,
) {
  const f = existing ?? (await committedFixture(t, backend));
  // The writer prepares persisted operation storage; the cold reader never migrates it.
  await f.first.parent.externalOperationStore().migrate();
  const reader = await coldReader(t, f, backend);
  await reader.store.enableProjectGenerationReads();
  assert.equal(reader.store.projectGenerationVersion, undefined);
  assert.equal(reader.store.projectGenerationPublicationVersion, undefined);
  const operations = reader.parent.externalOperationStore();
  const state = {
    denied: null as string | null,
    permissions: [] as { actorId: string; action: string }[],
    afterOperationRead: null as (() => Promise<void>) | null,
  };
  const projects = new CreativeProjectApplicationService({
    store: reader.parent.creativeProjectStore(),
    authorization: {
      async authorize(input) {
        state.permissions.push({
          actorId: input.actor.actorId,
          action: input.action,
        });
        return state.denied === input.action
          ? { outcome: "deny", reasonCode: "source-read-test-denied" }
          : { outcome: "allow" };
      },
    },
    clock: { now: () => timestamp },
    ids: {
      nextId: () => assert.fail("a read must not create project identity"),
    },
    digester: extensionStoreDigester,
  });
  const tasks = new ExtensionReadApplicationService({
    runs: reader.parent,
    agentVersions: reader.parent,
    extensions: reader.store,
    operations: {
      loadExternalOperation: (input) => operations.loadExternalOperation(input),
      async listExternalOperations(input) {
        const page = await operations.listExternalOperations(input);
        await state.afterOperationRead?.();
        return page;
      },
    },
    catalog: {
      list: () =>
        assert.fail("a saved task read must not enumerate implementations"),
      resolve: () =>
        assert.fail("a saved task read must not resolve execution"),
    },
    host: {
      validateConfiguration: async () =>
        assert.fail("a read must not validate supplier configuration"),
      evaluate: async () =>
        assert.fail("a read must not evaluate execution readiness"),
    },
    authorization: {
      async authorize(input) {
        state.permissions.push({
          actorId: input.actor.actorId,
          action: input.action,
        });
        return state.denied === input.action
          ? { outcome: "deny", reasonCode: "task-read-test-denied" }
          : { outcome: "allow" };
      },
    },
    digester: extensionStoreDigester,
  });
  const service = new ProjectGenerationReadApplicationService({
    projects,
    tasks,
    extensions: reader.store,
    digester: extensionStoreDigester,
  });
  return { ...f, service, state };
}

async function snapshot(f: Fixture, includeLink = true) {
  const tables = [
    "messages",
    "model_history_items",
    "run_snapshots",
    "extension_run_bindings",
    "extension_mutation_receipts",
    "plugin_task_admissions",
    "extension_credit_admissions",
    "plugin_credit_reservations",
    "plugin_credit_entries",
    "outbox",
    "work_items",
    ...(includeLink ? ["creative_project_generation_links"] : []),
  ];
  return {
    rows: Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [table, await f.count(table)]),
      ),
    ),
    account: await f.credits.getAccount(f.creditScope),
  };
}

/** Remove provenance only in this test's own schema; never change another connection's role. */
async function removeLinkedRecord(
  f: Fixture,
  backend: Backend,
  table:
    | "extension_mutation_receipts"
    | "extension_run_bindings"
    | "creative_projects",
) {
  const statement = `DELETE FROM ${f.prefix}${table}${table === "extension_mutation_receipts" ? " WHERE kind='task'" : ""};`;
  if (backend === "postgres") {
    await f.sql(
      `BEGIN; SET LOCAL session_replication_role=replica; ${statement} COMMIT;`,
    );
    return;
  }
  await f.sql("PRAGMA foreign_keys=OFF;");
  if (table === "creative_projects")
    await f.sql("DROP TRIGGER creative_projects_no_delete;");
  try {
    await f.sql(statement);
  } finally {
    if (table === "creative_projects")
      await f.sql(
        "CREATE TRIGGER creative_projects_no_delete BEFORE DELETE ON creative_projects BEGIN SELECT RAISE(ABORT,'creative_project_identity_immutable'); END;",
      );
    await f.sql("PRAGMA foreign_keys=ON;");
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe(
    `${backend} saved project generation source reads`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      test("writer migration leaves source reads off; a cold reader enables only reads and returns the original paid link", async (t) => {
        const f = await committedFixture(t, backend);
        const locator = sourceLocator(f);
        const before = await snapshot(f);
        assert.equal(f.first.store.projectGenerationReadVersion, undefined);
        await assert.rejects(
          f.first.store.loadProjectGenerationLinkBySource(locator),
          /project_generation_read_unavailable/u,
        );

        const cold = await coldReader(t, f, backend);
        assert.equal(cold.store.projectGenerationReadVersion, undefined);
        assert.equal(cold.store.projectGenerationVersion, undefined);
        assert.equal(cold.store.projectGenerationPublicationVersion, undefined);
        await cold.store.enableProjectGenerationReads();
        assert.equal(
          cold.store.projectGenerationReadVersion,
          "crewon.project-generation-read.v1",
        );
        assert.equal(cold.store.projectGenerationVersion, undefined);
        assert.equal(cold.store.projectGenerationPublicationVersion, undefined);
        assert.deepEqual(
          await cold.store.loadProjectGenerationLinkBySource(locator),
          f.link,
        );
        await assert.rejects(
          cold.store.commitExtensionTurn(f.admittedInput, activeAuthority),
          /project_generation_unavailable/u,
        );

        await f.first.store.enableProjectGenerationReads();
        assert.deepEqual(
          await f.first.store.loadProjectGenerationLinkBySource(locator),
          f.link,
        );
        await cold.store.enableProjectGenerationReads();
        assert.deepEqual(await snapshot(f), before);
        assert.equal(before.account?.availableCredits, "70");
        assert.equal(before.account?.reservedCredits, "30");
      });

      test("read opt-in rejects missing and partial optional schema without creating or repairing it", async (t) => {
        const f = await projectGenerationFixture(t, backend, {
          generationMigration: false,
        });
        const before = await snapshot(f, false);
        await assert.rejects(
          f.first.store.enableProjectGenerationReads(),
          /project_generation_schema_incomplete/u,
        );
        assert.equal(f.first.store.projectGenerationReadVersion, undefined);
        assert.equal(f.first.store.projectGenerationVersion, undefined);
        await assert.rejects(
          f.count("project_generation_schema_version"),
          /no such table|does not exist/u,
        );
        await assert.rejects(
          f.count("creative_project_generation_links"),
          /no such table|does not exist/u,
        );
        assert.deepEqual(await snapshot(f, false), before);

        await f.sql(
          `CREATE TABLE ${f.prefix}project_generation_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)${backend === "sqlite" ? " STRICT" : ""}; INSERT INTO ${f.prefix}project_generation_schema_version VALUES(1,99);`,
        );
        await assert.rejects(
          f.first.store.enableProjectGenerationReads(),
          /project_generation_schema_incomplete/u,
        );
        assert.equal(f.first.store.projectGenerationReadVersion, undefined);
        assert.equal(f.first.store.projectGenerationVersion, undefined);
        assert.equal(await f.count("project_generation_schema_version"), 1);
        await assert.rejects(
          f.count("creative_project_generation_links"),
          /no such table|does not exist/u,
        );
        assert.deepEqual(await snapshot(f, false), before);
      });

      test("only the exact owner and saved slot locate a generation; another actor of that principal keeps the original provenance", async (t) => {
        const f = await committedFixture(t, backend);
        await f.first.store.enableProjectGenerationReads();
        const locator = sourceLocator(f);
        const before = await snapshot(f);
        const laterActor = { ...f.actor, actorId: "another-session-actor" };
        assert.deepEqual(
          await f.first.store.loadProjectGenerationLinkBySource(
            sourceLocator(f, laterActor),
          ),
          f.link,
        );
        assert.equal(f.link.receipt.actorId, f.actor.actorId);
        for (const foreign of [
          {
            ...locator,
            owner: { ...locator.owner, principalId: "another-principal" },
          },
          {
            ...locator,
            owner: { ...locator.owner, tenantId: "another-tenant" },
          },
          { ...locator, owner: { ...locator.owner, spaceId: "another-space" } },
          { ...locator, projectId: "another-project" },
          { ...locator, assetId: "another-asset" },
          { ...locator, assetRevision: locator.assetRevision + 1 },
        ])
          assert.equal(
            await f.first.store.loadProjectGenerationLinkBySource(foreign),
            null,
          );
        assert.deepEqual(await snapshot(f), before);
      });

      test("new saved inputs and archive preserve the exact original generation slot", async (t) => {
        const f = await committedFixture(t, backend);
        await f.first.store.enableProjectGenerationReads();
        const locator = sourceLocator(f);
        const project = await f.metadata.loadProject({
          owner: locator.owner,
          projectId: locator.projectId,
        });
        const asset = await f.metadata.loadConceptAsset({
          owner: locator.owner,
          projectId: locator.projectId,
          assetId: locator.assetId,
        });
        assert.ok(project);
        assert.ok(asset);
        const brief = appendProjectBriefRevision(
          {
            project,
            actor: f.actor,
            expectedProjectRevision: project.revision,
            text: "A newer saved narrative.",
            at: timestamp,
          },
          extensionStoreDigester,
        );
        const savedBrief = await f.metadata.commitProjectBrief({
          actor: f.actor,
          receipt: projectReceipt("read-new-brief"),
          expectedProjectRevision: project.revision,
          ...brief,
        });
        const concept = appendConceptAssetRevision(
          {
            project: savedBrief.project,
            asset,
            brief: savedBrief.brief,
            actor: f.actor,
            expectedProjectRevision: savedBrief.project.revision,
            expectedAssetMetadataRevision: asset.revision,
            prompt: "A newer saved concept.",
            at: timestamp,
          },
          extensionStoreDigester,
        );
        const savedConcept = await f.metadata.commitConceptRevision({
          kind: "append-concept",
          actor: f.actor,
          receipt: projectReceipt("read-new-concept"),
          expectedProjectRevision: savedBrief.project.revision,
          expectedAssetMetadataRevision: asset.revision,
          ...concept,
        });
        const archived = setCreativeProjectState({
          project: savedConcept.project,
          actor: f.actor,
          expectedProjectRevision: savedConcept.project.revision,
          state: "archived",
          at: timestamp,
        });
        await f.metadata.commitProjectMetadata({
          kind: "set-project-state",
          actor: f.actor,
          receipt: projectReceipt("read-archive"),
          expectedProjectRevision: savedConcept.project.revision,
          project: archived,
        });
        const application = await applicationFixture(t, backend, f);
        const before = await snapshot(f);
        assert.deepEqual(
          await f.first.store.loadProjectGenerationLinkBySource(locator),
          f.link,
        );
        assert.equal(
          await f.first.store.loadProjectGenerationLinkBySource({
            ...locator,
            assetRevision: savedConcept.assetRevision.assetRevision,
          }),
          null,
        );
        const { owner: _owner, ...query } = locator;
        assert.deepEqual(
          (await application.service.getConceptGeneration(f.actor, query))
            ?.link,
          f.link,
        );
        assert.deepEqual(await snapshot(f), before);
      });

      for (const corruption of ["message-content", "run-identity"] as const) {
        test(`full original receipt validation rejects ${corruption} corruption with the digest and link unchanged`, async (t) => {
          const f = await committedFixture(t, backend);
          await f.first.store.enableProjectGenerationReads();
          const locator = sourceLocator(f);
          assert.deepEqual(
            await f.first.store.loadProjectGenerationLinkBySource(locator),
            f.link,
          );
          const path =
            corruption === "message-content"
              ? ["turn", "messages", "0", "content"]
              : ["run", "state", "runId"];
          const expression =
            backend === "sqlite"
              ? `json_set(result_json,'$.${path[0]}.${path[1]}${corruption === "message-content" ? "[0]" : ""}.${path[3] ?? path[2]}','corrupted-original-receipt')`
              : `jsonb_set(result_json,'{${path.join(",")}}',to_jsonb('corrupted-original-receipt'::text))`;
          await f.sql(
            `UPDATE ${f.prefix}extension_mutation_receipts SET result_json=${expression} WHERE kind='task';`,
          );
          const before = await snapshot(f);
          await assert.rejects(
            f.first.store.loadProjectGenerationLinkBySource(locator),
            corruption === "message-content"
              ? /turn_start_message_mismatch/u
              : /extension_task_receipt_invalid/u,
          );
          assert.deepEqual(await snapshot(f), before);
          assert.deepEqual(
            await f.first.store.loadProjectGenerationLink(
              f.admittedInput.binding,
            ),
            f.link,
          );
        });
      }

      for (const table of [
        "extension_mutation_receipts",
        "extension_run_bindings",
        "creative_projects",
      ] as const) {
        test(`a missing ${table} join fails closed instead of becoming an absent generation`, async (t) => {
          const f = await committedFixture(t, backend);
          await f.first.store.enableProjectGenerationReads();
          const locator = sourceLocator(f);
          assert.deepEqual(
            await f.first.store.loadProjectGenerationLinkBySource(locator),
            f.link,
          );
          await removeLinkedRecord(f, backend, table);
          const before = await snapshot(f);
          await assert.rejects(
            f.first.store.loadProjectGenerationLinkBySource(locator),
            /project_generation_|extension_|creative_project_/u,
          );
          assert.equal(await f.count("creative_project_generation_links"), 1);
          assert.deepEqual(await snapshot(f), before);
        });
      }

      for (const corruption of [
        "schema-version",
        "extension-version",
        "missing-trigger",
      ] as const) {
        test(`every read rejects ${corruption} after opt-in and never repairs the persisted schema`, async (t) => {
          const f = await committedFixture(t, backend);
          await f.first.store.enableProjectGenerationReads();
          const locator = sourceLocator(f);
          if (corruption === "schema-version")
            await f.sql(
              `UPDATE ${f.prefix}project_generation_schema_version SET version=99;`,
            );
          else if (corruption === "extension-version")
            await f.sql(
              `UPDATE ${f.prefix}extension_schema_version SET version=99;`,
            );
          else
            await f.sql(
              `DROP TRIGGER project_generation_no_update${backend === "postgres" ? ` ON ${f.prefix}creative_project_generation_links` : ""};`,
            );
          const before = await snapshot(f);
          const invalid =
            corruption === "schema-version"
              ? /project_generation_schema_version_unsupported/u
              : corruption === "extension-version"
                ? /project_generation_read_extension_schema_version_unsupported/u
                : /project_generation_schema_incomplete/u;
          await assert.rejects(
            f.first.store.loadProjectGenerationLinkBySource(locator),
            invalid,
          );
          const cold = { store: f.second.parent.extensionStore() };
          await assert.rejects(
            cold.store.enableProjectGenerationReads(),
            invalid,
          );
          assert.equal(cold.store.projectGenerationReadVersion, undefined);
          await assert.rejects(
            f.first.store.loadProjectGenerationLinkBySource(locator),
            invalid,
          );
          assert.deepEqual(await snapshot(f), before);
        });
      }

      test("actual project and task Application reads on a cold reader with PG maxPoolSize 1 and writes off enforce current permissions without execution", async (t) => {
        const f = await applicationFixture(t, backend);
        const { owner: _owner, ...query } = sourceLocator(f);
        const before = await snapshot(f);
        const result = await f.service.getConceptGeneration(f.actor, query);
        assert.ok(result);
        assert.deepEqual(result.link, f.link);
        assert.deepEqual(result.task.binding, f.accepted.binding);
        assert.equal(result.task.run.runId, f.accepted.binding.runId);
        assert.equal(result.task.run.status, f.accepted.run.state.status);
        assert.deepEqual(result.task.operations, []);
        for (const action of [
          "creativeProject:read",
          "extension:query",
          "run:read",
        ])
          assert.ok(
            f.state.permissions.some(
              (permission) => permission.action === action,
            ),
            action,
          );

        for (const denied of [
          "creativeProject:read",
          "extension:query",
          "run:read",
        ]) {
          f.state.denied = denied;
          await assert.rejects(
            f.service.getConceptGeneration(f.actor, query),
            /authorization_denied/u,
          );
        }
        f.state.denied = null;
        const laterActor = {
          ...f.actor,
          actorId: "new-actor-of-original-principal",
        };
        assert.deepEqual(
          (await f.service.getConceptGeneration(laterActor, query))?.link,
          f.link,
        );
        await assert.rejects(
          f.service.getConceptGeneration(
            { ...f.actor, principalId: "foreign-principal" },
            query,
          ),
          /creative_project_not_found/u,
        );
        assert.deepEqual(await snapshot(f), before);
      });

      test("the actual read returns the current canceled Run while retaining its original link and released-credit history", async (t) => {
        const f = await applicationFixture(t, backend);
        const run = f.accepted.run.state;
        const canceled = await f.first.parent.commitRun({
          tenantId: run.tenantId,
          expectedRevision: run.revision,
          idempotency: {
            scope: "source-read-cancel",
            key: run.runId,
            requestFingerprint: "source-read-cancel",
          },
          events: [
            {
              schemaVersion: "crewon.run-event.v0",
              identity: { runId: run.runId },
              eventId: "source-read-cancel-request",
              sequence: run.lastSequence + 1,
              occurredAt: timestamp,
              type: "run.cancel.requested",
              data: { actorId: f.actor.actorId },
            },
            {
              schemaVersion: "crewon.run-event.v0",
              identity: { runId: run.runId },
              eventId: "source-read-cancel-done",
              sequence: run.lastSequence + 2,
              occurredAt: timestamp,
              type: "run.canceled",
              data: { reasonCode: "source-read-canceled" },
            },
          ],
          outbox: [],
          workItems: [],
        });
        await f.credits.release({
          scope: f.creditScope,
          reservationId: run.runId,
        });
        const before = await snapshot(f);
        const { owner: _owner, ...query } = sourceLocator(f);
        const result = await f.service.getConceptGeneration(f.actor, query);
        assert.ok(result);
        assert.deepEqual(result.link, f.link);
        assert.deepEqual(result.task.run, canceled.state);
        assert.equal(result.task.run.status, "canceled");
        assert.equal(before.account?.availableCredits, "100");
        assert.equal(before.account?.reservedCredits, "0");
        assert.deepEqual(await snapshot(f), before);
      });

      test("current project permission and actual persisted activation are rechecked after the operation-read await", async (t) => {
        const f = await applicationFixture(t, backend);
        const { owner: _owner, ...query } = sourceLocator(f);
        const before = await snapshot(f);
        f.state.afterOperationRead = async () => {
          f.state.denied = "creativeProject:read";
        };
        await assert.rejects(
          f.service.getConceptGeneration(f.actor, query),
          /authorization_denied/u,
        );
        assert.deepEqual(await snapshot(f), before);

        f.state.denied = null;
        let revokedSnapshot: Awaited<ReturnType<typeof snapshot>> | undefined;
        f.state.afterOperationRead = async () => {
          f.state.afterOperationRead = null;
          const activation = await f.first.store.loadExtensionActivation(
            f.accepted.binding,
          );
          assert.ok(activation);
          await f.first.store.saveExtensionActivation({
            activation: {
              ...activation,
              revision: activation.revision + 1,
              state: "revoked",
              target: null,
            },
            expectedRevision: activation.revision,
            receipt: {
              actorId: f.actor.actorId,
              idempotencyKey: "source-read-revoke",
              requestDigest:
                extensionStoreDigester.sha256("source-read-revoke"),
            },
          });
          revokedSnapshot = await snapshot(f);
        };
        await assert.rejects(
          f.service.getConceptGeneration(f.actor, query),
          /extension_access_revoked/u,
        );
        assert.ok(revokedSnapshot);
        assert.deepEqual(await snapshot(f), revokedSnapshot);
      });
    },
  );
}
