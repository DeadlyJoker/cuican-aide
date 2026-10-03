import assert from "node:assert/strict";
import test from "node:test";
import type {
  PluginActionsService,
  PluginTaskService,
} from "@crewon/plugin-sdk/node";
import { projectGenerationExecutionFixture } from "./plugin-project-generation-execution-bridge.test-support.ts";
import { bridgeDeferred } from "./plugin-project-generation-action-bridge.test-support.ts";

test("actual target instance receives the original task shape and only the captured saved command can commit", async () => {
  const f = projectGenerationExecutionFixture();
  const result = await f.execute();
  assert.deepEqual(result.command, f.input.command);
  assert.deepEqual(result.executionPin, f.input.executionPin);
  assert.equal(result.result.turn.disposition, "committed");
  assert.deepEqual(f.state.serviceLookups, [
    `${f.input.executionPin.pluginId}@1`,
  ]);
  assert.deepEqual(f.state.lastInvocation!.input, {
    threadId: f.input.command.threadId,
    expectedThreadRevision: f.input.command.expectedThreadRevision,
    idempotencyKey: f.input.command.idempotencyKey,
    input: { prompt: f.f.app.project.original.assetRevision.prompt },
  });
  assert.notEqual(
    f.input.command.idempotencyKey,
    f.input.request.idempotencyKey,
  );
  assert.equal(f.state.commitCalls, 1);
  assert.equal(f.state.borrows, 1);
  assert.equal(f.state.releases, 1);
});

test("foreign same-shaped bound identities, changed prompts/CAS/keys and query actions cannot use the invocation", async () => {
  const f = projectGenerationExecutionFixture();
  const foreign = f.bridge.hostService().bindForPlugin!(
    Object.freeze({ ...f.identity }),
    { onDispose() {} },
  ) as PluginTaskService;
  f.setService({
    actions: [
      {
        contributionId: f.input.executionPin.contributionId,
        action: f.input.executionPin.action,
        kind: "generateTask",
      },
    ],
    async invoke(invocation) {
      const request = {
        invocationRef: invocation.invocationRef,
        ...(invocation.input as unknown as Omit<
          Parameters<PluginTaskService["createTask"]>[0],
          "invocationRef"
        >),
      };
      await assert.rejects(
        foreign.createTask(request),
        /plugin_invocation_owner_mismatch/u,
      );
      for (const changed of [
        { ...request, threadId: "other" },
        {
          ...request,
          expectedThreadRevision: request.expectedThreadRevision + 1,
        },
        { ...request, idempotencyKey: f.input.request.idempotencyKey },
        { ...request, input: { prompt: "unsaved draft" } },
      ])
        await assert.rejects(
          f.bound.createTask(changed),
          /plugin_invocation_task_conflict/u,
        );
      assert.throws(
        () =>
          f.boundV2.queryTask({
            invocationRef: invocation.invocationRef,
            threadId: request.threadId,
            expectedThreadRevision: request.expectedThreadRevision,
            idempotencyKey: request.idempotencyKey,
            sourceRunId: "run",
            operationId: "00000000-0000-0000-0000-000000000000",
          }),
        /plugin_project_generation_query_unsupported/u,
      );
      return { refused: true };
    },
  });
  await assert.rejects(
    f.execute(),
    /plugin_project_generation_task_not_committed/u,
  );
  assert.equal(f.state.commitCalls, 0);
  assert.equal(f.state.releases, 1);
});

test("read or query declarations and wrong target candidates are rejected before paid submission", async () => {
  for (const kind of ["read", "queryTask"] as const) {
    const f = projectGenerationExecutionFixture();
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
    await assert.rejects(
      f.execute(),
      /plugin_project_generation_action_invalid/u,
    );
    assert.equal(f.state.commitCalls, 0);
    assert.equal(f.state.releases, 1);
  }
  const f = projectGenerationExecutionFixture();
  await assert.rejects(
    f.execute({
      ...f.input,
      targetCandidate: {
        ...f.input.targetCandidate,
        packageDigest: `sha256:${"d".repeat(64)}`,
      },
    }),
    /plugin_project_generation_target_mismatch/u,
  );
  assert.equal(f.state.borrows, 0);
  assert.equal(f.state.commitCalls, 0);
});

test("transaction guard never calls complete source or target preflight while it holds the commit boundary", async () => {
  const f = projectGenerationExecutionFixture();
  let before = 0;
  let after = 0;
  const commit = f.input.commit;
  await f.execute({
    ...f.input,
    async commit(input) {
      before = f.state.fullCalls;
      const sourceBefore = f.f.state.currentCalls;
      await input.authority.assertTransactionCurrent();
      input.authority.assertActive();
      assert.equal(f.f.state.currentCalls, sourceBefore);
      after = f.state.fullCalls;
      return commit(input);
    },
  });
  assert.equal(before, 2);
  assert.equal(after, before);
  assert.equal(f.state.transactionCalls, 2);
});

test("same exact requests coalesce; ignored task promises are observed and committed results override later Node failure", async () => {
  const f = projectGenerationExecutionFixture();
  f.setService({
    actions: [
      {
        contributionId: f.input.executionPin.contributionId,
        action: f.input.executionPin.action,
        kind: "generateTask",
      },
    ],
    async invoke(invocation) {
      const request = {
        invocationRef: invocation.invocationRef,
        ...(invocation.input as unknown as Omit<
          Parameters<PluginTaskService["createTask"]>[0],
          "invocationRef"
        >),
      };
      void f.bound.createTask(request);
      void f.bound.createTask(request);
      throw new Error("node_failed_after_start");
    },
  });
  const result = await f.execute();
  assert.equal(result.result.turn.disposition, "committed");
  assert.equal(f.state.commitCalls, 1);
  assert.equal(f.state.releases, 1);
});

test("ignored task promises keep a failed commit observed while the action dispatcher returns the original error", async () => {
  const f = projectGenerationExecutionFixture();
  f.state.beforeCommit = async () => {
    throw new Error("fixture_commit_rejected");
  };
  f.setService({
    actions: [
      {
        contributionId: f.input.executionPin.contributionId,
        action: f.input.executionPin.action,
        kind: "generateTask",
      },
    ],
    async invoke(invocation) {
      void f.bound.createTask({
        invocationRef: invocation.invocationRef,
        ...(invocation.input as unknown as Omit<
          Parameters<PluginTaskService["createTask"]>[0],
          "invocationRef"
        >),
      });
      return { ignored: true };
    },
  });
  await assert.rejects(f.execute(), /fixture_commit_rejected/u);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.f.app.project.base.state.receipts.size, 0);
  assert.equal(f.state.releases, 1);
});

test("closing or expiring before the transaction fence rejects submission and releases the real borrow", async () => {
  for (const stop of ["close", "expiry", "source"] as const) {
    const f = projectGenerationExecutionFixture();
    const started = bridgeDeferred();
    const wait = bridgeDeferred();
    f.state.beforeCommit = async () => {
      started.resolve();
      await wait.promise;
    };
    const pending = f.execute();
    const rejected = assert.rejects(pending, /unavailable|closed/u);
    await started.promise;
    if (stop === "close") f.bridge.close();
    else if (stop === "expiry") f.state.now = "2026-10-02T03:00:30.000Z";
    else f.f.state.open = false;
    wait.resolve();
    await rejected;
    assert.equal(f.f.app.project.base.state.receipts.size, 0);
    assert.equal(f.state.releases, 1);
  }
});

test("after confirmed COMMIT withdrawal cannot erase the original receipt; expired references cannot be reused", async () => {
  const f = projectGenerationExecutionFixture();
  let ref = "";
  f.setService({
    actions: [
      {
        contributionId: f.input.executionPin.contributionId,
        action: f.input.executionPin.action,
        kind: "generateTask",
      },
    ],
    async invoke(invocation) {
      ref = invocation.invocationRef;
      return f.bound.createTask({
        invocationRef: ref,
        ...(invocation.input as unknown as Omit<
          Parameters<PluginTaskService["createTask"]>[0],
          "invocationRef"
        >),
      });
    },
  });
  f.state.afterCommit = () => {
    f.bridge.close();
    f.f.state.open = false;
    f.f.state.allow = false;
  };
  assert.equal((await f.execute()).result.turn.disposition, "committed");
  await assert.rejects(
    f.bound.createTask({
      invocationRef: ref,
      threadId: f.input.command.threadId,
      expectedThreadRevision: f.input.command.expectedThreadRevision,
      idempotencyKey: f.input.command.idempotencyKey,
      input: { prompt: f.f.app.project.original.assetRevision.prompt },
    }),
    /plugin_invocation_owner_mismatch/u,
  );
  assert.equal(f.state.releases, 1);
});

test("captured owner callbacks and frozen command cannot be replaced during preflight", async () => {
  const f = projectGenerationExecutionFixture();
  const started = bridgeDeferred();
  const wait = bridgeDeferred();
  f.state.beforeFull = async () => {
    started.resolve();
    await wait.promise;
  };
  const input = {
    ...f.input,
    command: structuredClone(f.input.command),
    authority: { ...f.input.authority },
  };
  const original = structuredClone(input.command);
  const pending = f.execute(input);
  await started.promise;
  Object.defineProperty(input.command, "intent", {
    value: { kind: "generate", input: { prompt: "replacement draft" } },
    enumerable: true,
  });
  input.authority.assertCurrent = async () => {
    throw new Error("replacement current");
  };
  input.authority.assertTransactionCurrent = async () => {
    throw new Error("replacement transaction");
  };
  input.commit = async () => {
    throw new Error("replacement commit");
  };
  f.state.beforeFull = null;
  wait.resolve();
  assert.deepEqual((await pending).command, original);
  assert.equal(f.state.commitCalls, 1);
});
