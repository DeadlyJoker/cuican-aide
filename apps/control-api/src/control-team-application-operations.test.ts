import assert from "node:assert/strict";
import test from "node:test";
import { sqliteWorkflowDeploymentFixture } from "./sqlite-workflow-deployment.test-support.ts";
import { prepare } from "./team-turn-application.test-support.ts";

test("standalone Control exposes Team operations from application services", async (t) => {
  const fixture = await sqliteWorkflowDeploymentFixture(t);
  const server = await fixture.control(null);
  const worker = await fixture.worker();
  worker.start();
  const prepared = await prepare(server.client, true);
  const operations = server.runtime.teamOperations;
  assert.ok(operations);

  const thread = await operations.getThread(prepared.thread.threadId);
  assert.equal(thread.thread.threadId, prepared.thread.threadId);
  assert.equal(thread.eventSequence, thread.thread.revision);

  const office = await operations.getOffice(prepared.plan.officeVersionId);
  assert.equal(office.office.officeVersionId, prepared.plan.officeVersionId);
  assert.equal(
    (
      await operations.authorizeOfficeRun(prepared.plan.officeVersionId, {
        targetId: prepared.plan.manager.targetId,
        threadId: prepared.thread.threadId,
      })
    ).target.targetId,
    prepared.plan.manager.targetId,
  );

  const messages = await operations.listThreadMessages(
    prepared.thread.threadId,
    { limit: 20 },
  );
  assert.ok(
    messages.data.some((message) => message.content.includes("PRIOR_CONTEXT")),
  );
  assert.deepEqual(await operations.getExecutionIntentCapability(), {
    version: "v1",
  });
  assert.equal(
    (await operations.getThreadGoal(prepared.thread.threadId)).goal,
    null,
  );
});
