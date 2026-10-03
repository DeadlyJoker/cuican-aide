import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import {
  ApplicationError,
  CreativeProjectApplicationService,
  ExtensionReadApplicationService,
  ProjectConceptSelectionApplicationService,
  ProjectGenerationReadApplicationService,
  type CreativeProjectStore,
} from "@crewon/application";
import {
  appendConceptAssetRevision,
  setCreativeProjectState,
} from "@crewon/domain";
import { receipt as projectReceipt } from "./creative-project-store.test-support.ts";
import {
  conceptSelectionFixture,
  selectionVerifier,
  observeSelectionSql,
} from "./project-concept-selection.test-support.ts";
import { extensionStoreDigester as digester } from "./extension-store-records.ts";
import { timestamp } from "./extension-store.test-support.ts";

async function applicationFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await conceptSelectionFixture(t, backend);
  await f.first.store.enableProjectGenerationReads();
  const state = {
    denied: null as string | null,
    alive: true,
    insideTransaction: false,
    transactionChecks: 0,
    reads: 0,
  };
  const projectAuthorization = {
    async authorize(input: { action: string }) {
      return state.denied === input.action
        ? { outcome: "deny" as const, reasonCode: "selection-test-denied" }
        : { outcome: "allow" as const };
    },
  };
  const authorization = { authorize: projectAuthorization.authorize };
  const checkedRead = <T extends (...args: never[]) => Promise<unknown>>(
    receiver: object,
    fn: T,
  ): T =>
    ((...args: never[]) => {
      assert.equal(
        state.insideTransaction,
        false,
        "transaction authority must not acquire another SQL connection",
      );
      state.reads++;
      return Reflect.apply(fn, receiver, args);
    }) as T;
  const projectStore = {
    ...f.metadata,
    loadProject: checkedRead(f.metadata, f.metadata.loadProject),
    loadConceptAsset: checkedRead(f.metadata, f.metadata.loadConceptAsset),
    loadConceptRevision: checkedRead(
      f.metadata,
      f.metadata.loadConceptRevision,
    ),
    loadBrief: checkedRead(f.metadata, f.metadata.loadBrief),
  };
  // Class prototype methods are not spread; the four read ports above are the selection service's complete usage.
  const projects = new CreativeProjectApplicationService({
    store: f.metadata,
    authorization: projectAuthorization,
    clock: { now: () => timestamp },
    ids: {
      nextId: () => assert.fail("selection must not create project identity"),
    },
    digester,
  });
  const tasks = new ExtensionReadApplicationService({
    runs: f.first.parent,
    agentVersions: f.first.parent,
    extensions: f.first.store,
    operations: f.operations,
    catalog: {
      list: () => assert.fail("no implementation catalog"),
      resolve: () => assert.fail("no execution resolution"),
    },
    host: {
      validateConfiguration: async () => assert.fail("no supplier validation"),
      evaluate: async () => assert.fail("no execution preparation"),
    },
    authorization,
    digester,
  });
  const generationReads = new ProjectGenerationReadApplicationService({
    projects,
    tasks,
    extensions: f.first.store,
    digester,
  });
  const authority = {
    async assertCurrent() {
      if (!state.alive)
        throw new ApplicationError(
          "authorization",
          "selection-test-owner-withdrawn",
        );
    },
    async assertTransactionCurrent() {
      state.transactionChecks++;
      if (!state.alive)
        throw new ApplicationError(
          "authorization",
          "selection-test-owner-withdrawn",
        );
    },
    assertActive() {
      if (!state.alive)
        throw new ApplicationError(
          "authorization",
          "selection-test-owner-withdrawn",
        );
    },
  };
  const selectionStore = {
    projectConceptSelectionReadVersion:
      f.selectionStore.projectConceptSelectionReadVersion,
    projectConceptSelectionVersion:
      f.selectionStore.projectConceptSelectionVersion,
    loadConceptSelectionReceipt:
      f.selectionStore.loadConceptSelectionReceipt.bind(f.selectionStore),
    loadCurrentConceptSelection:
      f.selectionStore.loadCurrentConceptSelection.bind(f.selectionStore),
    async commitConceptImageSelection(
      input: Parameters<typeof f.selectionStore.commitConceptImageSelection>[0],
      options: Parameters<
        typeof f.selectionStore.commitConceptImageSelection
      >[1],
    ) {
      // Wrap only the callback inside the actual transaction; the actual SQL adapter still owns every lock and COMMIT.
      return f.selectionStore.commitConceptImageSelection(input, {
        ...options,
        authority: {
          async assertCurrent() {
            state.insideTransaction = true;
            try {
              await options.authority.assertCurrent();
            } finally {
              state.insideTransaction = false;
            }
          },
          assertActive: options.authority.assertActive,
        },
      });
    },
  };
  const service = new ProjectConceptSelectionApplicationService({
    projects: {
      store: projectStore as CreativeProjectStore,
      authorization: projectAuthorization,
    },
    generationReads,
    extensions: f.first.store,
    operations: f.operations,
    selections: selectionStore,
    authorization,
    verifier: selectionVerifier,
    clock: { now: () => timestamp },
    digester,
  });
  const command = {
    reference: f.reference,
    operationId: f.operation.operationId,
    expectedOperationRevision: f.operation.revision,
    resultIndex: 1,
    expectedSelectionRevision: 0,
    idempotencyKey: "app-exact-image-selection",
  };
  const query = {
    projectId: f.reference.projectId,
    assetId: f.reference.assetId,
  };
  const httpOptions = {
    authority,
    source: { kind: "authenticated-project-command" as const },
  };
  const uiOptions = { authority, source: f.selectionCommitOptions.source };
  return { ...f, state, service, command, query, httpOptions, uiOptions };
}

async function noExecutionSnapshot(
  f: Awaited<ReturnType<typeof applicationFixture>>,
) {
  const tables = [
    "messages",
    "model_history_items",
    "run_snapshots",
    "extension_run_bindings",
    "plugin_task_admissions",
    "extension_credit_admissions",
    "plugin_credit_reservations",
    "plugin_credit_entries",
    "extension_external_operations",
    "creative_project_generation_links",
    "outbox",
    "work_items",
  ];
  return {
    rows: Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [table, await f.count(table)]),
      ),
    ),
    credit: await f.credits.getAccount(f.creditScope),
    project: await f.metadata.loadProject({
      owner: f.selectionReadInput.owner,
      projectId: f.query.projectId,
    }),
    asset: await f.metadata.loadConceptAsset(f.selectionReadInput),
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe(
    `${backend} actual Application concept selection`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      test(
        "HTTP then actual installed origin select exact images with zero new execution or metadata writes",
        { timeout: 20_000 },
        async (t) => {
          const f = await applicationFixture(t, backend);
          const before = await noExecutionSnapshot(f);
          assert.deepEqual(
            await f.service.getConceptSelection(f.actor, f.query),
            { selectionRevision: 0, current: null },
          );
          const first = await f.service.selectConceptImage(
            f.actor,
            f.command,
            f.httpOptions,
          );
          assert.equal(first.resultLink.image.filename, "original-1.png");
          assert.equal(first.resultLink.image.resultIndex, 1);
          const second = await f.service.selectConceptImage(
            f.actor,
            { ...f.command, resultIndex: 0, expectedSelectionRevision: 1 },
            f.uiOptions,
          );
          assert.equal(second.pointer.selectionRevision, 2);
          const current = await f.service.getConceptSelection(f.actor, f.query);
          assert.equal(
            current.current?.resultLink.image.filename,
            "original-0.png",
          );
          assert.equal(current.current?.requiresConfirmation, false);
          assert.ok(f.state.transactionChecks >= 4);
          assert.deepEqual(await noExecutionSnapshot(f), before);
        },
      );

      test(
        "old key passes actual replay transaction after newer pointer, new input and archive",
        { timeout: 20_000 },
        async (t) => {
          const f = await applicationFixture(t, backend);
          const first = await f.service.selectConceptImage(
            f.actor,
            f.command,
            f.httpOptions,
          );
          const second = await f.service.selectConceptImage(
            f.actor,
            {
              ...f.command,
              resultIndex: 0,
              expectedSelectionRevision: 1,
              idempotencyKey: "app-new-image",
            },
            f.httpOptions,
          );
          const owner = f.selectionReadInput.owner;
          const project = (await f.metadata.loadProject({
            owner,
            projectId: f.query.projectId,
          }))!;
          const asset = (await f.metadata.loadConceptAsset({
            owner,
            ...f.query,
          }))!;
          const brief = (await f.metadata.loadBrief({
            owner,
            projectId: f.query.projectId,
            briefRevision: project.latestBriefRevision,
          }))!;
          const next = appendConceptAssetRevision(
            {
              project,
              asset,
              brief,
              actor: f.actor,
              expectedProjectRevision: project.revision,
              expectedAssetMetadataRevision: asset.revision,
              prompt: "Updated concept",
              at: timestamp,
            },
            digester,
          );
          await f.metadata.commitConceptRevision({
            kind: "append-concept",
            actor: f.actor,
            receipt: projectReceipt("app-selection-new-input"),
            expectedProjectRevision: project.revision,
            expectedAssetMetadataRevision: asset.revision,
            ...next,
          });
          const archived = setCreativeProjectState({
            project: next.project,
            actor: f.actor,
            expectedProjectRevision: next.project.revision,
            state: "archived",
            at: timestamp,
          });
          await f.metadata.commitProjectMetadata({
            kind: "set-project-state",
            actor: f.actor,
            receipt: projectReceipt("app-selection-archive"),
            expectedProjectRevision: next.project.revision,
            project: archived,
          });
          const checks = f.state.transactionChecks;
          const replay = await f.service.selectConceptImage(
            f.actor,
            f.command,
            f.httpOptions,
          );
          assert.equal(replay.disposition, "replayed");
          assert.deepEqual(replay.pointer, first.pointer);
          assert.ok(f.state.transactionChecks > checks);
          const current = await f.service.getConceptSelection(f.actor, f.query);
          assert.equal(
            current.current?.pointer.contentDigest,
            second.pointer.contentDigest,
          );
          assert.equal(current.current?.requiresConfirmation, true);
          assert.equal(await f.count("creative_concept_selection_receipts"), 2);
          assert.equal(await f.count("creative_operation_result_links"), 2);
        },
      );

      test(
        "actual COMMIT success keeps receipt when current owner and policy close immediately",
        { timeout: 20_000 },
        async (t) => {
          const f = await applicationFixture(t, backend);
          const restore = observeSelectionSql(backend, "commit", () => {
            f.state.alive = false;
            f.state.denied = "creativeProject:write";
          });
          try {
            const result = await f.service.selectConceptImage(
              f.actor,
              f.command,
              f.httpOptions,
            );
            assert.equal(result.disposition, "committed");
            assert.equal(result.resultLink.image.filename, "original-1.png");
          } finally {
            restore();
          }
          assert.equal(await f.count("creative_concept_selection_receipts"), 1);
        },
      );
    },
  );
}
