import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import type { TeamTaskIntent } from "@crewon/application/team-task-journal";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import { createStandaloneTeamTaskScheduler } from "./standalone-team-task-scheduler.ts";
import { sqliteWorkflowDeploymentFixture } from "./sqlite-workflow-deployment.test-support.ts";
import { originalTask, prepare } from "./team-turn-application.test-support.ts";

test("standalone async Team scheduler executes a durable task through Control application services", async (t) => {
  const fixture = await sqliteWorkflowDeploymentFixture(t);
  const server = await fixture.control(null);
  const worker = await fixture.worker();
  worker.start();
  const prepared = await prepare(server.client, true);
  const journal = await fixture.store.experimentalTeamTaskJournalStore();
  await journal.migrate();
  const intent: TeamTaskIntent = {
    schemaVersion: "crewon.team-task.v1",
    ...fixture.actor,
    taskId: "standalone-async-scheduler",
    turn: {
      threadId: prepared.thread.threadId,
      expectedRevision: prepared.thread.revision,
      content: originalTask,
      plan: prepared.plan,
      responseMode: "manager",
      managerResponseKind: "office",
    },
  };
  await journal.create(intent);
  const runtime = await createStandaloneTeamTaskScheduler({
    databasePath: fixture.databasePath,
    actor: fixture.actor,
    operations: server.runtime.teamOperations!,
    digester: new NodeSha256ContentDigester(),
    scanIntervalMs: null,
  });
  t.after(() => runtime.close());
  runtime.pump.notify();
  const deadline = Date.now() + 20_000;
  let record = await journal.read(intent);
  while (record?.status !== "finalAccepted") {
    assert.ok(Date.now() < deadline, "standalone Team task did not finish");
    await setTimeout(10);
    record = await journal.read(intent);
  }
  assert.equal(record.result?.run.threadId, prepared.thread.threadId);
  assert.equal(record.lease, null);
});
