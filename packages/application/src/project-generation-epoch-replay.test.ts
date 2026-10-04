import assert from "node:assert/strict";
import test from "node:test";
import type { PluginTaskAdmissionPin } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type {
  ExtensionStore,
  PluginTaskReceiptLocator,
} from "./extension-store-port.ts";
import {
  pluginTaskReceipt,
  resolvePluginTaskReceipt,
} from "./extension-plugin-task-support.ts";
import {
  taskActor,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";
import { projectTaskFixture } from "./project-generation-task.test-support.ts";
import {
  committedProjectGenerationFixture,
  projectTaskDto,
} from "./plugin-ui-committed-project-generation.test-support.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import {
  projectGenerationTaskReceipt,
  projectGenerationUiTaskCommand,
} from "./project-generation-task-receipt.ts";

// Actual Application generation/replay/opaque authorities with the existing
// explicitly named memory Store, policy and quote doubles; no SQL, Native Main,
// supplier execution, real prices or funding are asserted by these tests.
function replayAdapter(
  f: ReturnType<typeof projectTaskFixture>,
  beforeRead: (() => void | Promise<void>) | undefined = undefined,
) {
  return {
    ...f.extensions,
    async loadPluginTaskAdmissionByReceipt(input: PluginTaskReceiptLocator) {
      await beforeRead?.();
      const saved = f.base.state.receipts.get(input.idempotencyKey);
      if (saved === undefined) return null;
      const admission = f.base.state.admissions.get(saved.result.binding.runId);
      if (admission === undefined)
        throw new Error("plugin_task_admission_missing");
      for (const field of [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "principalId",
        "actorId",
      ] as const)
        assert.equal(admission[field], input[field]);
      assert.equal(admission.idempotencyKey, input.idempotencyKey);
      assert.equal(admission.requestDigest, saved.digest);
      return structuredClone(admission);
    },
  } satisfies ExtensionStore;
}

const freshPin: PluginTaskAdmissionPin = {
  ...taskPin,
  authorityEpoch: "fresh-current-generation-epoch",
};
const conflict = (error: unknown) =>
  error instanceof ApplicationError &&
  error.category === "conflict" &&
  error.code === "extension_idempotency_conflict";
const invalidOutcome = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === "plugin_ui_committed_project_generation_invalid";

test("generation lookup replays the original wrapped full-pin v1 receipt under a fresh epoch without rewriting provenance or requoting", async () => {
  const f = projectTaskFixture();
  const first = await f.generate();
  const originalCommit = structuredClone(f.base.state.commits[0]!);
  const originalAdmission = structuredClone(
    f.base.state.admissions.get(first.binding.runId)!,
  );
  const originalLink = structuredClone(f.state.links.get(first.binding.runId)!);
  const counters = {
    ids: f.base.state.ids,
    clocks: f.base.state.clocks,
    configurations: f.base.state.configurationReads,
  };
  f.base.state.quote.quotedCredits = "999";
  const replayed = await f
    .create({
      extensions: replayAdapter(f),
      creditQuotes: undefined,
    })
    .createProjectTaskFromPlugin(
      taskActor,
      f.command,
      freshPin,
      f.reference,
      f.authority,
    );
  assert.equal(replayed.run.disposition, "replayed");
  assert.equal(replayed.binding.runId, first.binding.runId);
  assert.deepEqual(replayed.creditAdmission, first.creditAdmission);
  assert.deepEqual(f.base.state.commits, [originalCommit]);
  assert.deepEqual(
    f.base.state.admissions.get(first.binding.runId),
    originalAdmission,
  );
  assert.deepEqual(f.state.links.get(first.binding.runId), originalLink);
  assert.equal(originalAdmission.authorityEpoch, taskPin.authorityEpoch);
  assert.equal(
    originalAdmission.requestDigest,
    projectGenerationTaskReceipt(
      pluginTaskReceipt(taskActor, f.command, taskPin, taskDigester),
      f.reference,
      taskDigester,
    ).requestDigest,
  );
  assert.deepEqual(
    {
      ids: f.base.state.ids,
      clocks: f.base.state.clocks,
      configurations: f.base.state.configurationReads,
    },
    counters,
  );
  assert.equal(f.base.state.quoteCalls, 1);
  assert.ok(f.state.projectPermissions.includes("creativeProject:write"));
  assert.ok(f.base.state.permissions.includes("extension:run"));
  assert.ok(f.base.state.permissions.includes("run:create"));
});

test("published two-owner generation restores only target audit epoch while retaining the original project wrapper and current source authority", async () => {
  const f = committedProjectGenerationFixture();
  const context = f.detachedContext();
  const sourcePin = committedTaskContext(context).pin;
  const extensions = {
    ...replayAdapter(f.project),
    projectGenerationPublicationVersion:
      "crewon.project-generation-publication.v1" as const,
  };
  const authority = {
    assertCurrent: () => f.project.authority.assertCurrent(),
    assertTransactionCurrent: () => f.project.authority.assertCurrent(),
    assertActive: () => f.project.authority.assertActive(),
  };
  const input = {
    actor: taskActor,
    command: f.commandFor(context),
    reference: f.request.reference,
    publication: f.publication,
    sourcePin,
    executionPin: taskPin,
    authority,
  };
  const first = await f.project
    .create({ extensions })
    .createPublishedProjectTaskFromPlugin(input);
  const original = structuredClone(f.project.base.state.commits[0]!);
  const replayed = await f.project
    .create({ extensions, creditQuotes: undefined })
    .createPublishedProjectTaskFromPlugin({
      ...input,
      sourcePin: {
        ...sourcePin,
        authorityEpoch: "fresh-business-generation-epoch",
      },
      executionPin: freshPin,
    });
  assert.equal(replayed.run.disposition, "replayed");
  assert.equal(replayed.binding.runId, first.binding.runId);
  assert.deepEqual(f.project.base.state.commits, [original]);
  assert.equal(f.project.base.state.quoteCalls, 1);
  assert.equal(f.project.state.commitOptions.length, 1);
  assert.equal(
    f.project.base.state.admissions.get(first.binding.runId)?.authorityEpoch,
    taskPin.authorityEpoch,
  );
  f.project.state.hostAlive = false;
  await assert.rejects(
    f.project.create({ extensions }).createPublishedProjectTaskFromPlugin({
      ...input,
      executionPin: freshPin,
    }),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  assert.equal(f.project.base.state.commits.length, 1);
});

test("generation epoch recovery preserves every non-epoch target pin, command input, thread/CAS and saved project reference", async () => {
  const f = projectTaskFixture();
  await f.generate();
  const service = f.create({ extensions: replayAdapter(f) });
  for (const patch of [
    { selectionRevision: freshPin.selectionRevision + 1 },
    { publisherId: "different.publisher" },
    { version: "2.0.0" },
    { packageDigest: taskDigester.sha256("different-generation-package") },
    { contributionId: "different-workbench" },
    { action: "different.generate" },
  ])
    await assert.rejects(
      service.createProjectTaskFromPlugin(
        taskActor,
        f.command,
        { ...freshPin, ...patch },
        f.reference,
        f.authority,
      ),
      conflict,
    );
  for (const patch of [
    { threadId: "different-thread" },
    { expectedThreadRevision: f.command.expectedThreadRevision + 1 },
    {
      intent: {
        kind: "generate" as const,
        input: { prompt: "different saved input" },
      },
    },
  ])
    await assert.rejects(
      service.createProjectTaskFromPlugin(
        taskActor,
        { ...f.command, ...patch },
        freshPin,
        f.reference,
        f.authority,
      ),
      conflict,
    );
  for (const patch of [
    { assetId: "different-concept" },
    { assetRevision: f.reference.assetRevision + 1 },
    { expectedProjectRevision: f.reference.expectedProjectRevision + 1 },
    {
      expectedAssetMetadataRevision:
        f.reference.expectedAssetMetadataRevision + 1,
    },
  ])
    await assert.rejects(
      service.createProjectTaskFromPlugin(
        taskActor,
        f.command,
        freshPin,
        { ...f.reference, ...patch },
        f.authority,
      ),
      conflict,
    );
  assert.equal(f.base.state.commits.length, 1);
  assert.equal(f.base.state.quoteCalls, 1);
});

test("historical generation receipts cannot substitute for current project, task, thread or Run policy", async () => {
  for (const mode of [
    "project",
    "extension:run",
    "thread:message:append",
    "run:create",
  ] as const) {
    const f = projectTaskFixture();
    await f.generate();
    let lookups = 0;
    const extensions = replayAdapter(f, () => {
      lookups++;
    });
    if (mode === "project") f.state.deniedProject = true;
    else f.base.state.denied = mode;
    await assert.rejects(
      f
        .create({ extensions })
        .createProjectTaskFromPlugin(
          taskActor,
          f.command,
          freshPin,
          f.reference,
          f.authority,
        ),
      (error: unknown) =>
        error instanceof ApplicationError && error.category === "authorization",
    );
    assert.equal(lookups, 0);
    assert.equal(f.base.state.commits.length, 1);
    assert.equal(f.base.state.quoteCalls, 1);
  }
});

test("legacy generation adapter without historical lookup retains exact epoch rejection", async () => {
  const f = projectTaskFixture();
  await f.generate();
  await assert.rejects(
    f
      .create()
      .createProjectTaskFromPlugin(
        taskActor,
        f.command,
        freshPin,
        f.reference,
        f.authority,
      ),
    conflict,
  );
  assert.equal(f.base.state.commits.length, 1);
  assert.equal(f.base.state.quoteCalls, 1);
});

test("a generation receipt without its saved admission fails closed rather than starting another task", async () => {
  const f = projectTaskFixture();
  const first = await f.generate();
  f.base.state.admissions.delete(first.binding.runId);
  await assert.rejects(
    f
      .create({ extensions: replayAdapter(f) })
      .createProjectTaskFromPlugin(
        taskActor,
        f.command,
        freshPin,
        f.reference,
        f.authority,
      ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "internal" &&
      error.cause instanceof Error &&
      error.cause.message === "plugin_task_admission_missing",
  );
  assert.equal(f.base.state.commits.length, 1);
  assert.equal(f.base.state.quoteCalls, 1);
});

test("generation resolver validates the final persisted wrapper digest, not an ordinary task digest under the old epoch", async () => {
  const f = projectTaskFixture();
  const first = await f.generate();
  const admission = f.base.state.admissions.get(first.binding.runId)!;
  const invalidDigest = pluginTaskReceipt(
    taskActor,
    f.command,
    taskPin,
    taskDigester,
  ).requestDigest;
  const receipt = f.base.state.receipts.get(admission.idempotencyKey)!;
  f.base.state.admissions.set(first.binding.runId, {
    ...admission,
    requestDigest: invalidDigest,
  });
  f.base.state.receipts.set(admission.idempotencyKey, {
    ...receipt,
    digest: invalidDigest,
  });
  await assert.rejects(
    f
      .create({ extensions: replayAdapter(f) })
      .createProjectTaskFromPlugin(
        taskActor,
        f.command,
        freshPin,
        f.reference,
        f.authority,
      ),
    conflict,
  );
  assert.equal(f.base.state.commits.length, 1);
  assert.equal(f.base.state.quoteCalls, 1);
});

test("generation resolver captures reference, command, pin and the real digest receiver before its lookup await", async () => {
  const f = projectTaskFixture();
  await f.generate();
  const command = structuredClone(f.command);
  const pin = { ...freshPin };
  const reference = { ...f.reference };
  let hashes = 0;
  const digester = {
    sha256(value: string) {
      assert.equal(this, digester);
      hashes++;
      return taskDigester.sha256(value);
    },
  };
  const resolved = await resolvePluginTaskReceipt({
    store: replayAdapter(f, () => {
      command.expectedThreadRevision++;
      pin.selectionRevision++;
      reference.expectedAssetMetadataRevision++;
      digester.sha256 = () => assert.fail("replaced digest method executed");
    }),
    actor: taskActor,
    command,
    pin,
    digester,
    projectGeneration: reference,
  });
  assert.deepEqual(resolved.receiptPin, taskPin);
  assert.deepEqual(resolved.receipt, f.base.state.commits[0]!.receipt);
  assert.ok(hashes > 0);
});

test("enabling generation lookup adds no current authority fence after a confirmed new COMMIT", async () => {
  const f = projectTaskFixture();
  let currentAtCommit = 0;
  f.state.afterConfirmedCommit = () => {
    currentAtCommit = f.state.currentChecks;
    f.state.hostAlive = false;
  };
  const result = await f
    .create({ extensions: replayAdapter(f) })
    .createProjectTaskFromPlugin(
      taskActor,
      f.command,
      freshPin,
      f.reference,
      f.authority,
    );
  assert.equal(result.run.disposition, "committed");
  assert.equal(f.state.currentChecks, currentAtCommit);
  assert.equal(f.base.state.commits.length, 1);
  assert.equal(f.base.state.quoteCalls, 1);
});

test("committed generation authority issues the original opaque receipt under fresh source and execution epochs", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  const originalAdmission = structuredClone(
    f.project.base.state.admissions.get(accepted.result.binding.runId)!,
  );
  const context = {
    ...accepted.context,
    authorityEpoch: "fresh-business-generation-epoch",
  };
  const authority = f.createAuthority({ extensions: replayAdapter(f.project) });
  const outcome = await authority.issueProjectGeneration({
    ...accepted,
    context,
    executionPin: freshPin,
  });
  assert.deepEqual(
    authority.verify(context, outcome),
    projectTaskDto(accepted.result),
  );
  assert.throws(() => authority.verify(context, outcome));
  assert.deepEqual(
    f.project.base.state.admissions.get(accepted.result.binding.runId),
    originalAdmission,
  );
  assert.equal(f.project.base.state.quoteCalls, 1);
  assert.equal(f.project.base.state.commits.length, 1);
});

test("committed generation without the optional lookup keeps its strict old epoch behavior", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  await assert.rejects(
    f.authority.issueProjectGeneration({ ...accepted, executionPin: freshPin }),
    invalidOutcome,
  );
});

test("committed generation recovery refuses changed execution selection or original project CAS", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  const authority = f.createAuthority({ extensions: replayAdapter(f.project) });
  await assert.rejects(
    authority.issueProjectGeneration({
      ...accepted,
      executionPin: {
        ...freshPin,
        selectionRevision: freshPin.selectionRevision + 1,
      },
    }),
    invalidOutcome,
  );
  const request = {
    ...f.request,
    reference: {
      ...f.request.reference,
      expectedProjectRevision: f.request.reference.expectedProjectRevision + 1,
    },
  };
  const context = {
    ...accepted.context,
    input: request,
    authorityEpoch: "fresh-business-generation-epoch",
  };
  const command = projectGenerationUiTaskCommand(
    {
      sourcePin: committedTaskContext(context).pin,
      executionPin: freshPin,
      request,
      prompt: f.project.original.assetRevision.prompt,
    },
    taskDigester,
  );
  await assert.rejects(
    authority.issueProjectGeneration({
      ...accepted,
      context,
      command,
      executionPin: freshPin,
    }),
    invalidOutcome,
  );
  assert.equal(f.project.base.state.commits.length, 1);
});

test("committed generation captures the claimed COMMIT result and command before the historical lookup can mutate caller input", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  const result = structuredClone(accepted.result);
  const command = structuredClone(accepted.command);
  const executionPin = { ...freshPin };
  const authority = f.createAuthority({
    extensions: replayAdapter(f.project, () => {
      (result.turn.messages[0] as { messageId: string }).messageId =
        "caller-replaced-message";
      (command as { idempotencyKey: string }).idempotencyKey =
        "caller-replaced-key";
      executionPin.packageDigest = taskDigester.sha256(
        "caller-replaced-package",
      );
    }),
  });
  const outcome = await authority.issueProjectGeneration({
    ...accepted,
    result,
    command,
    executionPin,
  });
  assert.deepEqual(
    authority.verify(accepted.context, outcome),
    projectTaskDto(accepted.result),
  );
  assert.equal(f.project.base.state.commits.length, 1);
});

test("committed generation still refuses invocation-context mutation during historical lookup", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  const context = structuredClone(accepted.context);
  const authority = f.createAuthority({
    extensions: replayAdapter(f.project, () => {
      (context as { authorityEpoch: string }).authorityEpoch =
        "caller-replaced-invocation-epoch";
    }),
  });
  await assert.rejects(
    authority.issueProjectGeneration({
      ...accepted,
      context,
      executionPin: freshPin,
    }),
    invalidOutcome,
  );
  assert.equal(f.project.base.state.commits.length, 1);
  assert.equal(f.project.base.state.quoteCalls, 1);
});

test("committed generation captures the optional historical Store method without executing accessors or losing its receiver", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  const extensions = replayAdapter(f.project);
  const lookup = extensions.loadPluginTaskAdmissionByReceipt;
  let receiverChecks = 0;
  extensions.loadPluginTaskAdmissionByReceipt = async function (input) {
    assert.equal(this, extensions);
    receiverChecks++;
    return lookup.call(extensions, input);
  };
  const authority = f.createAuthority({ extensions });
  extensions.loadPluginTaskAdmissionByReceipt = async () =>
    assert.fail("replaced historical lookup executed");
  const outcome = await authority.issueProjectGeneration({
    ...accepted,
    executionPin: freshPin,
  });
  assert.deepEqual(
    authority.verify(accepted.context, outcome),
    projectTaskDto(accepted.result),
  );
  assert.equal(receiverChecks, 1);
  const accessor = { ...f.project.extensions };
  Object.defineProperty(accessor, "loadPluginTaskAdmissionByReceipt", {
    enumerable: true,
    get() {
      assert.fail("historical method getter executed");
    },
  });
  assert.throws(
    () => f.createAuthority({ extensions: accessor }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "plugin_ui_project_generation_configuration_invalid",
  );
});
