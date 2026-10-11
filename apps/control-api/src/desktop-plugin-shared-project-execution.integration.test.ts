import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseExtensionManifest } from "@crewon/domain";
import {
  parseProjectGenerationUiActionResponse,
  parseProjectGenerationQueryUiActionResponse,
} from "@crewon/contracts/plugins";
import { startExternalOperationFixtureRun } from "../../../packages/store/src/external-operation-run.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { nativeConfigurationManifest } from "./desktop-plugin-configuration.test-support.ts";
import {
  nativeTaskRuntimeFixture,
  actor,
  request,
} from "./desktop-native-plugin-task-runtime.test-support.ts";

test(
  "the original Native project generation and query owners commit, replay and reopen through one shared profile instance",
  { timeout: 20000 },
  async (t) => {
    const key = `shared-project-${randomUUID()}`;
    const globals = globalThis as unknown as Record<string, unknown>;
    const probe = { setups: 0, disposals: 0, invokes: 0 };
    globals[key] = probe;
    t.after(() => {
      delete globals[key];
    });
    const businessManifest = parseExtensionManifest({
      ...nativeConfigurationManifest,
      task: {
        ...nativeConfigurationManifest.task,
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", maxLength: 500, enum: null },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    });
    const f = await nativeTaskRuntimeFixture(t, undefined, {
      composition: true,
      projectExecution: true,
      businessManifest,
      tasksApiVersion: "2",
      nodeSource: `export default {apiVersion:'crewon.plugin-host.v1',pluginId:'test.native-business',setup(ctx){const probe=globalThis[${JSON.stringify(key)}];probe.setups++;const tasks=ctx.services.get('crewon.tasks','2');ctx.services.provide('test.native-business','1',{actions:[{contributionId:'workbench',action:'image.generate',kind:'generateTask'},{contributionId:'workbench',action:'image.query',kind:'queryTask'}],invoke({action,input,invocationRef}){probe.invokes++;return action==='image.query'?tasks.queryTask({...input,invocationRef}):tasks.createTask({...input,invocationRef});}});return {dispose(){probe.disposals++;}};}};`,
    });
    assert.ok(f.prepared);
    const created = await f.prepared.service.createProject(actor, {
      title: "Shared project",
      briefText: "Original project service and SQLite",
      idempotencyKey: "shared-project-create",
    });
    const concept = await f.prepared.service.createConcept(actor, {
      projectId: created.project.projectId,
      expectedProjectRevision: created.project.revision,
      briefRevision: created.brief.briefRevision,
      name: "Shared concept",
      prompt: "Saved project prompt",
      idempotencyKey: "shared-project-concept",
    });
    const action = "crewon.project-generations.v1.generateConcept" as const;
    const input = {
      reference: {
        projectId: concept.project.projectId,
        assetId: concept.asset.assetId,
        assetRevision: concept.assetRevision.assetRevision,
        expectedProjectRevision: concept.project.revision,
        expectedAssetMetadataRevision: concept.asset.revision,
      },
      threadId: "native-real-original-thread",
      expectedThreadRevision: 1,
      idempotencyKey: "shared-project-generation",
    };
    const invoke = (runtime = f.actual, mountRef = f.command.mountRef) =>
      runtime.ui.invokeAuthenticatedRequest!(
        request(),
        actor,
        { mountRef, action, input },
        new AbortController().signal,
      );
    const first = parseProjectGenerationUiActionResponse(
      { action, input },
      await invoke(),
    );
    assert.equal(first.disposition, "committed");
    const second = parseProjectGenerationUiActionResponse(
      { action, input },
      await invoke(),
    );
    assert.deepEqual(second, { ...first, disposition: "replayed" });
    assert.equal(probe.setups, 1);
    assert.equal(probe.invokes, 2);
    assert.equal(f.facts().runs, 1);
    assert.equal(f.facts().admissions, 1);
    assert.equal(f.facts().unmetered, 1);
    const binding = await f.originalStore
      .extensionStore()
      .loadExtensionRunBinding({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId: first.runId,
      });
    assert.ok(binding);
    await startExternalOperationFixtureRun(f.originalStore, binding);
    const operations = f.originalStore.externalOperationStore();
    await operations.migrate();
    const operationId = randomUUID();
    await operations.reserveExternalOperation({
      tenantId: actor.tenantId,
      runId: binding.runId,
      bindingDigest: binding.bindingDigest,
      operationId,
      executionId: "named-shared-project-operation",
      idempotencyKey: "named-shared-project-operation",
      actionDigest: `sha256:${"a".repeat(64)}`,
      requestDigest: `sha256:${"b".repeat(64)}`,
      correlationId: operationId,
      createdAt: "2026-10-04T00:00:00.000Z",
    });
    const queryAction =
      "crewon.project-generation-queries.v1.queryConceptGeneration" as const;
    // The source Run is still active. Keep the original one-active-Run-per-Thread rule.
    const queryThread = "native-real-project-query-thread";
    await seedThread(f.originalStore, { ...actor, threadId: queryThread });
    const queryInput = {
      reference: {
        projectId: concept.project.projectId,
        assetId: concept.asset.assetId,
        assetRevision: concept.assetRevision.assetRevision,
      },
      operationId,
      threadId: queryThread,
      expectedThreadRevision: 1,
      idempotencyKey: "shared-project-query",
    };
    const query = (runtime = f.actual, mountRef = f.command.mountRef) =>
      runtime.ui.invokeAuthenticatedRequest!(
        request(),
        actor,
        { mountRef, action: queryAction, input: queryInput },
        new AbortController().signal,
      );
    const queried = parseProjectGenerationQueryUiActionResponse(
      { action: queryAction, input: queryInput },
      await query(),
    );
    assert.equal(queried.disposition, "committed");
    const queriedAgain = parseProjectGenerationQueryUiActionResponse(
      { action: queryAction, input: queryInput },
      await query(),
    );
    assert.deepEqual(queriedAgain, { ...queried, disposition: "replayed" });
    assert.equal(probe.setups, 1);
    assert.equal(probe.invokes, 4);
    assert.equal(f.facts().runs, 2);
    const workerSource = f.actual.workerRunSource;
    assert.ok(workerSource);
    const workerSignal = new AbortController().signal;
    const generationProof = await workerSource.capture(
      first.runId,
      workerSignal,
    );
    const generationSnapshot = await workerSource.verify(
      generationProof,
      workerSignal,
    );
    const queryProof = await workerSource.capture(queried.runId, workerSignal);
    const querySnapshot = await workerSource.verify(queryProof, workerSignal);
    assert.equal(generationSnapshot.query, null);
    assert.ok(querySnapshot.query);
    assert.equal(querySnapshot.query.source.runId, first.runId);
    assert.deepEqual(querySnapshot.composition, generationSnapshot.composition);
    assert.equal(f.facts().runs, 2);
    const reopened = await f.reopen();
    const mount = await reopened.ui.openMount(actor, {
      pluginId: f.source.pluginId,
      contributionId: "workbench",
      expectedPackageDigest: f.source.packageDigest,
      expectedSelectionRevision: 2,
    });
    const replay = parseProjectGenerationUiActionResponse(
      { action, input },
      await invoke(reopened, mount.mountRef),
    );
    assert.deepEqual(replay, { ...first, disposition: "replayed" });
    assert.equal(probe.setups, 2);
    assert.equal(f.facts().runs, 2);
    const replayQuery = parseProjectGenerationQueryUiActionResponse(
      { action: queryAction, input: queryInput },
      await query(reopened, mount.mountRef),
    );
    assert.deepEqual(replayQuery, { ...queried, disposition: "replayed" });
    assert.equal(probe.setups, 2);
    assert.equal(f.facts().runs, 2);
    await reopened.close();
    assert.equal(probe.disposals, 2);
  },
);
