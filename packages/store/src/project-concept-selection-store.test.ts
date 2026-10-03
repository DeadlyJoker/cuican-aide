import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  appendConceptAssetRevision,
  renameCreativeProject,
  setCreativeProjectState,
} from "@crewon/domain";
import {
  conceptSelectionFixture,
  selectionAuthority,
  selectionVerifier,
  observeSelectionSql,
} from "./project-concept-selection.test-support.ts";
import { receipt as projectReceipt } from "./creative-project-store.test-support.ts";
import { extensionStoreDigester as digester } from "./extension-store-records.ts";
for (const backend of ["sqlite", "postgres"] as const)
  describe(
    `${backend} independent concept image selection`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      test("defaults off, read-only preparation is independent and fresh selection persists without metadata/credits/tasks mutations", async (t) => {
        const f = await conceptSelectionFixture(t, backend, {
            prepared: false,
          }),
          store = f.selectionStore;
        assert.equal(store.projectConceptSelectionVersion, undefined);
        assert.equal(store.projectConceptSelectionReadVersion, undefined);
        await assert.rejects(
          store.commitConceptImageSelection(
            f.selectionInput,
            f.selectionCommitOptions,
          ),
          /not_enabled/,
        );
        await assert.rejects(store.enableConceptSelectionReads());
        await store.migrateConceptSelections();
        assert.deepEqual(
          await store.loadCurrentConceptSelection(f.selectionReadInput),
          { selectionRevision: 0, current: null },
        );
        const before = {
          counts: await f.counts(),
          account: await f.credits.getAccount(f.creditScope),
          project: await f.metadata.loadProject({
            owner: f.selectionReadInput.owner,
            projectId: f.selectionReadInput.projectId,
          }),
          asset: await f.metadata.loadConceptAsset(f.selectionReadInput),
        };
        const selected = await store.commitConceptImageSelection(
          f.selectionInput,
          f.selectionCommitOptions,
        );
        assert.equal(selected.disposition, "committed");
        assert.equal(selected.pointer.selectionRevision, 1);
        assert.equal(selected.resultLink.image.filename, "original-0.png");
        assert.equal(selected.resultLink.sourceRunId, f.link.binding.runId);
        const current = await store.loadCurrentConceptSelection(
          f.selectionReadInput,
        );
        assert.deepEqual(current.current, {
          pointer: selected.pointer,
          resultLink: selected.resultLink,
        });
        assert.deepEqual(
          {
            counts: await f.counts(),
            account: await f.credits.getAccount(f.creditScope),
            project: await f.metadata.loadProject({
              owner: f.selectionReadInput.owner,
              projectId: f.selectionReadInput.projectId,
            }),
            asset: await f.metadata.loadConceptAsset(f.selectionReadInput),
          },
          before,
        );
        const cold = f.second.parent.projectConceptSelectionStore({
          verifier: selectionVerifier,
        });
        await cold.enableConceptSelectionReads();
        assert.equal(cold.projectConceptSelectionVersion, undefined);
        assert.deepEqual(
          await cold.loadCurrentConceptSelection(f.selectionReadInput),
          current,
        );
        await assert.rejects(
          cold.commitConceptImageSelection(
            f.selectionInput,
            f.selectionCommitOptions,
          ),
          /not_enabled/,
        );
      });
      test("second image UPDATE increments independent CAS and old receipt replay never rolls pointer back", async (t) => {
        const f = await conceptSelectionFixture(t, backend),
          store = f.selectionStore;
        const first = await store.commitConceptImageSelection(
          f.selectionInput,
          f.selectionCommitOptions,
        );
        const second = await store.commitConceptImageSelection(
          { ...f.secondSelectionInput, at: "2026-09-29T00:00:00.000Z" },
          f.selectionCommitOptions,
        );
        assert.equal(second.pointer.selectionRevision, 2);
        assert.equal(second.resultLink.image.resultIndex, 1);
        assert.equal(second.pointer.selectedAt, "2026-09-29T00:00:00.000Z");
        const replay = await store.commitConceptImageSelection(
          { ...f.selectionInput, at: "2026-10-04T00:00:00.000Z" },
          f.selectionCommitOptions,
        );
        assert.deepEqual(replay, { ...first, disposition: "replayed" });
        assert.deepEqual(
          await store.loadCurrentConceptSelection(f.selectionReadInput),
          {
            selectionRevision: 2,
            current: { pointer: second.pointer, resultLink: second.resultLink },
          },
        );
        await assert.rejects(
          store.commitConceptImageSelection(
            { ...f.selectionInput, resultIndex: 1 },
            f.selectionCommitOptions,
          ),
          /receipt_conflict/,
        );
        await assert.rejects(
          store.commitConceptImageSelection(
            {
              ...f.secondSelectionInput,
              receipt: {
                idempotencyKey: "stale-cas",
                requestDigest: digester.sha256("stale-cas"),
              },
            },
            f.selectionCommitOptions,
          ),
          /revision_conflict/,
        );
        assert.equal(await f.count("creative_concept_selection_receipts"), 2);
        assert.equal(await f.count("creative_operation_result_links"), 2);
      });
      test("authenticated command is explicit and cannot silently substitute a missing plugin publication", async (t) => {
        const f = await conceptSelectionFixture(t, backend);
        const options = {
          authority: selectionAuthority,
          source: { kind: "authenticated-project-command" as const },
        };
        const saved = await f.selectionStore.commitConceptImageSelection(
          f.selectionInput,
          options,
        );
        assert.equal(saved.pointer.selectionRevision, 1);
        for (const source of [
          { kind: "installed-plugin-ui" },
          { kind: "unknown" },
          {
            kind: "authenticated-project-command",
            publication: f.selectionCommitOptions.source.publication,
          },
          undefined,
        ])
          await assert.rejects(
            f.selectionStore.commitConceptImageSelection(
              f.secondSelectionInput,
              { authority: selectionAuthority, source } as typeof options,
            ),
          );
        await assert.rejects(
          f.selectionStore.commitConceptImageSelection(
            f.selectionInput,
            f.selectionCommitOptions,
          ),
          /receipt_conflict/,
        );
      });
      test("fresh source project/asset CAS and exact operation revision/index are checked; malformed verifier cannot publish", async (t) => {
        const f = await conceptSelectionFixture(t, backend);
        for (const patch of [
          {
            reference: {
              ...f.reference,
              expectedProjectRevision: f.reference.expectedProjectRevision + 1,
            },
          },
          { reference: { ...f.reference, expectedAssetMetadataRevision: 2 } },
          { operationId: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
          { expectedOperationRevision: 3 },
          { resultIndex: 2 },
          { expectedSelectionRevision: 1 },
          { actor: { ...f.actor, principalId: "someone-else" } },
        ])
          await assert.rejects(
            f.selectionStore.commitConceptImageSelection(
              { ...f.selectionInput, ...patch },
              f.selectionCommitOptions,
            ),
          );
        assert.equal(await f.count("creative_concept_selection_receipts"), 0);
        assert.equal(await f.count("creative_operation_result_links"), 0);
        const malformed = f.first.parent.projectConceptSelectionStore({
          verifier: {
            verifyImage() {
              return Promise.resolve({}) as never;
            },
          },
        });
        await malformed.migrateConceptSelections();
        await assert.rejects(
          malformed.commitConceptImageSelection(
            f.selectionInput,
            f.selectionCommitOptions,
          ),
          /image_result_invalid/,
        );
      });
      test("rename/new input permits historical exact image with current source CAS; archived source only replays", async (t) => {
        const f = await conceptSelectionFixture(t, backend),
          store = f.selectionStore;
        const first = await store.commitConceptImageSelection(
          f.selectionInput,
          f.selectionCommitOptions,
        );
        const project = await f.metadata.loadProject({
          owner: f.selectionReadInput.owner,
          projectId: f.selectionReadInput.projectId,
        });
        assert.ok(project);
        const brief = await f.metadata.loadBrief({
          owner: f.selectionReadInput.owner,
          projectId: f.selectionReadInput.projectId,
          briefRevision: 1,
        });
        assert.ok(brief);
        const asset = await f.metadata.loadConceptAsset(f.selectionReadInput);
        assert.ok(asset);
        const appended = appendConceptAssetRevision(
          {
            project,
            asset,
            actor: f.actor,
            expectedProjectRevision: project.revision,
            expectedAssetMetadataRevision: asset.revision,
            brief,
            prompt: "A new input",
            at: f.selectionInput.at,
          },
          digester,
        );
        const current = await f.metadata.commitConceptRevision({
          kind: "append-concept",
          actor: f.actor,
          receipt: projectReceipt("selection-new-input"),
          expectedProjectRevision: project.revision,
          expectedAssetMetadataRevision: asset.revision,
          ...appended,
        });
        const historical = {
          ...f.secondSelectionInput,
          reference: {
            ...f.reference,
            expectedProjectRevision: current.project.revision,
            expectedAssetMetadataRevision: current.asset.revision,
          },
        };
        const second = await store.commitConceptImageSelection(
          historical,
          f.selectionCommitOptions,
        );
        assert.equal(second.resultLink.reference.assetRevision, 1);
        const archived = setCreativeProjectState({
          project: current.project,
          actor: f.actor,
          expectedProjectRevision: current.project.revision,
          state: "archived",
          at: f.selectionInput.at,
        });
        await f.metadata.commitProjectMetadata({
          kind: "set-project-state",
          actor: f.actor,
          receipt: projectReceipt("selection-archive"),
          expectedProjectRevision: current.project.revision,
          project: archived,
        });
        assert.deepEqual(
          await store.commitConceptImageSelection(
            f.selectionInput,
            f.selectionCommitOptions,
          ),
          { ...first, disposition: "replayed" },
        );
        assert.equal(
          (await store.loadCurrentConceptSelection(f.selectionReadInput))
            .selectionRevision,
          2,
        );
        await assert.rejects(
          store.commitConceptImageSelection(
            {
              ...historical,
              expectedSelectionRevision: 2,
              receipt: {
                idempotencyKey: "archived-write",
                requestDigest: digester.sha256("archived-write"),
              },
              reference: {
                ...historical.reference,
                expectedProjectRevision: archived.revision,
              },
            },
            f.selectionCommitOptions,
          ),
          /archived/,
        );
      });
      test("disabled current UI fails even replay; disabled execution allows history and revoked execution denies", async (t) => {
        const f = await conceptSelectionFixture(t, backend);
        await f.selectionStore.commitConceptImageSelection(
          f.selectionInput,
          f.selectionCommitOptions,
        );
        const activation = await f.first.store.loadExtensionActivation(
          f.link.binding,
        );
        assert.ok(activation);
        await f.first.store.saveExtensionActivation({
          activation: { ...activation, revision: 2, state: "disabled" },
          expectedRevision: 1,
          receipt: {
            actorId: f.actor.actorId,
            idempotencyKey: "disable-execution",
            requestDigest: digester.sha256("disable-execution"),
          },
        });
        assert.equal(
          (
            await f.selectionStore.commitConceptImageSelection(
              f.selectionInput,
              f.selectionCommitOptions,
            )
          ).disposition,
          "replayed",
        );
        await f.first.store.saveExtensionActivation({
          activation: { ...activation, revision: 3, state: "revoked" },
          expectedRevision: 2,
          receipt: {
            actorId: f.actor.actorId,
            idempotencyKey: "revoke-execution",
            requestDigest: digester.sha256("revoke-execution"),
          },
        });
        await assert.rejects(
          f.selectionStore.commitConceptImageSelection(
            f.selectionInput,
            f.selectionCommitOptions,
          ),
          /revoked/,
        );
        await f.selection("source", "disabled");
        await assert.rejects(
          f.selectionStore.commitConceptImageSelection(
            f.selectionInput,
            f.selectionCommitOptions,
          ),
          /pin_conflict/,
        );
      });
      test("same transaction rolls all selection writes back after receipt failure and final synchronous policy fence", async (t) => {
        const state = { active: true };
        const f = await conceptSelectionFixture(t, backend, {
          verifier: {
            verifyImage(input) {
              const image = selectionVerifier.verifyImage(input);
              state.active = false;
              return image;
            },
          },
        });
        await assert.rejects(
          f.selectionStore.commitConceptImageSelection(f.selectionInput, {
            ...f.selectionCommitOptions,
            authority: {
              assertCurrent: async () => {},
              assertActive() {
                if (!state.active) throw new Error("selection_final_denied");
              },
            },
          }),
          /selection_final_denied/,
        );
        for (const table of [
          "creative_concept_selection_receipts",
          "creative_operation_result_links",
          "creative_current_concept_selections",
        ])
          assert.equal(await f.count(table), 0);
        const store = f.first.parent.projectConceptSelectionStore({
          verifier: selectionVerifier,
        });
        await store.migrateConceptSelections();
        const restore = observeSelectionSql(backend, "receipt", () => {
          throw new Error("selection_receipt_failure");
        });
        try {
          await assert.rejects(
            store.commitConceptImageSelection(
              f.selectionInput,
              f.selectionCommitOptions,
            ),
            /selection_receipt_failure/,
          );
        } finally {
          restore();
        }
        for (const table of [
          "creative_concept_selection_receipts",
          "creative_operation_result_links",
          "creative_current_concept_selections",
        ])
          assert.equal(await f.count(table), 0);
      });
      test("unknown and partial schema fail closed and persisted result/pointer records resist mutation", async (t) => {
        const f = await conceptSelectionFixture(t, backend);
        await f.selectionStore.commitConceptImageSelection(
          f.selectionInput,
          f.selectionCommitOptions,
        );
        await assert.rejects(
          f.sql(
            `UPDATE ${f.prefix}creative_operation_result_links SET record_json=record_json`,
          ),
          /immutable/,
        );
        await assert.rejects(
          f.sql(`DELETE FROM ${f.prefix}creative_concept_selection_receipts`),
          /immutable/,
        );
        await assert.rejects(
          f.sql(
            `UPDATE ${f.prefix}creative_current_concept_selections SET selection_revision=selection_revision`,
          ),
          /immutable/,
        );
        await f.sql(
          `UPDATE ${f.prefix}concept_selection_schema_version SET version=9`,
        );
        await assert.rejects(
          f.selectionStore.loadCurrentConceptSelection(f.selectionReadInput),
          /version_unsupported/,
        );
        const cold = f.second.parent.projectConceptSelectionStore({
          verifier: selectionVerifier,
        });
        await assert.rejects(
          cold.migrateConceptSelections(),
          /version_unsupported/,
        );
        assert.equal(cold.projectConceptSelectionVersion, undefined);
      });
    },
  );
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend} final local withdrawal after actual result INSERT rolls back; acknowledged COMMIT remains sticky`,
    options,
    async (t) => {
      const f = await conceptSelectionFixture(t, backend);
      let active = true;
      const authority = {
        assertCurrent: async () => {},
        assertActive() {
          if (!active) throw new Error("selection_owner_closed");
        },
      };
      let restore = observeSelectionSql(
        backend,
        "link",
        () => (active = false),
      );
      try {
        await assert.rejects(
          f.selectionStore.commitConceptImageSelection(f.selectionInput, {
            ...f.selectionCommitOptions,
            authority,
          }),
          /selection_owner_closed/,
        );
      } finally {
        restore();
      }
      assert.equal(await f.count("creative_operation_result_links"), 0);
      assert.equal(await f.count("creative_current_concept_selections"), 0);
      assert.equal(await f.count("creative_concept_selection_receipts"), 0);
      active = true;
      restore = observeSelectionSql(backend, "commit", () => (active = false));
      try {
        const result = await f.selectionStore.commitConceptImageSelection(
          f.selectionInput,
          { ...f.selectionCommitOptions, authority },
        );
        assert.equal(result.disposition, "committed");
      } finally {
        restore();
      }
      assert.equal(active, false);
      assert.equal(await f.count("creative_concept_selection_receipts"), 1);
    },
  );
  for (const corrupt of [
    "paid-link",
    "credit-admission",
    "plugin-admission",
    "original-receipt",
    "exact-operation",
    "historical-config",
  ] as const)
    test(
      `${backend} actual corrupted ${corrupt} proof refuses fresh/replay without extra selection writes`,
      options,
      async (t) => {
        const f = await conceptSelectionFixture(t, backend);
        await f.selectionStore.commitConceptImageSelection(
          f.selectionInput,
          f.selectionCommitOptions,
        );
        const pg = backend === "postgres";
        if (pg) await f.sql("SET session_replication_role=replica");
        else await f.sql("PRAGMA foreign_keys=OFF;");
        try {
          if (corrupt === "paid-link") {
            if (!pg) await f.sql("DROP TRIGGER project_generation_no_update;");
            await f.sql(
              `UPDATE ${f.prefix}creative_project_generation_links SET content_digest='sha256:${"a".repeat(64)}',record_json=${pg ? "jsonb_set(record_json,'{contentDigest}','\"sha256:" + "a".repeat(64) + "\"'::jsonb)" : "json_set(record_json,'$.contentDigest','sha256:" + "a".repeat(64) + "')"}`,
            );
          } else if (corrupt === "credit-admission") {
            if (!pg)
              await f.sql(
                "DROP TRIGGER extension_credit_admissions_no_update;",
              );
            await f.sql(
              `UPDATE ${f.prefix}extension_credit_admissions SET principal_id='other-principal'`,
            );
          } else if (corrupt === "plugin-admission") {
            if (!pg)
              await f.sql("DROP TRIGGER plugin_task_admissions_no_update;");
            await f.sql(
              `UPDATE ${f.prefix}plugin_task_admissions SET principal_id='other-principal',admission_json=${pg ? "jsonb_set(admission_json,'{principalId}','\"other-principal\"'::jsonb)" : "json_set(admission_json,'$.principalId','other-principal')"}`,
            );
          } else if (corrupt === "original-receipt")
            await f.sql(
              `UPDATE ${f.prefix}extension_mutation_receipts SET request_digest='sha256:${"b".repeat(64)}' WHERE kind='task'`,
            );
          else if (corrupt === "exact-operation")
            await f.sql(
              `UPDATE ${f.prefix}extension_external_operations SET revision=revision+1`,
            );
          else {
            if (!pg)
              await f.sql(
                "DROP TRIGGER IF EXISTS extension_configuration_no_update;",
              );
            await f.sql(
              `UPDATE ${f.prefix}extension_configurations SET configuration_json='{}'`,
            );
          }
        } finally {
          if (pg) await f.sql("SET session_replication_role=origin");
          else await f.sql("PRAGMA foreign_keys=ON;");
        }
        await assert.rejects(
          f.selectionStore.commitConceptImageSelection(
            f.selectionInput,
            f.selectionCommitOptions,
          ),
        );
        await assert.rejects(
          f.selectionStore.commitConceptImageSelection(
            f.secondSelectionInput,
            f.selectionCommitOptions,
          ),
        );
        assert.equal(await f.count("creative_current_concept_selections"), 1);
        assert.equal(await f.count("creative_concept_selection_receipts"), 1);
        assert.equal(await f.count("creative_operation_result_links"), 1);
      },
    );
  for (const table of [
    "concept_selection_schema_version",
    "creative_operation_result_links",
    "creative_current_concept_selections",
    "creative_concept_selection_receipts",
  ])
    test(
      `${backend} partial selection schema ${table} is refused without repair`,
      options,
      async (t) => {
        const f = await conceptSelectionFixture(t, backend, {
          prepared: false,
        });
        await f.sql(`CREATE TABLE ${f.prefix}${table}(id INTEGER)`);
        await assert.rejects(
          f.selectionStore.migrateConceptSelections(),
          /schema_incomplete/,
        );
        assert.equal(
          f.selectionStore.projectConceptSelectionVersion,
          undefined,
        );
        assert.equal(
          f.selectionStore.projectConceptSelectionReadVersion,
          undefined,
        );
      },
    );
}
