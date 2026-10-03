import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import {
  appendProjectBriefRevision,
  appendConceptAssetRevision,
  setCreativeProjectState,
  parsePluginTaskAdmission,
  createExtensionCreditAdmission,
} from "@crewon/domain";
import { projectGenerationSchemaSql } from "./project-generation-schema.ts";
import { extensionTurnInput } from "./extension-turn.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import {
  projectGenerationFixture,
  activeAuthority,
  generationTables,
  failGenerationInsert,
  observeGenerationWrite,
} from "./project-generation.test-support.ts";
import { receipt as projectReceipt } from "./creative-project-store.test-support.ts";
import { timestamp } from "./extension-store.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  describe(
    `${backend} internal project generation`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      test("atomically commits one real Turn, Run, personal hold and immutable link, then replays across connections and cold reopen", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        const input = await f.input();
        const before = await f.counts();
        const results = await Promise.all([
          f.first.store.commitExtensionTurn(input, activeAuthority),
          f.second.store.commitExtensionTurn(input, activeAuthority),
        ]);
        assert.deepEqual(results.map((r) => r.run.disposition).sort(), [
          "committed",
          "replayed",
        ]);
        const after = await f.counts();
        for (const table of generationTables)
          assert.equal(after[table], before[table]! + 1, table);
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "30",
        );
        const link = await f.first.store.loadProjectGenerationLink(
          input.binding,
        );
        assert.ok(link);
        assert.deepEqual(link.reference, f.reference);
        assert.deepEqual(link.binding, results[0]!.binding);
        assert.deepEqual(link.receipt, input.receipt);
        assert.equal(link.createdAt, input.turn.run.events[0]!.occurredAt);
        assert.deepEqual(
          Object.keys(results[0]!).sort(),
          ["schemaVersion", "turn", "run", "binding", "creditAdmission"].sort(),
        );
        assert.equal("projectGeneration" in results[0]!, false);
        const reopened = await f.open();
        assert.equal(reopened.store.projectGenerationVersion, undefined);
        await assert.rejects(
          reopened.store.loadProjectGenerationLink(input.binding),
          /project_generation_unavailable/u,
        );
        await reopened.store.migrateProjectGenerations();
        assert.deepEqual(
          await reopened.store.loadProjectGenerationLink(input.binding),
          link,
        );
        assert.equal(
          (await reopened.store.commitExtensionTurn(input, activeAuthority)).run
            .disposition,
          "replayed",
        );
        assert.deepEqual(await f.counts(), after);
      });

      test("old receipt and frozen source remain valid after newer brief/concept revisions and archive", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        const input = await f.input();
        await f.first.store.commitExtensionTurn(input, activeAuthority);
        const owner = {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        };
        const project = (await f.metadata.loadProject({
          owner,
          projectId: f.reference.projectId,
        }))!;
        const append = appendProjectBriefRevision(
          {
            project,
            actor: f.actor,
            expectedProjectRevision: project.revision,
            text: "新的需求",
            at: timestamp,
          },
          extensionStoreDigester,
        );
        const newer = await f.metadata.commitProjectBrief({
          actor: f.actor,
          receipt: projectReceipt("newer-brief"),
          expectedProjectRevision: project.revision,
          ...append,
        });
        const asset = (await f.metadata.loadConceptAsset({
          owner,
          projectId: project.projectId,
          assetId: f.reference.assetId,
        }))!;
        const revision = appendConceptAssetRevision(
          {
            project: newer.project,
            actor: f.actor,
            expectedProjectRevision: newer.project.revision,
            expectedAssetMetadataRevision: asset.revision,
            asset,
            brief: newer.brief,
            prompt: "新的概念提示词",
            at: timestamp,
          },
          extensionStoreDigester,
        );
        const concept = await f.metadata.commitConceptRevision({
          kind: "append-concept",
          actor: f.actor,
          receipt: projectReceipt("newer-concept"),
          expectedProjectRevision: newer.project.revision,
          expectedAssetMetadataRevision: asset.revision,
          ...revision,
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
          receipt: projectReceipt("archive-generation-project"),
          expectedProjectRevision: concept.project.revision,
          project: archived,
        });
        const before = await f.counts();
        assert.equal(
          (await f.second.store.commitExtensionTurn(input, activeAuthority)).run
            .disposition,
          "replayed",
        );
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          (await f.second.store.loadProjectGenerationLink(input.binding))
            ?.briefRevision,
          1,
        );
        const fresh = await f.input("run-fresh", "fresh-after-archive", {
          ...f.reference,
          expectedProjectRevision: archived.revision,
          expectedAssetMetadataRevision: concept.asset.revision,
        });
        await assert.rejects(
          f.first.store.commitExtensionTurn(fresh, activeAuthority),
          /creative_project_archived/u,
        );
        assert.deepEqual(await f.counts(), before);
      });

      test("slot conflict under another key does not reserve again or create a second Run", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        await f.first.store.commitExtensionTurn(
          await f.input(),
          activeAuthority,
        );
        const second = await f.input("run-second", "different-generation-key");
        const before = await f.counts();
        await assert.rejects(
          f.second.store.commitExtensionTurn(second, activeAuthority),
          /project_generation_slot_occupied/u,
        );
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "30",
        );
      });

      for (const [name, patch, error] of [
        [
          "project CAS",
          { expectedProjectRevision: 1 },
          "creative_project_revision_conflict",
        ],
        [
          "asset CAS",
          { expectedAssetMetadataRevision: 2 },
          "creative_project_asset_revision_conflict",
        ],
        [
          "missing project",
          { projectId: "unknown-project" },
          "project_generation_source_not_found",
        ],
        [
          "missing immutable input",
          { assetRevision: 2 },
          "project_generation_source_not_found",
        ],
      ] as const)
        test(`rejects ${name} before Turn and personal hold`, async (t) => {
          const f = await projectGenerationFixture(t, backend);
          const input = await f.input("run-1", "rejected-source", {
            ...f.reference,
            ...patch,
          });
          const before = await f.counts();
          await assert.rejects(
            f.first.store.commitExtensionTurn(input, activeAuthority),
            new RegExp(error, "u"),
          );
          assert.deepEqual(await f.counts(), before);
        });

      test("requires captured Host authority, paid provenance and the actual project owner", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        const input = await f.input();
        const before = await f.counts();
        await assert.rejects(
          f.first.store.commitExtensionTurn(input),
          /project_generation_authority_required/u,
        );
        await assert.rejects(
          f.first.store.commitExtensionTurn(
            { ...input, pluginAdmission: undefined },
            activeAuthority,
          ),
          /project_generation_paid_plugin_admission_required/u,
        );
        await assert.rejects(
          f.first.store.commitExtensionTurn(
            { ...input, creditAdmission: undefined },
            activeAuthority,
          ),
          /plugin_task_credit_admission_required/u,
        );
        const principalId = "foreign-project-owner";
        const foreign = {
          ...input,
          pluginAdmission: parsePluginTaskAdmission({
            ...input.pluginAdmission!,
            principalId,
          }),
          creditAdmission: createExtensionCreditAdmission(
            {
              binding: input.binding,
              receipt: input.receipt,
              principalId,
              poolId: f.creditScope.poolId,
              priceRevision: 1,
              quotedCredits: "30",
            },
            extensionStoreDigester,
          ),
        };
        await assert.rejects(
          f.first.store.commitExtensionTurn(foreign, activeAuthority),
          /project_generation_source_not_found/u,
        );
        assert.deepEqual(await f.counts(), before);
      });

      test("new and old association presence cannot share a receipt even when an internal caller reuses its digest", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        const linked = await f.input();
        await f.first.store.commitExtensionTurn(linked, activeAuthority);
        const { projectGeneration: _reference, ...plain } = linked;
        await assert.rejects(
          f.first.store.commitExtensionTurn(plain),
          /project_generation_receipt_conflict/u,
        );
        const changed = {
          ...linked,
          projectGeneration: { ...f.reference, expectedProjectRevision: 2 },
        };
        await assert.rejects(
          f.first.store.commitExtensionTurn(changed, activeAuthority),
          /creative_project_generation_replay_mismatch/u,
        );
      });

      for (const table of [
        "creative_project_generation_links",
        "extension_mutation_receipts",
      ] as const)
        test(`failure at ${table} rolls back link, receipt, messages, Run and credit together`, async (t) => {
          const f = await projectGenerationFixture(t, backend);
          const input = await f.input();
          const before = await f.counts();
          await failGenerationInsert(f, backend, table, true);
          await assert.rejects(
            f.first.store.commitExtensionTurn(input, activeAuthority),
            /generation_fixture_failure/u,
          );
          assert.deepEqual(await f.counts(), before);
          assert.equal(
            (await f.credits.getAccount(f.creditScope))?.reservedCredits,
            "0",
          );
          await failGenerationInsert(f, backend, table, false);
          assert.equal(
            (await f.first.store.commitExtensionTurn(input, activeAuthority))
              .run.disposition,
            "committed",
          );
        });

      test("synchronous withdrawal cannot defer COMMIT through a Promise or thenable", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        const input = await f.input();
        const before = await f.counts();
        let reads = 0;
        for (const result of [
          Promise.reject(new Error("observed-rejection")),
          Object.defineProperty({}, "then", {
            get() {
              reads++;
              throw new Error("getter");
            },
          }),
        ]) {
          const authority = {
            assertCurrent: async () => {},
            assertActive: () => result as never,
          };
          await assert.rejects(
            f.first.store.commitExtensionTurn(input, {
              projectGenerationAuthority: authority,
            }),
            /creative_project_commit_authority_sync_required/u,
          );
        }
        assert.equal(reads, 0);
        assert.deepEqual(await f.counts(), before);
      });

      test("immutable links reject direct update and deletion", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        await f.first.store.commitExtensionTurn(
          await f.input(),
          activeAuthority,
        );
        await assert.rejects(
          f.sql(
            `UPDATE ${f.prefix}creative_project_generation_links SET owner_principal_id='another'`,
          ),
          /project_generation_link_immutable/u,
        );
        await assert.rejects(
          f.sql(`DELETE FROM ${f.prefix}creative_project_generation_links`),
          /project_generation_link_immutable/u,
        );
      });

      test("unknown and partial optional schema fail closed instead of repairing it", async (t) => {
        const f = await projectGenerationFixture(t, backend, {
          generationMigration: false,
        });
        assert.equal(f.first.store.projectGenerationVersion, undefined);
        const input = await f.input();
        await assert.rejects(
          f.first.store.commitExtensionTurn(input, activeAuthority),
          /project_generation_unavailable/u,
        );
        await f.sql(
          `CREATE TABLE ${f.prefix}project_generation_schema_version(id INTEGER PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO ${f.prefix}project_generation_schema_version VALUES(1,99);`,
        );
        await assert.rejects(
          f.first.store.migrateProjectGenerations(),
          /project_generation_schema_incomplete/u,
        );
        assert.equal(f.first.store.projectGenerationVersion, undefined);
      });

      test("cancel and hold release keep the original slot immutable; a newly appended revision gets its own intent", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        const original = await f.input();
        const accepted = await f.first.store.commitExtensionTurn(
          original,
          activeAuthority,
        );
        const link = await f.first.store.loadProjectGenerationLink(
          original.binding,
        );
        const run = accepted.run.state;
        const canceled = await f.first.parent.commitRun({
          tenantId: run.tenantId,
          expectedRevision: run.revision,
          idempotency: {
            scope: "generation-fixture-cancel",
            key: run.runId,
            requestFingerprint: "generation-fixture-cancel",
          },
          events: [
            {
              schemaVersion: "crewon.run-event.v0",
              identity: { runId: run.runId },
              eventId: "generation-cancel-request",
              sequence: run.lastSequence + 1,
              occurredAt: timestamp,
              type: "run.cancel.requested",
              data: { actorId: f.actor.actorId },
            },
            {
              schemaVersion: "crewon.run-event.v0",
              identity: { runId: run.runId },
              eventId: "generation-cancel-done",
              sequence: run.lastSequence + 2,
              occurredAt: timestamp,
              type: "run.canceled",
              data: { reasonCode: "generation-fixture-canceled" },
            },
          ],
          outbox: [],
          workItems: [],
        });
        assert.equal(canceled.state.status, "canceled");
        await f.credits.release({
          scope: f.creditScope,
          reservationId: run.runId,
        });
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "0",
        );
        await assert.rejects(
          f.second.store.commitExtensionTurn(
            await f.input("run-second", "new-key-old-slot"),
            activeAuthority,
          ),
          /project_generation_slot_occupied/u,
        );
        const owner = {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        };
        const project = (await f.metadata.loadProject({
          owner,
          projectId: f.reference.projectId,
        }))!;
        const asset = (await f.metadata.loadConceptAsset({
          owner,
          projectId: project.projectId,
          assetId: f.reference.assetId,
        }))!;
        const brief = (await f.metadata.loadBrief({
          owner,
          projectId: project.projectId,
          briefRevision: 1,
        }))!;
        const next = appendConceptAssetRevision(
          {
            project,
            actor: f.actor,
            expectedProjectRevision: project.revision,
            expectedAssetMetadataRevision: asset.revision,
            asset,
            brief,
            prompt: "A ceramic teapot by a sunlit window.",
            at: timestamp,
          },
          extensionStoreDigester,
        );
        const source = await f.metadata.commitConceptRevision({
          kind: "append-concept",
          actor: f.actor,
          receipt: projectReceipt("new-generation-input"),
          expectedProjectRevision: project.revision,
          expectedAssetMetadataRevision: asset.revision,
          ...next,
        });
        const reference = {
          ...f.reference,
          assetRevision: source.assetRevision.assetRevision,
          expectedProjectRevision: source.project.revision,
          expectedAssetMetadataRevision: source.asset.revision,
        };
        const second = await f.input(
          "run-third",
          "new-key-new-slot",
          reference,
        );
        assert.equal(
          (await f.second.store.commitExtensionTurn(second, activeAuthority))
            .run.disposition,
          "committed",
        );
        assert.deepEqual(
          await f.first.store.loadProjectGenerationLink(original.binding),
          link,
        );
        assert.equal(await f.count("run_snapshots"), 2);
        assert.equal(await f.count("creative_project_generation_links"), 2);
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "30",
        );
        assert.equal(
          (
            await f.credits.getReservation({
              scope: f.creditScope,
              reservationId: run.runId,
            })
          )?.state,
          "released",
        );
        assert.equal(
          (await f.first.store.commitExtensionTurn(original, activeAuthority))
            .run.disposition,
          "replayed",
        );
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "30",
        );
      });

      test("concurrent different keys competing for one immutable revision commit only one paid intent", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        const first = await f.input("slot-race-1", "slot-race-key-1");
        const second = await f.input("slot-race-2", "slot-race-key-2");
        const results = await Promise.allSettled([
          f.first.store.commitExtensionTurn(first, activeAuthority),
          f.second.store.commitExtensionTurn(second, activeAuthority),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const failure = results.find((r) => r.status === "rejected");
        assert.ok(
          failure?.status === "rejected" &&
            /project_generation_slot_occupied/u.test(String(failure.reason)),
        );
        assert.equal(await f.count("creative_project_generation_links"), 1);
        assert.equal(await f.count("run_snapshots"), 1);
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "30",
        );
      });

      test("replay uses the original binding despite a newly prepared server Run and quote", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        const original = await f.input();
        const saved = await f.first.store.commitExtensionTurn(
          original,
          activeAuthority,
        );
        const fresh = extensionTurnInput("server-run-race", {
          threadId: original.binding.threadId,
        });
        const input = {
          ...fresh,
          receipt: original.receipt,
          projectGeneration: original.projectGeneration,
          pluginAdmission: parsePluginTaskAdmission({
            ...original.pluginAdmission!,
            runId: fresh.binding.runId,
            threadId: fresh.binding.threadId,
            extensionBindingDigest: fresh.binding.bindingDigest,
          }),
          creditAdmission: createExtensionCreditAdmission(
            {
              binding: fresh.binding,
              receipt: original.receipt,
              principalId: f.actor.principalId,
              poolId: f.creditScope.poolId,
              priceRevision: 9,
              quotedCredits: "90",
            },
            extensionStoreDigester,
          ),
        };
        const before = await f.counts();
        const replay = await f.second.store.commitExtensionTurn(
          input,
          activeAuthority,
        );
        assert.equal(replay.run.disposition, "replayed");
        assert.deepEqual(replay.binding, saved.binding);
        assert.deepEqual(replay.creditAdmission, saved.creditAdmission);
        assert.deepEqual(await f.counts(), before);
      });

      test("withdrawal after the actual link INSERT rolls back every original task write", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        const input = await f.input();
        const before = await f.counts();
        let written = false;
        const restore = observeGenerationWrite(backend, () => {
          written = true;
        });
        const authority = {
          async assertCurrent() {
            if (written) throw new Error("generation_host_withdrawn");
          },
          assertActive() {
            if (written) throw new Error("generation_host_withdrawn");
          },
        };
        try {
          await assert.rejects(
            f.first.store.commitExtensionTurn(input, {
              projectGenerationAuthority: authority,
            }),
            /generation_host_withdrawn/u,
          );
        } finally {
          restore();
        }
        assert.equal(written, true);
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "0",
        );
        assert.equal(
          (await f.first.store.commitExtensionTurn(input, activeAuthority)).run
            .disposition,
          "committed",
        );
      });

      test("callbacks stay captured during policy waits and a closed Store cannot admit a new task", async (t) => {
        const f = await projectGenerationFixture(t, backend);
        const input = await f.input();
        const before = await f.counts();
        let enter!: () => void;
        let resume!: () => void;
        const entered = new Promise<void>((done) => {
          enter = done;
        });
        const gate = new Promise<void>((done) => {
          resume = done;
        });
        let alive = true;
        const authority = {
          async assertCurrent() {
            enter();
            await gate;
          },
          assertActive() {
            if (!alive) throw new Error("generation_owner_closed");
          },
        };
        const pending = f.first.store.commitExtensionTurn(input, {
          projectGenerationAuthority: authority,
        });
        await entered;
        authority.assertCurrent = async () => {};
        authority.assertActive = () => {};
        alive = false;
        resume();
        await assert.rejects(pending, /generation_owner_closed/u);
        assert.deepEqual(await f.counts(), before);
        await f.first.parent.close();
        await assert.rejects(
          f.first.store.commitExtensionTurn(input, activeAuthority),
          /store_closed/u,
        );
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          (await f.second.store.commitExtensionTurn(input, activeAuthority)).run
            .disposition,
          "committed",
        );
      });

      for (const mutation of [
        "generation-check",
        "generation-fk",
        "version-id-check",
        "unknown-version",
        "brief-history",
        "concept-history",
      ] as const)
        test(`tampered ${mutation} refuses migration, read and commit without repair`, async (t) => {
          const f = await projectGenerationFixture(t, backend);
          const input = await f.input();
          const before = await f.counts();
          if (mutation === "generation-check")
            await f.sql(
              backend === "sqlite"
                ? sqliteReplacementSchema("check")
                : `ALTER TABLE ${f.prefix}creative_project_generation_links DROP CONSTRAINT creative_project_generation_links_asset_revision_check; ALTER TABLE ${f.prefix}creative_project_generation_links ADD CHECK(asset_revision>=0 AND asset_revision<=9007199254740991);`,
            );
          if (mutation === "generation-fk")
            await f.sql(
              backend === "sqlite"
                ? sqliteReplacementSchema("fk")
                : `DO $$ DECLARE n text; BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid='${f.prefix}creative_project_generation_links'::regclass AND contype='f' AND pg_get_constraintdef(oid) LIKE '%extension_run_bindings%'; EXECUTE 'ALTER TABLE ${f.prefix}creative_project_generation_links DROP CONSTRAINT '||quote_ident(n); END $$; ALTER TABLE ${f.prefix}creative_project_generation_links ADD FOREIGN KEY(tenant_id,run_id) REFERENCES ${f.prefix}extension_run_bindings(tenant_id,run_id) ON DELETE CASCADE;`,
            );
          if (mutation === "version-id-check")
            await f.sql(
              `DROP TABLE ${f.prefix}project_generation_schema_version; CREATE TABLE ${f.prefix}project_generation_schema_version(id INTEGER PRIMARY KEY CHECK(id IN (1,2)),version INTEGER NOT NULL)${backend === "sqlite" ? " STRICT" : ""}; INSERT INTO ${f.prefix}project_generation_schema_version VALUES(1,1);`,
            );
          if (mutation === "unknown-version")
            await f.sql(
              `UPDATE ${f.prefix}project_generation_schema_version SET version=99;`,
            );
          if (mutation === "brief-history" || mutation === "concept-history") {
            const table =
              mutation === "brief-history"
                ? "creative_project_briefs"
                : "creative_concept_revisions";
            await f.sql(
              backend === "sqlite"
                ? `DROP TRIGGER ${table}_no_update;`
                : `ALTER TABLE ${f.prefix}${table} DISABLE TRIGGER ${table}_no_update_or_delete;`,
            );
          }
          const failure =
            mutation === "unknown-version"
              ? /project_generation_schema_version_unsupported/u
              : /project_generation_schema_incomplete/u;
          const cold = await f.open();
          await assert.rejects(cold.store.migrateProjectGenerations(), failure);
          assert.equal(cold.store.projectGenerationVersion, undefined);
          await assert.rejects(
            f.first.store.loadProjectGenerationLink(input.binding),
            failure,
          );
          await assert.rejects(
            f.first.store.commitExtensionTurn(input, activeAuthority),
            failure,
          );
          await assert.rejects(cold.store.migrateProjectGenerations(), failure);
          assert.deepEqual(await f.counts(), before);
        });

      test("ordinary paid tasks never inspect or migrate project metadata on a default adapter", async (t) => {
        const f = await projectGenerationFixture(t, backend, {
          generationMigration: false,
          metadata: false,
        });
        const linked = await f.input();
        const { projectGeneration: _reference, ...input } = linked;
        const statements: string[] = [];
        const prototype =
          backend === "sqlite" ? DatabaseSync.prototype : Client.prototype;
        const method = backend === "sqlite" ? "prepare" : "query";
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
        const original = descriptor.value as (...args: unknown[]) => unknown;
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value: function (this: unknown, ...args: unknown[]) {
            if (
              typeof args[0] === "string" &&
              /creative_project|creative_concept|project_generation/u.test(
                args[0],
              )
            )
              statements.push(args[0]);
            return Reflect.apply(original, this, args);
          },
        });
        try {
          assert.equal(
            (await f.first.store.commitExtensionTurn(input)).run.disposition,
            "committed",
          );
          assert.equal(
            (await f.first.store.commitExtensionTurn(input)).run.disposition,
            "replayed",
          );
        } finally {
          Object.defineProperty(prototype, method, descriptor);
        }
        assert.deepEqual(statements, []);
        assert.equal(f.first.store.projectGenerationVersion, undefined);
      });
    },
  );

function sqliteReplacementSchema(change: "check" | "fk"): string {
  const sql = projectGenerationSchemaSql({ dialect: "sqlite" });
  return `DROP TABLE creative_project_generation_links; ${change === "check" ? sql.replace("asset_revision>=1", "asset_revision>=0") : sql.replaceAll("ON DELETE RESTRICT", "ON DELETE CASCADE")}
    CREATE TRIGGER project_generation_no_update BEFORE UPDATE ON creative_project_generation_links BEGIN SELECT RAISE(ABORT,'project_generation_link_immutable'); END;
    CREATE TRIGGER project_generation_no_delete BEFORE DELETE ON creative_project_generation_links BEGIN SELECT RAISE(ABORT,'project_generation_link_immutable'); END;`;
}
