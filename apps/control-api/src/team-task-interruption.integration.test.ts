import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { executeTeamTask } from "@crewon/application/team-task-execution";
import {
  TeamTaskJournalError,
  type TeamTaskIntent,
} from "@crewon/application/team-task-journal";
import { workflowDeploymentIntegrationTest } from "./workflow-deployment-integration.test-support.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import {
  originalTask,
  priorContext,
  lastUser,
  completed,
  prepare,
  teamOperations,
} from "./team-turn-application.test-support.ts";

function isCode(code: string) {
  return (error: unknown) =>
    error instanceof TeamTaskJournalError && error.code === code;
}

workflowDeploymentIntegrationTest(
  "Team cancellation interrupts live Run waiting without transient-read retries, final submission, or freezing a nonterminal response",
  async (t, fixture) => {
    let release!: () => void;
    const gate = new Promise<void>((ready) => {
      release = ready;
    });
    t.after(() => {
      release();
    });
    let calls = 0;
    const f = await fixture(t, {
      beforeModel: async () => {
        if (++calls > 1) await gate;
      },
      output: (request) =>
        lastUser(request) === priorContext ? "PRIOR_REPLY" : "MEMBER_REPORT",
    });
    const server = await f.control(null);
    const worker = await f.worker();
    worker.start();
    const { thread, plan } = await prepare(server.client, true);
    const intent: TeamTaskIntent = {
      schemaVersion: "crewon.team-task.v1",
      ...f.actor,
      taskId: "cancel-live",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager",
        managerResponseKind: "office",
      },
    };
    const journal = await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    await journal.create(intent);
    const fence = (await journal.claim({
      ...intent,
      ownerId: "owner",
      leaseId: "lease",
      durationMs: 1000,
    }))!;
    const operations = teamOperations(server.client),
      getRun = operations.getRun;
    let reads = 0;
    operations.getRun = async (id) => {
      reads++;
      return getRun(id);
    };
    const outcome = executeTeamTask({
      actor: f.actor,
      store: journal,
      fence,
      operations,
      digester: new NodeSha256ContentDigester(),
      pollIntervalMs: 10,
      runDeadlineMs: 20_000,
      leaseDurationMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    const deadline = Date.now() + 20_000;
    while (calls < 3 || reads < 2) {
      assert.ok(
        Date.now() < deadline,
        "both child models and live status reads must start",
      );
      await setTimeout(10);
    }
    const effects = await journal.effects(intent);
    const polling = effects.filter(
      (effect) =>
        effect.kind === "observation" &&
        (effect.request as { label?: string }).label?.startsWith("run."),
    );
    assert.equal(polling.length, 2);
    assert.ok(polling.every((effect) => !effect.settled));
    await journal.requestCancel(intent);
    const atCancel = reads;
    const error = await outcome;
    assert.ok(error instanceof TeamTaskJournalError);
    assert.equal(error.code, "team_task_cancel_requested");
    assert.ok(
      reads <= atCancel + 2,
      "lease/cancel errors must not use the transient read retry budget",
    );
    const after = await journal.effects(intent);
    assert.ok(
      !after.some(
        (effect) =>
          effect.kind === "command" &&
          (effect.request as { method?: string }).method === "startTurn",
      ),
    );
    const children = after
      .filter(
        (effect) =>
          effect.kind === "command" &&
          (effect.request as { method?: string }).method === "createRun",
      )
      .map(
        (effect) => (effect.response as { run: { runId: string } }).run.runId,
      );
    assert.equal(children.length, 2);
    for (const id of children) {
      const { run } = await server.client.getRun(id);
      await server.client.cancelRun(
        id,
        { expectedRevision: run.revision },
        `cleanup:${id}`,
      );
    }
    release();
    for (const id of children)
      assert.equal((await completed(server.client, id)).status, "canceled");
    assert.equal(
      calls,
      3,
      "journal cancellation has not been misrepresented as child Run propagation",
    );
  },
);

workflowDeploymentIntegrationTest(
  "Team main-thread reservation rejects an unscoped concurrent append while the fenced coordinator completes",
  async (t, fixture) => {
    let getThreadCalls = 0;
    const f = await fixture(t, {
      output: (request) =>
        lastUser(request) === priorContext ? "PRIOR_REPLY" : "MEMBER_REPORT",
    });
    const server = await f.control(null);
    const worker = await f.worker();
    worker.start();
    const { thread, plan } = await prepare(server.client, true);
    const journal = await f.store.experimentalTeamTaskJournalStore();
    await journal.migrate();
    const intent = {
      schemaVersion: "crewon.team-task.v1" as const,
      ...f.actor,
      taskId: "main-revision-fence",
      turn: {
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager" as const,
        managerResponseKind: "office" as const,
      },
    };
    await journal.create(intent);
    const fence = (await journal.claim({
      ...intent,
      ownerId: "fence-owner",
      leaseId: "fence-lease",
      durationMs: 30_000,
    }))!;
    const operations = teamOperations(server.client);
    const originalGetThread = operations.getThread;
    operations.getThread = async (threadId) => {
      getThreadCalls++;
      if (getThreadCalls === 2) {
        const current = await server.client.getThread(threadId);
        await assert.rejects(
          server.client.appendThreadMessage(
            threadId,
            {
              expectedRevision: current.thread.revision,
              content: "CONCURRENT_USER_INPUT",
            },
            "concurrent-user-input",
          ),
          (error: unknown) =>
            error instanceof Error &&
            error.message === "team_task_main_reserved",
        );
      }
      return originalGetThread(threadId);
    };
    const result = await executeTeamTask({
      actor: f.actor,
      store: journal,
      fence,
      operations,
      digester: new NodeSha256ContentDigester(),
      pollIntervalMs: 10,
      runDeadlineMs: 20_000,
    });
    const messages = (await server.client.listThreadMessages(thread.threadId))
      .data;
    assert.equal(
      messages.filter((message) => message.content === "CONCURRENT_USER_INPUT")
        .length,
      0,
    );
    assert.equal((await journal.read(intent))!.status, "finalAccepted");
    assert.equal(
      (await journal.read(intent))!.result?.run.runId,
      result.run.runId,
    );
  },
);
