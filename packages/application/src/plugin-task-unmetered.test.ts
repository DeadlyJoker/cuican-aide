import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionStore,
  CommitExtensionTurnResult,
} from "./extension-store-port.ts";
import type { PluginTaskUnmeteredAuthorityPort } from "./plugin-task-unmetered-authority-port.ts";
import { ApplicationError } from "./application-error.ts";
import {
  pluginTaskFixture,
  taskActor,
  taskCommand,
  taskPin,
  taskDigester,
} from "./extension-plugin-task.test-support.ts";
import { readinessFixture } from "./project-generation-readiness-application-service.test-support.ts";
import { projectGenerationReadFixture } from "./project-generation-read-application-service.test-support.ts";
import { committedTaskResult } from "./plugin-ui-committed-task-support.ts";

/** Memory ports prove Application behavior; the matching Store suite proves SQL/transaction facts. */
function freeStore(
  store: ExtensionStore,
  base: ReturnType<typeof pluginTaskFixture>,
): ExtensionStore {
  return {
    ...store,
    creditAdmissionVersion: undefined,
    unmeteredAdmissionVersion: "crewon.plugin-task-unmetered-admission.v1",
    async loadPluginTaskUnmeteredAdmission(input) {
      return structuredClone(
        [...base.state.receipts.values()].find(
          (value) => value.result.binding.runId === input.runId,
        )?.result.unmeteredAdmission ?? null,
      );
    },
    async commitExtensionTurn(input, options) {
      await options?.unmeteredAuthority?.assertCurrent();
      options?.unmeteredAuthority?.assertActive();
      const result = await store.commitExtensionTurn(input, options);
      const saved: CommitExtensionTurnResult = {
        ...result,
        ...(input.unmeteredAdmission === undefined
          ? {}
          : { unmeteredAdmission: input.unmeteredAdmission }),
      };
      base.state.receipts.get(input.receipt.idempotencyKey)!.result =
        structuredClone(saved);
      return saved;
    },
  };
}
function localAuthority() {
  const state = { live: true, prepared: 0, current: 0, active: 0 };
  const active = () => {
    state.active++;
    if (!state.live)
      throw new ApplicationError(
        "authorization",
        "test_local_unmetered_withdrawn",
      );
  };
  const authority = {
    authorization: { authorityId: "local-unmetered-test", policyRevision: 3 },
    async assertCurrent() {
      assert.equal(this, authority);
      state.current++;
      active();
    },
    assertActive() {
      assert.equal(this, authority);
      active();
    },
  };
  const port: PluginTaskUnmeteredAuthorityPort = {
    async prepareGeneration(input) {
      assert.deepEqual(input.actor, taskActor);
      assert.deepEqual(input.pin, taskPin);
      state.prepared++;
      active();
      return authority;
    },
  };
  return { state, authority, port };
}
test("explicit Host policy accepts an installed task without quotes or any credit capability and retains the original public receipt", async () => {
  const f = pluginTaskFixture(),
    a = localAuthority(),
    extensions = freeStore(f.extensions, f);
  const result = await f
    .create({ extensions, creditQuotes: undefined, unmeteredTasks: a.port })
    .createTaskFromPlugin(taskActor, taskCommand, taskPin);
  assert.equal(f.state.quoteCalls, 0);
  assert.equal(result.creditAdmission, undefined);
  assert.equal(a.state.prepared, 1);
  assert.deepEqual(
    result.unmeteredAdmission?.task,
    f.state.commits[0]!.pluginAdmission,
  );
  assert.deepEqual(
    result.unmeteredAdmission?.authorization,
    a.authority.authorization,
  );
  const task = result.unmeteredAdmission!.task;
  assert.doesNotThrow(() =>
    committedTaskResult(
      result,
      taskCommand,
      taskPin,
      {
        actorId: task.actorId,
        idempotencyKey: task.idempotencyKey,
        requestDigest: task.requestDigest,
      },
      taskDigester,
    ),
  );
});
test("accepted replay keeps its unmetered policy and never prepares policy, quotes or new identifiers again", async () => {
  const f = pluginTaskFixture(),
    a = localAuthority(),
    extensions = freeStore(f.extensions, f);
  const service = f.create({
    extensions,
    creditQuotes: undefined,
    unmeteredTasks: a.port,
  });
  const first = await service.createTaskFromPlugin(
    taskActor,
    taskCommand,
    taskPin,
  );
  const counts = { ...a.state, ids: f.state.ids, clocks: f.state.clocks };
  a.state.live = false;
  const replay = await service.createTaskFromPlugin(
    taskActor,
    taskCommand,
    taskPin,
  );
  assert.deepEqual(replay.unmeteredAdmission, first.unmeteredAdmission);
  assert.equal(replay.run.disposition, "replayed");
  assert.equal(a.state.prepared, counts.prepared);
  assert.equal(f.state.ids, counts.ids);
  assert.equal(f.state.clocks, counts.clocks);
});
test("the new trusted port method is captured before invocation and a late replacement cannot issue another policy", async () => {
  const f = pluginTaskFixture(),
    a = localAuthority();
  const service = f.create({
    extensions: freeStore(f.extensions, f),
    creditQuotes: undefined,
    unmeteredTasks: a.port,
  });
  a.port.prepareGeneration = async () =>
    assert.fail("late method must not run");
  assert.equal(
    (await service.createTaskFromPlugin(taskActor, taskCommand, taskPin))
      .unmeteredAdmission?.authorization.policyRevision,
    3,
  );
});
test("readiness accepts the same explicit local policy with no credit marker or quote and creates no task", async () => {
  const f = readinessFixture(),
    a = localAuthority();
  const result = await f
    .create({
      extensions: freeStore(f.extensions, f.f.base),
      creditQuotes: undefined,
      unmeteredTasks: a.port,
    })
    .getPublishedProjectGenerationReadiness(f.input);
  assert.equal(result.readiness.outcome, "ready");
  assert.equal(a.state.prepared, 1);
  assert.equal(f.f.base.state.commits.length, 0);
  assert.equal(f.f.base.state.quoteCalls, 0);
});
test("the real generation-read Application restores an original unmetered receipt without preparing execution or credits", async () => {
  const f = await projectGenerationReadFixture({ generated: false }),
    a = localAuthority();
  const generated = await f.f
    .create({
      extensions: freeStore(f.f.extensions, f.f.base),
      creditQuotes: undefined,
      unmeteredTasks: a.port,
    })
    .createProjectTaskFromPlugin(
      taskActor,
      f.f.command,
      taskPin,
      f.f.reference,
      f.f.authority,
    );
  f.state.run = generated.run.state;
  const restored = await f.read();
  assert.equal(restored?.task.binding.runId, generated.binding.runId);
  assert.equal(a.state.prepared, 1);
  assert.equal(f.f.base.state.quoteCalls, 0);
});
test("denied policy and malformed callback data never commit, and accessors are never evaluated", async () => {
  for (const kind of ["denied", "accessor", "asyncActive"] as const) {
    const f = pluginTaskFixture(),
      a = localAuthority();
    let getters = 0;
    if (kind === "denied")
      a.port.prepareGeneration = async () => {
        throw new ApplicationError("authorization", "unmetered_denied");
      };
    else if (kind === "accessor")
      Object.defineProperty(a.authority, "assertCurrent", {
        enumerable: true,
        get() {
          getters++;
          return async () => {};
        },
      });
    else Object.assign(a.authority, { assertActive: async () => {} });
    await assert.rejects(
      f
        .create({
          extensions: freeStore(f.extensions, f),
          creditQuotes: undefined,
          unmeteredTasks: a.port,
        })
        .createTaskFromPlugin(taskActor, taskCommand, taskPin),
    );
    assert.equal(getters, 0);
    assert.equal(f.state.commits.length, 0);
    assert.equal(f.state.quoteCalls, 0);
  }
});
test("a port accessor cannot issue local Host policy and absent quote still never becomes free", async () => {
  const f = pluginTaskFixture();
  let reads = 0;
  const port = Object.defineProperty({}, "prepareGeneration", {
    enumerable: true,
    get() {
      reads++;
      return async () => localAuthority().authority;
    },
  }) as PluginTaskUnmeteredAuthorityPort;
  assert.throws(() => f.create({ unmeteredTasks: port }));
  assert.equal(reads, 0);
  await assert.rejects(
    f
      .create({ creditQuotes: undefined })
      .createTaskFromPlugin(taskActor, taskCommand, taskPin),
    /extension_credit_quote_unavailable/,
  );
  assert.equal(f.state.commits.length, 0);
});
test("saved mode removal, dual mode and wrong owner cannot be acknowledged as an original UI result", async () => {
  const f = pluginTaskFixture(),
    a = localAuthority();
  const result = await f
    .create({
      extensions: freeStore(f.extensions, f),
      creditQuotes: undefined,
      unmeteredTasks: a.port,
    })
    .createTaskFromPlugin(taskActor, taskCommand, taskPin);
  const task = result.unmeteredAdmission!.task,
    receipt = {
      actorId: task.actorId,
      idempotencyKey: task.idempotencyKey,
      requestDigest: task.requestDigest,
    };
  const missing = { ...result };
  delete missing.unmeteredAdmission;
  assert.throws(() =>
    committedTaskResult(missing, taskCommand, taskPin, receipt, taskDigester),
  );
  assert.throws(() =>
    committedTaskResult(
      {
        ...result,
        creditAdmission: {} as NonNullable<
          CommitExtensionTurnResult["creditAdmission"]
        >,
      },
      taskCommand,
      taskPin,
      receipt,
      taskDigester,
    ),
  );
  assert.throws(() =>
    committedTaskResult(
      result,
      taskCommand,
      { ...taskPin, principalId: "foreign" },
      receipt,
      taskDigester,
    ),
  );
});
