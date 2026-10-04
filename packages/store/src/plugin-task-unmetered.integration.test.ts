import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import {
  createExtensionCreditAdmission,
  extensionCanonicalJson,
} from "@crewon/domain";
import {
  unmeteredFixture,
  observeUnmeteredInsert,
} from "./plugin-task-unmetered.test-support.ts";
import { extensionStoreDigester as digester } from "./extension-store-records.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { startExternalOperationFixtureRun } from "./external-operation-run.test-support.ts";
import { selectionVerifier } from "./project-concept-selection.test-support.ts";
import { timestamp, digest } from "./extension-store.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  describe(
    `${backend}: explicit unmetered installed tasks`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      test("default and not-yet-opted-in adapters refuse free generation with no Turn, financial schema or funds", async (t) => {
        const f = await unmeteredFixture(t, backend, { optIn: false });
        await assert.rejects(f.generate(), /plugin_task_unmetered_unavailable/);
        await assert.rejects(
          f
            .create(f.first.store, f.first.parent, null)
            .createProjectTaskFromPlugin(
              f.actor,
              f.command(),
              f.pin,
              f.reference,
              f.projectAuthority,
            ),
          /extension_credit_quote_unavailable/,
        );
        assert.equal(await f.count("run_snapshots"), 0);
        assert.deepEqual(await f.creditObjects(), []);
        assert.equal(await f.count("extension_run_bindings"), 0);
      });
      test("original Turn, complete pin and immutable proof commit once; replay and cold reads never quote or create a wallet", async (t) => {
        const f = await unmeteredFixture(t, backend);
        const result = await f.generate();
        assert.equal(result.creditAdmission, undefined);
        assert.deepEqual(
          result.unmeteredAdmission?.authorization,
          f.authorization,
        );
        assert.deepEqual(
          await f.first.store.loadPluginTaskUnmeteredAdmission(result.binding),
          result.unmeteredAdmission,
        );
        for (const table of [
          "run_snapshots",
          "messages",
          "model_history_items",
          "extension_run_bindings",
          "plugin_task_admissions",
          "plugin_task_unmetered_admissions",
          "creative_project_generation_links",
        ])
          assert.equal(await f.count(table), 1, table);
        const replay = await f
          .create(f.second.store, f.second.parent, null)
          .createProjectTaskFromPlugin(
            f.actor,
            f.command(),
            f.pin,
            f.reference,
            f.projectAuthority,
          );
        assert.equal(replay.run.disposition, "replayed");
        assert.deepEqual(replay.unmeteredAdmission, result.unmeteredAdmission);
        assert.equal(f.authorityState.prepared, 1);
        const cold = await f.open();
        const read = await f.reads(cold.store, cold.parent);
        const restored = await read.getConceptGeneration(f.actor, {
          projectId: f.reference.projectId,
          assetId: f.reference.assetId,
          assetRevision: f.reference.assetRevision,
        });
        assert.equal(restored?.task.binding.runId, result.binding.runId);
        assert.deepEqual(
          (
            await cold.store.loadExtensionTurnReceipt({
              ...result.binding,
              receipt: result.unmeteredAdmission!.task,
            })
          )?.unmeteredAdmission,
          result.unmeteredAdmission,
        );
        assert.deepEqual(await f.creditObjects(), []);
        await assert.rejects(
          f.sql(
            `UPDATE ${f.prefix}plugin_task_unmetered_admissions SET principal_id='other'`,
          ),
          /plugin_task_unmetered_immutable/,
        );
      });
      test("companion INSERT failure rolls back every original task write", async (t) => {
        const f = await unmeteredFixture(t, backend);
        // An actual trigger simulates failure of the final trusted-host fence, after the original Turn write.
        await f.sql(
          backend === "sqlite"
            ? "CREATE TRIGGER unmetered_test_failure BEFORE INSERT ON plugin_task_unmetered_admissions BEGIN SELECT RAISE(ABORT,'unmetered_test_failure'); END;"
            : `CREATE FUNCTION ${f.prefix}unmetered_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unmetered_test_failure'; END $$; CREATE TRIGGER unmetered_test_failure BEFORE INSERT ON ${f.prefix}plugin_task_unmetered_admissions FOR EACH ROW EXECUTE FUNCTION ${f.prefix}unmetered_test_failure();`,
        );
        await assert.rejects(f.generate());
        for (const table of [
          "run_snapshots",
          "messages",
          "model_history_items",
          "extension_run_bindings",
          "plugin_task_admissions",
          "plugin_task_unmetered_admissions",
          "creative_project_generation_links",
        ])
          assert.equal(await f.count(table), 0, table);
        assert.deepEqual(await f.creditObjects(), []);
      });
      test("dual proof and a missing persisted companion fail closed", async (t) => {
        const f = await unmeteredFixture(t, backend);
        const result = await f.generate();
        const proof = result.unmeteredAdmission!;
        const credit = createExtensionCreditAdmission(
          {
            binding: result.binding,
            receipt: proof.task,
            principalId: f.actor.principalId,
            poolId: "negative-test-only",
            priceRevision: 1,
            quotedCredits: "1",
          },
          digester,
        );
        const raw = (
          await f.rows(
            `SELECT result_json FROM ${f.prefix}extension_mutation_receipts WHERE kind='task'`,
          )
        )[0]!.result_json;
        const saved = typeof raw === "string" ? JSON.parse(raw) : raw;
        const changed = { ...saved, creditAdmission: credit };
        const encoded = JSON.stringify(changed).replaceAll("'", "''");
        await f.sql(
          `UPDATE ${f.prefix}extension_mutation_receipts SET result_json='${encoded}' WHERE kind='task'`,
        );
        await assert.rejects(
          f.first.store.loadExtensionTurnReceipt({
            ...result.binding,
            receipt: proof.task,
          }),
          /plugin_task_unmetered_mode_conflict/,
        );
        await f.sql(
          `UPDATE ${f.prefix}extension_mutation_receipts SET result_json='${JSON.stringify(saved).replaceAll("'", "''")}' WHERE kind='task'`,
        );
        await f.sql(
          backend === "sqlite"
            ? "DROP TRIGGER plugin_task_unmetered_no_delete; DELETE FROM plugin_task_unmetered_admissions;"
            : `DROP TRIGGER plugin_task_unmetered_no_update ON ${f.prefix}plugin_task_unmetered_admissions; DELETE FROM ${f.prefix}plugin_task_unmetered_admissions;`,
        );
        await assert.rejects(
          f.first.store.loadExtensionTurnReceipt({
            ...result.binding,
            receipt: proof.task,
          }),
          /plugin_task_unmetered_link_mismatch/,
        );
        assert.deepEqual(await f.creditObjects(), []);
      });
      test("final host withdrawal after the physical companion INSERT rolls back the original transaction", async (t) => {
        const f = await unmeteredFixture(t, backend);
        const restore = observeUnmeteredInsert(backend, () => {
          f.authorityState.live = false;
        });
        try {
          await assert.rejects(f.generate(), (error) => {
            let cause: unknown = error;
            for (let depth = 0; depth < 8 && cause instanceof Error; depth++) {
              if (cause.message === "test_unmetered_withdrawn") return true;
              cause = cause.cause;
            }
            return false;
          });
        } finally {
          restore();
        }
        for (const table of [
          "run_snapshots",
          "messages",
          "model_history_items",
          "extension_run_bindings",
          "plugin_task_admissions",
          "plugin_task_unmetered_admissions",
          "creative_project_generation_links",
        ])
          assert.equal(await f.count(table), 0, table);
        assert.deepEqual(await f.creditObjects(), []);
      });
      test("concurrent exact user intent replays one original Run/proof without switching mode", async (t) => {
        const f = await unmeteredFixture(t, backend);
        const results = await Promise.all([
          f.generate(),
          f
            .create(f.second.store, f.second.parent)
            .createProjectTaskFromPlugin(
              f.actor,
              f.command(),
              f.pin,
              f.reference,
              f.projectAuthority,
            ),
        ]);
        assert.deepEqual(results.map((value) => value.run.disposition).sort(), [
          "committed",
          "replayed",
        ]);
        assert.deepEqual(
          results[0]!.unmeteredAdmission,
          results[1]!.unmeteredAdmission,
        );
        assert.equal(await f.count("run_snapshots"), 1);
        assert.equal(await f.count("plugin_task_unmetered_admissions"), 1);
        assert.deepEqual(await f.creditObjects(), []);
      });
      test("partial, view and unknown-version opt-in schema are rejected without repairing them", async (t) => {
        const f = await unmeteredFixture(t, backend, { optIn: false });
        await f.sql(
          `CREATE TABLE ${f.prefix}plugin_task_unmetered_schema_version(id INTEGER PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO ${f.prefix}plugin_task_unmetered_schema_version VALUES(1,1)`,
        );
        await assert.rejects(
          f.first.store.migrateUnmeteredPluginAdmissions(),
          /plugin_task_unmetered_schema_invalid/,
        );
        await f.sql(
          `CREATE VIEW ${f.prefix}plugin_task_unmetered_admissions AS SELECT 'no' AS admission_json`,
        );
        await assert.rejects(
          f.first.store.migrateUnmeteredPluginAdmissions(),
          /plugin_task_unmetered_schema_invalid/,
        );
        await f.sql(
          `DROP VIEW ${f.prefix}plugin_task_unmetered_admissions; DROP TABLE ${f.prefix}plugin_task_unmetered_schema_version`,
        );
        await f.first.store.migrateUnmeteredPluginAdmissions();
        await f.sql(
          `UPDATE ${f.prefix}plugin_task_unmetered_schema_version SET version=99`,
        );
        await assert.rejects(
          f.first.store.migrateUnmeteredPluginAdmissions(),
          /plugin_task_unmetered_schema_unsupported/,
        );
        assert.deepEqual(await f.creditObjects(), []);
      });
      test("missing unmetered evidence cannot turn a new installed operation dispatch into a legacy operation", async (t) => {
        const f = await unmeteredFixture(t, backend);
        const result = await f.generate();
        await startExternalOperationFixtureRun(f.first.parent, result.binding);
        const raw = (
          await f.rows(
            `SELECT result_json FROM ${f.prefix}extension_mutation_receipts WHERE kind='task'`,
          )
        )[0]!.result_json;
        const saved = typeof raw === "string" ? JSON.parse(raw) : raw;
        delete saved.unmeteredAdmission;
        await f.sql(
          `UPDATE ${f.prefix}extension_mutation_receipts SET result_json='${JSON.stringify(saved).replaceAll("'", "''")}' WHERE kind='task'`,
        );
        await assert.rejects(
          f.operations.reserveExternalOperation({
            tenantId: f.actor.tenantId,
            runId: result.binding.runId,
            bindingDigest: result.binding.bindingDigest,
            operationId: randomUUID(),
            correlationId: randomUUID(),
            executionId: "no-free-fallback",
            idempotencyKey: "no-free-fallback",
            actionDigest: digest,
            requestDigest: digest,
            createdAt: timestamp,
          }),
          /plugin_task_credit_admission_required/,
        );
        assert.equal(await f.count("extension_external_operations"), 0);
        assert.deepEqual(await f.creditObjects(), []);
      });
      test("generation operation, explicit query, result selection and reopened history retain the original unmetered mode", async (t) => {
        const f = await unmeteredFixture(t, backend);
        const generation = await f.generate();
        await startExternalOperationFixtureRun(
          f.first.parent,
          generation.binding,
        );
        const operationId = randomUUID();
        const reserved = await f.operations.reserveExternalOperation({
          tenantId: f.actor.tenantId,
          runId: generation.binding.runId,
          bindingDigest: generation.binding.bindingDigest,
          operationId,
          correlationId: randomUUID(),
          executionId: "unmetered-test-worker",
          idempotencyKey: "unmetered-op",
          actionDigest: digest,
          requestDigest: digest,
          createdAt: timestamp,
        });
        const operation = (
          await f.operations.advanceExternalOperation({
            ...reserved.operation,
            expectedRevision: reserved.operation.revision,
            status: "succeeded",
            providerOperationId: "named-test-provider-receipt",
            resultJson: extensionCanonicalJson({
              images: [
                {
                  filename: "image.png",
                  url: "https://provider.example/image.png",
                },
              ],
            }),
            updatedAt: timestamp,
          })
        ).operation;
        const queryThread = "unmetered-explicit-query";
        await seedThread(f.first.parent, { ...f.actor, threadId: queryThread });
        const queryHost = {
          async resolveRegistration() {
            return f.dependencies.catalog.resolve({
              pluginId: f.pin.pluginId,
              pluginVersion: f.pin.version,
            });
          },
          async evaluate() {
            return {
              outcome: "ready" as const,
              target: generation.binding.target,
            };
          },
        };
        const query = await f
          .create(f.first.store, f.first.parent, f.unmeteredTasks, queryHost)
          .createQueryTaskFromPlugin(
            f.actor,
            {
              pluginId: f.pin.pluginId,
              threadId: queryThread,
              expectedThreadRevision: 1,
              idempotencyKey: "query-user-intent",
              intent: {
                kind: "query",
                sourceRunId: generation.binding.runId,
                operationId,
              },
            },
            { ...f.pin, action: "image.query" },
          );
        assert.equal(query.creditAdmission, undefined);
        assert.equal(query.unmeteredAdmission, undefined);
        assert.equal(f.authorityState.prepared, 1);
        const selection = f.first.parent.projectConceptSelectionStore({
          verifier: selectionVerifier,
        });
        await selection.migrateConceptSelections();
        const selected = await selection.commitConceptImageSelection(
          {
            actor: f.actor,
            reference: f.reference,
            operationId,
            expectedOperationRevision: operation.revision,
            resultIndex: 0,
            expectedSelectionRevision: 0,
            receipt: {
              idempotencyKey: "unmetered-select",
              requestDigest: digester.sha256("unmetered-select"),
            },
            at: timestamp,
          },
          {
            authority: f.projectAuthority,
            source: { kind: "authenticated-project-command" },
          },
        );
        assert.equal(selected.resultLink.image.filename, "image.png");
        const cold = await f.open();
        const restored = await f.reads(cold.store, cold.parent);
        assert.equal(
          (
            await restored.getConceptGeneration(f.actor, {
              projectId: f.reference.projectId,
              assetId: f.reference.assetId,
              assetRevision: f.reference.assetRevision,
            })
          )?.task.operations[0]?.operationId,
          operationId,
        );
        const coldSelection = cold.parent.projectConceptSelectionStore({
          verifier: selectionVerifier,
        });
        await coldSelection.enableConceptSelectionReads();
        assert.deepEqual(
          (
            await coldSelection.loadCurrentConceptSelection({
              owner: {
                tenantId: f.actor.tenantId,
                spaceId: f.actor.spaceId,
                principalId: f.actor.principalId,
              },
              projectId: f.reference.projectId,
              assetId: f.reference.assetId,
            })
          ).current?.resultLink,
          selected.resultLink,
        );
        assert.equal(await f.count("plugin_task_unmetered_admissions"), 1);
        assert.deepEqual(await f.creditObjects(), []);
      });
    },
  );
