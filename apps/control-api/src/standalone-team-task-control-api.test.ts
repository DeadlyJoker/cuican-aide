import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { ControlApiClient } from "@crewon/control-client";
import { resolveControlTeamPlan } from "@crewon/application/team-turn";
import { sqliteWorkflowDeploymentFixture } from "./sqlite-workflow-deployment.test-support.ts";
import { createStandaloneTeamTaskControlApi } from "./standalone-team-task-control-api.ts";
import { originalTask, prepare } from "./team-turn-application.test-support.ts";

test("standalone Team HTTP admission wakes the durable scheduler and preserves one main message", async (t) => {
  const server = await sqliteWorkflowDeploymentFixture(t, {});
  const worker = await server.worker();
  worker.start();
  const errors: unknown[] = [];
  const runtime = await createStandaloneTeamTaskControlApi({
    databasePath: server.databasePath,
    actor: server.actor,
    defaultAgentVersionId: server.base.route.agentVersionId,
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "team-admission-http-test",
    sessionToken: server.token,
    csrfToken: server.token,
    allowedOrigins: [server.origin],
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: null,
    artifactRetention: null,
    teamTaskScheduler: {
      onError: (_fence, error) => {
        errors.push(error);
      },
    },
  });
  t.after(() => runtime.app.close());
  const baseUrl = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new ControlApiClient({
    baseUrl,
    accessToken: server.token,
    csrfToken: server.token,
    origin: server.origin,
  });
  const prepared = await prepare(client, true);
  const plan = await resolveControlTeamPlan({
    client,
    threadId: prepared.thread.threadId,
    officeVersionId: prepared.plan.officeVersionId,
    catalog: await client.getActiveAgentVersionCatalog(),
  });
  const accepted = await client.admitTeamTask(
    {
      threadId: prepared.thread.threadId,
      expectedRevision: prepared.thread.revision,
      content: originalTask,
      plan,
      responseMode: "manager",
    },
    "team-http-admission-1",
  );
  assert.equal(accepted.disposition, "committed");
  const admittedSnapshot = await client.getTeamTask(accepted.task.taskId);
  assert.equal(admittedSnapshot.task.status, "coordinating");
  const journal = await server.store.experimentalTeamTaskJournalStore();
  await journal.migrate();
  const deadline = Date.now() + 20_000;
  let final = null;
  while (Date.now() < deadline) {
    final = await journal.read({
      tenantId: server.actor.tenantId,
      spaceId: server.actor.spaceId,
      taskId: accepted.task.taskId,
    });
    if (final?.status === "finalAccepted") break;
    await setTimeout(20);
  }
  assert.equal(final?.status, "finalAccepted", errors.map(String).join(";"));
  assert.equal(
    final?.intent.mainMessageSequence,
    accepted.task.mainMessageSequence,
  );
  const messages = await client.listThreadMessages(prepared.thread.threadId, {
    cursor: null,
    limit: 100,
  });
  assert.equal(
    messages.data.filter((message) => message.content === originalTask).length,
    1,
  );
  const completedSnapshot = await client.getTeamTask(accepted.task.taskId);
  assert.equal(completedSnapshot.task.status, "finalAccepted");
  assert.ok(completedSnapshot.task.resultRunId);
  const cancelAfterCompletion = await client.cancelTeamTask(
    accepted.task.taskId,
    "team-http-cancel-after-completion",
  );
  assert.equal(cancelAfterCompletion.task.status, "finalAccepted");
  assert.equal(cancelAfterCompletion.task.cancelRequested, false);
});

test("standalone Team HTTP cancellation marks a running durable task and wakes its scheduler", async (t) => {
  let hold = false;
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const server = await sqliteWorkflowDeploymentFixture(t, {
    beforeModel: async () => {
      if (!hold) return;
      enteredResolve();
      await held;
    },
  });
  t.after(() => releaseResolve());
  const worker = await server.worker();
  worker.start();
  const runtime = await createStandaloneTeamTaskControlApi({
    databasePath: server.databasePath,
    actor: server.actor,
    defaultAgentVersionId: server.base.route.agentVersionId,
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "team-admission-http-cancel-test",
    sessionToken: server.token,
    csrfToken: server.token,
    allowedOrigins: [server.origin],
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: null,
    artifactRetention: null,
  });
  t.after(() => runtime.app.close());
  const baseUrl = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new ControlApiClient({
    baseUrl,
    accessToken: server.token,
    csrfToken: server.token,
    origin: server.origin,
  });
  const prepared = await prepare(client, true);
  const plan = await resolveControlTeamPlan({
    client,
    threadId: prepared.thread.threadId,
    officeVersionId: prepared.plan.officeVersionId,
    catalog: await client.getActiveAgentVersionCatalog(),
  });
  hold = true;
  const accepted = await client.admitTeamTask(
    {
      threadId: prepared.thread.threadId,
      expectedRevision: prepared.thread.revision,
      content: originalTask,
      plan,
      responseMode: "manager",
    },
    "team-http-admission-cancel-1",
  );
  await entered;
  const canceled = await client.cancelTeamTask(
    accepted.task.taskId,
    "team-http-cancel-1",
  );
  assert.equal(canceled.task.cancelRequested, true);
  releaseResolve();
  const deadline = Date.now() + 5_000;
  let snapshot = canceled;
  while (Date.now() < deadline) {
    snapshot = await client.getTeamTask(accepted.task.taskId);
    if (snapshot.task.cancelRequested) break;
    await setTimeout(20);
  }
  assert.equal(snapshot.task.cancelRequested, true);
});
