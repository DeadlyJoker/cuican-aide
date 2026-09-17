import { createContextTestStorage } from "./runtime-model-context.test-support.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { CrewONAgentKernel } from "@crewon/agent-kernel";
import { DirectResponsesTransport } from "@crewon/agent-responses";
import {
  RunStoreError,
  RunApplicationService,
  RunExecutionService,
  ThreadApplicationService,
  type DomainStore,
  type ModelHistoryContextStore,
} from "@crewon/application";
import { projectModelHistory } from "@crewon/context";
import type { ModelHistoryItem, RunState } from "@crewon/domain";
import { RuntimeWorker } from "./runtime-worker.ts";
import { loadRuntimeModelContext } from "./runtime-model-context.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";

const actor = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
};
const route = {
  authorityId: "standalone-1",
  runtimeGeneration: "ts-v0" as const,
  agentVersionId: "agent-version-1",
  policySnapshotId: "policy-1",
  workspaceBindingId: "workspace-1",
};

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: Worker completes and resumes provider state after 20,000 compacted records with the exact canonical input`,
    {
      skip:
        backend === "postgres" &&
        process.env.CREWON_TEST_POSTGRES_URL === undefined,
    },
    async (context) => {
      const fixture = await createFixture(context, 20_000, true, backend);
      const requests: Record<string, unknown>[] = [];
      const transport = new DirectResponsesTransport(
        {
          endpoint: "https://provider.example/v1/responses",
          model: "provider-model",
          storeResponses: true,
        },
        {
          fetch: async (_input, init) => {
            requests.push(JSON.parse(String(init?.body)));
            return new Response(
              responseStream(
                `resp-${requests.length}`,
                `answer-${requests.length}`,
              ),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          },
        },
      );
      const worker = fixture.worker(transport);
      context.after(() => worker.close());
      assert.deepEqual(await worker.wake(), {
        kind: "completed",
        runId: fixture.run.runId,
      });
      await worker.close();
      const oracle = projectModelHistory(fixture.history, {
        maxItems: 10_000,
        maxBytes: 64 * 1024 * 1024,
      });
      assert.deepEqual(
        requests[0]?.input,
        oracle.items.map((item) => {
          assert.equal(item.type, "message");
          return item.type === "message"
            ? { role: item.role, content: item.content }
            : null;
        }),
      );
      const firstCheckpoint = await fixture.store.loadThreadContinuation({
        ...fixture.locator,
        agentVersionId: route.agentVersionId,
        adapterName: transport.adapterName,
        adapterVersion: transport.adapterVersion,
        modelId: transport.modelId,
      });
      assert.equal(firstCheckpoint?.throughHistorySequence, 20_004);
      assert.equal(firstCheckpoint?.contextRevision, "old-history-20002");
      const thread = await fixture.store.loadThread(fixture.locator);
      assert.ok(thread !== null);
      await fixture.threads().appendMessage(actor, {
        kind: "thread.message.append",
        idempotencyKey: "second-message",
        threadId: fixture.locator.threadId,
        expectedRevision: thread.revision,
        role: "user",
        content: "second turn\n  exact spacing",
      });
      const second = await fixture.runs().createRun(actor, {
        kind: "run.create",
        idempotencyKey: "second-run",
        threadId: fixture.locator.threadId,
        route,
      });
      await fixture.store.close();
      await fixture.reopen();
      const resumed = fixture.worker(transport);
      context.after(() => resumed.close());
      assert.deepEqual(await resumed.wake(), {
        kind: "completed",
        runId: second.state.runId,
      });
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1]?.input, [
        { role: "user", content: "second turn\n  exact spacing" },
      ]);
      assert.equal(requests[1]?.previous_response_id, "resp-1");
      const { input: _firstInput, ...firstRequest } = requests[0]!;
      const {
        input: _secondInput,
        previous_response_id: _previous,
        ...secondRequest
      } = requests[1]!;
      assert.deepEqual(
        secondRequest,
        firstRequest,
        "index tokens must not leak into provider request/cache keys",
      );
      const state = await fixture.store.modelHistoryContext.prepare(
        fixture.locator,
      );
      assert.equal(state.context?.checkpoint.throughHistorySequence, 20_006);
      await resumed.close();
    },
  );
}

test("Context preparation yields bounded pages, can stop, and resumes without losing its prefix", async (context) => {
  const fixture = await createFixture(context, 500);
  let progressCalls = 0;
  await assert.rejects(
    loadRuntimeModelContext(fixture.store, fixture.run, {
      onProgress: async () => {
        if (++progressCalls === 4) throw new Error("stop-context-load");
      },
    }),
    /stop-context-load/,
  );
  const saved = await fixture.readContextProgress();
  assert.equal(saved, 301); // Initial instruction was indexed at write time.
  await fixture.store.close();
  await fixture.reopen();
  const actual = await loadRuntimeModelContext(fixture.store, fixture.run, {
    onProgress: async () => {},
  });
  assert.deepEqual(
    actual,
    projectModelHistory(fixture.history, {
      maxItems: 10_000,
      maxBytes: 64 * 1024 * 1024,
    }),
  );
});

test("Context snapshot conflicts retry from a fresh checkpoint and stop after three conflicts", async (context) => {
  const fixture = await createFixture(context, 4);
  const authority = fixture.store.modelHistoryContext;
  let conflicts = 0;
  const intermittent: ModelHistoryContextStore = {
    prepare: (locator) => authority.prepare(locator),
    listItems: (...args) => {
      if (++conflicts === 1)
        throw new RunStoreError("model_history_context_changed");
      return authority.listItems(...args);
    },
  };
  const wrapped = withContext(fixture.store, intermittent);
  const actual = await loadRuntimeModelContext(wrapped, fixture.run, {
    onProgress: async () => {},
  });
  assert.deepEqual(actual, projectModelHistory(fixture.history));
  assert.equal(conflicts, 2);
  conflicts = 0;
  await assert.rejects(
    loadRuntimeModelContext(
      withContext(fixture.store, {
        prepare: (locator) => authority.prepare(locator),
        listItems: async () => {
          conflicts += 1;
          throw new RunStoreError("model_history_context_changed");
        },
      }),
      fixture.run,
      { onProgress: async () => {} },
    ),
    /model_history_context_changed/,
  );
  assert.equal(conflicts, 3);
});

test("The active context limit remains enforced independently of lifetime history", async (context) => {
  const fixture = await createFixture(context, 10_001, false);
  await assert.rejects(
    loadRuntimeModelContext(fixture.store, fixture.run, {
      onProgress: async () => {},
    }),
    /context_history_limit_exceeded/,
  );
});

test("Forked history gets an independent checkpoint and preserves canonical model input", async (context) => {
  const fixture = await createFixture(context, 0, false);
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
    },
    {
      fetch: async () =>
        new Response(responseStream("resp-fork", "answer"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    },
  );
  const worker = fixture.worker(transport);
  context.after(() => worker.close());
  assert.equal((await worker.wake()).kind, "completed");
  await worker.close();
  const source = await fixture.store.loadThread(fixture.locator);
  assert.ok(source !== null);
  const fork = await fixture.threads().forkThread(actor, {
    kind: "thread.fork",
    idempotencyKey: "fork-context",
    sourceThreadId: source.threadId,
    expectedSourceRevision: source.revision,
    throughHistorySequence: null,
  });
  const forkLocator = { ...fixture.locator, threadId: fork.state.threadId };
  const forkHistory = await fixture.store.listModelHistoryItems(
    forkLocator,
    0,
    100,
  );
  const sourceHistory = await fixture.store.listModelHistoryItems(
    fixture.locator,
    0,
    100,
  );
  const projected = await loadRuntimeModelContext(
    fixture.store,
    { ...fixture.run, threadId: fork.state.threadId },
    {
      allowAssistantBoundary: true,
      onProgress: async () => {},
    },
  );
  assert.deepEqual(projected, projectModelHistory(forkHistory));
  assert.deepEqual(projected.items, projectModelHistory(sourceHistory).items);
  assert.notEqual(forkHistory[0]?.itemId, sourceHistory[0]?.itemId);
  const checkpoint = (
    await fixture.store.modelHistoryContext.prepare(forkLocator)
  ).context!.checkpoint;
  await assert.rejects(
    fixture.store.modelHistoryContext.listItems(
      fixture.locator,
      checkpoint,
      0,
      100,
    ),
    /model_history_context_changed/,
  );
});

for (const cancelDuringBuild of [false, true]) {
  test(`Worker renews its lease while rebuilding context${cancelDuringBuild ? " and honors cancellation before sampling" : ""}`, async (context) => {
    const fixture = await createFixture(context, 500);
    let elapsed = 0;
    let pages = 0;
    let modelCalls = 0;
    context.mock.method(performance, "now", () => elapsed);
    const original = fixture.store.modelHistoryContext.prepare.bind(
      fixture.store.modelHistoryContext,
    );
    context.mock.method(
      fixture.store.modelHistoryContext,
      "prepare",
      async (...args: Parameters<ModelHistoryContextStore["prepare"]>) => {
        const result = await original(...args);
        elapsed += 4000;
        fixture.setLeaseElapsed(elapsed);
        if (cancelDuringBuild && ++pages === 2) {
          const running = await fixture.store.loadRun({
            tenantId: actor.tenantId,
            runId: fixture.run.runId,
          });
          assert.ok(running !== null);
          await fixture.runs().transitionRun(actor, {
            kind: "run.requestCancel",
            runId: running.runId,
            expectedRevision: running.revision,
            idempotencyKey: "cancel-context-build",
          });
        }
        return result;
      },
    );
    const transport = new DirectResponsesTransport(
      {
        endpoint: "https://provider.example/v1/responses",
        model: "provider-model",
      },
      {
        fetch: async () => {
          modelCalls += 1;
          return new Response(responseStream("resp-lease", "done"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    );
    const worker = fixture.worker(transport);
    context.after(() => worker.close());
    assert.deepEqual(await worker.wake(), {
      kind: cancelDuringBuild ? "canceled" : "completed",
      runId: fixture.run.runId,
    });
    assert.equal(modelCalls, cancelDuringBuild ? 0 : 1);
    if (!cancelDuringBuild)
      assert.ok(elapsed > 10_000, "preparation outlasts the original lease");
    await worker.close();
  });
}

function withContext(
  store: DomainStore,
  authority: ModelHistoryContextStore,
): DomainStore {
  return new Proxy(store, {
    get(target, key) {
      if (key === "modelHistoryContext") return authority;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function createFixture(
  context: TestContext,
  oldItems: number,
  compact = true,
  backend: "sqlite" | "postgres" = "sqlite",
) {
  let leaseElapsed = 0;
  const leaseClock = {
    nowEpochMilliseconds: () =>
      Date.parse("2026-08-08T01:00:00Z") + leaseElapsed,
  };
  const storage = await createContextTestStorage(context, backend, leaseClock);
  let store = storage.store;
  let identifier = 0;
  let instant = Date.parse("2026-08-08T00:00:00Z");
  const ids = { nextId: (kind: string) => `${kind}-${++identifier}` };
  const clock = { now: () => new Date((instant += 1000)).toISOString() };
  const digester = {
    sha256: (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  };
  const authorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  const threads = () =>
    new ThreadApplicationService({
      store,
      clock,
      ids,
      digester,
      authorization,
    });
  const runs = () =>
    new RunApplicationService({ store, clock, ids, authorization });
  const thread = await threads().createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "create-thread",
    title: null,
  });
  const locator = { tenantId: actor.tenantId, threadId: thread.state.threadId };
  await threads().appendMessage(actor, {
    kind: "thread.message.append",
    idempotencyKey: "first-message",
    threadId: locator.threadId,
    expectedRevision: 1,
    role: "user",
    content: "original instruction",
  });
  const created = await runs().createRun(actor, {
    kind: "run.create",
    idempotencyKey: "first-run",
    threadId: locator.threadId,
    route,
  });
  const run: RunState = created.state;
  const history: ModelHistoryItem[] = [
    ...(await store.listModelHistoryItems(locator, 0, 100)),
  ];
  const base = (sequence: number) => ({
    ...locator,
    schemaVersion: "crewon.model-history-item.v0" as const,
    sequence,
    itemId: `old-history-${sequence}`,
    runId: run.runId,
    segmentId: "old-segment",
    createdAt: "2026-08-08T00:00:00Z",
  });
  const append = (item: ModelHistoryItem) => {
    history.push(item);
  };
  for (let sequence = 2; sequence <= oldItems + 1; sequence += 1) {
    append({
      ...base(sequence),
      type: "message",
      role: sequence % 2 ? "user" : "assistant",
      source: "thread_message",
      content: `old message ${sequence}`,
      contentDigest: digester.sha256(`old message ${sequence}`),
    });
  }
  if (compact) {
    append({
      ...base(oldItems + 2),
      type: "compaction",
      mode: "auto",
      replacesThroughSequence: oldItems + 1,
      sourceDigest: digester.sha256("source"),
      summary: "durable summary\n  preserve this prefix",
      summaryDigest: digester.sha256("durable summary\n  preserve this prefix"),
      retainedUserMessages: [
        {
          content: "original instruction",
          contentDigest: digester.sha256("original instruction"),
        },
      ],
    });
    append({
      ...base(oldItems + 3),
      type: "message",
      role: "user",
      source: "thread_message",
      content: "current task",
      contentDigest: digester.sha256("current task"),
    });
  }
  await storage.seed(history.slice(1));
  return {
    get store() {
      return store;
    },
    readContextProgress: storage.progress,
    run,
    history,
    locator,
    threads,
    runs,
    setLeaseElapsed(value: number) {
      leaseElapsed = value;
    },
    async reopen() {
      store = await storage.open();
    },
    worker(transport: DirectResponsesTransport) {
      return new RuntimeWorker(
        {
          store,
          execution: new RunExecutionService({ store, clock, ids, digester }),
          kernel: new CrewONAgentKernel({ transport }),
          policy: new PinnedRunExecutionPolicy(route),
        },
        {
          ownerId: "context-worker",
          nextLeaseId: () => ids.nextId("lease"),
          leaseDurationMs: 10_000,
          scanIntervalMs: null,
        },
      );
    },
  };
}

function responseStream(id: string, output: string): string {
  const message = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: output }],
  };
  return [
    { type: "response.created", sequence_number: 0, response: { id } },
    { type: "response.output_text.delta", sequence_number: 1, delta: output },
    { type: "response.output_item.done", sequence_number: 2, item: message },
    {
      type: "response.completed",
      sequence_number: 3,
      response: {
        id,
        status: "completed",
        output: [message],
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
          input_tokens_details: { cached_tokens: 8 },
        },
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}
