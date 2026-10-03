import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import {
  appendConceptAssetRevision,
  appendProjectBriefRevision,
  renameCreativeProject,
  setCreativeProjectState,
} from "@crewon/domain";
import {
  projectQueryFixture,
  queryWriteTables,
  unchangedTables,
} from "./project-query.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { receipt as metadataReceipt } from "./creative-project-store.test-support.ts";
import { timestamp } from "./extension-store.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const)
  describe(
    `${backend} published project query`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      test("commits actual query Turn/Run/admission/receipt/sidecar once, preserving generation A and querying with B without credits or a slot", async (t) => {
        const f = await projectQueryFixture(t, backend),
          input = await f.queryInput(),
          before = await f.counts();
        const result = await f.first.store.commitExtensionTurn(
            input,
            f.commitOptions,
          ),
          after = await f.counts();
        for (const table of queryWriteTables)
          assert.equal(after[table], before[table]! + 1, table);
        for (const table of unchangedTables)
          assert.equal(after[table], before[table], table);
        assert.equal(result.creditAdmission, undefined);
        assert.equal(result.binding.source?.runId, f.generation.binding.runId);
        assert.notEqual(result.binding.runId, f.generation.binding.runId);
        const sidecar = await f.second.store.loadProjectQueryLink(
          result.binding,
        );
        assert.ok(sidecar);
        assert.equal(sidecar.executionPin.version, "2.0.0");
        assert.equal(
          sidecar.generationLinkDigest,
          f.generationLink.contentDigest,
        );
        const query = await f.first.store.loadPluginQueryTaskAdmission(
          result.binding,
        );
        assert.ok(query);
        assert.equal(query.source.version, "1.0.0");
        assert.deepEqual(
          await f.first.store.loadProjectGenerationLink(f.generation.binding),
          f.generationLink,
        );
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "30",
        );
        assert.equal(Object.keys(result).includes("projectQuery"), false);
      });
      test("same key replays original query across connections and cold opt-in without granting generation writes", async (t) => {
        const f = await projectQueryFixture(t, backend),
          input = await f.queryInput(),
          first = await f.first.store.commitExtensionTurn(
            input,
            f.commitOptions,
          ),
          before = await f.counts();
        const candidate = await f.queryInput("newly-allocated-query-run");
        const replay = await f.second.store.commitExtensionTurn(
          candidate,
          f.commitOptions,
        );
        assert.equal(replay.run.disposition, "replayed");
        assert.equal(replay.binding.runId, first.binding.runId);
        const cold = await f.open();
        assert.equal(cold.store.projectQueryVersion, undefined);
        assert.equal(cold.store.projectGenerationVersion, undefined);
        await assert.rejects(
          cold.store.loadProjectQueryLink(first.binding),
          /project_query_unavailable/u,
        );
        await cold.store.migrateProjectQueries();
        await cold.store.enableProjectGenerationReads();
        assert.equal(
          cold.store.projectQueryVersion,
          "crewon.project-query-link.v1",
        );
        assert.equal(cold.store.projectGenerationVersion, undefined);
        assert.equal(cold.store.projectGenerationPublicationVersion, undefined);
        assert.equal(
          (await cold.store.commitExtensionTurn(candidate, f.commitOptions))
            .binding.runId,
          first.binding.runId,
        );
        assert.deepEqual(
          await cold.store.loadProjectQueryLink(first.binding),
          await f.first.store.loadProjectQueryLink(first.binding),
        );
        assert.deepEqual(await f.counts(), before);
      });
      test("historical source3 remains queryable after rename, new brief/input and archive", async (t) => {
        const f = await projectQueryFixture(t, backend),
          owner = {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          };
        let project = (await f.metadata.loadProject({
          owner,
          projectId: f.reference.projectId,
        }))!;
        const renamed = renameCreativeProject({
          project,
          actor: f.actor,
          expectedProjectRevision: project.revision,
          title: "历史项目改名",
          at: timestamp,
        });
        await f.metadata.commitProjectMetadata({
          kind: "rename-project",
          actor: f.actor,
          receipt: metadataReceipt("query-rename"),
          expectedProjectRevision: project.revision,
          project: renamed,
        });
        project = renamed;
        const brief = appendProjectBriefRevision(
          {
            project,
            actor: f.actor,
            expectedProjectRevision: project.revision,
            text: "新需求",
            at: timestamp,
          },
          extensionStoreDigester,
        );
        const saved = await f.metadata.commitProjectBrief({
          actor: f.actor,
          receipt: metadataReceipt("query-new-brief"),
          expectedProjectRevision: project.revision,
          ...brief,
        });
        const asset = (await f.metadata.loadConceptAsset({
          owner,
          projectId: f.reference.projectId,
          assetId: f.reference.assetId,
        }))!;
        const append = appendConceptAssetRevision(
          {
            project: saved.project,
            actor: f.actor,
            expectedProjectRevision: saved.project.revision,
            expectedAssetMetadataRevision: asset.revision,
            asset,
            brief: saved.brief,
            prompt: "新输入",
            at: timestamp,
          },
          extensionStoreDigester,
        );
        const concept = await f.metadata.commitConceptRevision({
          kind: "append-concept",
          actor: f.actor,
          receipt: metadataReceipt("query-new-input"),
          expectedProjectRevision: saved.project.revision,
          expectedAssetMetadataRevision: asset.revision,
          ...append,
        });
        const archived = setCreativeProjectState({
          project: concept.project,
          actor: f.actor,
          expectedProjectRevision: concept.project.revision,
          state: "archived",
          at: timestamp,
        });
        await f.metadata.commitProjectMetadata({
          kind: "set-project-state",
          actor: f.actor,
          receipt: metadataReceipt("query-archive"),
          expectedProjectRevision: concept.project.revision,
          project: archived,
        });
        const input = await f.queryInput();
        const before = await f.counts();
        const result = await f.first.store.commitExtensionTurn(
          input,
          f.commitOptions,
        );
        assert.deepEqual(
          (await f.first.store.loadProjectQueryLink(result.binding))?.reference,
          f.reference,
        );
        const after = await f.counts();
        for (const table of unchangedTables)
          assert.equal(after[table], before[table], table);
      });
      for (const owner of ["source", "execution"] as const)
        for (const state of ["disabled", "uninstalled"] as const)
          test(`${owner} ${state} refuses fresh acceptance and original-key replay with no writes`, async (t) => {
            const f = await projectQueryFixture(t, backend),
              accepted = await f.queryInput();
            await f.first.store.commitExtensionTurn(accepted, f.commitOptions);
            const fresh = await f.queryInput("fresh-query", "fresh-query-key");
            await f.disable(owner, state);
            const before = await f.counts();
            await assert.rejects(
              f.second.store.commitExtensionTurn(fresh, f.commitOptions),
              /plugin_task_admission_conflict/u,
            );
            await assert.rejects(
              f.second.store.commitExtensionTurn(accepted, f.commitOptions),
              /plugin_task_admission_conflict/u,
            );
            assert.deepEqual(await f.counts(), before);
          });
      test("wrong source link digest/reference and source ownership fail before Turn/credit writes", async (t) => {
        const f = await projectQueryFixture(t, backend),
          input = await f.queryInput(),
          before = await f.counts();
        for (const projectQuery of [
          {
            ...input.projectQuery!,
            generationLinkDigest: extensionStoreDigester.sha256("foreign"),
          },
          {
            ...input.projectQuery!,
            reference: { ...f.reference, assetRevision: 2 },
          },
        ])
          await assert.rejects(
            f.first.store.commitExtensionTurn(
              { ...input, projectQuery },
              f.commitOptions,
            ),
            /project_query_source_mismatch/u,
          );
        const executionPin = { ...f.executionPin, principalId: "foreign" },
          sourcePin = { ...f.sourcePin, principalId: "foreign" };
        await assert.rejects(
          f.first.store.commitExtensionTurn(
            {
              ...input,
              pluginQueryAdmission: {
                ...input.pluginQueryAdmission!,
                principalId: "foreign",
              },
            },
            {
              ...f.commitOptions,
              projectQueryPublication: {
                publication: f.publication,
                sourcePin,
                executionPin,
              },
            },
          ),
          /project_query_source_mismatch/u,
        );
        assert.deepEqual(await f.counts(), before);
      });
      test("sidecar failure rolls back actual Turn, Run, admission and outbox", async (t) => {
        const f = await projectQueryFixture(t, backend),
          input = await f.queryInput(),
          before = await f.counts();
        await f.sql(
          backend === "sqlite"
            ? "CREATE TRIGGER project_query_failure BEFORE INSERT ON creative_project_query_links BEGIN SELECT RAISE(ABORT,'project_query_failure'); END;"
            : `CREATE FUNCTION ${f.prefix}project_query_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project_query_failure'; END $$; CREATE TRIGGER project_query_failure BEFORE INSERT ON ${f.prefix}creative_project_query_links FOR EACH ROW EXECUTE FUNCTION ${f.prefix}project_query_failure();`,
        );
        await assert.rejects(
          f.first.store.commitExtensionTurn(input, f.commitOptions),
          /project_query_failure/u,
        );
        assert.deepEqual(await f.counts(), before);
      });
      test("sidecars are immutable, malformed/partial schemas refuse migration and old query paths remain opt-in", async (t) => {
        const f = await projectQueryFixture(t, backend, { migration: false });
        const input = await f.queryInput();
        await assert.rejects(
          f.first.store.commitExtensionTurn(input, f.commitOptions),
          /project_query_unavailable/u,
        );
        await f.first.store.migrateProjectQueries();
        await f.first.store.commitExtensionTurn(input, f.commitOptions);
        await assert.rejects(
          f.sql(
            `UPDATE ${f.prefix}creative_project_query_links SET source_run_id='foreign'`,
          ),
          /project_query_link_immutable/u,
        );
        await assert.rejects(
          f.sql(`DELETE FROM ${f.prefix}creative_project_query_links`),
          /project_query_link_immutable/u,
        );
        await f.sql(
          `UPDATE ${f.prefix}project_query_schema_version SET version=2`,
        );
        const cold = await f.open();
        await assert.rejects(
          cold.store.migrateProjectQueries(),
          /project_query_schema_version_unsupported/u,
        );
      });
      test("transaction authority captures receivers/getters and rejects async final fence without accepting a query", async (t) => {
        const f = await projectQueryFixture(t, backend),
          input = await f.queryInput(),
          before = await f.counts();
        let getters = 0;
        const authority = Object.defineProperty(
          { assertCurrent: async () => {}, assertActive() {} },
          "assertActive",
          {
            enumerable: true,
            get() {
              getters++;
              return () => {};
            },
          },
        );
        await assert.rejects(
          f.first.store.commitExtensionTurn(input, {
            ...f.commitOptions,
            projectQueryAuthority: authority,
          }),
        );
        assert.equal(getters, 0);
        await assert.rejects(
          f.first.store.commitExtensionTurn(input, {
            ...f.commitOptions,
            projectQueryAuthority: {
              async assertCurrent() {},
              assertActive: (() => Promise.resolve()) as () => void,
            },
          }),
          /creative_project_commit_authority_sync_required/u,
        );
        let calls = 0;
        const states = new WeakMap<object, boolean>();
        const live = {
          async assertCurrent() {
            assert.equal(states.get(this), true);
            calls++;
          },
          assertActive() {
            assert.equal(states.get(this), true);
          },
        };
        states.set(live, true);
        await f.first.store.commitExtensionTurn(input, {
          ...f.commitOptions,
          projectQueryAuthority: live,
        });
        assert.ok(calls >= 1);
        assert.equal(
          (await f.counts()).creative_project_query_links,
          before.creative_project_query_links! + 1,
        );
      });
      test("concurrent exact acceptance across two connections commits once and rejects changed replay", async (t) => {
        const f = await projectQueryFixture(t, backend),
          a = await f.queryInput("query-candidate-a"),
          b = await f.queryInput("query-candidate-b"),
          before = await f.counts();
        const saved = await Promise.all([
          f.first.store.commitExtensionTurn(a, f.commitOptions),
          f.second.store.commitExtensionTurn(b, f.commitOptions),
        ]);
        assert.deepEqual(saved.map((result) => result.run.disposition).sort(), [
          "committed",
          "replayed",
        ]);
        assert.equal(saved[0]!.binding.runId, saved[1]!.binding.runId);
        const after = await f.counts();
        for (const table of queryWriteTables)
          assert.equal(after[table], before[table]! + 1, table);
        for (const table of unchangedTables)
          assert.equal(after[table], before[table], table);
        await assert.rejects(
          f.second.store.commitExtensionTurn(
            {
              ...a,
              projectQuery: {
                ...a.projectQuery!,
                reference: { ...f.reference, assetRevision: 2 },
              },
            },
            f.commitOptions,
          ),
          /project_query_replay_mismatch/u,
        );
        assert.deepEqual(await f.counts(), after);
      });
      test("ordinary query remains usable without migrating or inspecting the new project query schema", async (t) => {
        const f = await projectQueryFixture(t, backend, { migration: false }),
          input = await f.queryInput();
        const { projectQuery: _association, ...ordinary } = input;
        assert.equal(f.first.store.projectQueryVersion, undefined);
        await assert.rejects(f.count("creative_project_query_links"));
        const creditsBefore = await f.count("plugin_credit_reservations");
        const result = await f.first.store.commitExtensionTurn(ordinary);
        assert.equal(result.creditAdmission, undefined);
        await assert.rejects(f.count("creative_project_query_links"));
        assert.equal(
          await f.count("plugin_credit_reservations"),
          creditsBefore,
        );
        await f.first.store.migrateProjectQueries();
        assert.equal(
          await f.first.store.loadProjectQueryLink(result.binding),
          null,
        );
      });
      for (const table of [
        "project_query_schema_version",
        "creative_project_query_links",
      ] as const)
        test(`partial query schema ${table} is refused without repair`, async (t) => {
          const f = await projectQueryFixture(t, backend, { migration: false });
          await f.sql(`CREATE TABLE ${f.prefix}${table}(id INTEGER)`);
          await assert.rejects(
            f.first.store.migrateProjectQueries(),
            /project_query_schema_incomplete/u,
          );
          assert.equal(f.first.store.projectQueryVersion, undefined);
          await assert.rejects(
            f.count(
              table === "project_query_schema_version"
                ? "creative_project_query_links"
                : "project_query_schema_version",
            ),
          );
        });
      test("owner withdrawal immediately after sidecar INSERT rolls back every query write", async (t) => {
        const f = await projectQueryFixture(t, backend),
          input = await f.queryInput(),
          before = await f.counts();
        let active = true;
        const restore = observeQuerySql(backend, "insert", () => {
          active = false;
        });
        try {
          await assert.rejects(
            f.first.store.commitExtensionTurn(input, {
              ...f.commitOptions,
              projectQueryAuthority: {
                async assertCurrent() {},
                assertActive() {
                  if (!active) throw new Error("query_owner_withdrawn");
                },
              },
            }),
            /query_owner_withdrawn/u,
          );
        } finally {
          restore();
        }
        assert.deepEqual(await f.counts(), before);
      });
      test("acknowledged COMMIT is sticky when the owner withdraws after physical commit", async (t) => {
        const f = await projectQueryFixture(t, backend),
          input = await f.queryInput();
        let active = true;
        const restore = observeQuerySql(backend, "commit", () => {
          active = false;
        });
        try {
          const result = await f.first.store.commitExtensionTurn(input, {
            ...f.commitOptions,
            projectQueryAuthority: {
              async assertCurrent() {},
              assertActive() {
                if (!active) throw new Error("query_owner_withdrawn");
              },
            },
          });
          assert.equal(result.run.disposition, "committed");
        } finally {
          restore();
        }
        assert.equal(active, false);
        assert.equal(await f.count("creative_project_query_links"), 1);
      });
    },
  );

/** Observe physical SQL success while preserving native receivers and results. */
function observeQuerySql(
  backend: "sqlite" | "postgres",
  point: "insert" | "commit",
  after: () => void,
): () => void {
  const prototype =
    backend === "sqlite" ? DatabaseSync.prototype : Client.prototype;
  const method =
    backend === "sqlite" ? (point === "insert" ? "prepare" : "exec") : "query";
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!,
    original = descriptor.value as (...args: unknown[]) => unknown;
  Object.defineProperty(prototype, method, {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args),
        sql = args[0];
      if (
        typeof sql !== "string" ||
        !(point === "commit"
          ? sql === "COMMIT"
          : /^INSERT INTO (?:(?:"[a-z0-9_]+")\.)?creative_project_query_links /u.test(
              sql,
            ))
      )
        return result;
      if (backend === "postgres")
        return (result as Promise<unknown>).then((value) => {
          after();
          return value;
        });
      if (point === "commit") {
        after();
        return result;
      }
      const statement = result as { run(...values: unknown[]): unknown },
        run = statement.run;
      Object.defineProperty(statement, "run", {
        value(...values: unknown[]) {
          const value = Reflect.apply(run, statement, values);
          after();
          return value;
        },
      });
      return statement;
    },
  });
  return () => Object.defineProperty(prototype, method, descriptor);
}
