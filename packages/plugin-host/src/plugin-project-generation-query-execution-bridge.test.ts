import assert from "node:assert/strict";
import test from "node:test";
import type { PluginTaskServiceV2 } from "@crewon/plugin-sdk/node";
import { projectGenerationQueryExecutionFixture } from "./plugin-project-generation-query-execution-bridge.test-support.ts";
import { bridgeDeferred } from "./plugin-project-generation-action-bridge.test-support.ts";

test("actual query target receives only the original captured historical query and yields a query Run receipt", async () => {
  const f = await projectGenerationQueryExecutionFixture();
  const result = await f.execute();
  assert.deepEqual(result.command, f.input.command);
  assert.deepEqual(result.executionPin, f.input.executionPin);
  assert.notEqual(result.result.binding.runId, f.f.app.generated.binding.runId);
  assert.deepEqual(f.state.lastInvocation!.input, {
    threadId: f.input.command.threadId,
    expectedThreadRevision: f.input.command.expectedThreadRevision,
    idempotencyKey: f.input.command.idempotencyKey,
    sourceRunId: f.f.app.generated.binding.runId,
    operationId: f.input.request.operationId,
  });
  assert.equal(f.state.commits, 1);
  assert.equal(f.state.releases, 1);
});

test("foreign instance, source Run, operation, CAS and key cannot replace the bound query; generation is unavailable", async () => {
  const f = await projectGenerationQueryExecutionFixture();
  const foreign = f.bridge.hostServiceV2().bindForPlugin!(
    { ...f.identity },
    { onDispose() {} },
  ) as PluginTaskServiceV2;
  f.setService({
    actions: [
      {
        contributionId: f.input.executionPin.contributionId,
        action: f.input.executionPin.action,
        kind: "queryTask",
      },
    ],
    async invoke(invocation) {
      const request = {
        invocationRef: invocation.invocationRef,
        ...(invocation.input as unknown as Omit<
          Parameters<PluginTaskServiceV2["queryTask"]>[0],
          "invocationRef"
        >),
      };
      await assert.rejects(
        foreign.queryTask(request),
        /plugin_invocation_owner_mismatch/u,
      );
      for (const changed of [
        { ...request, sourceRunId: "another-run" },
        { ...request, operationId: "22222222-2222-4222-8222-222222222222" },
        {
          ...request,
          expectedThreadRevision: request.expectedThreadRevision + 1,
        },
        { ...request, idempotencyKey: f.input.request.idempotencyKey },
      ])
        await assert.rejects(
          f.bound.queryTask(changed),
          /plugin_invocation_task_conflict/u,
        );
      assert.throws(
        () =>
          f.bound.createTask({
            invocationRef: invocation.invocationRef,
            threadId: request.threadId,
            expectedThreadRevision: request.expectedThreadRevision,
            idempotencyKey: request.idempotencyKey,
            input: { prompt: "draft" },
          }),
        /create_unsupported/u,
      );
      return null;
    },
  });
  await assert.rejects(f.execute(), /task_not_committed/u);
  assert.equal(f.state.commits, 0);
  assert.equal(f.state.releases, 1);
});

test("query declaration is exact and mismatched actual target candidates fail before borrowing", async () => {
  for (const kind of ["read", "generateTask"] as const) {
    const f = await projectGenerationQueryExecutionFixture();
    f.setService({
      actions: [
        {
          contributionId: f.input.executionPin.contributionId,
          action: f.input.executionPin.action,
          kind,
        },
      ],
      async invoke() {
        throw new Error("must not invoke");
      },
    });
    await assert.rejects(f.execute(), /action_invalid/u);
    assert.equal(f.state.commits, 0);
    assert.equal(f.state.releases, 1);
  }
  const f = await projectGenerationQueryExecutionFixture();
  await assert.rejects(
    f.execute({
      ...f.input,
      targetCandidate: {
        ...f.input.targetCandidate,
        packageDigest: `sha256:${"d".repeat(64)}`,
      },
    }),
    /target_mismatch/u,
  );
  assert.equal(f.state.borrows, 0);
});

test("query transaction guard invokes no source or target full preflight while locks are held", async () => {
  const f = await projectGenerationQueryExecutionFixture();
  const original = f.input.commit;
  await f.execute({
    ...f.input,
    async commit(input) {
      const full = f.state.full,
        source = f.f.state.currentCalls;
      await input.authority.assertTransactionCurrent();
      input.authority.assertActive();
      assert.equal(f.state.full, full);
      assert.equal(f.f.state.currentCalls, source);
      return original(input);
    },
  });
  assert.equal(f.state.full, 2);
  assert.equal(f.state.transaction, 2);
});

test("ignored identical query promises coalesce and commit overrides a later Node error", async () => {
  const f = await projectGenerationQueryExecutionFixture();
  f.setService({
    actions: [
      {
        contributionId: f.input.executionPin.contributionId,
        action: f.input.executionPin.action,
        kind: "queryTask",
      },
    ],
    async invoke(invocation) {
      const request = {
        invocationRef: invocation.invocationRef,
        ...(invocation.input as unknown as Omit<
          Parameters<PluginTaskServiceV2["queryTask"]>[0],
          "invocationRef"
        >),
      };
      void f.bound.queryTask(request);
      void f.bound.queryTask(request);
      throw new Error("query-node-late-error");
    },
  });
  assert.equal((await f.execute()).result.turn.disposition, "committed");
  assert.equal(f.state.commits, 1);
  assert.equal(f.state.releases, 1);
});

test("close, expiry and source close before commit prevent query admission and release the borrow", async () => {
  for (const change of ["close", "expiry", "source"] as const) {
    const f = await projectGenerationQueryExecutionFixture();
    const entered = bridgeDeferred(),
      release = bridgeDeferred();
    f.state.beforeCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.execute();
    const rejected = assert.rejects(pending, /unavailable|closed/u);
    await entered.promise;
    if (change === "close") f.bridge.close();
    else if (change === "expiry") f.state.now = "2026-10-02T03:00:30.000Z";
    else f.f.state.open = false;
    release.resolve();
    await rejected;
    assert.equal(f.f.app.state.links.size, 0);
    assert.equal(f.state.releases, 1);
  }
});

test("post-COMMIT close preserves query acceptance and an expired invocation reference cannot be reused", async () => {
  const f = await projectGenerationQueryExecutionFixture();
  f.state.afterCommit = () => {
    f.bridge.close();
    f.f.state.open = false;
    f.f.state.allow = false;
  };
  assert.equal((await f.execute()).result.turn.disposition, "committed");
  const invocation = f.state.lastInvocation!;
  await assert.rejects(
    f.bound.queryTask({
      invocationRef: invocation.invocationRef,
      ...(invocation.input as unknown as Omit<
        Parameters<PluginTaskServiceV2["queryTask"]>[0],
        "invocationRef"
      >),
    }),
    /owner_mismatch/u,
  );
  assert.equal(f.state.releases, 1);
});

test("captured query request and adapter receivers cannot be replaced during an awaiting preflight", async () => {
  const f = await projectGenerationQueryExecutionFixture();
  const entered = bridgeDeferred(),
    release = bridgeDeferred();
  f.state.beforeFull = async () => {
    entered.resolve();
    await release.promise;
  };
  const input = {
    ...f.input,
    command: structuredClone(f.input.command),
    authority: { ...f.input.authority },
  };
  const pending = f.execute(input);
  await entered.promise;
  Object.defineProperty(input.command, "intent", {
    enumerable: true,
    value: {
      kind: "query",
      sourceRunId: "replacement",
      operationId: f.input.request.operationId,
    },
  });
  input.authority.assertCurrent = async () => {
    throw new Error("replacement");
  };
  input.authority.assertTransactionCurrent = async () => {
    throw new Error("replacement");
  };
  input.commit = async () => {
    throw new Error("replacement");
  };
  f.state.beforeFull = null;
  release.resolve();
  assert.deepEqual((await pending).command, f.input.command);
  assert.equal(f.state.commits, 1);
});
