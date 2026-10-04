import assert from "node:assert/strict";
import { expect, it } from "vitest";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import {
  parseProjectGenerationUiActionResponse,
  parseProjectGenerationQueryUiActionResponse,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts/plugins";
import { nativeTaskProcessFixture } from "./desktopInstalledPluginRuntime.tasks.process.test-support.ts";
import {
  nativeProjectReceiptFacts,
  seedNativeProjectQuerySource,
} from "./desktopInstalledPluginRuntime.projects.process.test-support.ts";

const professionalDirectory =
  process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;
const kreaDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;
const projectUiDirectory =
  process.env.CREWON_TEST_SHORT_DRAMA_RECOVERY_DIRECTORY;
const enabled =
  professionalDirectory !== undefined &&
  kreaDirectory !== undefined &&
  projectUiDirectory !== undefined;
const generationAction =
  "crewon.project-generations.v1.generateConcept" as const;
const queryAction =
  "crewon.project-generation-queries.v1.queryConceptGeneration" as const;
const denied = (status: number, category?: string) => (error: unknown) =>
  error instanceof ControlApiClientError &&
  error.status === status &&
  (category === undefined || error.category === category);

/** Genuine source Supervisor/private Main/Worker/FileIssued/SQLite/HTTP flow.
 * The Worker never receives execution authority; the operation used for query is
 * an explicit stored fixture created only between physical process lifetimes.
 * This tests real epoch/receipt/recovery behavior, not supplier completion, live
 * funds, a renderer, or a complete short-drama product acceptance. */
it.runIf(enabled)(
  "actual Native project generation and query replay original receipts and journal hints across three fresh Source Supervisor epochs",
  async () => {
    const f = await nativeTaskProcessFixture(
      {
        professionalDirectory: professionalDirectory!,
        kreaDirectory: kreaDirectory!,
        projectUiDirectory: projectUiDirectory!,
      },
      { scenario: "project-recovery" },
    );
    let failure: unknown;
    try {
      const first = await f.start();
      assert.equal(
        first.bootstrap.schemaVersion,
        "crewon.desktop-plugin-bootstrap.v3",
      );
      assert.ok(first.task && f.projects);
      const installed = await first.client.plugins.installPackage(
        {
          sourceId: f.source.sourceId,
          expectedPluginId: f.source.pluginId,
          expectedPackageDigest: f.source.packageDigest,
          expectedSelectionRevision: null,
        },
        "named-native-epoch-install-short-drama9",
      );
      assert.equal(installed.selection.revision, 1);
      const enabledSource = await first.client.plugins.setSelection(
        f.source.pluginId,
        {
          selectedPackageDigest: f.source.packageDigest,
          state: "enabled",
          expectedSelectionRevision: 1,
        },
        "named-native-epoch-enable-short-drama9",
      );
      assert.equal(enabledSource.mutation.selection.revision, 2);
      const mount1 = await first.mount();
      const created = await first.client.creativeProjects.createProject(
        {
          title: "Named Native project epoch recovery",
          briefText:
            "Named saved brief; external API execution is outside this fixture.",
        },
        "named-native-epoch-create-project",
      );
      const concept = await first.client.creativeProjects.createConcept(
        created.project.projectId,
        {
          name: "Named concept",
          prompt:
            "Named saved concept prompt, recovered with its original revision.",
          briefRevision: created.brief.briefRevision,
          expectedProjectRevision: created.project.revision,
        },
        "named-native-epoch-create-concept",
      );
      const thread = (
        await first.client.createThread(
          {
            title: "Named Native generation thread",
          },
          "named-native-epoch-generation-thread",
        )
      ).thread;
      const reference = {
        projectId: concept.project.projectId,
        assetId: concept.asset.assetId,
        assetRevision: concept.assetRevision.assetRevision,
      };
      const generation = {
        action: generationAction,
        input: {
          reference: {
            ...reference,
            expectedProjectRevision: concept.project.revision,
            expectedAssetMetadataRevision: concept.asset.revision,
          },
          threadId: thread.threadId,
          expectedThreadRevision: thread.revision,
          idempotencyKey: "named-native-epoch-original-generation",
        },
      } as const;
      await first.client.plugins.stageRecovery(mount1.mountRef, generation);
      const before = f.effects(),
        walletBefore = f.wallet();
      f.state.responses.task = {
        outcome: "deny",
        reasonCode: "named-native-epoch-generation-denial",
      };
      await assert.rejects(
        first.client.plugins.invoke(mount1.mountRef, generation),
        denied(403, "authorization"),
      );
      assert.deepEqual(f.effects(), before);
      assert.deepEqual(f.wallet(), walletBefore);
      assert.equal(f.countQuotes(), 0);
      f.state.responses.task = { outcome: "allow" };
      const committedGeneration = parseProjectGenerationUiActionResponse(
        generation,
        (await first.client.plugins.invoke(mount1.mountRef, generation)).output,
      );
      assert.equal(committedGeneration.disposition, "committed");
      assert.equal(f.countQuotes(), 1);
      await f.waitWorkerExecutionDenied(committedGeneration.runId);
      f.assertNoSupplierExecution();
      await first.stop();

      // Explicit named query history; every original process is already joined.
      const source = await seedNativeProjectQuerySource({
        databasePath: f.databasePath,
        actor: f.actor,
        runId: committedGeneration.runId,
      });
      await f.metadata.allowNamedHistoricalQueryRead({
        pluginId: f.executionSource.pluginId,
        runId: committedGeneration.runId,
      });
      const { pluginId, publisherId, version, packageDigest } =
        f.executionSource;
      f.metadata.authority.allowNamedHistoricalQueryObservation({
        pluginId,
        publisherId,
        version,
        packageDigest,
      });
      const firstFacts = nativeProjectReceiptFacts(f.databasePath),
        firstWallet = f.wallet();
      const second = await f.start();
      assert.ok(second.task);
      assert.notEqual(second.session.sessionToken, first.session.sessionToken);
      assert.notEqual(second.session.csrfToken, first.session.csrfToken);
      assert.notEqual(
        second.bootstrap.authorityEpoch,
        first.bootstrap.authorityEpoch,
      );
      assert.notEqual(
        second.task.document.authorityEpoch,
        first.task.document.authorityEpoch,
      );
      assert.notEqual(
        second.task.document.activationDigest,
        first.task.document.activationDigest,
      );
      const oldClient = new ControlApiClient({
        baseUrl: second.session.baseUrl,
        origin: second.session.origin,
        accessToken: first.session.sessionToken,
        csrfToken: first.session.csrfToken,
      });
      await assert.rejects(
        oldClient.getExtensionTask(
          f.executionSource.pluginId,
          committedGeneration.runId,
        ),
        denied(401),
      );
      await assert.rejects(
        second.client.plugins.invoke(mount1.mountRef, generation),
        denied(404, "notFound"),
      );
      const mount2 = await second.mount();
      const restoredGeneration = (
        await second.client.plugins.getRecovery(mount2.mountRef)
      ).intents.find((intent) => intent.request.action === generationAction);
      assert.ok(restoredGeneration);
      assert.deepEqual(restoredGeneration.request, generation);
      assert.deepEqual(restoredGeneration.receipt, committedGeneration);
      f.state.responses.task = {
        outcome: "deny",
        reasonCode: "named-native-epoch-current-generation-denial",
      };
      await assert.rejects(
        second.client.plugins.invoke(mount2.mountRef, generation),
        denied(403, "authorization"),
      );
      f.state.responses.task = { outcome: "allow" };
      assert.deepEqual(
        parseProjectGenerationUiActionResponse(
          generation,
          (await second.client.plugins.invoke(mount2.mountRef, generation))
            .output,
        ),
        { ...committedGeneration, disposition: "replayed" },
      );
      assert.deepEqual(nativeProjectReceiptFacts(f.databasePath), firstFacts);
      assert.deepEqual(f.wallet(), firstWallet);
      assert.equal(f.countQuotes(), 1);

      const queryThread = (
        await second.client.createThread(
          {
            title: "Named Native query thread",
          },
          "named-native-epoch-query-thread",
        )
      ).thread;
      const query = {
        action: queryAction,
        input: {
          reference,
          operationId: source.operationId,
          threadId: queryThread.threadId,
          expectedThreadRevision: queryThread.revision,
          idempotencyKey: "named-native-epoch-original-query",
        },
      } as const;
      const selection: PluginUiRecoveryRequest = {
        action: "crewon.project-generation-selections.v1.selectConceptImage",
        input: {
          reference: generation.input.reference,
          operationId: source.operationId,
          expectedOperationRevision: 1,
          resultIndex: 0,
          expectedSelectionRevision: 0,
          idempotencyKey: "named-native-epoch-prepared-selection-only",
        },
      };
      await second.client.plugins.stageRecovery(mount2.mountRef, query);
      await second.client.plugins.stageRecovery(mount2.mountRef, selection);
      const beforeQuery = f.effects(),
        walletBeforeQuery = f.wallet();
      const committedQuery = parseProjectGenerationQueryUiActionResponse(
        query,
        (await second.client.plugins.invoke(mount2.mountRef, query)).output,
      );
      assert.equal(committedQuery.disposition, "committed");
      assert.equal(f.effects().run_snapshots, beforeQuery.run_snapshots + 1);
      for (const table of [
        "plugin_task_admissions",
        "extension_credit_admissions",
        "plugin_credit_reservations",
        "plugin_credit_entries",
      ] as const)
        assert.equal(f.effects()[table], beforeQuery[table], table);
      assert.deepEqual(f.wallet(), walletBeforeQuery);
      assert.equal(f.countQuotes(), 1);
      await f.waitWorkerExecutionDenied(committedQuery.runId);
      const queryRun = (await second.client.getRun(committedQuery.runId)).run;
      await second.client.cancelRun(
        committedQuery.runId,
        { expectedRevision: queryRun.revision },
        "named-native-epoch-explicit-query-cancel-after-worker-denial",
      );
      await f.waitTaskStable(second, committedQuery.runId);
      const hints2 = await second.client.plugins.getRecovery(mount2.mountRef);
      assert.equal(hints2.intents.length, 3);
      const facts2 = nativeProjectReceiptFacts(f.databasePath),
        wallet2 = f.wallet();
      f.assertNoSupplierExecution();
      await second.stop();

      const third = await f.start();
      assert.ok(third.task);
      assert.notEqual(
        third.bootstrap.authorityEpoch,
        second.bootstrap.authorityEpoch,
      );
      assert.notEqual(
        third.task.document.authorityEpoch,
        second.task.document.authorityEpoch,
      );
      assert.notEqual(third.session.sessionToken, second.session.sessionToken);
      const mount3 = await third.mount();
      const hints3 = await third.client.plugins.getRecovery(mount3.mountRef);
      assert.deepEqual(
        hints3.intents.map((intent) => ({
          request: intent.request,
          receipt: intent.receipt,
        })),
        hints2.intents.map((intent) => ({
          request: intent.request,
          receipt: intent.receipt,
        })),
      );
      assert.deepEqual(nativeProjectReceiptFacts(f.databasePath), facts2);
      f.state.responses.task = {
        outcome: "deny",
        reasonCode: "named-native-epoch-current-query-denial",
      };
      await assert.rejects(
        third.client.plugins.invoke(mount3.mountRef, query),
        denied(403, "authorization"),
      );
      f.state.responses.task = { outcome: "allow" };
      assert.deepEqual(
        parseProjectGenerationQueryUiActionResponse(
          query,
          (await third.client.plugins.invoke(mount3.mountRef, query)).output,
        ),
        { ...committedQuery, disposition: "replayed" },
      );
      assert.deepEqual(nativeProjectReceiptFacts(f.databasePath), facts2);
      assert.deepEqual(f.wallet(), wallet2);
      assert.equal(f.countQuotes(), 1);
      const preparedSelection = hints3.intents.find(
        (intent) => intent.request.action === selection.action,
      );
      assert.ok(preparedSelection);
      assert.equal(preparedSelection.phase, "prepared");
      assert.equal(preparedSelection.dispatchAttemptCount, 0);
      assert.equal(preparedSelection.receipt, null);
      f.assertNoSupplierExecution();
      await third.stop();
      expect(await f.taskDirectories()).toEqual([]);
    } catch (error) {
      failure = new Error(
        `${String(error)}\n${f.metadata.logs.join("").slice(-12000)}\nNamed authority failures: ${JSON.stringify(f.state.failures)}\nNamed metadata authority failures: ${JSON.stringify(f.metadata.authorityFailures()).slice(-4000)}`,
        { cause: error },
      );
      throw failure;
    } finally {
      try {
        await f.close();
      } catch (cleanup) {
        if (failure !== undefined)
          throw new AggregateError(
            [failure, cleanup],
            "native_project_epoch_test_and_cleanup_failed",
          );
        throw cleanup;
      }
    }
  },
  240_000,
);
