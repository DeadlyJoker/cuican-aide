import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { parsePluginSelection, reduceRunLifecycleEvent } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { PluginUiCommittedTaskAuthority } from "./plugin-ui-committed-task-authority.ts";
import type {
  PluginUiActionContext,
  PluginUiCommittedTaskOutcome,
} from "./plugin-ui-ports.ts";
import type { CommitExtensionTurnResult } from "./extension-store-port.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";
import {
  taskActor,
  taskCommand,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";

function invalid(error: unknown) {
  return (
    error instanceof ApplicationError &&
    error.category === "internal" &&
    error.code === "plugin_ui_committed_task_invalid"
  );
}
function taskDto(result: CommitExtensionTurnResult) {
  return {
    disposition: result.turn.disposition,
    threadId: result.binding.threadId,
    threadRevision: result.turn.threadState.revision,
    runId: result.binding.runId,
    messageId: result.turn.messages[0]!.messageId,
    configurationRevision: result.binding.configurationRevision,
  };
}
async function invoke(f: ReturnType<typeof committedUiFixture>) {
  const lease = await f.service.openMount(taskActor, f.openCommand);
  return {
    lease,
    running: f.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: taskPin.action,
      input: { intent: taskCommand.intent },
    }),
  };
}

test("authority returns only the original accepted task DTO through an opaque single-use invocation capability", async () => {
  const f = committedUiFixture();
  const accepted = await f.accept();
  const outcome = await f.authority.issue(accepted);
  assert.equal(f.authority.isOutcome(outcome), true);
  assert.ok(Object.isFrozen(outcome));
  assert.throws(() => parsePluginUiJsonValue(outcome));
  const projected = f.authority.verify(accepted.context, outcome);
  assert.deepEqual(projected, taskDto(accepted.result));
  assert.ok(Object.isFrozen(projected));
  assert.equal(f.authority.isOutcome(outcome), false);
  assert.throws(() => f.authority.verify(accepted.context, outcome), invalid);
  assert.equal(f.tasks.state.quoteCalls, 1);
  assert.equal(f.tasks.state.commits.length, 1);
});

test("receipt-first replay can issue its original DTO without changing the frozen price or Run", async () => {
  const f = committedUiFixture();
  const first = await f.accept();
  f.tasks.state.quote.quotedCredits = "999";
  const replay = await f.accept();
  const outcome = await f.authority.issue(replay);
  assert.deepEqual(
    f.authority.verify(replay.context, outcome),
    taskDto(replay.result),
  );
  assert.equal(replay.result.binding.runId, first.result.binding.runId);
  assert.equal(replay.result.turn.disposition, "replayed");
  assert.equal(f.tasks.state.quoteCalls, 1);
  assert.equal(f.tasks.state.receipts.size, 1);
});

test("advanced real Run status does not replace or invalidate the original commit snapshot", async () => {
  const f = committedUiFixture();
  const accepted = await f.accept();
  f.state.currentRun = reduceRunLifecycleEvent(accepted.result.run.state, {
    schemaVersion: "crewon.run-event.v0",
    type: "run.started",
    identity: { runId: accepted.result.binding.runId },
    eventId: "run-started-1",
    sequence: 2,
    occurredAt: "2026-10-02T03:01:00.000Z",
    data: {},
  });
  const outcome = await f.authority.issue(accepted);
  assert.deepEqual(
    f.authority.verify(accepted.context, outcome),
    taskDto(accepted.result),
  );
  assert.equal(f.state.currentRun.status, "running");
});

test("same-shaped JSON, inherited shape and a copied prototype cannot forge registry membership", async () => {
  const f = committedUiFixture();
  const accepted = await f.accept();
  const outcome = await f.authority.issue(accepted);
  for (const fake of [
    { committed: true, output: taskDto(accepted.result) },
    {},
    Object.create(Object.getPrototypeOf(outcome)),
    Object.create(outcome),
  ]) {
    assert.equal(f.authority.isOutcome(fake), false);
    assert.throws(
      () =>
        f.authority.verify(
          accepted.context,
          fake as PluginUiCommittedTaskOutcome,
        ),
      invalid,
    );
  }
  assert.equal(f.authority.isOutcome(outcome), true);
});

test("an outcome cannot be reused by another registry or another invocation with identical context fields", async () => {
  const f = committedUiFixture();
  const accepted = await f.accept();
  const outcome = await f.authority.issue(accepted);
  const other = committedUiFixture();
  assert.equal(other.authority.isOutcome(outcome), false);
  assert.throws(
    () => other.authority.verify(accepted.context, outcome),
    invalid,
  );
  assert.throws(
    () => f.authority.verify({ ...accepted.context }, outcome),
    invalid,
  );
  assert.equal(f.authority.isOutcome(outcome), false);
});

test("mutating a captured context before verification consumes and rejects its capability", async () => {
  const f = committedUiFixture();
  const context = structuredClone(f.detachedContext());
  const accepted = await f.accept(context);
  const outcome = await f.authority.issue(accepted);
  (
    context.input as { intent: { input: { prompt: string } } }
  ).intent.input.prompt = "altered";
  assert.throws(() => f.authority.verify(context, outcome), invalid);
  assert.equal(f.authority.isOutcome(outcome), false);
});

test("identity, profile, package, contribution, action and authority must match persisted provenance", async () => {
  const changes: ((context: PluginUiActionContext) => PluginUiActionContext)[] =
    [
      (c) => ({ ...c, actor: { ...c.actor, principalId: "foreign" } }),
      (c) => ({ ...c, actor: { ...c.actor, actorId: "foreign" } }),
      (c) => ({ ...c, scope: { ...c.scope, profileId: "foreign" } }),
      (c) => ({
        ...c,
        package: {
          ...c.package,
          packageDigest: taskDigester.sha256("foreign"),
        },
      }),
      (c) => ({ ...c, selection: { ...c.selection, revision: 999 } }),
      (c) => ({ ...c, lease: { ...c.lease, contributionId: "foreign" } }),
      (c) => ({ ...c, action: "other-action" }),
      (c) => ({ ...c, authorityEpoch: "other-epoch" }),
    ];
  for (const change of changes) {
    const f = committedUiFixture();
    const accepted = await f.accept();
    await assert.rejects(
      f.authority.issue({ ...accepted, context: change(accepted.context) }),
      invalid,
    );
  }
});

test("missing receipt, persisted pin or actual Run cannot be recognized as committed", async () => {
  for (const missing of ["receipt", "pin", "run"] as const) {
    const f = committedUiFixture();
    const accepted = await f.accept();
    if (missing === "receipt") f.tasks.state.receipts.clear();
    else if (missing === "pin") f.tasks.state.admissions.clear();
    else f.state.currentRun = null;
    await assert.rejects(f.authority.issue(accepted), invalid);
  }
});

test("a creditless receipt and principal or stable pin corruption cannot be projected", async () => {
  for (const corrupt of ["credit", "principal", "package", "digest"] as const) {
    const f = committedUiFixture();
    const accepted = await f.accept();
    const admission = f.tasks.state.admissions.get(
      accepted.result.binding.runId,
    )!;
    if (corrupt === "credit")
      delete (
        [...f.tasks.state.receipts.values()][0]!.result as {
          creditAdmission?: unknown;
        }
      ).creditAdmission;
    else
      f.tasks.state.admissions.set(admission.runId, {
        ...admission,
        ...(corrupt === "principal"
          ? { principalId: "foreign" }
          : corrupt === "package"
            ? { packageDigest: taskDigester.sha256("foreign") }
            : { requestDigest: taskDigester.sha256("foreign") }),
      });
    await assert.rejects(f.authority.issue(accepted), invalid);
  }
});

test("original command key, input, revision and thread remain bound to the stored receipt", async () => {
  const f = committedUiFixture();
  const accepted = await f.accept();
  for (const patch of [
    { idempotencyKey: "other-key" },
    { threadId: "other-thread" },
    { expectedThreadRevision: 99 },
    { intent: { kind: "generate" as const, input: { prompt: "changed" } } },
    {
      intent: {
        kind: "query" as const,
        sourceRunId: "source",
        operationId: "00000000-0000-0000-0000-000000000001",
      },
    },
  ])
    await assert.rejects(
      f.authority.issue({ ...accepted, command: { ...taskCommand, ...patch } }),
      invalid,
    );
  assert.equal(f.tasks.state.receipts.size, 1);
});

test("claimed transaction, message and price must match the saved original snapshot exactly", async () => {
  const f = committedUiFixture();
  const accepted = await f.accept();
  const altered = structuredClone(accepted.result);
  (altered.turn.messages[0] as { messageId: string }).messageId =
    "foreign-message";
  for (const result of [
    altered,
    {
      ...accepted.result,
      turn: {
        ...accepted.result.turn,
        threadState: { ...accepted.result.turn.threadState, revision: 99 },
      },
    },
    {
      ...accepted.result,
      binding: { ...accepted.result.binding, runId: "foreign-run" },
    },
    {
      ...accepted.result,
      creditAdmission: {
        ...accepted.result.creditAdmission!,
        reservation: {
          ...accepted.result.creditAdmission!.reservation,
          quotedCredits: "999",
        },
      },
    },
    { ...accepted.result, output: { account: "private" } },
  ])
    await assert.rejects(f.authority.issue({ ...accepted, result }), invalid);
});

test("actual current Run ownership and immutable target must still describe the original task", async () => {
  for (const patch of [
    { runId: "other-run" },
    { threadId: "other-thread" },
    { tenantId: "other-tenant" },
    { spaceId: "other-space" },
    { createdByActorId: "other-actor" },
    { runtimeGeneration: "other-runtime" },
    { authorityId: "other-authority" },
    { agentVersionId: "other-agent" },
    { policySnapshotId: "other-policy" },
    { workspaceBindingId: "other-workspace" },
    { purpose: "workflow" },
  ]) {
    const f = committedUiFixture();
    const accepted = await f.accept();
    f.state.currentRun = {
      ...accepted.result.run.state,
      ...patch,
    } as typeof f.state.currentRun;
    await assert.rejects(f.authority.issue(accepted), invalid);
  }
});

test("issue envelopes, contexts, commands and claims reject getters without executing them", async () => {
  const f = committedUiFixture();
  const accepted = await f.accept();
  let calls = 0;
  for (const [object, field] of [
    [accepted, "context"],
    [accepted.context, "actor"],
    [taskCommand, "intent"],
    [accepted.result, "binding"],
  ] as const) {
    const getter = Object.defineProperty({ ...object }, field, {
      enumerable: true,
      get() {
        calls++;
        throw new Error("getter must not execute");
      },
    });
    const input =
      object === accepted
        ? getter
        : {
            ...accepted,
            ...(object === accepted.context
              ? { context: getter }
              : object === taskCommand
                ? { command: getter }
                : { result: getter }),
          };
    await assert.rejects(f.authority.issue(input as typeof accepted), invalid);
  }
  assert.equal(calls, 0);
});

test("issue detaches the command and result before awaits and rejects a changed invocation context", async () => {
  const f = committedUiFixture();
  const accepted = await f.accept();
  const command = { ...structuredClone(taskCommand) };
  const result = structuredClone(accepted.result);
  f.tasks.state.onReceipt = () => {
    command.idempotencyKey = "changed";
    (result.turn.messages[0] as { messageId: string }).messageId = "changed";
  };
  const outcome = await f.authority.issue({ ...accepted, command, result });
  assert.deepEqual(
    f.authority.verify(accepted.context, outcome),
    taskDto(accepted.result),
  );
  f.tasks.state.onReceipt = null;
  const context = structuredClone(f.detachedContext());
  const next = await f.accept(context);
  f.tasks.state.onReceipt = () => {
    (context as { authorityEpoch: string }).authorityEpoch = "changed";
  };
  await assert.rejects(f.authority.issue(next), invalid);
});

test("UI invocation returns its original receipt after commit despite later selection, authority, profile, expiry or close", async () => {
  for (const change of [
    "disable",
    "upgrade",
    "epoch",
    "deny",
    "profile",
    "expiry",
    "close",
  ] as const) {
    const f = committedUiFixture();
    f.state.afterCommit = async (context) => {
      if (change === "disable")
        f.state.selection = parsePluginSelection({
          ...f.state.selection!,
          state: "disabled",
          revision: 3,
        });
      else if (change === "upgrade")
        f.state.selection = parsePluginSelection({
          ...f.state.selection!,
          revision: 3,
          selectedPackageDigest: taskDigester.sha256("upgrade"),
        });
      else if (change === "epoch") f.state.epoch = "epoch-2";
      else if (change === "deny") f.state.allow = false;
      else if (change === "profile")
        f.state.scope = { ...f.state.scope, profileId: "profile-2" };
      else if (change === "expiry") f.state.now = context.lease.expiresAt;
      else
        await f.service.closeMount(taskActor, {
          mountRef: context.lease.mountRef,
        });
    };
    const { running } = await invoke(f);
    const output = await running;
    const result = [...f.tasks.state.receipts.values()][0]!.result;
    assert.deepEqual(output, taskDto(result));
    assert.equal(f.tasks.state.receipts.size, 1);
    assert.equal(f.tasks.state.admissions.size, 1);
    assert.equal(f.tasks.state.quoteCalls, 1);
    assert.equal(f.tasks.state.commits.length, 1);
  }
});

test("revocation at the final commit gate still rejects before any durable writes", async () => {
  const f = committedUiFixture();
  f.tasks.state.onQuote = () => {
    f.state.epoch = "epoch-2";
  };
  const { running } = await invoke(f);
  await assert.rejects(
    running,
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "plugin_ui_authority_changed",
  );
  assert.equal(f.tasks.state.commits.length, 0);
  assert.equal(f.tasks.state.receipts.size, 0);
});

test("ordinary read JSON and plugin self-reported committed JSON retain their post-action fence", async () => {
  for (const claimedCommitted of [false, true]) {
    for (const change of [
      "selection",
      "epoch",
      "profile",
      "close",
      "expiry",
    ] as const) {
      const f = committedUiFixture();
      f.state.mode = "json";
      if (claimedCommitted)
        f.state.json = { committed: true, output: { runId: "invented" } };
      const lease = await f.service.openMount(taskActor, f.openCommand);
      f.state.afterAction = async () => {
        if (change === "selection")
          f.state.selection = parsePluginSelection({
            ...f.state.selection!,
            revision: 3,
          });
        else if (change === "epoch") f.state.epoch = "epoch-2";
        else if (change === "profile")
          f.state.scope = { ...f.state.scope, profileId: "profile-2" };
        else if (change === "expiry") f.state.now = lease.expiresAt;
        else
          await f.service.closeMount(taskActor, { mountRef: lease.mountRef });
      };
      await assert.rejects(
        f.service.invoke(taskActor, {
          mountRef: lease.mountRef,
          action: "read",
          input: null,
        }),
        (error: unknown) =>
          error instanceof ApplicationError && error.category !== "internal",
      );
      assert.equal(f.tasks.state.commits.length, 0);
    }
  }
});

test("an old invocation's valid capability cannot make another UI call return its receipt", async () => {
  const f = committedUiFixture();
  const accepted = await f.accept();
  f.state.raw = await f.authority.issue(accepted);
  f.state.mode = "raw";
  const { running } = await invoke(f);
  await assert.rejects(running, invalid);
});

test("missing configured authority cannot interpret a genuine opaque outcome as JSON", async () => {
  const f = committedUiFixture();
  const accepted = await f.accept();
  const outcome = await f.authority.issue(accepted);
  // Capture original host composition without the receipt authority, using ordinary port doubles.
  const dependencies = {
    store: f.ledger,
    profiles: {
      async resolve() {
        return accepted.context.scope;
      },
    },
    authorization: {
      async authorize() {
        return {
          outcome: "allow" as const,
          authorityEpoch: taskPin.authorityEpoch,
        };
      },
    },
    packages: {
      async verify() {
        return {
          descriptor: accepted.context.lease.descriptor,
          publicAssets: accepted.context.lease.publicAssets,
        };
      },
      async readAsset() {
        throw new Error("unused");
      },
    },
    actions: {
      async invoke() {
        return outcome;
      },
    },
    ids: { nextId: () => "x".repeat(40) },
    clock: { now: () => "2026-10-02T03:00:00.000Z" },
  };
  const service = new PluginUiApplicationService(dependencies);
  const lease = await service.openMount(taskActor, f.openCommand);
  await assert.rejects(
    service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: taskPin.action,
      input: null,
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "plugin_ui_output_invalid",
  );
});

test("authority requires explicit atomic admission, paid receipt and actual Run ports", () => {
  const f = committedUiFixture();
  for (const dependencies of [
    {
      extensions: { ...f.tasks.extensions, pluginAdmissionVersion: undefined },
      runs: f.runs,
      digester: taskDigester,
    },
    {
      extensions: f.tasks.extensions,
      runs: { loadRunInSpace: undefined },
      digester: taskDigester,
    },
  ])
    assert.throws(
      () =>
        new PluginUiCommittedTaskAuthority(
          dependencies as ConstructorParameters<
            typeof PluginUiCommittedTaskAuthority
          >[0],
        ),
      (error: unknown) => error instanceof ApplicationError,
    );
});
