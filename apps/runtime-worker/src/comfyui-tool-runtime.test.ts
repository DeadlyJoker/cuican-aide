import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  migrateSqliteExternalOperations,
  SqliteExternalOperationStore,
} from "@crewon/store";
import type { ToolExecutionResolution } from "@crewon/tool-broker";
import {
  COMFY_OBSERVE_TOOL,
  ComfyToolRuntime,
} from "./extensions/comfyui-tool-runtime.ts";
import type { ComfyJsonHttpPort } from "./extensions/comfyui-api.ts";
import { krea2Workflow } from "./extensions/comfyui-krea2-workflow.ts";
import { comfyCommand } from "./comfyui-tool-runtime.test-support.ts";

const scope = {
  tenantId: "tenant-1",
  runId: "run-1",
  bindingDigest: `sha256:${"a".repeat(64)}`,
};
const image = { filename: "image.png", subfolder: "crewon", type: "output" };
const signal = () => new AbortController().signal;

async function fixture(t: TestContext, request: ComfyJsonHttpPort["request"]) {
  const dir = await mkdtemp(join(tmpdir(), "crewon-comfy-tool-"));
  const connections: DatabaseSync[] = [];
  t.after(async () => {
    for (const db of connections) db.close();
    await rm(dir, { force: true, recursive: true });
  });
  const open = (
    patch: Partial<ConstructorParameters<typeof ComfyToolRuntime>[0]> = {},
  ) => {
    const db = new DatabaseSync(join(dir, "operations.sqlite"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    connections.push(db);
    migrateSqliteExternalOperations(db);
    const store = new SqliteExternalOperationStore(db);
    const runtime = new ComfyToolRuntime({
      scope,
      bindingId: "comfy-1",
      baseUrl: "https://comfy.example/",
      store,
      http: { request },
      approvalRequirement: "none",
      ...patch,
    });
    return {
      store,
      runtime,
      close: () => {
        db.close();
        connections.splice(connections.indexOf(db), 1);
      },
    };
  };
  return { ...open(), open };
}

function output(resolution: ToolExecutionResolution): Record<string, unknown> {
  assert.equal(resolution.status, "completed");
  if (resolution.status !== "completed") throw new Error("not completed");
  return JSON.parse(resolution.result.output) as Record<string, unknown>;
}

test("durable Tool submission, restarted observation and cached terminal result form one flow", async (t) => {
  let posts = 0;
  let gets = 0;
  let requestId = "";
  const f = await fixture(t, async ({ method, body, path }) => {
    if (method === "POST") {
      posts++;
      requestId = (body as { prompt_id: string }).prompt_id;
      const saved = await f.store.loadExternalOperation({
        ...scope,
        operationId: requestId,
      });
      assert.equal(saved?.status, "submitting", "must commit before network");
      return { prompt_id: requestId };
    }
    gets++;
    assert.equal(path, `/history/${requestId}`);
    return {
      [requestId]: {
        status: { completed: true, status_str: "success" },
        outputs: { "29": { images: [image] } },
      },
    };
  });
  const command = comfyCommand(f.runtime);
  const submitted = await f.runtime.execute(command, signal());
  assert.deepEqual(output(submitted), {
    operationId: requestId,
    submission: "accepted",
    next: COMFY_OBSERVE_TOOL,
  });
  f.close();
  const reopened = f.open();
  assert.deepEqual(
    await reopened.runtime.reconcile(command, signal()),
    submitted,
  );
  const observe = comfyCommand(reopened.runtime, {
    name: COMFY_OBSERVE_TOOL,
    args: { operationId: requestId },
    callId: "observe-1",
  });
  const completed = await reopened.runtime.execute(observe, signal());
  assert.equal(output(completed).status, "succeeded");
  assert.deepEqual(output(completed).images, [
    {
      ...image,
      url: "https://comfy.example/view?filename=image.png&subfolder=crewon&type=output",
    },
  ]);
  reopened.close();
  const restored = f.open();
  assert.deepEqual(
    await restored.runtime.reconcile(observe, signal()),
    completed,
  );
  assert.equal(posts, 1);
  assert.equal(gets, 1);
});

test("lost submission response reconciles by durable correlation without another POST", async (t) => {
  let posts = 0;
  let requestId = "";
  const f = await fixture(t, async ({ method, body, path }) => {
    if (method === "POST") {
      posts++;
      requestId = (body as { prompt_id: string }).prompt_id;
      throw new Error("response lost");
    }
    return path.startsWith("/history/")
      ? {}
      : { queue_running: [[0, requestId]], queue_pending: [] };
  });
  const command = comfyCommand(f.runtime);
  assert.equal(
    (await f.runtime.execute(command, signal())).status,
    "unknownOutcome",
  );
  f.close();
  const restored = f.open();
  assert.equal(
    output(await restored.runtime.reconcile(command, signal())).submission,
    "accepted",
  );
  await restored.runtime.execute(command, signal());
  assert.equal(posts, 1);
});

test("unknown provider history, repeated execution and cancellation never resubmit or interrupt", async (t) => {
  const methods: string[] = [];
  const f = await fixture(t, async ({ method, path }) => {
    methods.push(`${method} ${path}`);
    if (method === "POST") throw new Error("timeout");
    return path.startsWith("/history/")
      ? {}
      : { queue_running: [], queue_pending: [] };
  });
  const command = comfyCommand(f.runtime);
  assert.equal(
    (await f.runtime.reconcile(command, signal())).status,
    "unknownOutcome",
  );
  assert.equal(methods.length, 0);
  await f.runtime.execute(command, signal());
  f.close();
  const restored = f.open();
  assert.equal(
    (await restored.runtime.reconcile(command, signal())).status,
    "unknownOutcome",
  );
  assert.equal(
    (await restored.runtime.execute(command, signal())).status,
    "unknownOutcome",
  );
  assert.equal(
    (await restored.runtime.cancel(command, signal())).status,
    "unknownOutcome",
  );
  assert.equal(methods.filter((method) => method.startsWith("POST")).length, 1);
  assert.ok(methods.every((method) => !method.includes("interrupt")));
});

test("concurrent runtimes reserve once while the first POST is in flight", async (t) => {
  let accept!: () => void;
  const pending = new Promise<void>((resolve) => {
    accept = resolve;
  });
  let started!: () => void;
  const dispatch = new Promise<void>((resolve) => {
    started = resolve;
  });
  let posts = 0;
  const f = await fixture(t, async ({ method, body, path }) => {
    if (method === "POST") {
      posts++;
      started();
      await pending;
      return { prompt_id: (body as { prompt_id: string }).prompt_id };
    }
    return path.startsWith("/history/")
      ? {}
      : { queue_running: [], queue_pending: [] };
  });
  const other = f.open();
  const command = comfyCommand(f.runtime);
  const first = f.runtime.execute(command, signal());
  await dispatch;
  assert.equal(
    (await other.runtime.execute(command, signal())).status,
    "unknownOutcome",
  );
  accept();
  await first;
  assert.equal(
    output(await other.runtime.reconcile(command, signal())).submission,
    "accepted",
  );
  assert.equal(posts, 1);
});

test("invalid input, approval, action identity and expired lease fail before dispatch", async (t) => {
  let requests = 0;
  const f = await fixture(t, async () => {
    requests++;
    throw new Error("should not dispatch");
  });
  for (const args of [
    { prompt: "ok", baseUrl: "https://evil.example/" },
    { prompt: "" },
    { prompt: "x".repeat(2001) },
    { prompt: "\ud800" },
  ])
    await assert.rejects(
      f.runtime.execute(comfyCommand(f.runtime, { args }), signal()),
    );
  await assert.rejects(
    f.runtime.execute(
      comfyCommand(f.runtime, { expiresAt: "2000-01-01T00:00:00.000Z" }),
      signal(),
    ),
    /lease_expired/u,
  );
  const command = comfyCommand(f.runtime);
  await assert.rejects(
    f.runtime.execute({ ...command, input: "{}" }, signal()),
    /intent_mismatch/u,
  );
  await assert.rejects(
    f.runtime.execute(comfyCommand(f.runtime, { runId: "another" }), signal()),
    /run_binding_mismatch/u,
  );
  const restricted = f.open({ approvalRequirement: "perAction" });
  await assert.rejects(
    restricted.runtime.execute(comfyCommand(restricted.runtime), signal()),
    /approval/u,
  );
  assert.equal(requests, 0);
});

test("observations cannot escape tenant, Run or immutable binding and do not probe foreign jobs", async (t) => {
  let requests = 0;
  const f = await fixture(t, async ({ body }) => {
    requests++;
    return { prompt_id: (body as { prompt_id: string }).prompt_id };
  });
  const id = output(
    await f.runtime.execute(comfyCommand(f.runtime), signal()),
  ).operationId;
  for (const patch of [
    { tenantId: "tenant-2" },
    { runId: "run-2" },
    { bindingDigest: `sha256:${"b".repeat(64)}` },
  ]) {
    const scoped = f.open({ scope: { ...scope, ...patch } });
    const result = await scoped.runtime.execute(
      comfyCommand(scoped.runtime, {
        name: COMFY_OBSERVE_TOOL,
        args: { operationId: id },
        runId: patch.runId ?? "run-1",
      }),
      signal(),
    );
    assert.deepEqual(output(result), { error: "operation_not_found" });
  }
  assert.equal(requests, 1);
});

test("reviewed Krea graph keeps original sampler path and bounded single-image profile", () => {
  const workflow = krea2Workflow(
    "A teapot 🫖",
    "da7b2922-e9a1-4dda-9020-528bfbe197d0",
  );
  assert.equal(workflow["52"].inputs.batch_size, 1);
  assert.equal(workflow["49"].inputs.megapixels, 1);
  assert.equal(workflow["53"].inputs.steps, 8);
  assert.deepEqual(workflow["53"].inputs.model, ["55", 0]);
  assert.deepEqual(workflow["87"].inputs.model, ["55", 0]);
  assert.deepEqual(workflow["29"].inputs.images, ["54", 0]);
});

test("accepted provider identity survives contention even when different from correlation", async (t) => {
  const providerId = "ba7b2922-e9a1-4dda-9020-528bfbe197d1";
  let operationId = "";
  let posts = 0;
  const f = await fixture(t, async ({ method, body, path }) => {
    if (method === "POST") {
      posts++;
      operationId = (body as { prompt_id: string }).prompt_id;
      const receipt = (await f.store.loadExternalOperation({
        ...scope,
        operationId,
      }))!;
      await f.store.advanceExternalOperation({
        ...receipt,
        expectedRevision: receipt.revision,
        status: "unknownOutcome",
        updatedAt: new Date().toISOString(),
      });
      return { prompt_id: providerId };
    }
    assert.equal(path, `/history/${providerId}`);
    return {
      [providerId]: {
        status: { completed: true, status_str: "success" },
        outputs: { "29": { images: [image] } },
      },
    };
  });
  const command = comfyCommand(f.runtime);
  assert.equal(
    output(await f.runtime.execute(command, signal())).submission,
    "accepted",
  );
  f.close();
  const restored = f.open();
  assert.equal(
    (await restored.store.loadExternalOperation({ ...scope, operationId }))!
      .providerOperationId,
    providerId,
  );
  const observed = await restored.runtime.execute(
    comfyCommand(restored.runtime, {
      name: COMFY_OBSERVE_TOOL,
      args: { operationId },
      callId: "observe-1",
    }),
    signal(),
  );
  assert.equal(output(observed).status, "succeeded");
  assert.equal(posts, 1);
});

test("mutation dispatch requires a matching approval proof when host policy requests one", async (t) => {
  let posts = 0;
  const f = await fixture(t, async ({ body }) => {
    posts++;
    return { prompt_id: (body as { prompt_id: string }).prompt_id };
  });
  const restricted = f.open({ approvalRequirement: "perAction" });
  const command = comfyCommand(restricted.runtime);
  const proof = {
    schemaVersion: "crewon.tool-approval-proof.v0" as const,
    approvalId: "approval-1",
    actionDigest: command.actionDigest,
    policySnapshotId: command.actionIntent.policySnapshotId,
    approvalRevision: 2,
    decidedAt: "2026-09-30T00:00:00.000Z",
  };
  await assert.rejects(
    restricted.runtime.execute(
      {
        ...command,
        approvalProof: { ...proof, actionDigest: `sha256:${"b".repeat(64)}` },
      },
      signal(),
    ),
    /approval/u,
  );
  assert.equal(posts, 0);
  assert.equal(
    output(
      await restricted.runtime.execute(
        { ...command, approvalProof: proof },
        signal(),
      ),
    ).submission,
    "accepted",
  );
  assert.equal(posts, 1);
});
