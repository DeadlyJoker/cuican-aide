import assert from "node:assert/strict";
import {
  originalTask,
  priorContext,
  lastUser,
  completed,
  prepare,
} from "./team-turn-application.test-support.ts";
import { setTimeout } from "node:timers/promises";
import type { ModelRequest } from "@crewon/agent-kernel";
import type { ControlApiClient } from "@crewon/control-client";
import {
  startControlTeamTurn,
  type ControlTeamRunAcceptedEvent,
} from "@crewon/application/team-turn";
import { workflowDeploymentIntegrationTest } from "./workflow-deployment-integration.test-support.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

async function disconnectAfterRunStarted(
  client: ControlApiClient,
  runId: string,
) {
  const controller = new AbortController();
  const response = await client.openRunEventStream({
    runId,
    afterSequence: 0,
    view: "client",
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  });
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "the gated model must still be running");
      text += decoder.decode(chunk.value, { stream: true });
      const frames = text.split("\n\n").slice(0, -1);
      if (frames.some((frame) => frame.includes("event: run.started\n"))) {
        const cursor = frames
          .flatMap((frame) => [...frame.matchAll(/^id: (\d+)$/gm)])
          .map((match) => Number(match[1]))
          .at(-1);
        assert.ok(cursor !== undefined);
        assert.ok(!text.includes("event: run.completed"));
        return cursor;
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}

for (const roleDirected of [false, true]) {
  workflowDeploymentIntegrationTest(
    `headless Team ${roleDirected ? "role-directed" : "manager-planned"} application preserves forked context, parallel workers, bounded reports and canonical main output across Control reopen`,
    async (t, fixture) => {
      const sampled: ModelRequest[] = [];
      let arrivals = 0;
      const workersReady = barrier();
      const finalStarted = barrier();
      const finalRelease = barrier();
      t.after(() => {
        workersReady.resolve();
      });
      t.after(() => {
        finalRelease.resolve();
      });
      const f = await fixture(t, {
        beforeModel: async () => {
          const n = ++arrivals;
          const firstWorker = roleDirected ? 2 : 3;
          if (n === firstWorker + 2) {
            finalStarted.resolve();
            await finalRelease.promise;
            return;
          }
          if (n < firstWorker || n > firstWorker + 1) return;
          if (n === firstWorker + 1) workersReady.resolve();
          await workersReady.promise;
        },
        output: (request) => {
          sampled.push(request);
          const prompt = lastUser(request);
          if (prompt === priorContext)
            return "PRIOR_REPLY: customer-alpha confirmed.";
          if (prompt.includes("组长拆解]"))
            return "PLAN: independent QA and security checks.";
          if (prompt.includes("成员任务]"))
            return prompt.includes("「QA」")
              ? `QA_REPORT:${"q".repeat(2000)}:QA_REPORT_TAIL`
              : "SECURITY_REPORT: retain the unresolved security risk.";
          assert.match(prompt, /组长汇总\]/);
          assert.match(prompt, /QA_REPORT:/);
          assert.match(prompt, /SECURITY_REPORT:/);
          assert.match(prompt, /truncated=yes/);
          assert.ok(!prompt.includes("QA_REPORT_TAIL"));
          return "TEAM_FINAL: evidence and unresolved risk retained.";
        },
      });
      let server = await f.control(null);
      const worker = await f.worker();
      worker.start();
      const { thread, plan } = await prepare(server.client, roleDirected);
      const events: ControlTeamRunAcceptedEvent[] = [];
      const result = await startControlTeamTurn({
        client: server.client,
        threadId: thread.threadId,
        expectedRevision: thread.revision,
        content: originalTask,
        plan,
        responseMode: "manager",
        managerResponseKind: "office",
        pollIntervalMs: 10,
        runDeadlineMs: 20_000,
        idempotencyKey: (operation) => `acceptance:${operation}`,
        onTeamRunAccepted: (event) => {
          events.push(event);
        },
      });
      const finalWaitAbort = new AbortController();
      await Promise.race([
        finalStarted.promise,
        setTimeout(20_000, undefined, { signal: finalWaitAbort.signal }).then(
          () => {
            throw Error("team_fixture_final_not_started");
          },
        ),
      ]).finally(() => {
        finalWaitAbort.abort();
      });
      const liveCursor = await disconnectAfterRunStarted(
        server.client,
        result.run.runId,
      );
      await server.runtime.app.close();
      server = await f.control(null);
      const liveResume = await server.client.openRunEventStream({
        runId: result.run.runId,
        afterSequence: liveCursor,
        view: "client",
        signal: AbortSignal.timeout(10_000),
      });
      finalRelease.resolve();
      assert.equal(
        (await completed(server.client, result.run.runId)).status,
        "completed",
      );
      // This fixture disables background scans. Deliver through the actual
      // outbox dispatcher; Main's continuous wakeup lifecycle is tested separately.
      await server.runtime.outboxDispatcher.wake();
      const liveText = await liveResume.text();
      assert.match(liveText, /event: model\.output\.delta/);
      assert.equal((liveText.match(/event: run\.completed/g) ?? []).length, 1);
      const resumedSequences = [...liveText.matchAll(/^id: (\d+)$/gm)].map(
        (match) => Number(match[1]),
      );
      assert.ok(resumedSequences.every((sequence) => sequence > liveCursor));
      assert.equal(result.message.content, originalTask);
      assert.equal(result.run.threadId, thread.threadId);
      assert.deepEqual(
        events.map((event) => event.kind),
        roleDirected
          ? ["worker", "worker", "managerFinal"]
          : ["managerPlanning", "worker", "worker", "managerFinal"],
      );
      assert.equal(sampled.length, roleDirected ? 4 : 5);
      const children = events.filter((event) => event.kind === "worker");
      for (const event of children) {
        const branch = (await server.client.getThread(event.runThreadId))
          .thread;
        assert.equal(branch.forkedFromThreadId, thread.threadId);
        assert.notEqual(branch.forkedThroughHistorySequence, null);
        const request = sampled.find((value) => value.runId === event.runId)!;
        const context = JSON.stringify(request.input.items);
        assert.ok(context.includes(priorContext));
        assert.ok(context.includes("PRIOR_REPLY: customer-alpha confirmed."));
        assert.ok(context.includes(originalTask));
        assert.ok(!context.includes("QA_REPORT:"));
        assert.ok(!context.includes("SECURITY_REPORT:"));
      }
      const transcript = await server.client.listThreadMessages(
        thread.threadId,
      );
      assert.equal(
        transcript.data.filter((message) => message.content === originalTask)
          .length,
        1,
      );
      assert.equal(
        transcript.data.filter(
          (message) =>
            message.content ===
            "TEAM_FINAL: evidence and unresolved risk retained.",
        ).length,
        1,
      );
      const stream = await server.client.openRunEventStream({
        runId: result.run.runId,
        afterSequence: 0,
        view: "client",
        signal: AbortSignal.timeout(10_000),
      });
      const sse = await stream.text();
      assert.match(sse, /event: model\.output\.delta/);
      assert.equal((sse.match(/event: run\.completed/g) ?? []).length, 1);
      const sequences = [...sse.matchAll(/^id: (\d+)$/gm)].map((match) =>
        Number(match[1]),
      );
      assert.ok(sequences.length > 1);
      const cursor = sequences.at(-2)!;
      await server.runtime.app.close();
      server = await f.control(null);
      const resumed = await server.client.openRunEventStream({
        runId: result.run.runId,
        afterSequence: cursor,
        view: "client",
        signal: AbortSignal.timeout(10_000),
      });
      const resumedText = await resumed.text();
      assert.deepEqual(
        [...resumedText.matchAll(/^id: (\d+)$/gm)].map((match) =>
          Number(match[1]),
        ),
        sequences.filter((sequence) => sequence > cursor),
      );
      assert.deepEqual(
        await server.client.listThreadMessages(thread.threadId),
        transcript,
      );
      assert.equal(
        sampled.length,
        roleDirected ? 4 : 5,
        "reading/reopening must not execute the Team again",
      );
    },
  );
}

workflowDeploymentIntegrationTest(
  "headless Team recovers a failed member with the manager before delegating the final response to the selected member",
  async (t, fixture) => {
    const sampled: ModelRequest[] = [];
    const f = await fixture(t, {
      output: (request) => {
        sampled.push(request);
        const prompt = lastUser(request);
        if (prompt === priorContext)
          return "PRIOR_REPLY: customer-alpha confirmed.";
        if (prompt.includes("成员任务]") && prompt.includes("「QA」"))
          throw Error("synthetic_team_qa_failure");
        if (prompt.includes("恢复任务]"))
          return "RECOVERED_QA: missing external evidence remains unknown.";
        if (prompt.includes("成员任务]"))
          return "SECURITY_REPORT: preserve risk.";
        if (prompt.includes("成员报告]")) {
          assert.match(prompt, /RECOVERED_QA:/);
          assert.match(prompt, /recovered=yes/);
          return "@Security answer with the unresolved risks.\n[[CrewON delegate:security]]";
        }
        assert.match(prompt, /成员直答\]/);
        assert.match(prompt, /TEAM_ORIGINAL/);
        assert.match(prompt, /RECOVERED_QA:/);
        return "MEMBER_FINAL: evidence gap and security risk retained.";
      },
    });
    const server = await f.control(null);
    const worker = await f.worker();
    worker.start();
    const { thread, plan } = await prepare(server.client, true);
    const events: ControlTeamRunAcceptedEvent[] = [];
    const result = await startControlTeamTurn({
      client: server.client,
      threadId: thread.threadId,
      expectedRevision: thread.revision,
      content: originalTask,
      plan,
      responseMode: "member",
      pollIntervalMs: 10,
      runDeadlineMs: 20_000,
      idempotencyKey: (operation) => `recovery:${operation}`,
      onTeamRunAccepted: (event) => {
        events.push(event);
      },
    });
    assert.equal(
      (await completed(server.client, result.run.runId)).status,
      "completed",
    );
    const failed = events.find(
      (event) => event.kind === "worker" && event.memberId === "qa",
    )!;
    assert.equal(
      (await server.client.getRun(failed.runId)).run.status,
      "failed",
    );
    const recovered = events.find((event) => event.kind === "workerRecovery")!;
    assert.equal(recovered.recoveredMemberId, "qa");
    assert.equal(recovered.memberId, "manager");
    assert.equal(recovered.runThreadId, failed.runThreadId);
    assert.equal(events.at(-2)?.kind, "managerDelegation");
    assert.equal(events.at(-1)?.kind, "memberFinal");
    assert.equal(events.at(-1)?.memberId, "security");
    assert.equal(events.at(-1)?.runThreadId, thread.threadId);
    assert.equal(
      sampled.find((request) => request.runId === result.run.runId)
        ?.agentVersionId,
      plan.workers[1]!.agentVersionId,
    );
    const messages = (await server.client.listThreadMessages(thread.threadId))
      .data;
    assert.equal(
      messages.filter((message) => message.content === originalTask).length,
      1,
    );
    assert.equal(
      messages.at(-1)?.content,
      "MEMBER_FINAL: evidence gap and security risk retained.",
    );
    assert.equal(
      sampled.filter((request) => lastUser(request).includes("恢复任务]"))
        .length,
      1,
    );
  },
);

workflowDeploymentIntegrationTest(
  "headless Team pauses the requested Goal during child work, resumes only its final main turn, and retains explicit pause/cancel behavior",
  async (t, fixture) => {
    const finalRelease = barrier();
    const finalStarted = barrier();
    t.after(() => {
      finalRelease.resolve();
    });
    let calls = 0;
    let client: ControlApiClient;
    let threadId: string;
    const workerGoals: { status: string; objective: string; goalId: string }[] =
      [];
    const f = await fixture(t, {
      beforeModel: async () => {
        const n = ++calls;
        if (n === 2 || n === 3) {
          const { goal } = await client.getThreadGoal(threadId);
          assert.ok(goal);
          workerGoals.push(goal);
        }
        if (n === 4) {
          finalStarted.resolve();
          await finalRelease.promise;
        }
      },
      output: (request) =>
        lastUser(request) === priorContext
          ? "PRIOR_REPLY: customer-alpha confirmed."
          : "MEMBER_REPORT: evidence remains bounded.",
    });
    const server = await f.control(null);
    client = server.client;
    const worker = await f.worker();
    worker.start();
    const { thread, plan } = await prepare(client, true);
    threadId = thread.threadId;
    const events: ControlTeamRunAcceptedEvent[] = [];
    const result = await startControlTeamTurn({
      client,
      threadId,
      expectedRevision: thread.revision,
      content: originalTask,
      plan,
      responseMode: "manager",
      managerResponseKind: "experts",
      executionIntent: "goal",
      pollIntervalMs: 10,
      runDeadlineMs: 20_000,
      idempotencyKey: (operation) => `goal:${operation}`,
      onTeamRunAccepted: (event) => {
        events.push(event);
      },
    });
    assert.equal(workerGoals.length, 2);
    const waitAbort = new AbortController();
    await Promise.race([
      finalStarted.promise,
      setTimeout(20_000, undefined, { signal: waitAbort.signal }).then(() => {
        throw Error("team_fixture_final_not_started");
      }),
    ]).finally(() => {
      waitAbort.abort();
    });
    assert.ok(
      workerGoals.every(
        (goal) => goal.status === "paused" && goal.objective === originalTask,
      ),
    );
    const active = (await client.getThreadGoal(threadId)).goal!;
    assert.equal(active.status, "active");
    assert.equal(active.objective, originalTask);
    assert.equal(active.goalId, workerGoals[0]!.goalId);
    assert.equal(result.run.goalBinding?.goalId, active.goalId);
    for (const event of events.filter((event) => event.kind === "worker"))
      assert.equal((await client.getRun(event.runId)).run.goalBinding, null);
    const paused = await client.setThreadGoalWithExecutionIntentV1(
      threadId,
      {
        expectedRevision: active.revision,
        objective: null,
        status: "paused",
        tokenBudget: { kind: "keep" },
      },
      "explicit-user-pause",
    );
    assert.equal(paused.goal?.status, "paused");
    assert.equal(paused.canceledRun, null);
    assert.equal(paused.retainedRun?.runId, result.run.runId);
    assert.equal(paused.retainedRun?.cancelRequested, false);
    await client.cancelRun(
      result.run.runId,
      {
        expectedRevision: paused.retainedRun!.revision,
      },
      "explicit-user-stop",
    );
    finalRelease.resolve();
    assert.equal(
      (await completed(client, result.run.runId)).status,
      "canceled",
    );
    assert.equal((await client.getThreadGoal(threadId)).goal?.status, "paused");
    assert.equal(
      calls <= 4,
      true,
      "pausing the Goal must prevent automatic continuation",
    );
  },
);
