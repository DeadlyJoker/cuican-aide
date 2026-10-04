import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import type { PluginTaskReceiptLocator } from "./extension-store-port.ts";
import {
  pluginTaskFixture,
  taskActor,
  taskCommand,
  taskPin,
} from "./extension-plugin-task.test-support.ts";

function replayAdapter(f: ReturnType<typeof pluginTaskFixture>) {
  return {
    ...f.extensions,
    async loadPluginTaskAdmissionByReceipt(input: PluginTaskReceiptLocator) {
      const saved = [...f.state.admissions.values()].find(
        (entry) => entry.idempotencyKey === input.idempotencyKey,
      );
      if (!saved) return null;
      for (const key of [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "principalId",
        "actorId",
      ] as const)
        assert.equal(saved[key], input[key]);
      return structuredClone(saved);
    },
  };
}
const conflict = (error: unknown) =>
  error instanceof ApplicationError &&
  error.category === "conflict" &&
  error.code === "extension_idempotency_conflict";

test("an explicit historical lookup replays a previously committed full-pin v1 command under a fresh authorized epoch without rewriting provenance or price", async () => {
  const f = pluginTaskFixture();
  // This receipt was made by the original adapter and original v1 algorithm.
  const first = await f
    .create()
    .createTaskFromPlugin(taskActor, taskCommand, taskPin);
  const original = structuredClone(f.state.commits[0]!);
  const admission = structuredClone(
    f.state.admissions.get(first.binding.runId)!,
  );
  const counters = {
    ids: f.state.ids,
    clocks: f.state.clocks,
    configurations: f.state.configurationReads,
  };
  f.state.quote.quotedCredits = "999";
  const replay = await f
    .create({ extensions: replayAdapter(f), creditQuotes: undefined })
    .createTaskFromPlugin(taskActor, taskCommand, {
      ...taskPin,
      authorityEpoch: "fresh-current-task-epoch",
    });
  assert.equal(replay.run.disposition, "replayed");
  assert.equal(replay.binding.runId, first.binding.runId);
  assert.deepEqual(replay.creditAdmission, first.creditAdmission);
  assert.deepEqual(f.state.commits, [original]);
  assert.deepEqual(f.state.admissions.get(first.binding.runId), admission);
  assert.deepEqual(
    {
      ids: f.state.ids,
      clocks: f.state.clocks,
      configurations: f.state.configurationReads,
    },
    counters,
  );
  assert.equal(f.state.quoteCalls, 1);
  assert.ok(f.state.permissions.includes("extension:run"));
  assert.ok(f.state.permissions.includes("run:create"));
});

test("fresh-epoch replay preserves exact selection revision, package, action, original input, thread and CAS conflict semantics", async () => {
  const f = pluginTaskFixture();
  await f.create().createTaskFromPlugin(taskActor, taskCommand, taskPin);
  const service = f.create({ extensions: replayAdapter(f) });
  for (const patch of [
    { selectionRevision: taskPin.selectionRevision + 1 },
    { version: "2.0.0" },
    { publisherId: "different.publisher" },
    { contributionId: "different-studio" },
    { action: "different.generate" },
  ])
    await assert.rejects(
      service.createTaskFromPlugin(taskActor, taskCommand, {
        ...taskPin,
        authorityEpoch: "fresh-current-task-epoch",
        ...patch,
      }),
      conflict,
    );
  for (const patch of [
    { expectedThreadRevision: taskCommand.expectedThreadRevision + 1 },
    { threadId: "different-thread" },
    {
      intent: {
        kind: "generate" as const,
        input: { prompt: "different input" },
      },
    },
  ])
    await assert.rejects(
      service.createTaskFromPlugin(
        taskActor,
        { ...taskCommand, ...patch },
        { ...taskPin, authorityEpoch: "fresh-current-task-epoch" },
      ),
      conflict,
    );
  assert.equal(f.state.commits.length, 1);
  assert.equal(f.state.quoteCalls, 1);
});

test("historical provenance is never a substitute for current task permission", async () => {
  const f = pluginTaskFixture();
  await f.create().createTaskFromPlugin(taskActor, taskCommand, taskPin);
  f.state.denied = "extension:run";
  await assert.rejects(
    f
      .create({ extensions: replayAdapter(f) })
      .createTaskFromPlugin(taskActor, taskCommand, {
        ...taskPin,
        authorityEpoch: "fresh-current-task-epoch",
      }),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  assert.equal(f.state.commits.length, 1);
  assert.equal(f.state.quoteCalls, 1);
});

test("an older adapter without the optional lookup retains its strict original epoch behavior", async () => {
  const f = pluginTaskFixture();
  await f.create().createTaskFromPlugin(taskActor, taskCommand, taskPin);
  await assert.rejects(
    f.create().createTaskFromPlugin(taskActor, taskCommand, {
      ...taskPin,
      authorityEpoch: "fresh-current-task-epoch",
    }),
    conflict,
  );
  assert.equal(f.state.commits.length, 1);
});
