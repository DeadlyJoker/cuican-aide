import assert from "node:assert/strict";
import { ControlApiClientError } from "@crewon/control-client";
import {
  deploymentWorkflowSource,
  waitWorkflow,
} from "./workflow-deployment.test-support.ts";
import { workflowDeploymentIntegrationTest } from "./workflow-deployment-integration.test-support.ts";

workflowDeploymentIntegrationTest(
  "a legacy review after an explicit contextual gate stays metadata-only instead of inheriting the earlier wake mode",
  async (t, fixture) => {
    const requests: string[] = [];
    const f = await fixture(t, {
      output(request) {
        requests.push(JSON.stringify(request));
        return '{"topic":"reviewed"}';
      },
    });
    const server = await f.control(),
      base = deploymentWorkflowSource(),
      gate = base.nodes.find((node) => node.kind === "humanGate")!;
    const source = {
      ...base,
      workflowId: "review-mixed",
      workflowVersionId: "review-mixed-v1",
      nodes: [
        ...base.nodes.filter((node) => node.kind !== "verification"),
        {
          ...gate,
          nodeId: "legacy-review",
          title: "Legacy review",
          dependsOn: ["review"],
        },
        ...base.nodes
          .filter((node) => node.kind === "verification")
          .map((node) => ({ ...node, dependsOn: ["legacy-review"] })),
      ],
    };
    const published = await server.client.publishWorkflowVersion(source);
    const thread = (
      await server.client.createThread(
        { title: "Mixed reviews" },
        "mixed-reviews-thread",
      )
    ).thread;
    const root = (
      await server.client.startWorkflowRun(
        {
          threadId: thread.threadId,
          workflowVersionId: published.workflowVersion.workflowVersionId,
          input: { topic: "safe" },
        },
        "mixed-review-root",
      )
    ).run;
    const worker = await f.worker(f.workflow, 1);
    worker.start();
    for (const id of ["review", "legacy-review"]) {
      const view = await waitWorkflow(
        server.client,
        root.runId,
        (view) =>
          view.nodes.find((node) => node.nodeId === id)?.status ===
          "waitingHuman",
      );
      const node = view.nodes.find((node) => node.nodeId === id)!;
      await server.client.reviewWorkflowHumanGate(
        {
          runId: root.runId,
          nodeId: id,
          gateRequestId: node.gate!.gateRequestId,
        },
        {
          inputDigest: node.inputDigest!,
          decision: "approved",
          comment:
            id === "review" ? "explicit-context-only" : "legacy-metadata-only",
          ...(id === "review"
            ? { commentContext: "descendants-v1" as const }
            : {}),
        },
      );
    }
    await waitWorkflow(
      server.client,
      root.runId,
      (view) => view.run.status === "completed",
    );
    assert.equal(requests.length, 2);
    assert.ok(requests[1]!.includes("explicit-context-only"));
    assert.equal(requests[1]!.includes("legacy-metadata-only"), false);
  },
);

workflowDeploymentIntegrationTest(
  "real branching Workflow isolates human comments by DAG ancestry, persists exact child context and rejoins after restart",
  async (t, fixture) => {
    const sampled = new Map<string, string>();
    const f = await fixture(t, {
      output(request) {
        const text = JSON.stringify(request);
        const branch = [
          "Branch A result",
          "Branch B result",
          "Join both results",
        ].find((value) => text.includes(value))!;
        assert.ok(branch);
        assert.equal(
          sampled.has(branch),
          false,
          "restart must not resample completed children",
        );
        sampled.set(branch, text);
        return '{"topic":"reviewed"}';
      },
    });
    let server = await f.control();
    const base = deploymentWorkflowSource(),
      schema = base.inputSchema;
    const gate = base.nodes.find((node) => node.kind === "humanGate")!;
    const agent = base.nodes.find((node) => node.kind === "agent")!;
    const verify = base.nodes.find((node) => node.kind === "verification")!;
    const published = await server.client.publishWorkflowVersion({
      ...base,
      workflowId: "review-branches",
      workflowVersionId: "review-branches-v1",
      entryNodeIds: ["gate-a", "gate-b"],
      outputNodeIds: ["join"],
      nodes: [
        { ...gate, nodeId: "gate-a", title: "审阅 A", dependsOn: [] },
        { ...gate, nodeId: "gate-b", title: "审阅 B", dependsOn: [] },
        {
          ...agent,
          nodeId: "branch-a",
          instruction: "Branch A result",
          dependsOn: ["gate-a"],
        },
        {
          ...agent,
          nodeId: "branch-b",
          instruction: "Branch B result",
          dependsOn: ["gate-b"],
        },
        {
          ...verify,
          nodeId: "join",
          instruction: "Join both results",
          dependsOn: ["branch-a", "branch-b"],
          inputSchema: {
            type: "object",
            properties: { "branch-a": schema, "branch-b": schema },
            required: ["branch-a", "branch-b"],
            additionalProperties: false,
          },
        },
      ],
    });
    const thread = (
      await server.client.createThread(
        { title: "Branch reviews" },
        "branch-review-thread",
      )
    ).thread;
    const root = (
      await server.client.startWorkflowRun(
        {
          threadId: thread.threadId,
          workflowVersionId: published.workflowVersion.workflowVersionId,
          input: { topic: "safe" },
        },
        "branch-review-root",
      )
    ).run;
    let worker = await f.worker(f.workflow, 2);
    worker.start();
    await waitWorkflow(
      server.client,
      root.runId,
      (view) =>
        view.nodes.filter((node) => node.status === "waitingHuman").length >= 2,
    );
    const comments = [
      "  branch-A-only\n保留 😀  ",
      "\ufeffbranch-B-only\n确认",
    ];
    for (const [index, id] of ["gate-a", "gate-b"].entries()) {
      const view = await server.client.getWorkflowRunSnapshot(root.runId),
        node = view.nodes.find((node) => node.nodeId === id)!;
      await server.client.reviewWorkflowHumanGate(
        {
          runId: root.runId,
          nodeId: id,
          gateRequestId: node.gate!.gateRequestId,
        },
        {
          inputDigest: node.inputDigest!,
          decision: "approved",
          comment: comments[index]!,
          commentContext: "descendants-v1",
        },
      );
      if (index === 0) {
        await waitWorkflow(
          server.client,
          root.runId,
          (view) =>
            view.nodes.find((node) => node.nodeId === "branch-a")?.status ===
            "completed",
        );
        await worker.close();
        await server.runtime.app.close();
        server = await f.control();
        worker = await f.worker(f.workflow, 2);
        worker.start();
      }
    }
    const final = await waitWorkflow(
      server.client,
      root.runId,
      (view) => view.run.status === "completed",
    );
    assert.equal(sampled.size, 3);
    assert.ok(sampled.get("Branch A result")!.includes("branch-A-only"));
    assert.equal(
      sampled.get("Branch A result")!.includes("branch-B-only"),
      false,
    );
    assert.ok(sampled.get("Branch B result")!.includes("branch-B-only"));
    assert.equal(
      sampled.get("Branch B result")!.includes("branch-A-only"),
      false,
    );
    assert.ok(sampled.get("Join both results")!.includes("branch-A-only"));
    assert.ok(sampled.get("Join both results")!.includes("branch-B-only"));
    for (const [id, expected] of [
      ["branch-a", [{ title: "审阅 A", comment: comments[0] }]],
      ["branch-b", [{ title: "审阅 B", comment: comments[1] }]],
      [
        "join",
        [
          { title: "审阅 A", comment: comments[0] },
          { title: "审阅 B", comment: comments[1] },
        ],
      ],
    ] as const) {
      const child = final.nodes.find((node) => node.nodeId === id)!.child!;
      const snapshot = await server.client.getThreadTranscriptSnapshot(
        child.threadId,
      );
      const messages = snapshot.transcriptWindow.messageWindow.data.map(
        (message) => message.content,
      );
      const start = messages.findIndex((text) =>
          text.startsWith("Approved human review comments"),
        ),
        end = messages.findIndex((text) => text.startsWith("Node input:"));
      assert.ok(start >= 0 && end > start);
      const text = messages.slice(start, end).join("");
      assert.deepEqual(
        JSON.parse(text.slice(text.indexOf("\n") + 1)),
        expected,
      );
      assert.ok(messages.every((text) => Buffer.byteLength(text) <= 9999));
      assert.deepEqual(
        await server.client.getThreadTranscriptSnapshot(child.threadId),
        snapshot,
      );
    }
    const transcript = await server.client.getThreadTranscriptSnapshot(
      thread.threadId,
    );
    assert.equal(transcript.activeRunId, null);
    assert.equal(
      transcript.transcriptWindow.messageWindow.data.at(-1)!.content,
      '{"topic":"reviewed"}',
    );
  },
);

workflowDeploymentIntegrationTest(
  "aggregate review context overflow rejects the approval atomically, then accepts shorter context without duplicate sampling",
  async (t, fixture) => {
    let samples = 0;
    const f = await fixture(t, {
      output() {
        samples++;
        return '{"topic":"reviewed"}';
      },
    });
    const server = await f.control(),
      base = deploymentWorkflowSource(),
      schema = base.inputSchema;
    const gate = base.nodes.find((node) => node.kind === "humanGate")!,
      verifier = base.nodes.find((node) => node.kind === "verification")!;
    const ids = Array.from({ length: 4 }, (_, i) => `gate-${i}`);
    const published = await server.client.publishWorkflowVersion({
      ...base,
      workflowId: "review-budget",
      workflowVersionId: "review-budget-v1",
      entryNodeIds: ids,
      outputNodeIds: ["verify"],
      nodes: [
        ...ids.map((nodeId) => ({
          ...gate,
          nodeId,
          title: nodeId,
          dependsOn: [],
        })),
        {
          ...verifier,
          dependsOn: ids,
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(ids.map((id) => [id, schema])),
            required: ids,
            additionalProperties: false,
          },
        },
      ],
    });
    const thread = (
      await server.client.createThread(
        { title: "Review budget" },
        "review-budget-thread",
      )
    ).thread;
    const root = (
      await server.client.startWorkflowRun(
        {
          threadId: thread.threadId,
          workflowVersionId: published.workflowVersion.workflowVersionId,
          input: { topic: "safe" },
        },
        "review-budget-root",
      )
    ).run;
    let worker = await f.worker(f.workflow, 2);
    worker.start();
    await waitWorkflow(
      server.client,
      root.runId,
      (view) =>
        view.nodes.filter((node) => node.status === "waitingHuman").length >= 2,
    );
    // Allow the scheduler to publish the other two gates; no child is eligible yet.
    for (const [index, id] of ids.entries()) {
      const view = await waitWorkflow(
        server.client,
        root.runId,
        (view) =>
          view.nodes.find((node) => node.nodeId === id)?.status ===
          "waitingHuman",
      );
      const node = view.nodes.find((node) => node.nodeId === id)!;
      const locator = {
        runId: root.runId,
        nodeId: id,
        gateRequestId: node.gate!.gateRequestId,
      };
      const command = {
        inputDigest: node.inputDigest!,
        decision: "approved" as const,
        comment: "x".repeat(4096),
        commentContext: "descendants-v1" as const,
      };
      if (index < 3) {
        await server.client.reviewWorkflowHumanGate(locator, command);
        continue;
      }
      await worker.close();
      const before = await server.client.getWorkflowRunSnapshot(root.runId);
      await assert.rejects(
        server.client.reviewWorkflowHumanGate(locator, command),
        (error: unknown) =>
          error instanceof ControlApiClientError &&
          error.status === 400 &&
          error.message.includes("workflow_review_context_limit"),
      );
      assert.deepEqual(
        await server.client.getWorkflowRunSnapshot(root.runId),
        before,
      );
      assert.equal(
        (await server.client.getWorkflowHumanGateReview(locator)).review,
        null,
      );
      assert.equal(samples, 0);
      await server.client.reviewWorkflowHumanGate(locator, {
        ...command,
        comment: "  缩短后确认 😀  ",
      });
      worker = await f.worker(f.workflow, 2);
      worker.start();
    }
    const final = await waitWorkflow(
      server.client,
      root.runId,
      (view) => view.run.status === "completed",
    );
    assert.equal(samples, 1);
    const child = final.nodes.find(
      (node) => node.kind === "verification",
    )!.child!;
    const messages = (
      await server.client.getThreadTranscriptSnapshot(child.threadId)
    ).transcriptWindow.messageWindow.data;
    assert.ok(
      messages.every((message) => Buffer.byteLength(message.content) <= 9999),
    );
    assert.ok(
      messages
        .map((message) => message.content)
        .join("")
        .includes("缩短后确认"),
    );
  },
);
