import assert from "node:assert/strict";
import test from "node:test";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  RunExecutionService,
  type ProjectPlanningRuntimePort,
} from "@crewon/application";
import {
  parseProjectPlanningProposal,
  type ProjectPlanningCapability,
} from "@crewon/contracts/project-planning";
import { DatabaseSync } from "node:sqlite";
import { ordinaryProjectPlanningFixture } from "./project-planning-runtime-tools.test-support.ts";

test("without the explicit project-planning capability, an actual ordinary Turn retains its original Kernel tools and durable stream", async (t) => {
  let samples = 0;
  const transport: ModelTransportPort = {
    adapterName: "named-ordinary-planning-baseline",
    adapterVersion: "1",
    modelId: "named-model",
    async *stream(request, signal) {
      signal.throwIfAborted();
      samples++;
      assert.deepEqual(
        request.tools.map((tool) => tool.name),
        ["get_goal", "create_goal", "update_plan"],
      );
      yield { type: "output.delta", delta: "先讨论用户的想法。" };
      yield { type: "completed", checkpoint: null };
    },
  };
  const fixture = await ordinaryProjectPlanningFixture(t, { transport });
  const outcome = await fixture.openWorker().wake();
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.equal(samples, 1);
  const events = await fixture.events();
  assert.equal(
    events.filter((event) => event.type === "tool.requested").length,
    0,
  );
  assert.equal(
    events.filter((event) => event.type === "run.completed").length,
    1,
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "model.output.delta")
      .map((event) => event.data.delta),
    ["先讨论用户的想法。"],
  );
  await fixture.reopen();
  assert.deepEqual(await fixture.events(), events);
  assert.equal((await fixture.openWorker().wake()).kind, "idle");
  assert.equal(samples, 1);
});

const capability: ProjectPlanningCapability = {
  capabilityId: `sha256:${"a".repeat(64)}`,
  source: {
    pluginId: "crewon.short-drama",
    publisherId: "crewon.examples",
    version: "18.0.0",
    packageDigest: `sha256:${"b".repeat(64)}`,
    contributionId: "workbench",
  },
  title: "AI 短剧",
  kind: "short-drama",
  stages: ["brief", "outline", "script"],
  maximumEpisodes: 16,
  moduleAvailable: true,
  textPlansAvailable: true,
  executionReady: true,
};

test("an explicit deployment port does not publish project tools for a different sealed owner", async (t) => {
  let gateChecks = 0;
  const port: ProjectPlanningRuntimePort = {
    version: "crewon.project-planning-runtime.v1",
    canPublish(run) {
      gateChecks++;
      return run.createdByActorId === "different-sealed-actor";
    },
    assertActive() {
      assert.fail("foreign Run must not enter the project-planning owner");
    },
    async assertCurrent() {
      assert.fail("foreign Run must not receive an identity check as a grant");
    },
    async readCapabilities() {
      assert.fail("foreign Run must not read approved metadata");
    },
  };
  const transport: ModelTransportPort = {
    adapterName: "named-foreign-project-planning-owner",
    adapterVersion: "1",
    modelId: "named-model",
    async *stream(request) {
      assert.deepEqual(
        request.tools.map((tool) => tool.name),
        ["get_goal", "create_goal", "update_plan"],
      );
      yield { type: "output.delta", delta: "继续普通聊天。" };
      yield { type: "completed", checkpoint: null };
    },
  };
  const f = await ordinaryProjectPlanningFixture(t, {
    transport,
    configureWorker: (dependencies) => ({
      ...dependencies,
      projectPlanning: port,
    }),
  });
  assert.equal((await f.openWorker().wake()).kind, "completed");
  assert.ok(gateChecks > 0);
  assert.equal(
    (await f.events()).filter((event) => event.type === "tool.requested")
      .length,
    0,
  );
});

test("actual ordinary Kernel requests and persisted proposal survive a cold Worker restart without admitting a plugin Run or creating a project", async (t) => {
  let samples = 0,
    reads = 0;
  let fixture!: Awaited<ReturnType<typeof ordinaryProjectPlanningFixture>>;
  const port: ProjectPlanningRuntimePort = {
    version: "crewon.project-planning-runtime.v1",
    canPublish: (run) => run.createdByActorId === "planning-actor",
    assertActive() {},
    async assertCurrent(input) {
      input.signal.throwIfAborted();
      assert.equal(input.run.createdByActorId, fixture.actor.actorId);
      assert.equal(input.run.tenantId, fixture.actor.tenantId);
      assert.equal(input.run.spaceId, fixture.actor.spaceId);
      assert.equal(input.claim.workItem.runId, fixture.runId);
      const thread = await fixture.store().loadThreadInSpace({
        tenantId: fixture.actor.tenantId,
        spaceId: fixture.actor.spaceId,
        threadId: fixture.threadId,
      });
      assert.ok(thread);
      assert.equal(thread.createdByActorId, fixture.actor.actorId);
      assert.equal(thread.status, "active");
      input.signal.throwIfAborted();
    },
    async readCapabilities() {
      reads++;
      return [capability];
    },
  };
  const transport: ModelTransportPort = {
    adapterName: "named-ordinary-project-planning-model",
    adapterVersion: "1",
    modelId: "named-model",
    async *stream(request, signal) {
      signal.throwIfAborted();
      samples++;
      assert.deepEqual(
        request.tools.map((tool) => tool.name),
        [
          "get_goal",
          "create_goal",
          "update_plan",
          "crewon_project_capabilities",
          "crewon_project_propose",
        ],
      );
      const last = request.input.items
        .filter((item) => item.type === "tool_result")
        .at(-1);
      if (!last || last.type !== "tool_result") {
        yield {
          type: "tool.call",
          kind: "function",
          callId: "planning-capabilities",
          name: "crewon_project_capabilities",
          input: "{}",
        };
      } else if (last.callId === "planning-capabilities") {
        const available = JSON.parse(last.output);
        assert.equal(
          available.capabilities[0].capabilityId,
          capability.capabilityId,
        );
        yield {
          type: "tool.call",
          kind: "function",
          callId: "planning-proposal",
          name: "crewon_project_propose",
          input: JSON.stringify({
            capabilityId: available.capabilities[0].capabilityId,
            title: "雨夜来信",
            briefText: "摄影师在雨夜收到父亲寄来的旧信。",
            instruction: "创作两集悬疑故事，先让用户审阅建议。",
            start: "brief",
            target: "script",
            episodeCount: 2,
            adoption: "manual",
          }),
        };
      } else {
        const proposal = JSON.parse(last.output);
        assert.deepEqual(proposal.origin, {
          runId: fixture.runId,
          threadId: fixture.threadId,
          callId: "planning-proposal",
        });
        assert.equal(proposal.input.adoption, "manual");
        yield { type: "output.delta", delta: "请在短剧工作台审阅这份建议。" };
      }
      yield { type: "completed", checkpoint: null };
    },
  };
  fixture = await ordinaryProjectPlanningFixture(t, {
    transport,
    configureWorker: (dependencies) => ({
      ...dependencies,
      projectPlanning: port,
    }),
  });
  const original = RunExecutionService.prototype.recordAgentEvent;
  let interrupted = false;
  t.mock.method(
    RunExecutionService.prototype,
    "recordAgentEvent",
    async function (
      this: RunExecutionService,
      claim: Parameters<RunExecutionService["recordAgentEvent"]>[0],
      event: Parameters<RunExecutionService["recordAgentEvent"]>[1],
    ) {
      const committed = await original.call(this, claim, event);
      if (
        !interrupted &&
        event.type === "tool.completed" &&
        event.data.name === "crewon_project_propose"
      ) {
        interrupted = true;
        throw new Error("named_crash_after_original_proposal_event_commit");
      }
      return committed;
    },
  );
  assert.equal((await fixture.openWorker().wake()).kind, "retried");
  assert.equal(interrupted, true);
  assert.equal(reads, 2);
  const prefix = await fixture.events();
  const saved = prefix.filter((event) => event.type === "tool.completed");
  assert.equal(saved.length, 2);
  for (const event of saved)
    assert.ok(Buffer.byteLength(event.data.output) <= 8192);
  const firstHttp = await fixture.listenControl();
  const liveStream = await fetch(
    `${firstHttp.origin}/api/v1/runs/${fixture.runId}/events?view=transcript`,
    { headers: firstHttp.headers, signal: AbortSignal.timeout(5000) },
  );
  assert.equal(liveStream.status, 200);
  assert.match(liveStream.headers.get("content-type")!, /text\/event-stream/u);
  const streamed = await readStreamThroughProposal(liveStream);
  const proposalEvent = streamed.find(
    (event) =>
      event.type === "tool.completed" &&
      event.data.name === "crewon_project_propose",
  );
  assert.ok(proposalEvent);
  assert.equal(proposalEvent.data.outputTruncated, false);
  const streamedProposal = parseProjectPlanningProposal(
    JSON.parse(proposalEvent.data.outputPreview),
  );
  assert.equal(streamedProposal.origin.runId, fixture.runId);
  assert.equal(proposalEvent.data.outputPreview, saved[1]!.data.output);
  const httpCursor = proposalEvent.sequence;
  await fixture.reopen();
  assert.deepEqual(await fixture.events(), prefix);
  const completion = await fixture.openWorker().wake();
  assert.equal(completion.kind, "completed", JSON.stringify(completion));
  assert.equal(reads, 2);
  assert.equal(samples, 3);
  const events = await fixture.events();
  assert.equal(
    events.filter((event) => event.type === "tool.requested").length,
    2,
  );
  assert.equal(
    events.filter((event) => event.type === "tool.completed").length,
    2,
  );
  const cursor = prefix.at(-1)!.sequence;
  assert.deepEqual(
    await fixture.events(cursor),
    events.filter((event) => event.sequence > cursor),
  );
  const coldHttp = await fixture.listenControl();
  const currentRun = await fetch(
    `${coldHttp.origin}/api/v1/runs/${fixture.runId}`,
    { headers: coldHttp.headers, signal: AbortSignal.timeout(5000) },
  );
  assert.equal(currentRun.status, 200);
  assert.equal((await currentRun.json()).run.status, "completed");
  const resumed = await fetch(
    `${coldHttp.origin}/api/v1/runs/${fixture.runId}/events?view=transcript`,
    {
      headers: { ...coldHttp.headers, "last-event-id": String(httpCursor) },
      signal: AbortSignal.timeout(5000),
    },
  );
  assert.equal(resumed.status, 200);
  const resumedFrames = (await resumed.text())
    .split("\n\n")
    .filter((frame) => frame.startsWith("id:"));
  assert.ok(resumedFrames.length > 0);
  const resumedSequences = resumedFrames.map((frame) =>
    Number(/^id: (\d+)$/mu.exec(frame)![1]),
  );
  assert.deepEqual(
    resumedSequences,
    events
      .filter((event) => event.sequence > httpCursor)
      .map((event) => event.sequence),
  );
  assert.ok(resumedFrames.at(-1)!.includes("event: run.completed"));
  assert.ok(
    resumedFrames.every((frame) => !frame.includes("planning-proposal")),
  );
  const db = new DatabaseSync(fixture.path, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM run_snapshots").get()!.n,
      1,
    );
    for (const table of [
      "plugin_task_admissions",
      "creative_projects",
      "project_text_plans",
      "extension_external_operations",
      "plugin_credit_reservations",
    ]) {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      if (exists)
        assert.equal(
          db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
          0,
        );
    }
  } finally {
    db.close();
  }
  await fixture.reopen();
  assert.equal((await fixture.openWorker().wake()).kind, "idle");
  assert.equal(reads, 2);
});

async function readStreamThroughProposal(response: Response): Promise<
  {
    sequence: number;
    type: string;
    data: { name?: string; outputPreview: string; outputTruncated: boolean };
  }[]
> {
  assert.ok(response.body);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  const events: {
    sequence: number;
    type: string;
    data: { name?: string; outputPreview: string; outputTruncated: boolean };
  }[] = [];
  let buffered = "";
  try {
    while (true) {
      const part = await reader.read();
      assert.equal(
        part.done,
        false,
        "proposal must appear before the stream ends",
      );
      buffered += decoder.decode(part.value, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = /^data: (.+)$/mu.exec(frame);
        if (data) {
          const event = JSON.parse(data[1]!);
          events.push(event);
          if (
            event.type === "tool.completed" &&
            event.data.name === "crewon_project_propose"
          )
            return events;
        }
        boundary = buffered.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

test("Worker close withdraws a held metadata result synchronously and joins the physical read", async (t) => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const port: ProjectPlanningRuntimePort = {
    version: "crewon.project-planning-runtime.v1",
    canPublish: () => true,
    assertActive() {},
    async assertCurrent(input) {
      input.signal.throwIfAborted();
    },
    async readCapabilities() {
      enter();
      await held;
      return [capability];
    },
  };
  const transport: ModelTransportPort = {
    adapterName: "named-held-project-metadata",
    adapterVersion: "1",
    modelId: "named-model",
    async *stream() {
      yield {
        type: "tool.call",
        kind: "function",
        callId: "held-metadata",
        name: "crewon_project_capabilities",
        input: "{}",
      };
      yield { type: "completed", checkpoint: null };
    },
  };
  const f = await ordinaryProjectPlanningFixture(t, {
    transport,
    configureWorker: (dependencies) => ({
      ...dependencies,
      projectPlanning: port,
    }),
  });
  const worker = f.openWorker(),
    waking = worker.wake();
  await entered;
  let joined = false;
  const closing = worker.close().then(() => {
    joined = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(joined, false);
  release();
  await closing;
  await waking;
  assert.equal(joined, true);
  assert.equal(
    (await f.events()).filter((event) => event.type === "tool.completed")
      .length,
    0,
  );
});
