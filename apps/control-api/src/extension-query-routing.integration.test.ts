import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  parseExtensionRuntimeResponse,
  parseGetExtensionTaskResponse,
  type CreateExtensionTaskRequest,
} from "@crewon/contracts";
import type { ExtensionConfiguration } from "@crewon/domain";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { ExtensionHostRouter } from "./extension-host-router.ts";
import {
  queryActor,
  queryDefaultText,
  queryHeaders,
  queryPluginPath,
  queryRoutingFixture,
} from "./extension-query-routing.test-support.ts";

test("actual private peers route an old query to its entire prepared target while the current Worker leaves its lease untouched", async (t) => {
  const f = await queryRoutingFixture(t);
  const metadataControl = await f.openControl(f.metadataPeer);
  const saved = await metadataControl.app.inject({
    method: "PUT",
    url: `${queryPluginPath}/configuration`,
    headers: { ...queryHeaders, "idempotency-key": "configuration" },
    payload: {
      pluginVersion: "0.1.0",
      expectedRevision: 0,
      parameters: { baseUrl: "https://comfy.example/" },
      credentialBindings: [],
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const configuration = saved.json().configuration as ExtensionConfiguration;
  const old = await f.prepareWorker("old", configuration);
  const oldControl = await f.openControl(old.peer);
  const activation = await oldControl.app.inject({
    method: "PUT",
    url: `${queryPluginPath}/activation`,
    headers: { ...queryHeaders, "idempotency-key": "activate-old" },
    payload: {
      configurationRevision: configuration.revision,
      expectedRevision: 0,
      state: "enabled",
      agentVersionId: old.version.agentVersionId,
    },
  });
  assert.equal(activation.statusCode, 200, activation.body);
  const createTask = async (
    control: typeof oldControl,
    threadId: string,
    intent: CreateExtensionTaskRequest["intent"],
  ) => {
    await seedThread(f.inspection, { ...queryActor, threadId });
    return control.app.inject({
      method: "POST",
      url: `${queryPluginPath}/tasks`,
      headers: { ...queryHeaders, "idempotency-key": threadId },
      payload: { threadId, expectedThreadRevision: 1, intent },
    });
  };
  const source = await createTask(oldControl, "original-image", {
    kind: "generate",
    input: { prompt: "Generate the original teapot image." },
  });
  assert.equal(source.statusCode, 200, source.body);
  const sourceRunId: string = source.json().runId;
  assert.deepEqual(await old.runtime.worker.wake(), {
    kind: "completed",
    runId: sourceRunId,
  });
  const readTask = async (control: typeof oldControl, runId: string) => {
    const response = await control.app.inject({
      url: `${queryPluginPath}/tasks/${runId}`,
      headers: queryHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    return parseGetExtensionTaskResponse(response.json()).task;
  };
  const sourceView = await readTask(oldControl, sourceRunId);
  assert.equal(sourceView.runStatus, "completed");
  assert.equal(sourceView.operations.length, 1);
  assert.equal(sourceView.operations[0]!.status, "succeeded");
  assert.equal(sourceView.operations[0]!.images.length, 1);
  const binding = await f.inspection
    .extensionStore()
    .loadExtensionRunBinding({ ...queryActor, runId: sourceRunId });
  assert.ok(binding);
  const originalTarget = binding.target;
  assert.equal(originalTarget.agentVersionId, old.version.agentVersionId);
  const queryIntent: CreateExtensionTaskRequest["intent"] = {
    kind: "query",
    sourceRunId,
    operationId: sourceView.operations[0]!.operationId,
  };

  await old.runtime.close();
  const current = await f.prepareWorker("current", configuration);
  const historical = await old.reopenHistorical();
  const control = await f.openControl(current.peer, [historical.peer]);
  const currentOnly = await f.openControl(current.peer);
  const metadataOnlyHistorical = await f.openControl(current.peer, [
    f.metadataPeer,
  ]);
  const requestsBeforeReads = f.externalRequests.length;
  const unavailable = await createTask(
    currentOnly,
    "query-current-only",
    queryIntent,
  );
  assert.equal(unavailable.statusCode, 409, unavailable.body);
  assert.equal(unavailable.json().error.code, "extension_runtime_unavailable");
  const metadataUnavailable = await createTask(
    metadataOnlyHistorical,
    "query-metadata-only",
    queryIntent,
  );
  assert.equal(metadataUnavailable.statusCode, 409, metadataUnavailable.body);
  assert.equal(
    metadataUnavailable.json().error.code,
    "extension_runtime_unavailable",
  );
  assert.deepEqual(
    await readTask(metadataOnlyHistorical, sourceRunId),
    sourceView,
  );
  assert.equal(f.externalRequests.length, requestsBeforeReads);

  const runtimeResponse = await control.app.inject({
    url: `${queryPluginPath}/runtime?agentVersionId=${old.version.agentVersionId}&configurationRevision=${configuration.revision}`,
    headers: queryHeaders,
  });
  assert.equal(runtimeResponse.statusCode, 200, runtimeResponse.body);
  assert.deepEqual(
    parseExtensionRuntimeResponse(runtimeResponse.json()).readiness,
    {
      outcome: "unavailable",
      reasonCode: "extension_runtime_unavailable",
    },
  );
  const activatedCurrent = await control.app.inject({
    method: "PUT",
    url: `${queryPluginPath}/activation`,
    headers: { ...queryHeaders, "idempotency-key": "activate-current" },
    payload: {
      configurationRevision: configuration.revision,
      expectedRevision: 1,
      state: "enabled",
      agentVersionId: current.version.agentVersionId,
    },
  });
  assert.equal(activatedCurrent.statusCode, 200, activatedCurrent.body);
  const currentTarget = activatedCurrent.json().activation.target;
  assert.equal(currentTarget.agentVersionId, current.version.agentVersionId);
  assert.notDeepEqual(currentTarget, originalTarget);

  const router = new ExtensionHostRouter({
    ...current.peer,
    historicalPeers: [historical.peer],
  });
  t.after(() => router.close());
  const registration = await router.queryHost.resolveRegistration({
    actor: queryActor,
    identity: {
      pluginId: configuration.pluginId,
      pluginVersion: configuration.pluginVersion,
      manifestDigest: configuration.manifestDigest,
      implementationDigest: configuration.implementationDigest,
    },
  });
  assert.ok(registration);
  assert.equal(
    registration.implementationDigest,
    configuration.implementationDigest,
  );
  assert.equal(registration.manifestDigest, configuration.manifestDigest);
  assert.deepEqual(
    await router.evaluate({
      actor: queryActor,
      registration,
      configuration,
      agentVersionId: current.version.agentVersionId,
    }),
    { outcome: "ready", target: currentTarget },
  );
  const readinessInput = {
    actor: queryActor,
    registration,
    configuration,
    agentVersionId: originalTarget.agentVersionId,
    expectedTarget: originalTarget,
  };
  assert.deepEqual(await router.queryHost.evaluate(readinessInput), {
    outcome: "ready",
    target: originalTarget,
  });
  // Every modified value is compared against actual private-host proofs, never synthetic readiness.
  for (const changed of [
    { agentVersionId: current.version.agentVersionId },
    { agentVersionContentDigest: `sha256:${"f".repeat(64)}` },
    { materializationDigest: `sha256:${"e".repeat(64)}` },
    { authorityId: "other-authority" },
    { runtimeGeneration: "other-generation" },
    { policySnapshotId: "other-policy" },
    { workspaceBindingId: "other-workspace" },
  ]) {
    const expectedTarget = { ...originalTarget, ...changed };
    assert.deepEqual(
      await router.queryHost.evaluate({
        ...readinessInput,
        agentVersionId: expectedTarget.agentVersionId,
        expectedTarget,
      }),
      { outcome: "unavailable", reasonCode: "extension_runtime_unavailable" },
    );
  }

  const query = await createTask(control, "query-original-target", queryIntent);
  assert.equal(query.statusCode, 200, query.body);
  const queryRunId: string = query.json().runId;
  const queryBinding = await f.inspection
    .extensionStore()
    .loadExtensionRunBinding({ ...queryActor, runId: queryRunId });
  assert.deepEqual(queryBinding?.target, originalTarget);
  assert.equal(queryBinding?.source?.runId, sourceRunId);
  const sql = new DatabaseSync(f.databasePath);
  t.after(() => sql.close());
  const queueRow = () =>
    sql
      .prepare(
        "SELECT status, lease_owner_id, lease_id, lease_epoch, lease_expires_at_ms FROM work_items WHERE tenant_id=? AND run_id=?",
      )
      .get(queryActor.tenantId, queryRunId);
  const beforeWake = queueRow();
  const queryCursor = (
    await f.inspection.listRunEvents(
      { ...queryActor, runId: queryRunId },
      0,
      200,
    )
  ).at(-1)!.sequence;
  assert.deepEqual(
    { ...beforeWake },
    {
      status: "pending",
      lease_owner_id: null,
      lease_id: null,
      lease_epoch: 0,
      lease_expires_at_ms: null,
    },
  );
  assert.deepEqual(await current.runtime.worker.wake(), { kind: "idle" });
  assert.deepEqual(queueRow(), beforeWake);
  assert.equal(
    (await f.inspection.loadRun({ ...queryActor, runId: queryRunId }))?.status,
    "queued",
  );
  assert.deepEqual(await historical.runtime.worker.wake(), {
    kind: "completed",
    runId: queryRunId,
  });
  const queriedView = await readTask(control, queryRunId);
  assert.equal(queriedView.runStatus, "completed");
  assert.equal(queriedView.sourceRunId, sourceRunId);
  assert.deepEqual(queriedView.operations, sourceView.operations);
  assert.equal(
    f.externalRequests.filter((request) => request === "POST /prompt").length,
    1,
  );
  await control.app.listen({ host: "127.0.0.1", port: 0 });
  const address = control.app.server.address();
  assert.ok(address !== null && typeof address !== "string");
  const resumeQuery = async () => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/runs/${queryRunId}/events`,
      {
        headers: { ...queryHeaders, "last-event-id": String(queryCursor) },
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /text\/event-stream/u);
    return response.text();
  };
  const queryStream = await resumeQuery();
  assert.match(queryStream, /event: model.output.delta/u);
  assert.match(queryStream, /comfy.example\/view/u);
  assert.match(queryStream, /event: run.completed/u);
  assert.equal(queryStream.includes("event: run.created\n"), false);
  assert.equal(await resumeQuery(), queryStream);

  const generated = await createTask(control, "new-current-image", {
    kind: "generate",
    input: { prompt: "Generate a new image using the current target." },
  });
  assert.equal(generated.statusCode, 200, generated.body);
  const currentRunId: string = generated.json().runId;
  assert.deepEqual(await historical.runtime.worker.wake(), { kind: "idle" });
  assert.deepEqual(await current.runtime.worker.wake(), {
    kind: "completed",
    runId: currentRunId,
  });
  const generatedBinding = await f.inspection
    .extensionStore()
    .loadExtensionRunBinding({ ...queryActor, runId: currentRunId });
  assert.deepEqual(generatedBinding?.target, currentTarget);
  assert.equal(
    f.externalRequests.filter((request) => request === "POST /prompt").length,
    2,
  );

  const defaultThread = await control.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: { ...queryHeaders, "idempotency-key": "default-thread" },
    payload: { title: "Default Agent compatibility" },
  });
  assert.equal(defaultThread.statusCode, 201, defaultThread.body);
  const { thread } = defaultThread.json();
  const normal = await control.app.inject({
    method: "POST",
    url: `/api/v1/threads/${thread.threadId}/turns`,
    headers: { ...queryHeaders, "idempotency-key": "default-turn" },
    payload: {
      expectedRevision: thread.revision,
      content: "Use the existing default Agent.",
      agentVersionId: null,
      executionIntent: "none",
    },
  });
  assert.equal(normal.statusCode, 201, normal.body);
  const normalRunId: string = normal.json().run.runId;
  assert.deepEqual(await historical.runtime.worker.wake(), { kind: "idle" });
  assert.deepEqual(await current.runtime.worker.wake(), {
    kind: "completed",
    runId: normalRunId,
  });
  assert.equal(
    (await f.inspection.loadRun({ ...queryActor, runId: normalRunId }))
      ?.agentVersionId,
    f.defaultVersion.agentVersionId,
  );
  const normalEvents = await f.inspection.listRunEvents(
    { ...queryActor, runId: normalRunId },
    0,
    200,
  );
  assert.equal(
    normalEvents
      .filter((event) => event.type === "model.output.delta")
      .map((event) => event.data.delta)
      .join(""),
    queryDefaultText,
  );
  assert.equal(f.models.length, 8);
  assert.deepEqual(current.runtime.agentVersion, f.defaultVersion);
  t.diagnostic(
    JSON.stringify({
      fixture:
        "local model and pinned Comfy; actual SQLite/kernel/private HTTP",
      sameImplementation: registration.implementationDigest,
      oldAgentVersionId: originalTarget.agentVersionId,
      currentAgentVersionId: currentTarget.agentVersionId,
      queryCursor,
      resumedSseEqual: true,
      modelRequests: f.models.length,
      comfyPosts: f.externalRequests.filter(
        (request) => request === "POST /prompt",
      ).length,
      comfyHistoryReads: f.externalRequests.filter((request) =>
        request.startsWith("GET /history/"),
      ).length,
      currentFirstWake: "idle; old query lease remained pending/epoch 0",
    }),
  );
});
