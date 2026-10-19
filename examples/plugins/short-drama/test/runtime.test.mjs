import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "20.0.2";
const plugin = (
  await import(
    process.env.CREWON_SHORT_DRAMA_PLUGIN_DIR
      ? pathToFileURL(
          join(process.env.CREWON_SHORT_DRAMA_PLUGIN_DIR, "node.mjs"),
        ).href
      : `../dist/${version}/node.mjs`
  )
).default;
const SUBMIT = "crewon_short_drama__submit";
const OBSERVE = "crewon_short_drama__observe";
const providerId = "11111111-1111-1111-1111-111111111111";
const digest = (input) =>
  "sha256:" + createHash("sha256").update(input).digest("hex");
function canonical(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}
function context(overrides = {}) {
  return {
    identity: {
      pluginId: "crewon.short-drama",
      version,
      packageDigest: digest("package"),
    },
    scope: { tenantId: "tenant-1", spaceId: "space-1", profileId: "profile-1" },
    run: {
      runId: "run-1",
      threadId: "thread-1",
      bindingDigest: digest("binding"),
      inputDigest: digest("input"),
      source: null,
    },
    configuration: {
      revision: 1,
      contentDigest: digest("configuration"),
      parameters: {
        baseUrl: "https://comfy.example/",
        preset: "krea2-portrait",
      },
      credentialBindings: [],
    },
    target: {
      executionAuthority: "crewonKernel",
      agentVersionId: "agent-1",
      agentVersionContentDigest: digest("agent"),
      materializationDigest: digest("materialization"),
      authorityId: "authority-1",
      runtimeGeneration: "generation-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
    },
    ...overrides,
  };
}
function factory(tasks, mediaExecution) {
  let factory;
  let actions;
  const disposers = [];
  plugin.setup({
    identity: {
      pluginId: "crewon.short-drama",
      version,
      packageDigest: digest("package"),
    },
    services: {
      getOptional(service, apiVersion) {
        if (service === "crewon.project-media-execution") return mediaExecution;
        if (service === "crewon.tasks") {
          assert.equal(apiVersion, "2");
          return tasks;
        }
        return service === "crewon.execution"
          ? {
              register(value) {
                factory = value;
                return { dispose() {} };
              },
            }
          : undefined;
      },
      provide(_name, _api, value) {
        actions = value;
        return { dispose() {} };
      },
    },
    onDispose(callback) {
      disposers.push(callback);
    },
  });
  assert.equal(typeof factory?.create, "function");
  assert.deepEqual(
    factory.requiredServices,
    Number(version.split(".")[0]) < 13
      ? ["externalOperations", "jsonHttp"]
      : undefined,
  );
  return { factory, actions };
}
/** Explicit unit IO ports; these do not simulate host permissions, paid admission or production network governance. */
function fixture(options = {}) {
  const ctx = options.context ?? context();
  const operations = options.operations ?? new Map();
  const requests = [];
  const ioCommands = [];
  const services = {
    approvalRequirement: options.approvalRequirement ?? "none",
    externalOperations: {
      async reserve({ command, operationId, request }) {
        ioCommands.push(command);
        const existing = operations.get(operationId);
        if (existing)
          return {
            disposition: "existing",
            operation: existing,
            dispatchRef: null,
          };
        const value = Object.freeze({
          schemaVersion: "crewon.external-operation.v0",
          tenantId: ctx.scope.tenantId,
          runId: ctx.run.runId,
          bindingDigest: ctx.run.bindingDigest,
          operationId,
          executionId: command.executionId,
          idempotencyKey: command.idempotencyKey,
          actionDigest: command.actionDigest,
          requestDigest: digest(canonical(request)),
          correlationId: operationId,
          providerOperationId: null,
          status: "submitting",
          resultJson: null,
          revision: 1,
          createdAt: "2026-10-03T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
        });
        operations.set(operationId, value);
        return {
          disposition: "created",
          operation: value,
          dispatchRef: "dispatch-" + operationId,
        };
      },
      async load({ command, operationId }) {
        ioCommands.push(command);
        return operations.get(operationId) ?? null;
      },
      async advance({ command, operationId, expectedRevision, ...changes }) {
        ioCommands.push(command);
        const previous = operations.get(operationId);
        assert.ok(previous);
        if (previous.revision !== expectedRevision)
          return { disposition: "conflict", operation: previous };
        const value = Object.freeze({
          ...previous,
          ...changes,
          revision: previous.revision + 1,
        });
        operations.set(operationId, value);
        return { disposition: "updated", operation: value };
      },
    },
    jsonHttp: {
      async request(input) {
        ioCommands.push(input.command);
        requests.push(input);
        if (options.request) return options.request(input);
        if (input.method === "POST")
          return { prompt_id: providerId, node_errors: {} };
        if (input.path.startsWith("/history/")) return {};
        return { queue_running: [], queue_pending: [] };
      },
    },
  };
  const runtime = factory(undefined, options.mediaExecution).factory.create(
    ctx,
    services,
  );
  function command(
    name = SUBMIT,
    input = { prompt: "写实人物照片" },
    index = 1,
  ) {
    const serialized = JSON.stringify(input);
    const policy = runtime.executionPolicy("function", name);
    const actionIntent = {
      schemaVersion: "crewon.action-intent.v0",
      runId: ctx.run.runId,
      segmentId: "segment-" + index,
      callId: "call-" + index,
      tool: { kind: "function", name, inputDigest: digest(serialized) },
      policySnapshotId: ctx.target.policySnapshotId,
      workspaceBindingId: ctx.target.workspaceBindingId,
      ...policy,
    };
    return Object.freeze({
      schemaVersion: "crewon.tool-invocation.v0",
      executionId: "execution-" + index,
      idempotencyKey: "key-" + index,
      runId: ctx.run.runId,
      segmentId: actionIntent.segmentId,
      callId: actionIntent.callId,
      kind: "function",
      name,
      input: serialized,
      actionDigest: digest(canonical(actionIntent)),
      actionIntent,
      executionLease: {
        workItemId: "work-1",
        stepId: "step-1",
        attemptId: "attempt-1",
        leaseId: "lease-1",
        leaseEpoch: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      approvalProof: null,
    });
  }
  return {
    runtime,
    context: ctx,
    operations,
    requests,
    ioCommands,
    services,
    command,
  };
}
const signal = () => new AbortController().signal;
function ack(command, resolution) {
  return {
    executionId: command.executionId,
    idempotencyKey: command.idempotencyKey,
    actionDigest: command.actionDigest,
    actionIntent: command.actionIntent,
    status: resolution.status,
    providerReceiptId: resolution.providerReceiptId,
  };
}

function characterContext() {
  const value = context();
  value.configuration.parameters.preset = "krea2-character-three-view";
  return value;
}

test("character preset preserves the reviewed graph and changes only the two declared slots", async () => {
  const template = JSON.parse(
    await readFile(
      new URL(
        "../src/templates/krea2-character-three-view.api.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const f = fixture({ context: characterContext() });
  const command = f.command(SUBMIT, {
    prompt: "同一角色的正面、侧面和背面\n保持服装一致",
  });
  const result = await f.runtime.execute(command, signal());
  assert.equal(result.status, "completed");
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  const expected = structuredClone(template);
  expected["121"].inputs.prompt = JSON.parse(command.input).prompt;
  expected["29"].inputs.filename_prefix = "crewon-" + result.providerReceiptId;
  assert.equal(Object.keys(request.body.prompt).length, 16);
  assert.equal(canonical(request.body.prompt), canonical(expected));
  assert.equal(
    f.operations.get(result.providerReceiptId).requestDigest,
    digest(
      canonical({
        method: request.method,
        path: request.path,
        body: request.body,
      }),
    ),
  );
  assert.deepEqual(await f.runtime.execute(command, signal()), result);
  assert.equal(f.requests.length, 1);
  await f.runtime.close();
});

test("a character lost reply reconciles the same operation without a second submission", async () => {
  const f = fixture({
    context: characterContext(),
    request(request) {
      if (request.method === "POST")
        throw new Error("test-owned lost response");
      return request.path.startsWith("/history/")
        ? {}
        : { queue_running: [], queue_pending: [] };
    },
  });
  const command = f.command();
  const result = await f.runtime.execute(command, signal());
  assert.equal(result.status, "unknownOutcome");
  const operationId = result.providerReceiptId;
  const original = f.operations.get(operationId);
  await f.runtime.close();
  const cold = fixture({
    context: characterContext(),
    operations: f.operations,
  });
  assert.equal(
    (await cold.runtime.reconcile(command, signal())).status,
    "unknownOutcome",
  );
  assert.equal(
    cold.requests.filter((request) => request.method === "POST").length,
    0,
  );
  assert.deepEqual(
    cold.requests.map((request) => request.path),
    ["/history/" + operationId, "/queue"],
  );
  assert.equal(
    cold.operations.get(operationId).requestDigest,
    original.requestDigest,
  );
  assert.equal(cold.operations.size, 1);
  await cold.runtime.close();
});

test("changing preset cannot reinterpret an original operation or dispatch again", async () => {
  const original = fixture({ context: characterContext() });
  const command = original.command();
  const accepted = await original.runtime.execute(command, signal());
  const digestBefore = original.operations.get(
    accepted.providerReceiptId,
  ).requestDigest;
  await original.runtime.close();
  const different = fixture({ operations: original.operations });
  await assert.rejects(
    () => different.runtime.reconcile(command, signal()),
    /operation_identity_conflict/,
  );
  assert.equal(different.requests.length, 0);
  assert.equal(
    different.operations.get(accepted.providerReceiptId).requestDigest,
    digestBefore,
  );
  await different.runtime.close();
});

test("unknown or absent preset refuses the factory before IO", () => {
  for (const preset of [
    undefined,
    "../../../arbitrary.json",
    "unreviewed-video",
    true,
  ]) {
    const value = context();
    if (preset === undefined) delete value.configuration.parameters.preset;
    else value.configuration.parameters.preset = preset;
    assert.throws(() => fixture({ context: value }), /configuration_invalid/);
  }
});

test("requires explicit host IO and applies perAction only to submit", async () => {
  if (Number(version.split(".")[0]) < 13) {
    assert.throws(
      () => factory().factory.create(context()),
      /execution_io_unavailable/,
    );
  } else {
    const noIo = factory().factory.create(context());
    assert.equal(
      noIo.definitions().length,
      Number(version.split(".")[0]) >= 40
        ? 34
        : Number(version.split(".")[0]) >= 23
          ? 24
          : Number(version.split(".")[0]) >= 21
            ? 23
            : Number(version.split(".")[0]) >= 19
              ? 21
              : Number(version.split(".")[0]) >= 16
                ? 15
                : 14,
    );
    await assert.rejects(
      noIo.execute(fixture().command(), signal()),
      /execution_io_unavailable/,
    );
    await noIo.close();
  }
  const f = fixture({ approvalRequirement: "perAction" });
  assert.equal(
    f.runtime.executionPolicy("function", SUBMIT).approvalRequirement,
    "perAction",
  );
  assert.equal(
    f.runtime.executionPolicy("function", OBSERVE).approvalRequirement,
    "none",
  );
  await f.runtime.close();
});

test("Node actions use tasks@2 and actual invocation reference; query only passes source references", async () => {
  const calls = [];
  const receipt = {
    disposition: "committed",
    threadId: "thread-1",
    threadRevision: 2,
    runId: "run-1",
    messageId: "message-1",
    configurationRevision: 1,
  };
  const { actions } = factory({
    async createTask(input) {
      calls.push({ kind: "create", input });
      return receipt;
    },
    async queryTask(input) {
      calls.push({ kind: "query", input });
      return receipt;
    },
  });
  assert.deepEqual(actions.actions, [
    ...(Number(version.split(".")[0]) >= 13
      ? [
          {
            contributionId: "workbench",
            action: "project.execute",
            kind: "generateTask",
          },
        ]
      : []),
    {
      contributionId: "workbench",
      action: "image.generate",
      kind: "generateTask",
    },
    { contributionId: "workbench", action: "image.query", kind: "queryTask" },
  ]);
  const common = {
    threadId: "thread-1",
    expectedThreadRevision: 1,
    idempotencyKey: "request-1",
  };
  await actions.invoke({
    invocationRef: "actual-create",
    contributionId: "workbench",
    action: "image.generate",
    input: { ...common, input: { prompt: "写实照片" } },
  });
  await actions.invoke({
    invocationRef: "actual-query",
    contributionId: "workbench",
    action: "image.query",
    input: { ...common, sourceRunId: "run-1", operationId: providerId },
  });
  assert.equal(calls[0].input.invocationRef, "actual-create");
  assert.deepEqual(calls[1].input, {
    ...common,
    sourceRunId: "run-1",
    operationId: providerId,
    invocationRef: "actual-query",
  });
  await assert.rejects(
    () =>
      actions.invoke({
        invocationRef: "invalid",
        contributionId: "workbench",
        action: "image.query",
        input: {
          ...common,
          sourceRunId: "run-1",
          operationId: providerId,
          actor: "forged",
        },
      }),
    /action_input_invalid/,
  );
  assert.equal(calls.length, 2);
  if (Number(version.split(".")[0]) >= 21) {
    for (const action of ["project.execute", "image.generate"])
      for (const input of [
        {},
        { prompt: "valid", mediaInputId: "invented" },
        {
          kind: "crewon.short-drama.reference-generation.v1",
          projectId: "invented",
        },
      ])
        await assert.rejects(
          actions.invoke({
            invocationRef: "forged-media",
            contributionId: "workbench",
            action,
            input: { ...common, input },
          }),
          /action_input_invalid/,
        );
    assert.equal(calls.length, 2);
  }
  if (Number(version.split(".")[0]) >= 13) {
    await actions.invoke({
      invocationRef: "actual-project",
      contributionId: "workbench",
      action: "project.execute",
      input: {
        ...common,
        idempotencyKey: "project-request",
        input: { prompt: "整理想法并生成大纲。" },
      },
    });
    assert.deepEqual(calls[2], {
      kind: "create",
      input: {
        ...common,
        idempotencyKey: "project-request",
        input: { prompt: "整理想法并生成大纲。" },
        invocationRef: "actual-project",
      },
    });
    await assert.rejects(
      () =>
        actions.invoke({
          invocationRef: "forged-project",
          contributionId: "workbench",
          action: "project.execute",
          input: { ...common, input: { prompt: "idea" }, actor: "forged" },
        }),
      /action_input_invalid/,
    );
    assert.equal(calls.length, 3);
  }
  await assert.rejects(
    () =>
      factory().actions.invoke({
        invocationRef: "no-tasks",
        contributionId: "workbench",
        action: "image.query",
        input: {},
      }),
    /tasks_unavailable/,
  );
});

test("fixed workflow submits once with original command and durable acceptance; cold recovery never POSTs", async () => {
  const f = fixture();
  const command = f.command();
  const result = await f.runtime.execute(command, signal());
  assert.equal(result.status, "completed");
  const id = result.providerReceiptId;
  assert.equal(f.operations.get(id).providerOperationId, providerId);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.command, command);
  assert.ok(f.ioCommands.every((item) => item === command));
  assert.equal(request.dispatchRef, "dispatch-" + id);
  assert.equal(request.body.prompt_id, id);
  assert.equal(request.body.client_id, id);
  const graph = request.body.prompt;
  assert.equal(graph["49"].inputs.megapixels, 1);
  assert.equal(graph["53"].inputs.seed, 769068639772876);
  assert.equal(graph["51"].inputs.text, "写实人物照片");
  assert.equal(graph["29"].inputs.filename_prefix, "crewon-" + id);
  assert.deepEqual(Object.keys(graph), [
    "29",
    "49",
    "51",
    "52",
    "53",
    "54",
    "55",
    "56",
    "57",
    "58",
    "87",
  ]);
  assert.deepEqual(await f.runtime.execute(command, signal()), result);
  assert.equal(f.requests.length, 1);
  assert.equal(
    f.runtime.acknowledgeExecutionResult(ack(command, result)),
    true,
  );
  await f.runtime.close();
  const cold = fixture({ operations: f.operations });
  assert.deepEqual(await cold.runtime.reconcile(command, signal()), result);
  assert.equal(cold.requests.length, 0);
  await cold.runtime.close();
});

test("unknown transport outcome cannot repeat POST; absent history and cancel preserve uncertainty", async () => {
  const f = fixture({
    request(input) {
      if (input.method === "POST") throw new Error("lost response");
      return input.path.startsWith("/history/")
        ? {}
        : { queue_running: [], queue_pending: [] };
    },
  });
  const command = f.command();
  const first = await f.runtime.execute(command, signal());
  assert.equal(first.status, "unknownOutcome");
  await assert.rejects(
    () => f.runtime.execute(command, signal()),
    /requires_reconciliation/,
  );
  assert.equal(
    (await f.runtime.reconcile(command, signal())).status,
    "unknownOutcome",
  );
  assert.equal(
    (await f.runtime.cancel(command, signal())).status,
    "unknownOutcome",
  );
  assert.equal(
    f.requests.filter((request) => request.method === "POST").length,
    1,
  );
  assert.ok(f.requests.every((request) => request.path !== "/interrupt"));
  await f.runtime.close();
});

test("a received acceptance is persisted despite abort immediately after response", async () => {
  const controller = new AbortController();
  const f = fixture({
    request() {
      controller.abort(new Error("revoked after provider response"));
      return { prompt_id: providerId };
    },
  });
  const result = await f.runtime.execute(f.command(), controller.signal);
  assert.equal(result.status, "completed");
  assert.equal(
    f.operations.get(result.providerReceiptId).providerOperationId,
    providerId,
  );
  await f.runtime.close();
});

test("success comes only from output29 with sanitized real image references; terminal lookup uses stored evidence", async () => {
  const f = fixture({
    request(input) {
      return input.method === "POST"
        ? { prompt_id: providerId }
        : {
            [providerId]: {
              status: { completed: true, status_str: "success" },
              outputs: {
                29: {
                  images: [
                    {
                      filename: "real image.png",
                      subfolder: "safe",
                      type: "output",
                    },
                  ],
                },
              },
            },
          };
    },
  });
  const submitted = await f.runtime.execute(f.command(), signal());
  const observed = await f.runtime.execute(
    f.command(OBSERVE, { operationId: submitted.providerReceiptId }, 2),
    signal(),
  );
  const output = JSON.parse(observed.result.output);
  assert.equal(output.status, "succeeded");
  assert.equal(
    output.images[0].url,
    "https://comfy.example/view?filename=real+image.png&subfolder=safe&type=output",
  );
  const before = f.requests.length;
  await f.runtime.execute(
    f.command(OBSERVE, { operationId: submitted.providerReceiptId }, 3),
    signal(),
  );
  assert.equal(f.requests.length, before);
  await f.runtime.close();
});

test("unsafe provider image paths are rejected without publishing links", async () => {
  const f = fixture({
    request(input) {
      return input.method === "POST"
        ? { prompt_id: providerId }
        : {
            [providerId]: {
              status: { completed: true, status_str: "success" },
              outputs: {
                29: {
                  images: [
                    { filename: "../secret", subfolder: "", type: "output" },
                  ],
                },
              },
            },
          };
    },
  });
  const submitted = await f.runtime.execute(f.command(), signal());
  await assert.rejects(
    () =>
      f.runtime.execute(
        f.command(OBSERVE, { operationId: submitted.providerReceiptId }, 2),
        signal(),
      ),
    /image_reference_invalid/,
  );
  assert.equal(f.operations.get(submitted.providerReceiptId).resultJson, null);
  await f.runtime.close();
});

test("query source forbids submission and unrelated operation before any IO", async () => {
  const base = context();
  const f = fixture({
    context: context({
      run: {
        ...base.run,
        runId: "query-run",
        source: {
          runId: "run-1",
          operationId: providerId,
          bindingDigest: base.run.bindingDigest,
        },
      },
    }),
  });
  await assert.rejects(
    () => f.runtime.execute(f.command(), signal()),
    /query_submission_forbidden/,
  );
  const result = await f.runtime.execute(
    f.command(OBSERVE, { operationId: "22222222-2222-2222-2222-222222222222" }),
    signal(),
  );
  assert.equal(result.result.isError, true);
  assert.deepEqual(JSON.parse(result.result.output), {
    error: "operation_not_found",
  });
  assert.equal(f.ioCommands.length, 0);
  await f.runtime.close();
});

test("bounded retained evidence rotates, projects exact ABI, rejects conflicting retries and releases by full ACK", async () => {
  const f = fixture();
  const first = f.command();
  const second = f.command(SUBMIT, { prompt: "另一个画面" }, 2);
  const a = await f.runtime.execute(first, signal());
  const b = await f.runtime.execute(second, signal());
  assert.equal(f.runtime.canRetire(), false);
  assert.notEqual(
    f.runtime.scanRetainedExecutionResults({ limit: 1 })[0].executionId,
    f.runtime.scanRetainedExecutionResults({ limit: 1 })[0].executionId,
  );
  const run = f.runtime.retainedExecutionResults({
    runId: f.context.run.runId,
    limit: 128,
  });
  assert.deepEqual(
    Object.keys(run[0]).sort(),
    [
      "executionId",
      "idempotencyKey",
      "actionDigest",
      "kind",
      "name",
      "status",
    ].sort(),
  );
  assert.deepEqual(
    f.runtime.retainedExecutionResults({ runId: "other-run", limit: 1 }),
    [],
  );
  const scoped = f.runtime.scanRetainedExecutionResults({ limit: 128 });
  assert.ok(
    scoped.every(
      (entry) =>
        entry.tenantId === f.context.scope.tenantId &&
        entry.runId === f.context.run.runId,
    ),
  );
  assert.equal(
    f.runtime.acknowledgeExecutionResult({
      ...ack(first, a),
      actionIntent: { ...first.actionIntent, runId: "other-run" },
    }),
    false,
  );
  await assert.rejects(
    () =>
      f.runtime.execute(
        { ...first, input: JSON.stringify({ prompt: "conflict" }) },
        signal(),
      ),
    /command_mismatch|execution_conflict/,
  );
  assert.equal(f.runtime.acknowledgeExecutionResult(ack(first, a)), true);
  assert.deepEqual(f.runtime.readRetainedExecutionResult(ack(second, b)), b);
  assert.equal(f.runtime.acknowledgeExecutionResult(ack(second, b)), true);
  assert.equal(f.runtime.canRetire(), true);
  assert.equal(f.operations.size, 2);
  await f.runtime.close();
});

test("32 receipts bound capacity until a correct ACK; rejected capacity creates no external operation", async () => {
  const f = fixture();
  let first;
  for (let i = 1; i <= 32; i++) {
    const command = f.command(SUBMIT, { prompt: "画面" }, i);
    const result = await f.runtime.execute(command, signal());
    if (i === 1) first = { command, result };
  }
  await assert.rejects(
    () =>
      f.runtime.execute(f.command(SUBMIT, { prompt: "画面" }, 33), signal()),
    /retained_capacity_exceeded/,
  );
  assert.equal(f.operations.size, 32);
  assert.equal(f.requests.length, 32);
  assert.equal(
    f.runtime.acknowledgeExecutionResult(ack(first.command, first.result)),
    true,
  );
  assert.equal(
    (
      await f.runtime.execute(
        f.command(SUBMIT, { prompt: "画面" }, 33),
        signal(),
      )
    ).status,
    "completed",
  );
  await f.runtime.close();
});

test("close waits physical request and serial concurrency cannot dispatch a second provider call", async () => {
  let finish;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture({
    async request() {
      started();
      await gate;
      return { prompt_id: providerId };
    },
  });
  const command = f.command();
  const active = f.runtime.execute(command, signal());
  await ready;
  assert.equal(f.runtime.canRetire(), false);
  await assert.rejects(
    () =>
      f.runtime.execute(
        f.command(SUBMIT, { prompt: "第二个画面" }, 2),
        signal(),
      ),
    /runtime_busy/,
  );
  let closed = false;
  const closing = f.runtime.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(f.requests.length, 1);
  finish();
  assert.equal((await active).status, "completed");
  await closing;
  assert.equal(
    f.operations.values().next().value.providerOperationId,
    providerId,
  );
  await assert.rejects(
    () => f.runtime.execute(command, signal()),
    /runtime_closed/,
  );
});

test("an old unknown ACK cannot release the same execution while physical reconciliation is pending", async () => {
  let finish;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture({
    async request(input) {
      if (input.method === "POST") throw new Error("lost provider response");
      if (input.path.startsWith("/history/")) {
        started();
        await gate;
        return {};
      }
      return { queue_running: [], queue_pending: [] };
    },
  });
  const command = f.command();
  const previous = await f.runtime.execute(command, signal());
  const pending = f.runtime.reconcile(command, signal());
  await ready;
  assert.equal(
    f.runtime.acknowledgeExecutionResult(ack(command, previous)),
    false,
  );
  assert.equal(f.runtime.canRetire(), false);
  finish();
  const resolved = await pending;
  assert.equal(resolved.status, "unknownOutcome");
  assert.equal(
    f.runtime.acknowledgeExecutionResult(ack(command, resolved)),
    true,
  );
  assert.equal(f.runtime.canRetire(), true);
  await f.runtime.close();
});

function panelContext() {
  const value = context();
  value.configuration.parameters.serviceProtocol = "workflow-panel-v1";
  return value;
}

test("workflow panel submits the fixed graph once and observes the provider's returned id with canonical image URLs", async () => {
  const f = fixture({
    context: panelContext(),
    request(request) {
      if (request.method === "POST") {
        assert.equal(request.path, "/api/workflow/generate");
        assert.equal(request.body.source, "quick");
        assert.equal(
          request.body.workflow_template["29"].class_type,
          "SaveImage",
        );
        assert.equal(
          request.body.workflow_template["51"].inputs.text,
          "测试剧情角色",
        );
        assert.equal(request.body.prompt_id, request.body.client_id);
        assert.equal(Object.hasOwn(request.body, "workflow_id"), false);
        return { success: true, prompt_id: providerId };
      }
      assert.equal(
        request.path,
        "/api/comfy/proxy/history?prompt_id=" + providerId,
      );
      return {
        [providerId]: {
          status: { completed: true, status_str: "success" },
          outputs: {
            29: {
              images: [
                {
                  filename: "image one.png",
                  subfolder: "scene",
                  type: "output",
                },
              ],
            },
          },
        },
      };
    },
  });
  const command = f.command(SUBMIT, { prompt: "测试剧情角色" });
  const submitted = await f.runtime.execute(command, signal());
  const observed = await f.runtime.execute(
    f.command(OBSERVE, { operationId: submitted.providerReceiptId }, 2),
    signal(),
  );
  const output = JSON.parse(observed.result.output);
  assert.equal(output.status, "succeeded");
  assert.equal(
    output.images[0].url,
    "https://comfy.example/api/comfy/view?filename=image+one.png&subfolder=scene&type=output",
  );
  await f.runtime.execute(command, signal());
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  await f.runtime.close();
});

test("panel lost response and missing process history stay unknown after cold reconciliation without resubmission", async () => {
  const f = fixture({
    context: panelContext(),
    request() {
      throw new Error("lost panel reply");
    },
  });
  const command = f.command();
  const submitted = await f.runtime.execute(command, signal());
  assert.equal(submitted.status, "unknownOutcome");
  await f.runtime.close();
  const cold = fixture({
    context: panelContext(),
    operations: f.operations,
    request(r) {
      assert.equal(r.method, "GET");
      return r.path.includes("/history?")
        ? {}
        : { queue_running: [], queue_pending: [] };
    },
  });
  assert.equal(
    (await cold.runtime.reconcile(command, signal())).status,
    "unknownOutcome",
  );
  assert.deepEqual(
    cold.requests.map((r) => r.path),
    [
      "/api/comfy/proxy/history?prompt_id=" + submitted.providerReceiptId,
      "/api/comfy/proxy/queue",
    ],
  );
  await cold.runtime.close();
  const native = fixture({ operations: f.operations });
  await assert.rejects(
    () => native.runtime.reconcile(command, signal()),
    /operation_identity_conflict/,
  );
  assert.equal(native.requests.length, 0);
  await native.runtime.close();
});

test("unknown service protocols fail before network IO", () => {
  for (const serviceProtocol of [
    null,
    true,
    "https://other.example/api",
    "workflow-panel-v2",
  ]) {
    const ctx = context();
    ctx.configuration.parameters.serviceProtocol = serviceProtocol;
    assert.throws(() => fixture({ context: ctx }), /service_protocol_invalid/);
  }
});

function savedApiContext(preset = "api-c16-scene") {
  const ctx = context();
  ctx.configuration.parameters = {
    ...ctx.configuration.parameters,
    preset,
    serviceProtocol: "workflow-api-v1",
  };
  return ctx;
}

test("saved C16 API uses its actual aliases and exact output58; one operation never dispatches twice", async () => {
  const f = fixture({
    context: savedApiContext(),
    request(r) {
      if (r.method === "POST") {
        assert.equal(r.path, "/api/workflow/generate");
        assert.equal(
          r.body.workflow_id,
          "API-C16-短剧文生图专用-支持场景-角色",
        );
        assert.deepEqual(Object.keys(r.body.input_values).sort(), [
          "prompt_2",
          "seed",
          "value",
          "value_2",
        ]);
        assert.equal(r.body.input_values.prompt_2, "闭店柜台，无人空场");
        assert.equal(r.body.input_values.value, 1280);
        assert.equal(r.body.input_values.value_2, 720);
        assert.equal(Object.hasOwn(r.body, "workflow_template"), false);
        assert.equal(Object.hasOwn(r.body, "source"), false);
        assert.equal(r.body.prompt_id, r.body.client_id);
        return { success: true, prompt_id: providerId };
      }
      assert.equal(r.path, "/api/comfy/proxy/history?prompt_id=" + providerId);
      return {
        [providerId]: {
          status: { completed: true, status_str: "success" },
          outputs: {
            29: {
              images: [
                { filename: "unrelated.png", subfolder: "", type: "output" },
              ],
            },
            58: {
              images: [
                {
                  filename: "saved-scene.png",
                  subfolder: "crewon",
                  type: "output",
                },
              ],
            },
          },
        },
      };
    },
  });
  const command = f.command(SUBMIT, { prompt: "闭店柜台，无人空场" });
  const accepted = await f.runtime.execute(command, signal());
  const observed = await f.runtime.execute(
    f.command(OBSERVE, { operationId: accepted.providerReceiptId }, 2),
    signal(),
  );
  const output = JSON.parse(observed.result.output);
  assert.equal(output.status, "succeeded");
  assert.equal(output.images.length, 1);
  assert.equal(
    output.images[0].url,
    "https://comfy.example/api/comfy/view?filename=saved-scene.png&subfolder=crewon&type=output",
  );
  await f.runtime.execute(command, signal());
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  await f.runtime.close();
});

test("saved portrait and T4 APIs keep their distinct dimensions and prompt aliases", async () => {
  for (const [preset, expected] of [
    [
      "api-c16-portrait",
      { value: 768, value_2: 1024, prompt_2: "原创成年角色" },
    ],
    [
      "api-t4-three-view",
      { width: 1920, height: 1080, value: false, prompt: "原创成年角色" },
    ],
  ]) {
    const f = fixture({ context: savedApiContext(preset) });
    await f.runtime.execute(
      f.command(SUBMIT, { prompt: "原创成年角色" }),
      signal(),
    );
    const values = f.requests[0].body.input_values;
    for (const [k, v] of Object.entries(expected)) assert.equal(values[k], v);
    assert.equal(Object.hasOwn(values, "seed"), preset !== "api-t4-three-view");
    await f.runtime.close();
  }
});

test("lost saved-API replies recover the original operation and cannot be reinterpreted as a local graph", async () => {
  const f = fixture({
    context: savedApiContext(),
    request() {
      throw new Error("lost saved API reply");
    },
  });
  const command = f.command();
  const accepted = await f.runtime.execute(command, signal());
  assert.equal(accepted.status, "unknownOutcome");
  await f.runtime.close();
  const cold = fixture({
    context: savedApiContext(),
    operations: f.operations,
    request(r) {
      assert.equal(r.method, "GET");
      return r.path.includes("history?")
        ? {}
        : { queue_running: [], queue_pending: [] };
    },
  });
  assert.equal(
    (await cold.runtime.reconcile(command, signal())).status,
    "unknownOutcome",
  );
  assert.equal(
    cold.requests.some((r) => r.method === "POST"),
    false,
  );
  await cold.runtime.close();
  const different = fixture({
    context: panelContext(),
    operations: f.operations,
  });
  await assert.rejects(
    () => different.runtime.reconcile(command, signal()),
    /operation_identity_conflict/,
  );
  assert.equal(different.requests.length, 0);
  await different.runtime.close();
});

test("saved API and local graph presets cannot silently cross protocols", () => {
  for (const [preset, serviceProtocol] of [
    ["api-c16-scene", "native"],
    ["api-c16-scene", "workflow-panel-v1"],
    ["krea2-portrait", "workflow-api-v1"],
    ["unknown-api", "workflow-api-v1"],
  ]) {
    const ctx = context();
    ctx.configuration.parameters = {
      ...ctx.configuration.parameters,
      preset,
      serviceProtocol,
    };
    assert.throws(() => fixture({ context: ctx }), /configuration_invalid/);
  }
});

for (const protocol of ["native", "workflow-panel-v1", "workflow-api-v1"])
  test(`project media ${protocol}: packaged Tool runtime submits the reviewed graph once and cold observation never re-submits`, async () => {
    const module = await import(
      process.env.CREWON_SHORT_DRAMA_PLUGIN_DIR
        ? pathToFileURL(
            join(process.env.CREWON_SHORT_DRAMA_PLUGIN_DIR, "node.mjs"),
          ).href
        : `../dist/${version}/node.mjs`
    );
    const reviewed = module.referenceWorkflowCatalog.find(
      (w) => w.workflowId === "krea2-reference-four-view",
    );
    const workflow = {
      workflowId: reviewed.workflowId,
      workflowDigest: reviewed.workflowDigest,
      output: { kind: "image", nodeId: "129", dimensions: "workflow-native" },
    };
    const reference = {
      schemaVersion: "crewon.project-media-generation-reference.v1",
      projectId: "project",
      mediaInputId: "media",
      executionId: "media-execution",
      inputRevision: 1,
      expectedInputRevision: 1,
      mediaInputDigest: digest("media"),
      workflowId: workflow.workflowId,
      materials: [{ role: "character" }],
    };
    const operations = new Map();
    const mediaExecution = {
      async readInput() {
        const operation = [...operations.values()][0];
        return operation
          ? { kind: "existing", reference, workflow, operation }
          : {
              kind: "new",
              reference,
              workflow,
              prompt: "同一原创成年角色四视图",
              targetServiceOrigin: "https://comfy.example/",
              images: {
                character: {
                  filename: "material-prepared.png",
                  subfolder: "",
                  type: "input",
                },
              },
            };
      },
      async readOperation() {
        const operation = [...operations.values()][0];
        return operation
          ? { kind: "existing", reference, workflow, operation }
          : null;
      },
    };
    const ctx = context();
    ctx.configuration.parameters.serviceProtocol = protocol;
    const options = {
      context: ctx,
      operations,
      mediaExecution,
      request(q) {
        if (q.method === "POST") {
          assert.equal(
            q.path,
            protocol === "native" ? "/prompt" : "/api/workflow/generate",
          );
          const graph =
            protocol === "native" ? q.body.prompt : q.body.workflow_template;
          assert.equal(
            graph["146"].inputs.image,
            "material-prepared.png [input]",
          );
          if (protocol !== "native") {
            assert.equal(q.body.source, "quick");
            assert.equal(Object.hasOwn(q.body, "workflow_id"), false);
          }
          return { success: true, prompt_id: providerId };
        }
        assert.equal(
          q.path,
          protocol === "native"
            ? `/history/${providerId}`
            : `/api/comfy/proxy/history?prompt_id=${providerId}`,
        );
        return {
          [providerId]: {
            status: { completed: true, status_str: "success" },
            outputs: {
              129: {
                images: [
                  { filename: "four-view.png", subfolder: "", type: "output" },
                ],
              },
            },
          },
        };
      },
    };
    const f = fixture(options),
      command = f.command("crewon_short_drama__media_submit", {});
    assert.equal(
      (await f.runtime.execute(command, signal())).status,
      "completed",
    );
    assert.equal(f.requests.filter((q) => q.method === "POST").length, 1);
    const cold = fixture(options);
    assert.equal(
      (await cold.runtime.reconcile(command, signal())).status,
      "completed",
    );
    assert.equal(cold.requests.filter((q) => q.method === "POST").length, 0);
    const result = JSON.parse([...operations.values()][0].resultJson);
    assert.equal(
      result.images[0].url,
      `https://comfy.example${protocol === "native" ? "/view" : "/api/comfy/view"}?filename=four-view.png&subfolder=&type=output`,
    );
  });
