import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { ControlApiClient } from "@crewon/control-client";
import { WORKFLOW_RECOVERY_CONTEXT_HEADER } from "@crewon/contracts";
import {
  ControlWorkflowCommands,
  WorkflowCommandUnconfirmedError,
} from "../../crewon-ui/src/lib/control-runtime/controlWorkflowCommands.ts";
import { ControlWorkflowIntentJournal } from "../../crewon-ui/src/lib/control-runtime/controlWorkflowIntentJournal.ts";
import { workflowIntentMemoryStorage } from "../../crewon-ui/src/lib/control-runtime/controlWorkflowCommands.test-support.ts";
import {
  workflowDeploymentFixture,
  deploymentWorkflowSource,
  waitWorkflow,
} from "./workflow-deployment.test-support.ts";

const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "frontend exact intents survive unknown admission and review, changed deployment, Control/Worker restart and terminal SSE",
  async (t) => {
    const f = await workflowDeploymentFixture(t);
    let server = await f.control();
    const { thread } = await server.client.createThread(
      { title: "Frontend durable recovery" },
      "frontend-root-thread",
    );
    const { workflowVersion } = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(),
    );
    const storage = workflowIntentMemoryStorage();
    const journal = () =>
      new ControlWorkflowIntentJournal({ storage: () => storage });
    const delivered: {
      path: string;
      key: string | null;
      context: string | null;
      body: string;
    }[] = [];
    const commands = (lostSuffix?: string) =>
      new ControlWorkflowCommands({
        journal: journal(),
        client: new ControlApiClient({
          baseUrl: server.baseUrl,
          accessToken: f.token,
          csrfToken: f.token,
          origin: f.origin,
          fetch: async (url, init) => {
            const path = new URL(String(url)).pathname;
            const response = await fetch(url, init);
            if (init?.method === "POST") {
              const headers = new Headers(init.headers);
              delivered.push({
                path,
                key: headers.get("idempotency-key"),
                context: headers.get(WORKFLOW_RECOVERY_CONTEXT_HEADER),
                body: String(init.body),
              });
              if (lostSuffix && path.endsWith(lostSuffix) && response.ok) {
                await response.arrayBuffer();
                throw new Error("fixture lost response after actual commit");
              }
            }
            return response;
          },
        }),
      });
    const originalInput = { topic: "原始输入" };
    await assert.rejects(
      commands("/workflow-runs:admit-v1").start({
        threadId: thread.threadId,
        workflowVersionId: workflowVersion.workflowVersionId,
        input: originalInput,
      }),
      WorkflowCommandUnconfirmedError,
    );
    originalInput.topic = "must not replace stored input";
    let availability = await commands().readAvailability();
    assert.equal(availability.pending.length, 1);
    const intent = availability.pending[0]!;
    assert.equal(
      delivered.length,
      1,
      "read-only discovery cannot resume execution",
    );
    const initial = (
      await server.client.listWorkflowRuns({
        workflowVersionId: workflowVersion.workflowVersionId,
      })
    ).data;
    assert.equal(initial.length, 1);
    assert.equal(
      initial[0]!.threadId,
      thread.threadId,
      "no hidden execution fork",
    );
    await server.runtime.app.close();
    server = await f.control({ ...f.workflow, maximumParallelNodes: 1 });
    assert.equal((await commands().readAvailability()).pending.length, 0);
    await assert.rejects(
      commands().recover(intent.id),
      /workflow_recovery_context_changed/,
    );
    assert.deepEqual(journal().get(intent.id), intent);
    assert.equal(
      delivered.length,
      1,
      "context mismatch rejected before replay dispatch",
    );
    assert.equal(f.requests.length, 0);
    await server.runtime.app.close();
    server = await f.control();
    const restored = await commands().recover(intent.id);
    assert.equal(restored.kind, "start");
    if (restored.kind !== "start") throw Error("wrong result");
    assert.equal(restored.response.disposition, "replayed");
    assert.equal(restored.response.run.runId, initial[0]!.runId);
    assert.deepEqual(delivered[1], delivered[0]);
    assert.equal(storage.length, 0);
    let worker = await f.worker();
    worker.start();
    const waiting = await waitWorkflow(
      server.client,
      restored.response.run.runId,
      (snapshot) =>
        snapshot.nodes.some((node) => node.status === "waitingHuman"),
    );
    await worker.close();
    const gate = waiting.nodes.find((node) => node.status === "waitingHuman")!;
    const comment = "  同意\n保留原意见  ";
    await assert.rejects(
      commands("/review-guarded-v1").review({
        snapshot: waiting,
        nodeId: gate.nodeId,
        decision: "approved",
        comment,
        commentContext: "descendants-v1",
      }),
      WorkflowCommandUnconfirmedError,
    );
    availability = await commands().readAvailability();
    const pendingReview = availability.pending[0]!;
    assert.equal(pendingReview.command.kind, "review");
    const locator = {
      runId: waiting.run.runId,
      nodeId: gate.nodeId,
      gateRequestId: gate.gate!.gateRequestId,
    };
    assert.equal(
      (await server.client.getWorkflowHumanGateReview(locator)).review!.comment,
      comment,
    );
    assert.equal(
      (await commands().readAvailability()).pending.length,
      1,
      "a GET is not acknowledgement of exact review mode",
    );
    await server.runtime.app.close();
    server = await f.control();
    const approved = await commands().recover(pendingReview.id);
    assert.equal(approved.kind, "review");
    if (approved.kind !== "review") throw Error("wrong review result");
    assert.equal(approved.response.disposition, "replayed");
    assert.equal(approved.response.review.comment, comment);
    assert.deepEqual(delivered[3], delivered[2]);
    assert.equal(storage.length, 0);
    worker = await f.worker();
    worker.start();
    const completed = await waitWorkflow(
      server.client,
      waiting.run.runId,
      (snapshot) => snapshot.run.status === "completed",
    );
    await worker.close();
    assert.deepEqual(f.requests, ["agent", "verifier"]);
    const transcript = await server.client.getThreadTranscriptSnapshot(
      thread.threadId,
    );
    const replies = transcript.transcriptWindow.messageWindow.data.filter(
      (message) => message.role === "assistant",
    );
    assert.equal(replies.length, 1);
    assert.equal(transcript.activeRunId, null);
    const events = await fetch(
      `${server.baseUrl}/api/v1/runs/${waiting.run.runId}/events?view=transcript`,
      {
        headers: {
          "authorization": `Bearer ${f.token}`,
          "origin": f.origin,
          "last-event-id": String(completed.run.lastSequence - 1),
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(events.status, 200);
    assert.match(await events.text(), /event: run.completed/);
    assert.equal(
      (
        await server.client.listWorkflowRuns({
          workflowVersionId: workflowVersion.workflowVersionId,
        })
      ).data.length,
      1,
    );
    t.diagnostic(
      JSON.stringify({
        case: "frontend-intent-admission-review-recovery",
        rootCount: 1,
        modelCalls: f.requests,
        mainReplies: replies.length,
        originalBodiesAndKeys: true,
        terminalSse: true,
      }),
    );
  },
);

pgTest(
  "frontend unknown cancellation recovers its original revision after Control restart and never fabricates terminal cancellation",
  async (t) => {
    const f = await workflowDeploymentFixture(t);
    let server = await f.control();
    const { thread } = await server.client.createThread(
      { title: "Frontend cancel recovery" },
      "frontend-cancel-thread",
    );
    const { workflowVersion } = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(false),
    );
    const storage = workflowIntentMemoryStorage();
    const journal = () =>
      new ControlWorkflowIntentJournal({ storage: () => storage });
    let commands = new ControlWorkflowCommands({
      client: server.client,
      journal: journal(),
    });
    const started = await commands.start({
      threadId: thread.threadId,
      workflowVersionId: workflowVersion.workflowVersionId,
      input: { topic: "cancel before sampling" },
    });
    assert.equal(started.kind, "start");
    if (started.kind !== "start") throw Error("wrong result");
    const snapshot = await server.client.getWorkflowRunSnapshot(
      started.response.run.runId,
    );
    const lost = new ControlApiClient({
      baseUrl: server.baseUrl,
      accessToken: f.token,
      csrfToken: f.token,
      origin: f.origin,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (
          init?.method === "POST" &&
          new URL(String(url)).pathname.endsWith(":cancel-guarded-v1") &&
          response.ok
        ) {
          await response.arrayBuffer();
          throw Error("cancel accepted; response lost");
        }
        return response;
      },
    });
    await assert.rejects(
      new ControlWorkflowCommands({ client: lost, journal: journal() }).cancel(
        snapshot,
      ),
      WorkflowCommandUnconfirmedError,
    );
    const pending = (await commands.readAvailability()).pending[0]!;
    assert.equal(pending.command.kind, "cancel");
    if (pending.command.kind !== "cancel") throw Error("wrong stored command");
    assert.equal(pending.command.body.expectedRevision, snapshot.run.revision);
    assert.ok(
      (await server.client.getWorkflowRunSnapshot(snapshot.run.runId)).run
        .revision > snapshot.run.revision,
    );
    await server.runtime.app.close();
    server = await f.control();
    commands = new ControlWorkflowCommands({
      client: server.client,
      journal: journal(),
    });
    const canceled = await commands.recover(pending.id);
    assert.equal(canceled.kind, "cancel");
    if (canceled.kind !== "cancel") throw Error("wrong cancellation result");
    assert.equal(canceled.response.disposition, "replayed");
    assert.equal(canceled.response.run.cancelRequested, true);
    assert.equal(
      canceled.response.run.status,
      "queued",
      "accepted cancellation is not terminal",
    );
    assert.equal(storage.length, 0);
    const worker = await f.worker();
    worker.start();
    await waitWorkflow(
      server.client,
      snapshot.run.runId,
      (value) => value.run.status === "canceled",
    );
    await worker.close();
    assert.equal(f.requests.length, 0);
    const transcript = await server.client.getThreadTranscriptSnapshot(
      thread.threadId,
    );
    assert.equal(transcript.activeRunId, null);
    assert.equal(
      transcript.transcriptWindow.messageWindow.data.filter(
        (message) => message.role === "assistant",
      ).length,
      0,
    );
    t.diagnostic(
      JSON.stringify({
        case: "frontend-intent-cancel-recovery",
        originalRevision: snapshot.run.revision,
        acceptedStatus: canceled.response.run.status,
        terminalStatus: "canceled",
        modelCalls: 0,
      }),
    );
  },
);

pgTest(
  "two frontend owners recover separate unknown intents and receive only their own parallel Workflow results",
  async (t) => {
    let release!: () => void, bothStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const both = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    let active = 0,
      peak = 0;
    const f = await workflowDeploymentFixture(t, {
      async beforeModel(role) {
        if (role !== "agent") return;
        active++;
        peak = Math.max(peak, active);
        if (active === 2) bothStarted();
        await held;
        active--;
      },
      output(request) {
        return JSON.stringify({
          topic: JSON.stringify(request).includes("chat-one")
            ? "chat-one"
            : "chat-two",
        });
      },
    });
    const server = await f.control();
    const { workflowVersion } = await server.client.publishWorkflowVersion(
      deploymentWorkflowSource(false),
    );
    const storage = workflowIntentMemoryStorage();
    const owner = (loseResponse = false) =>
      new ControlWorkflowCommands({
        journal: new ControlWorkflowIntentJournal({ storage: () => storage }),
        client: loseResponse
          ? new ControlApiClient({
              baseUrl: server.baseUrl,
              accessToken: f.token,
              csrfToken: f.token,
              origin: f.origin,
              fetch: async (url, init) => {
                const response = await fetch(url, init);
                if (
                  init?.method === "POST" &&
                  new URL(String(url)).pathname.endsWith(
                    "/workflow-runs:admit-v1",
                  ) &&
                  response.ok
                ) {
                  await response.arrayBuffer();
                  throw Error("independent owner's response lost");
                }
                return response;
              },
            })
          : server.client,
      });
    const threads = await Promise.all(
      ["chat-one", "chat-two"].map(async (topic) => {
        const { thread } = await server.client.createThread(
          { title: topic },
          `frontend-${topic}`,
        );
        await assert.rejects(
          owner(true).start({
            threadId: thread.threadId,
            workflowVersionId: workflowVersion.workflowVersionId,
            input: { topic },
          }),
          WorkflowCommandUnconfirmedError,
        );
        return { thread, topic };
      }),
    );
    const pending = (await owner().readAvailability()).pending;
    assert.equal(pending.length, 2);
    assert.notEqual(pending[0]!.id, pending[1]!.id);
    const first = await owner().recover(pending[0]!.id);
    assert.equal(
      (await owner().readAvailability()).pending[0]!.id,
      pending[1]!.id,
    );
    const second = await owner().recover(pending[1]!.id);
    assert.equal(storage.length, 0);
    if (first.kind !== "start" || second.kind !== "start")
      throw Error("wrong result");
    assert.notEqual(first.response.run.runId, second.response.run.runId);
    const worker = await f.worker();
    worker.start();
    try {
      assert.equal(
        await Promise.race([
          both.then(() => "both"),
          setTimeout(5000, "timeout", { ref: false }),
        ]),
        "both",
      );
      assert.equal(peak, 2);
    } finally {
      release();
    }
    const completed = await Promise.all(
      [first.response.run, second.response.run].map((run) =>
        waitWorkflow(
          server.client,
          run.runId,
          (snapshot) => snapshot.run.status === "completed",
        ),
      ),
    );
    await worker.close();
    for (const { thread, topic } of threads) {
      const root = completed.find(
        (snapshot) => snapshot.run.threadId === thread.threadId,
      )!;
      assert.ok(root);
      const transcript = await server.client.getThreadTranscriptSnapshot(
        thread.threadId,
      );
      const replies = transcript.transcriptWindow.messageWindow.data.filter(
        (message) => message.role === "assistant",
      );
      assert.equal(replies.length, 1);
      assert.ok(replies[0]!.content.includes(topic));
      assert.ok(
        !replies[0]!.content.includes(
          topic === "chat-one" ? "chat-two" : "chat-one",
        ),
      );
      assert.equal(
        transcript.transcriptWindow.runBindings.find(
          (binding) => binding.messageId === replies[0]!.messageId,
        )?.runId,
        root.run.runId,
      );
      assert.equal(transcript.activeRunId, null);
    }
    assert.equal(f.requests.length, 4);
    assert.equal(
      (
        await server.client.listWorkflowRuns({
          workflowVersionId: workflowVersion.workflowVersionId,
        })
      ).data.length,
      2,
    );
    t.diagnostic(
      JSON.stringify({
        case: "two-frontend-owners-parallel-results",
        roots: 2,
        peakProducerModels: peak,
        modelCalls: f.requests.length,
        repliesPerMainThread: 1,
        crossAttribution: false,
      }),
    );
  },
);
