import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  RunApplicationService,
  RunExecutionService,
  ThreadApplicationService,
} from "@crewon/application";
import {
  SqliteRunStore,
  SqliteExternalOperationStore,
  migrateSqliteExternalOperations,
} from "@crewon/store";
import {
  COMFY_OBSERVE_TOOL,
  COMFY_SUBMIT_TOOL,
  ComfyToolRuntime,
} from "./extensions/comfyui-tool-runtime.ts";
import type { ComfyJsonHttpPort } from "./extensions/comfyui-api.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";

test("CrewON Worker streams image result after process loss between provider acceptance and Tool receipt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "crewon-comfy-worker-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const databasePath = join(dir, "control.sqlite");
  const actor = {
    tenantId: "tenant-1",
    spaceId: "space-1",
    principalId: "principal-1",
    actorId: "actor-1",
  };
  const route = {
    authorityId: "authority-1",
    runtimeGeneration: "ts-v0",
    agentVersionId: "image-agent-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  };
  const authorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  const clock = { now: () => new Date().toISOString() };
  const ids = { nextId: (_kind: string) => randomUUID() };
  const digester = {
    sha256: (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  };
  let store = new SqliteRunStore(databasePath);
  const threads = new ThreadApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester,
  });
  const thread = await threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "thread-1",
    title: null,
  });
  await threads.appendMessage(actor, {
    kind: "thread.message.append",
    threadId: thread.state.threadId,
    expectedRevision: 1,
    idempotencyKey: "message-1",
    role: "user",
    content: "生成一张茶壶照片",
  });
  const run = await new RunApplicationService({
    store,
    authorization,
    clock,
    ids,
  }).createRun(actor, {
    kind: "run.create",
    threadId: thread.state.threadId,
    idempotencyKey: "run-1",
    route,
  });
  const runId = run.state.runId;
  let posts = 0;
  let generatedId = "";
  const http: ComfyJsonHttpPort = {
    request: async ({ method, body, path }) => {
      if (method === "POST") {
        posts++;
        generatedId = (body as { prompt_id: string }).prompt_id;
        return { prompt_id: generatedId };
      }
      assert.equal(path, `/history/${generatedId}`);
      return {
        [generatedId]: {
          status: { completed: true, status_str: "success" },
          outputs: {
            "29": {
              images: [
                { filename: "teapot.png", subfolder: "", type: "output" },
              ],
            },
          },
        },
      };
    },
  };
  // Deterministic model fixture; the real CrewON Kernel, Worker, queue and Tool receipts run below.
  const transport: ModelTransportPort = {
    adapterName: "comfy-integration-model",
    adapterVersion: "1",
    modelId: "fixture",
    async *stream(request) {
      assert.deepEqual(
        request.tools
          .map((tool) => tool.name)
          .filter((name) => name.startsWith("crewon_comfyui_")),
        [COMFY_SUBMIT_TOOL, COMFY_OBSERVE_TOOL],
      );
      const lastResult = [...request.input.items]
        .reverse()
        .find((item) => item.type === "tool_result");
      if (lastResult === undefined) {
        yield {
          type: "tool.call",
          kind: "function",
          callId: "submit-image",
          name: COMFY_SUBMIT_TOOL,
          input: JSON.stringify({
            prompt: "A photorealistic ceramic teapot beside a sunlit window.",
          }),
        };
      } else if (lastResult.callId === "submit-image") {
        const result = JSON.parse(lastResult.output) as {
          operationId: string;
          submission: string;
        };
        assert.equal(result.submission, "accepted");
        yield {
          type: "tool.call",
          kind: "function",
          callId: "observe-image",
          name: COMFY_OBSERVE_TOOL,
          input: JSON.stringify({ operationId: result.operationId }),
        };
      } else {
        const result = JSON.parse(lastResult.output) as {
          status: string;
          images: Array<{ url: string }>;
        };
        assert.equal(result.status, "succeeded");
        yield { type: "output.delta", delta: "图片已生成：" };
        yield { type: "output.delta", delta: result.images[0]!.url };
      }
      yield { type: "completed", checkpoint: null };
    },
  };
  const open = (crash: boolean) => {
    const database = new DatabaseSync(databasePath);
    migrateSqliteExternalOperations(database);
    const tools = new ComfyToolRuntime({
      scope: {
        tenantId: actor.tenantId,
        runId,
        bindingDigest: digester.sha256("reviewed-krea2-test-binding"),
      },
      bindingId: "comfy-1",
      baseUrl: "https://comfy.example/",
      store: new SqliteExternalOperationStore(database),
      http,
      approvalRequirement: "none",
    });
    const worker = new RuntimeWorker(
      {
        store,
        execution: new RunExecutionService({ store, clock, ids, digester }),
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
          if (crash)
            throw new Error("simulated_process_loss_after_comfy_acceptance");
        },
      },
    );
    return {
      worker,
      close: async () => {
        await worker.close();
        database.close();
      },
    };
  };
  const first = open(true);
  try {
    assert.deepEqual(await first.worker.wake(), {
      kind: "retried",
      runId,
      code: "simulated_process_loss_after_comfy_acceptance",
    });
  } finally {
    await first.close();
    await store.close();
  }
  store = new SqliteRunStore(databasePath);
  const recovered = open(false);
  try {
    assert.deepEqual(await recovered.worker.wake(), {
      kind: "completed",
      runId,
    });
    assert.equal(posts, 1);
    const events = await store.listRunEvents(
      { tenantId: actor.tenantId, runId },
      0,
      100,
    );
    assert.equal(
      events.filter((event) => event.type === "tool.completed").length,
      2,
    );
    const deltas = events
      .filter((event) => event.type === "model.output.delta")
      .map((event) => event.data.delta)
      .join("");
    assert.match(deltas, /图片已生成：https:\/\/comfy.example\/view/u);
    const messages = await store.listMessages(
      { tenantId: actor.tenantId, threadId: thread.state.threadId },
      0,
      100,
    );
    assert.ok(
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.includes("teapot.png"),
      ),
    );
    const cursor = events.find(
      (event) => event.type === "tool.completed",
    )!.sequence;
    const resumed = await store.listRunEvents(
      { tenantId: actor.tenantId, runId },
      cursor,
      100,
    );
    assert.ok(resumed.every((event) => event.sequence > cursor));
    assert.ok(
      resumed.some(
        (event) =>
          event.type === "model.output.delta" &&
          event.data.delta.includes("图片已生成"),
      ),
    );
  } finally {
    await recovered.close();
    await store.close();
  }
});
