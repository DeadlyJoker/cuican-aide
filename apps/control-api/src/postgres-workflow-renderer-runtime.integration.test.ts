import assert from "node:assert/strict";
import { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { ControlApiClient } from "@crewon/control-client";
import { ControlDurableWorkflowRuntime } from "../../crewon-ui/src/lib/control-runtime/controlDurableWorkflowRuntime.ts";
import { ControlWorkflowIntentJournal } from "../../crewon-ui/src/lib/control-runtime/controlWorkflowIntentJournal.ts";
import { workflowIntentMemoryStorage } from "../../crewon-ui/src/lib/control-runtime/controlWorkflowCommands.test-support.ts";
import {
  workflowDeploymentFixture,
  waitWorkflow,
} from "./workflow-deployment.test-support.ts";

import {
  workflowDeploymentIntegrationTest,
  type WorkflowDeploymentFixtureFactory,
} from "./workflow-deployment-integration.test-support.ts";
const nodes = (gate: boolean) => [
  {
    type: "agent" as const,
    title: "Producer",
    instruction: "Review the source and produce evidence",
    agentVersionId: "agent-1",
  },
  ...(gate
    ? [
        {
          type: "humanGate" as const,
          title: "Release approval",
          instruction: "Review the evidence",
        },
      ]
    : []),
  {
    type: "verification" as const,
    title: "Verifier",
    instruction: "Independently validate evidence",
    agentVersionId: "verifier-1",
  },
];
async function fixture(
  t: TestContext,
  create: WorkflowDeploymentFixtureFactory,
  options: Parameters<typeof workflowDeploymentFixture>[1] = {},
) {
  const f = await create(t, options);
  const configuration = {
    ...f.workflow,
    humanGates: [
      { approvalPolicyId: "control-workflow-user-gate-v1", approver: f.actor },
    ],
  };
  let server = await f.control(configuration);
  const storage = workflowIntentMemoryStorage();
  const ui = () =>
    new ControlDurableWorkflowRuntime({
      client: server.client,
      journal: new ControlWorkflowIntentJournal({ storage: () => storage }),
    });
  return {
    ...f,
    configuration,
    get server() {
      return server;
    },
    storage,
    ui,
    async reopen() {
      await server.runtime.app.close();
      server = await f.control(configuration);
    },
  };
}
const output =
  (text = "VERDICT: PASS\nEvidence verified") =>
  (request: unknown) =>
    JSON.stringify({
      result: JSON.stringify(request).includes("workflow-verifier-role")
        ? text
        : "Producer evidence",
    });

workflowDeploymentIntegrationTest(
  "the product Workflow renderer publishes without hidden Threads, uses the main root, survives reopen, passes exact review context and reads one final reply/SSE",
  async (t, create) => {
    const requests: string[] = [];
    const f = await fixture(t, create, {
      output(request) {
        requests.push(JSON.stringify(request));
        return output()(request);
      },
    });
    let ui = f.ui();
    const context = (await ui.availability()).contextId!;
    const definition = await ui.createWorkflow({
      title: "Release",
      description: "Evidence and independent verification",
      nodes: nodes(true),
    });
    assert.equal(
      (await f.server.client.listThreads({ limit: 100 })).data.length,
      0,
      "publishing cannot create a registration Thread",
    );
    const { thread } = await f.server.client.createThread(
      { title: "Main release task" },
      "renderer-main-thread",
    );
    const accepted = await ui.runWorkflow(
      {
        workflowVersionId: definition.config.workflowId,
        threadId: thread.threadId,
        prompt: "Review the original release",
      },
      { expectedRecoveryContext: context },
    );
    const runId = accepted.control!.knownRunId!;
    assert.equal(accepted.config.runs![0]!.status, "queued");
    assert.equal(accepted.control!.root!.threadId, thread.threadId);
    const worker = await f.worker(f.configuration);
    worker.start();
    await waitWorkflow(f.server.client, runId, (snapshot) =>
      snapshot.nodes.some((node) => node.status === "waitingHuman"),
    );
    await worker.close();
    const waiting = await ui.read({
      workflowVersionId: definition.config.workflowId,
      runId,
    });
    assert.equal(waiting.config.runs![0]!.status, "waitingForApproval");
    assert.deepEqual(f.requests, ["agent"]);
    const review = "  release with original opinion\n  ";
    const approved = await ui.resolveGate(
      {
        workflowVersionId: definition.config.workflowId,
        executionId: runId,
        nodeId: "node-02",
        decision: "approve",
        comment: review,
      },
      { expectedRecoveryContext: context },
    );
    assert.equal(
      approved.control!.awaitingSnapshot,
      true,
      "an approval receipt is not the next snapshot",
    );
    await f.reopen();
    ui = f.ui();
    assert.equal((await ui.availability()).contextId, context);
    await ui.read({ workflowVersionId: definition.config.workflowId, runId });
    assert.deepEqual(
      f.requests,
      ["agent"],
      "renderer reopen/read cannot run the verifier",
    );
    const restarted = await f.worker(f.configuration);
    restarted.start();
    const completed = await waitWorkflow(
      f.server.client,
      runId,
      (snapshot) => snapshot.run.status === "completed",
    );
    await restarted.close();
    const final = await ui.read({
      workflowVersionId: definition.config.workflowId,
      runId,
    });
    assert.equal(final.config.runs![0]!.status, "completed");
    assert.equal(final.config.runs![0]!.error, null);
    assert.match(final.config.runs![0]!.output, /^VERDICT: PASS/u);
    assert.deepEqual(f.requests, ["agent", "verifier"]);
    assert.ok(requests[1]!.includes("release with original opinion"));
    const transcript = await f.server.client.getThreadTranscriptSnapshot(
      thread.threadId,
    );
    const replies = transcript.transcriptWindow.messageWindow.data.filter(
      (message) => message.role === "assistant",
    );
    assert.equal(replies.length, 1);
    const original = transcript.transcriptWindow.messageWindow.data.filter(
      (message) => message.role === "user",
    );
    assert.equal(original.length, 1);
    assert.equal(original[0]!.content, "Review the original release");
    assert.equal(
      transcript.transcriptWindow.runBindings.find(
        (binding) => binding.messageId === original[0]!.messageId,
      )?.runId,
      runId,
    );
    assert.equal(
      transcript.transcriptWindow.runBindings.find(
        (binding) => binding.messageId === replies[0]!.messageId,
      )?.runId,
      runId,
    );
    assert.equal(transcript.activeRunId, null);
    const streamed = [];
    for await (const event of ui.events(
      {
        workflowVersionId: definition.config.workflowId,
        runId,
        afterSequence: 0,
      },
      AbortSignal.timeout(5000),
    ))
      streamed.push(event);
    assert.equal(streamed[0]?.type, "run.created");
    assert.equal(streamed.at(-1)?.type, "run.completed");
    assert.ok(streamed.every((event) => event.runId === runId));
    const resumed = [];
    for await (const event of ui.events(
      {
        workflowVersionId: definition.config.workflowId,
        runId,
        afterSequence: completed.run.lastSequence - 1,
      },
      AbortSignal.timeout(5000),
    ))
      resumed.push(event.type);
    assert.deepEqual(resumed, ["run.completed"]);
    t.diagnostic(
      JSON.stringify({
        case: "product-renderer-gate-reopen",
        models: f.requests,
        mainReplies: 1,
        hiddenRegistrationThreads: 0,
        readDrivenExecution: false,
        terminalSse: true,
      }),
    );
  },
);

workflowDeploymentIntegrationTest(
  "the product renderer retains rejection as a terminal Gate failure and never schedules verification",
  async (t, create) => {
    const f = await fixture(t, create, { output: output() });
    const ui = f.ui();
    const context = (await ui.availability()).contextId!;
    const definition = await ui.createWorkflow({
      title: "Reject release",
      description: "Reject unsafe evidence",
      nodes: nodes(true),
    });
    const { thread } = await f.server.client.createThread(
      { title: "Rejected release" },
      "renderer-reject-thread",
    );
    const accepted = await ui.runWorkflow(
      {
        workflowVersionId: definition.config.workflowId,
        threadId: thread.threadId,
        prompt: "Review",
      },
      { expectedRecoveryContext: context },
    );
    const worker = await f.worker(f.configuration);
    worker.start();
    const runId = accepted.control!.knownRunId!;
    await waitWorkflow(f.server.client, runId, (snapshot) =>
      snapshot.nodes.some((node) => node.status === "waitingHuman"),
    );
    await ui.resolveGate(
      {
        workflowVersionId: definition.config.workflowId,
        executionId: runId,
        nodeId: "node-02",
        decision: "reject",
        comment: "Insufficient evidence",
      },
      { expectedRecoveryContext: context },
    );
    await waitWorkflow(
      f.server.client,
      runId,
      (snapshot) => snapshot.run.status === "failed",
    );
    await worker.close();
    const failed = await ui.read({
      workflowVersionId: definition.config.workflowId,
      runId,
    });
    assert.equal(failed.config.runs![0]!.status, "failed");
    assert.equal(failed.config.runs![0]!.error, "workflow_human_gate_rejected");
    assert.deepEqual(f.requests, ["agent"]);
  },
);

for (const [name, text, failure] of [
  [
    "FAIL",
    "VERDICT: FAIL\nMissing evidence",
    "control_workflow_verification_failed",
  ],
  [
    "missing verdict",
    "Evidence without a verdict",
    "control_workflow_verification_invalid",
  ],
  [
    "multiple verdicts",
    "VERDICT: PASS\nVERDICT: FAIL",
    "control_workflow_verification_invalid",
  ],
  [
    "malformed spacing",
    "VERDICT : PASS",
    "control_workflow_verification_invalid",
  ],
  ["malformed case", "verdict: PASS", "control_workflow_verification_invalid"],
  [
    "malformed suffix",
    "VERDICT: PASS - complete",
    "control_workflow_verification_invalid",
  ],
  [
    "PASS with FAIL prose",
    "The instruction mentioned VERDICT: FAIL.\nVERDICT: PASS\nEvidence verified.",
    null,
  ],
] as const)
  workflowDeploymentIntegrationTest(
    `the product renderer preserves durable strict-v1 verification: ${name}`,
    async (t, create) => {
      const f = await fixture(t, create, { output: output(text) }),
        ui = f.ui();
      const context = (await ui.availability()).contextId!;
      const definition = await ui.createWorkflow({
        title: "Verify release",
        description: "Independent verification",
        nodes: nodes(false),
      });
      const { thread } = await f.server.client.createThread(
        { title: "Verifier result" },
        "renderer-verdict-thread",
      );
      const accepted = await ui.runWorkflow(
        {
          workflowVersionId: definition.config.workflowId,
          threadId: thread.threadId,
          prompt: "Review evidence",
        },
        { expectedRecoveryContext: context },
      );
      const runId = accepted.control!.knownRunId!,
        worker = await f.worker(f.configuration);
      worker.start();
      await waitWorkflow(f.server.client, runId, (snapshot) =>
        ["failed", "completed"].includes(snapshot.run.status),
      );
      await worker.close();
      const result = (
        await ui.read({
          workflowVersionId: definition.config.workflowId,
          runId,
        })
      ).config.runs![0]!;
      assert.equal(result.status, failure ? "failed" : "completed");
      assert.equal(result.error, failure);
      assert.deepEqual(f.requests, ["agent", "verifier"]);
      if (!failure) assert.equal(result.output, text);
      else
        assert.equal(
          await ui.verificationEvidence({
            workflowVersionId: definition.config.workflowId,
            runId,
            nodeId: "node-02",
          }),
          text,
        );
    },
  );

workflowDeploymentIntegrationTest(
  "the product renderer cancels an approved running verifier without letting late PASS resurrect the root",
  async (t, create) => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(t, create, {
      output: output(),
      async beforeModel(role) {
        if (role === "verifier") {
          entered();
          await held;
        }
      },
    });
    const ui = f.ui(),
      context = (await ui.availability()).contextId!;
    const definition = await ui.createWorkflow({
      title: "Cancel verifier",
      description: "Cancel after approval",
      nodes: nodes(true),
    });
    const { thread } = await f.server.client.createThread(
      { title: "Cancel active release" },
      "renderer-cancel-thread",
    );
    const accepted = await ui.runWorkflow(
      {
        workflowVersionId: definition.config.workflowId,
        threadId: thread.threadId,
        prompt: "Review",
      },
      { expectedRecoveryContext: context },
    );
    const runId = accepted.control!.knownRunId!,
      worker = await f.worker(f.configuration);
    worker.start();
    try {
      await waitWorkflow(f.server.client, runId, (snapshot) =>
        snapshot.nodes.some((node) => node.status === "waitingHuman"),
      );
      await ui.resolveGate(
        {
          workflowVersionId: definition.config.workflowId,
          executionId: runId,
          nodeId: "node-02",
          decision: "approve",
          comment: null,
        },
        { expectedRecoveryContext: context },
      );
      assert.equal(
        await Promise.race([
          started.then(() => "started"),
          setTimeout(5000, "timeout", { ref: false }),
        ]),
        "started",
      );
      const running = await ui.read({
        workflowVersionId: definition.config.workflowId,
        runId,
      });
      assert.equal(
        running.config.runs![0]!.executedNodes.at(-1)!.status,
        "running",
      );
      const requested = await ui.cancelWorkflow(
        { workflowVersionId: definition.config.workflowId, executionId: runId },
        { expectedRecoveryContext: context },
      );
      assert.equal(requested.config.runs![0]!.status, "canceling");
      assert.equal(requested.control!.root!.cancelRequested, true);
    } finally {
      release();
    }
    await waitWorkflow(
      f.server.client,
      runId,
      (snapshot) => snapshot.run.status === "canceled",
    );
    await worker.close();
    const final = await ui.read({
      workflowVersionId: definition.config.workflowId,
      runId,
    });
    assert.equal(final.config.runs![0]!.status, "canceled");
    assert.equal(final.config.runs![0]!.error, null);
    assert.deepEqual(f.requests, ["agent", "verifier"]);
  },
);
