import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  RunExecutionService,
  ExtensionTaskApplicationService,
  type ExtensionCreditQuotePort,
} from "@crewon/application";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import {
  actor,
  boundComfyFixture,
  target,
} from "./comfyui-bound-runtime.test-support.ts";
import {
  COMFY_OBSERVE_TOOL,
  COMFY_SUBMIT_TOOL,
} from "./extensions/comfyui-tool-catalog.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";

async function assertBoundWorkerResume(
  t: TestContext,
  pricing: "unpriced" | "quoted",
) {
  const f = await boundComfyFixture(t);
  const prompt = "生成一张茶壶照片";
  const clock = { now: () => new Date().toISOString() };
  const ids = { nextId: () => randomUUID() };
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "worker-credit-fixture",
  };
  let quoteCalls = 0;
  const creditQuotes: ExtensionCreditQuotePort = {
    async quoteGeneration() {
      quoteCalls += 1;
      // Fixture amounts only; production pricing and settlement are not configured.
      return {
        poolId: creditScope.poolId,
        priceRevision: 1,
        quotedCredits: "25",
      };
    },
  };
  if (pricing === "quoted") {
    await f.first.store.migrateCredits();
    await f.first.parent.pluginCreditStore().grant({
      scope: creditScope,
      grantId: "worker-fixture-funding",
      credits: "100",
    });
  }
  // Real application admission; deployment readiness and providers remain explicit fixtures.
  const threadId = "image-thread";
  await seedThread(f.first.parent, { ...actor, threadId });
  const tasks = new ExtensionTaskApplicationService({
    store: f.first.parent,
    extensions: f.first.store,
    operations: f.operations,
    authorization: f.authorization,
    clock,
    ids,
    digester: extensionStoreDigester,
    ...(pricing === "quoted" ? { creditQuotes } : {}),
    catalog: {
      list: () => [f.registration],
      resolve: (identity) =>
        identity.pluginId === f.config.pluginId &&
        identity.pluginVersion === f.config.pluginVersion
          ? f.registration
          : null,
    },
    host: {
      validateConfiguration: async () => {},
      evaluate: async () => ({ outcome: "ready", target }),
    },
  });
  const { binding, creditAdmission } = await tasks.createTask(actor, {
    pluginId: f.config.pluginId,
    threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "image-task",
    intent: { kind: "generate", input: { prompt } },
  });
  const transport: ModelTransportPort = {
    adapterName: "comfy-bound-worker-fixture",
    adapterVersion: "1",
    modelId: "fixture",
    async *stream(request) {
      assert.match(JSON.stringify(request.input), /生成一张茶壶照片/u);
      assert.deepEqual(
        request.tools
          .map((tool) => tool.name)
          .filter((name) => name.startsWith("crewon_comfyui_")),
        [COMFY_SUBMIT_TOOL, COMFY_OBSERVE_TOOL],
      );
      const last = [...request.input.items]
        .reverse()
        .find((item) => item.type === "tool_result");
      if (last === undefined)
        yield {
          type: "tool.call",
          kind: "function",
          callId: "submit",
          name: COMFY_SUBMIT_TOOL,
          input: JSON.stringify({
            prompt: "A ceramic teapot on a sunlit wooden table.",
          }),
        };
      else if (last.callId === "submit") {
        const accepted = JSON.parse(last.output) as {
          operationId: string;
          submission: string;
        };
        assert.equal(accepted.submission, "accepted");
        yield {
          type: "tool.call",
          kind: "function",
          callId: "observe",
          name: COMFY_OBSERVE_TOOL,
          input: JSON.stringify({ operationId: accepted.operationId }),
        };
      } else {
        const completed = JSON.parse(last.output) as {
          status: string;
          images: { url: string }[];
        };
        assert.equal(completed.status, "succeeded");
        yield { type: "output.delta", delta: "图片已生成：" };
        yield { type: "output.delta", delta: completed.images[0]!.url };
      }
      yield { type: "completed", checkpoint: null };
    },
  };
  const route = {
    agentVersionId: target.agentVersionId,
    authorityId: target.authorityId,
    runtimeGeneration: target.runtimeGeneration,
    policySnapshotId: target.policySnapshotId,
    workspaceBindingId: target.workspaceBindingId,
  };
  const openWorker = (storage: typeof f.first, crash: boolean) => {
    const tools = f.runtime({
      extensions: storage.store,
      runs: storage.parent,
    });
    const worker = new RuntimeWorker(
      {
        store: storage.parent,
        execution: new RunExecutionService({
          store: storage.parent,
          clock,
          ids,
          digester: extensionStoreDigester,
        }),
        kernel: new CrewONAgentKernel({
          transport,
          toolCatalog: tools,
          streamMaxRetries: 0,
        }),
        toolRuntime: tools,
        policy: new PinnedRunExecutionPolicy(route),
      },
      {
        ownerId: randomUUID(),
        nextLeaseId: randomUUID,
        leaseDurationMs: 30_000,
        retryAfterMs: 0,
        scanIntervalMs: null,
        afterToolProviderResolved: async () => {
          if (crash) throw new Error("lost_after_acceptance");
        },
      },
    );
    return {
      worker,
      close: async () => {
        await worker.close();
        await tools.close();
      },
    };
  };
  const first = openWorker(f.first, true);
  let cursor = 0;
  try {
    assert.deepEqual(await first.worker.wake(), {
      kind: "retried",
      runId: binding.runId,
      code: "lost_after_acceptance",
    });
    cursor = (await f.first.parent.listRunEvents(binding, 0, 100)).at(
      -1,
    )!.sequence;
    await f.state("disabled");
    if (pricing === "quoted") {
      const account = await f.first.parent
        .pluginCreditStore()
        .getAccount(creditScope);
      assert.equal(account?.availableCredits, "75");
      assert.equal(account?.reservedCredits, "25");
    }
  } finally {
    await first.close();
    await f.first.parent.close();
  }
  const reopened = await f.open();
  const restored = openWorker(reopened, false);
  try {
    assert.deepEqual(await restored.worker.wake(), {
      kind: "completed",
      runId: binding.runId,
    });
    assert.equal(
      f.requests.filter((request) => request.method === "POST").length,
      1,
    );
    const events = await reopened.parent.listRunEvents(binding, cursor, 100);
    assert.ok(events.every((event) => event.sequence > cursor));
    assert.equal(
      events.filter((event) => event.type === "tool.completed").length,
      2,
    );
    const deltas = events
      .filter((event) => event.type === "model.output.delta")
      .map((event) => event.data.delta)
      .join("");
    assert.match(deltas, /图片已生成：https:\/\/comfy.example\/view/u);
    const messages = await reopened.parent.listMessages(binding, 0, 100);
    assert.ok(
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.includes("comfy.example/view"),
      ),
    );
    assert.equal((await reopened.parent.loadRun(binding))?.status, "completed");
    assert.deepEqual(
      await reopened.store.loadExtensionRunBinding(binding),
      binding,
    );
    assert.equal(
      (await reopened.store.loadExtensionActivation(binding))?.state,
      "disabled",
    );
    assert.equal(quoteCalls, pricing === "quoted" ? 1 : 0);
    if (pricing === "quoted") {
      const credits = reopened.parent.pluginCreditStore();
      const account = await credits.getAccount(creditScope);
      assert.equal(account?.availableCredits, "75");
      assert.equal(account?.reservedCredits, "25");
      assert.deepEqual(
        await reopened.store.loadExtensionCreditAdmission(binding),
        creditAdmission,
      );
      const reservation = await credits.getReservation({
        scope: creditScope,
        reservationId: binding.runId,
      });
      assert.equal(reservation?.state, "reserved");
      assert.deepEqual(
        (
          await credits.listEntries({
            scope: creditScope,
            afterRevision: 0,
            limit: 10,
          })
        ).map((entry) => entry.kind),
        ["grant", "reserve"],
      );
    } else {
      assert.equal(creditAdmission, undefined);
    }
  } finally {
    await restored.close();
  }
}

test("bound Worker resumes accepted image work after disable and streams the persisted source result", (t) =>
  assertBoundWorkerResume(t, "unpriced"));

test("quoted bound Worker resumes accepted image work with one personal credit hold", (t) =>
  assertBoundWorkerResume(t, "quoted"));
