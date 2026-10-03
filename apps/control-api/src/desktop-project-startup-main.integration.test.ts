import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import {
  parseGetConceptSelectionResponse,
  parsePluginUiRecoveryRequest,
  parseProjectGenerationReadUiActionResponse,
  parseSelectConceptImageResponse,
} from "@crewon/contracts";
import {
  nativeHistoryCurrentAction,
  nativeHistoryReadAction,
  nativeHistorySelectAction,
} from "./desktop-project-history-plugin-runtime.test-support.ts";
import { nativeProjectMainFixture } from "./desktop-project-startup-main.integration.test-support.ts";

test(
  "actual Standalone Main reads original SQLite history, durably selects its exact second image and recovers the original receipt after physical child restart without new execution or holds",
  { timeout: 90_000 },
  async (t) => {
    const f = await nativeProjectMainFixture(t);
    const baseline = await f.effects();
    assert.equal(
      await f.history.count("creative_concept_selection_receipts"),
      0,
    );
    const first = await f.start();
    assert.equal(first.environment.CREWON_CONTROL_DB_PATH, f.databasePath);
    for (const forbidden of [
      "CREWON_CONTROL_DATABASE_URL",
      "CREWON_PROJECT_COMPOSITION_CONFIG_PATH",
      "CREWON_INSTALLED_PLUGIN_TASK_CONFIG_PATH",
      "CREWON_INSTALLED_PLUGIN_CONFIGURATION_CONFIG_PATH",
      "CREWON_PLUGIN_UI_ENABLED",
      "CREWON_PROVIDER_PROBE_WORKER_ORIGIN",
      "CREWON_EXTENSION_WORKER_CONFIG_PATH",
    ])
      assert.equal(Object.hasOwn(first.environment, forbidden), false);
    const lease = await first.mount();
    assert.deepEqual(lease.descriptor, f.v1.descriptor);
    assert.equal(lease.descriptor.entrypoints.node, null);
    assert.equal(lease.packageDigest, f.v1.packageDigest);
    assert.deepEqual(
      (await first.client.plugins.getRecovery(lease.mountRef)).intents,
      [],
    );
    const readRequest = {
      action: nativeHistoryReadAction,
      input: f.locator,
    } as const;
    const generation = parseProjectGenerationReadUiActionResponse(
      readRequest,
      (await first.client.plugins.invoke(lease.mountRef, readRequest)).output,
    ).generation;
    assert.ok(generation);
    assert.equal(
      generation.task.runId,
      f.history.generation.committed.binding.runId,
    );
    assert.equal(
      generation.task.configurationRevision,
      f.history.configuration.revision,
    );
    assert.deepEqual(
      generation.task.operations[0]?.images,
      f.history.generation.images.map((image, resultIndex) => ({
        filename: image.filename,
        url: image.url,
        resultIndex,
      })),
    );
    const request = parsePluginUiRecoveryRequest({
      action: nativeHistorySelectAction,
      input: f.selectionInput("named-native-main-original-second-image", 1),
    });
    assert.equal(request.action, nativeHistorySelectAction);
    if (request.action !== nativeHistorySelectAction)
      throw new Error("Expected named original selection request");
    const { idempotencyKey: _key, ...body } = request.input;
    const originalPin = {
      pluginId: f.v1.pluginId,
      publisherId: f.v1.publisherId,
      version: f.v1.version,
      packageDigest: f.v1.packageDigest,
      selectionRevision: lease.selectionRevision,
      contributionId: lease.contributionId,
    };
    const staged = await first.client.plugins.stageRecovery(
      lease.mountRef,
      request,
    );
    assert.equal(staged.disposition, "created");
    assert.equal(staged.intent.phase, "prepared");
    assert.equal(staged.intent.dispatchAttemptCount, 0);
    assert.deepEqual(staged.intent.request, request);
    assert.deepEqual(staged.intent.sourcePin, originalPin);
    assert.deepEqual(await f.effects(), baseline);
    const selected = parseSelectConceptImageResponse(
      (await first.client.plugins.invoke(lease.mountRef, request)).output,
      body,
    );
    assert.equal(selected.disposition, "committed");
    assert.equal(selected.selectionRevision, 1);
    assert.equal(
      selected.selection.operationId,
      f.history.generation.operation.operationId,
    );
    assert.equal(
      selected.selection.operationRevision,
      f.history.generation.operation.revision,
    );
    assert.equal(selected.selection.resultIndex, 1);
    assert.equal(selected.selection.filename, "second.png");
    assert.equal(selected.selection.url, f.history.generation.images[1]!.url);
    const accepted = (await first.client.plugins.getRecovery(lease.mountRef))
      .intents;
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.phase, "accepted");
    assert.equal(accepted[0]!.retryable, false);
    assert.equal(accepted[0]!.dispatchAttemptCount, 1);
    assert.deepEqual(accepted[0]!.sourcePin, originalPin);
    assert.deepEqual(accepted[0]!.request, request);
    assert.deepEqual(accepted[0]!.receipt, selected);
    assert.equal(
      await f.history.count("creative_concept_selection_receipts"),
      1,
    );
    assert.equal(await f.history.count("plugin_ui_intents"), 1);
    assert.deepEqual(await f.effects(), baseline);
    await first.stop();
    assert.equal(first.child.finished(), true);
    assert.deepEqual(await f.providerTransports(), []);

    const second = await f.start();
    assert.notEqual(second.child.child.pid, first.child.child.pid);
    assert.notEqual(second.sessionToken, first.sessionToken);
    assert.notEqual(second.authorityEpoch, first.authorityEpoch);
    assert.equal(second.environment.CREWON_CONTROL_DB_PATH, f.databasePath);
    const coldLease = await second.mount();
    assert.notEqual(coldLease.mountRef, lease.mountRef);
    assert.deepEqual(coldLease.descriptor, f.v1.descriptor);
    await assert.rejects(
      second.client.plugins.invoke(lease.mountRef, readRequest),
      (error: unknown) => error instanceof ControlApiClientError,
    );
    const staleSession = new ControlApiClient({
      baseUrl: `http://127.0.0.1:${second.port}`,
      accessToken: first.sessionToken,
      csrfToken: first.csrfToken,
      origin: second.origin,
    });
    await assert.rejects(
      staleSession.plugins.getRecovery(coldLease.mountRef),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 401,
    );
    const badCsrf = new ControlApiClient({
      baseUrl: `http://127.0.0.1:${second.port}`,
      accessToken: second.sessionToken,
      csrfToken: "named-native-main-wrong-csrf-" + "x".repeat(32),
      origin: second.origin,
    });
    await assert.rejects(
      badCsrf.plugins.invoke(coldLease.mountRef, request),
      (error: unknown) =>
        error instanceof ControlApiClientError && error.status === 403,
    );
    // A new Main process sees the same immutable accepted intent before any business replay.
    assert.deepEqual(
      (await second.client.plugins.getRecovery(coldLease.mountRef)).intents,
      accepted,
    );
    const currentInput = {
      projectId: f.locator.projectId,
      assetId: f.locator.assetId,
    };
    const current = parseGetConceptSelectionResponse(
      (
        await second.client.plugins.invoke(coldLease.mountRef, {
          action: nativeHistoryCurrentAction,
          input: currentInput,
        })
      ).output,
      currentInput,
    );
    assert.equal(current.selectionRevision, 1);
    assert.ok(current.current);
    const { requiresConfirmation, ...currentImage } = current.current;
    assert.equal(requiresConfirmation, false);
    assert.deepEqual(currentImage, selected.selection);
    const restaged = await second.client.plugins.stageRecovery(
      coldLease.mountRef,
      request,
    );
    assert.equal(restaged.disposition, "replayed");
    assert.deepEqual(restaged.intent.request, request);
    const replayed = parseSelectConceptImageResponse(
      (await second.client.plugins.invoke(coldLease.mountRef, request)).output,
      body,
    );
    assert.equal(replayed.disposition, "replayed");
    assert.equal(replayed.selectionRevision, 1);
    assert.deepEqual(replayed.selection, selected.selection);
    const afterReplay = (
      await second.client.plugins.getRecovery(coldLease.mountRef)
    ).intents;
    assert.equal(afterReplay.length, 1);
    assert.equal(afterReplay[0]!.phase, "accepted");
    // Accepted journal replay retains the first verified receipt and its dispatch count.
    assert.equal(afterReplay[0]!.dispatchAttemptCount, 1);
    assert.deepEqual(afterReplay[0]!.request, request);
    assert.deepEqual(afterReplay[0]!.sourcePin, originalPin);
    assert.deepEqual(afterReplay[0]!.receipt, selected);
    const stillCurrent = parseGetConceptSelectionResponse(
      (
        await second.client.plugins.invoke(coldLease.mountRef, {
          action: nativeHistoryCurrentAction,
          input: currentInput,
        })
      ).output,
      currentInput,
    );
    assert.deepEqual(stillCurrent, current);
    assert.equal(
      await f.history.count("creative_concept_selection_receipts"),
      1,
    );
    assert.equal(await f.history.count("plugin_ui_intents"), 1);
    assert.deepEqual(await f.effects(), baseline);
    await f.assertNoNodeImport();
    await second.stop();
    assert.equal(second.child.finished(), true);
    assert.deepEqual(await f.providerTransports(), []);
  },
);
