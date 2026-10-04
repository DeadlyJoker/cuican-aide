import assert from "node:assert/strict";
import test from "node:test";
import {
  extensionCanonicalJson,
  parseProjectQueryLink,
  type PluginQueryTaskAdmission,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { ExtensionTaskApplicationService } from "./extension-task-application-service.ts";
import type {
  ExtensionStore,
  PluginTaskReceiptLocator,
} from "./extension-store-port.ts";
import { PluginUiCommittedTaskAuthority } from "./plugin-ui-committed-task-authority.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";
import { projectGenerationQueryUiTaskCommand } from "./project-query-task-receipt.ts";
import { projectQueryTaskFixture } from "./project-query-task.test-support.ts";
import { taskDigester } from "./extension-plugin-task.test-support.ts";
import { uiDeferred } from "./plugin-ui.test-support.ts";

type Fixture = Awaited<ReturnType<typeof projectQueryTaskFixture>>;
/** Actual Application/issuer recipes over the original named memory ports.
 * SQL reopen, Native FileIssued owners, Worker and supplier execution are tested elsewhere. */
function replayAdapter(f: Fixture): ExtensionStore {
  return {
    ...f.extensions,
    async loadPluginQueryTaskAdmissionByReceipt(
      input: PluginTaskReceiptLocator,
    ) {
      const saved = [...f.state.queries.values()].find(
        (query) => query.idempotencyKey === input.idempotencyKey,
      );
      if (saved === undefined) return null;
      for (const key of [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "principalId",
        "actorId",
        "idempotencyKey",
      ] as const)
        assert.equal(saved[key], input[key]);
      return structuredClone(saved);
    },
  };
}
function current(f: Fixture, epochs: "source" | "execution" | "both" = "both") {
  const context = {
    ...f.context,
    authorityEpoch:
      epochs === "execution"
        ? f.context.authorityEpoch
        : "fresh-current-query-source-epoch",
  };
  const sourcePin = committedTaskContext(context).pin;
  const executionPin = {
    ...f.executionPin,
    authorityEpoch:
      epochs === "source"
        ? f.executionPin.authorityEpoch
        : "fresh-current-query-execution-epoch",
  };
  const command = projectGenerationQueryUiTaskCommand(
    {
      sourcePin,
      executionPin,
      request: f.request,
      sourceRunId: f.generated.binding.runId,
    },
    taskDigester,
  );
  return {
    context,
    command,
    executionPin,
    input: { ...f.input, sourcePin, executionPin, command },
  };
}
function effects(f: Fixture) {
  return structuredClone({
    commits: f.saved.f.base.state.commits,
    admissions: [...f.saved.f.base.state.admissions],
    queries: [...f.state.queries],
    generationLinks: [...f.saved.f.state.links],
    queryLinks: [...f.state.links],
    quotes: f.saved.f.base.state.quoteCalls,
    ids: f.saved.f.base.state.ids,
    clocks: f.saved.f.base.state.clocks,
    historicalVersions: f.state.historicalVersions,
  });
}
const conflict = (error: unknown) =>
  error instanceof ApplicationError && error.category === "conflict";

for (const epochs of ["source", "execution", "both"] as const)
  test(`verified original project query replays and acknowledges after ${epochs} epoch renewal without rewriting either saved pin or paid source`, async () => {
    const f = await projectQueryTaskFixture();
    const first = await f.accept(); // Original adapter and original full-pin v1/wrapper, before the new lookup.
    const before = effects(f);
    const renewed = current(f, epochs);
    const extensions = replayAdapter(f);
    const tasks = new ExtensionTaskApplicationService({
      ...f.dependencies,
      extensions,
      creditQuotes: undefined,
    });
    const result = await tasks.createPublishedProjectQueryTaskFromPlugin(
      renewed.input,
    );
    assert.equal(result.run.disposition, "replayed");
    assert.equal(result.binding.runId, first.result.binding.runId);
    assert.equal(result.creditAdmission, undefined);
    const issuer = new PluginUiCommittedTaskAuthority({
      ...f.committedDependencies,
      extensions,
    });
    const outcome = await issuer.issueProjectGenerationQuery({
      context: renewed.context,
      command: renewed.command,
      executionPin: renewed.executionPin,
      result,
    });
    assert.equal(
      (issuer.verify(renewed.context, outcome) as { runId: string }).runId,
      first.result.binding.runId,
    );
    assert.deepEqual(effects(f), before);
    assert.equal(
      f.state.links.get(result.binding.runId)!.sourcePin.authorityEpoch,
      f.sourcePin.authorityEpoch,
    );
    assert.equal(
      f.state.links.get(result.binding.runId)!.executionPin.authorityEpoch,
      f.executionPin.authorityEpoch,
    );
  });

test("query historical lookup remains optional and old adapters retain both pin epoch checks", async () => {
  const f = await projectQueryTaskFixture();
  await f.accept();
  const before = effects(f);
  for (const epochs of ["source", "execution", "both"] as const) {
    const renewed = current(f, epochs);
    await assert.rejects(
      f.tasks.createPublishedProjectQueryTaskFromPlugin(renewed.input),
    );
  }
  assert.deepEqual(effects(f), before);
});

test("fresh query epoch never relaxes execution selection, package identity, action, original input or Thread CAS", async () => {
  const f = await projectQueryTaskFixture();
  await f.accept();
  const before = effects(f);
  const renewed = current(f);
  const tasks = new ExtensionTaskApplicationService({
    ...f.dependencies,
    extensions: replayAdapter(f),
  });
  for (const patch of [
    { selectionRevision: renewed.executionPin.selectionRevision + 1 },
    { version: "3.0.0" },
    { publisherId: "another.publisher" },
    { packageDigest: taskDigester.sha256("another-query-package") },
    { contributionId: "another-query-contribution" },
    { action: "another.query" },
  ])
    await assert.rejects(
      tasks.createPublishedProjectQueryTaskFromPlugin({
        ...renewed.input,
        executionPin: { ...renewed.executionPin, ...patch },
      }),
    );
  for (const command of [
    { ...renewed.command, threadId: "different-thread" },
    {
      ...renewed.command,
      expectedThreadRevision: renewed.command.expectedThreadRevision + 1,
    },
    {
      ...renewed.command,
      intent: {
        kind: "query" as const,
        sourceRunId: "different-source-run",
        operationId: f.request.operationId,
      },
    },
    {
      ...renewed.command,
      intent: {
        kind: "query" as const,
        sourceRunId: f.generated.binding.runId,
        operationId: "22222222-2222-4222-8222-222222222222",
      },
    },
  ])
    await assert.rejects(
      tasks.createPublishedProjectQueryTaskFromPlugin({
        ...renewed.input,
        command,
      }),
    );
  assert.deepEqual(effects(f), before);
});

test("the actual saved query link permits only its two historical epochs, never a changed source selection or forged execution epoch", async () => {
  const f = await projectQueryTaskFixture();
  const first = await f.accept();
  const before = effects(f);
  const renewed = current(f);
  const extensions = replayAdapter(f);
  const tasks = new ExtensionTaskApplicationService({
    ...f.dependencies,
    extensions,
  });
  const storedMismatch = (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === "internal" &&
    error.code === "creative_project_store_result_invalid" &&
    error.cause instanceof ApplicationError &&
    error.cause.category === "conflict" &&
    error.cause.code === "project_query_replay_mismatch";
  await assert.rejects(
    tasks.createPublishedProjectQueryTaskFromPlugin({
      ...renewed.input,
      sourcePin: {
        ...renewed.input.sourcePin,
        selectionRevision: renewed.input.sourcePin.selectionRevision + 1,
      },
    }),
    storedMismatch,
  );
  const saved = f.state.links.get(first.result.binding.runId)!;
  const { contentDigest: _digest, ...body } = saved;
  f.state.links.set(
    saved.binding.runId,
    parseProjectQueryLink(
      {
        ...body,
        executionPin: {
          ...body.executionPin,
          authorityEpoch: "forged-query-epoch",
        },
        contentDigest: taskDigester.sha256(
          extensionCanonicalJson({
            ...body,
            executionPin: {
              ...body.executionPin,
              authorityEpoch: "forged-query-epoch",
            },
          }),
        ),
      },
      taskDigester,
    ),
  );
  await assert.rejects(
    tasks.createPublishedProjectQueryTaskFromPlugin(renewed.input),
    storedMismatch,
  );
  f.state.links.set(saved.binding.runId, saved);
  assert.deepEqual(effects(f), before);
});

test("current query/project/run permissions and owner withdrawal still reject historical original-key replay", async () => {
  const f = await projectQueryTaskFixture();
  await f.accept();
  const before = effects(f);
  const renewed = current(f);
  const tasks = new ExtensionTaskApplicationService({
    ...f.dependencies,
    extensions: replayAdapter(f),
  });
  for (const denied of [
    "extension:query",
    "thread:message:append",
    "run:create",
    "run:read",
  ] as const) {
    f.saved.f.base.state.denied = denied;
    await assert.rejects(
      tasks.createPublishedProjectQueryTaskFromPlugin(renewed.input),
      (error) =>
        error instanceof ApplicationError && error.category === "authorization",
    );
  }
  f.saved.f.base.state.denied = null;
  f.saved.f.state.deniedProject = true;
  await assert.rejects(
    tasks.createPublishedProjectQueryTaskFromPlugin(renewed.input),
  );
  f.saved.f.state.deniedProject = false;
  f.state.alive = false;
  await assert.rejects(
    tasks.createPublishedProjectQueryTaskFromPlugin(renewed.input),
  );
  assert.deepEqual(effects(f), before);
});

test("withdrawal during the exact historical query lookup cannot escape the current owner checks", async () => {
  const f = await projectQueryTaskFixture();
  await f.accept();
  const before = effects(f);
  const renewed = current(f);
  const adapter = replayAdapter(f);
  const extensions = {
    ...adapter,
    async loadPluginQueryTaskAdmissionByReceipt(
      input: PluginTaskReceiptLocator,
    ) {
      const saved = await adapter.loadPluginQueryTaskAdmissionByReceipt!(input);
      f.state.alive = false;
      return saved;
    },
  };
  await assert.rejects(
    new ExtensionTaskApplicationService({
      ...f.dependencies,
      extensions,
    }).createPublishedProjectQueryTaskFromPlugin(renewed.input),
  );
  assert.deepEqual(effects(f), before);
});

test("ordinary query and its original opaque issuer use the same historical receipt proof without a project sidecar or extra quote", async () => {
  const f = await projectQueryTaskFixture();
  const context = {
    ...committedUiFixture().detachedContext(),
    action: "image.query",
    input: { operationId: f.request.operationId },
  };
  const pin = committedTaskContext(context).pin;
  const command = {
    ...f.command,
    idempotencyKey: "ordinary-query-original-key",
  };
  const first = await f.tasks.createQueryTaskFromPlugin(
    context.actor,
    command,
    pin,
  );
  const before = effects(f);
  const freshContext = {
    ...context,
    authorityEpoch: "fresh-current-ordinary-query-epoch",
  };
  const freshPin = committedTaskContext(freshContext).pin;
  await assert.rejects(
    f.tasks.createQueryTaskFromPlugin(freshContext.actor, command, freshPin),
    conflict,
  );
  const extensions = replayAdapter(f);
  const result = await new ExtensionTaskApplicationService({
    ...f.dependencies,
    extensions,
    creditQuotes: undefined,
  }).createQueryTaskFromPlugin(freshContext.actor, command, freshPin);
  assert.equal(result.binding.runId, first.binding.runId);
  assert.equal(result.creditAdmission, undefined);
  const issuer = new PluginUiCommittedTaskAuthority({
    extensions,
    runs: f.runs,
    digester: taskDigester,
  });
  const outcome = await issuer.issueQuery({
    context: freshContext,
    command,
    result,
  });
  assert.equal(
    (issuer.verify(freshContext, outcome) as { runId: string }).runId,
    first.binding.runId,
  );
  assert.equal(f.state.links.size, 0);
  assert.deepEqual(effects(f), before);
});

test("project query acknowledgement captures the result and receipt reader before historical waits and still rejects invocation mutation", async () => {
  const f = await projectQueryTaskFixture();
  const first = await f.accept();
  const renewed = current(f);
  const adapter = replayAdapter(f);
  const gate = uiDeferred();
  const extensions = {
    ...adapter,
    async loadPluginQueryTaskAdmissionByReceipt(
      input: PluginTaskReceiptLocator,
    ) {
      await gate.promise;
      return adapter.loadPluginQueryTaskAdmissionByReceipt!(input);
    },
  };
  const issuer = new PluginUiCommittedTaskAuthority({
    ...f.committedDependencies,
    extensions,
  });
  const claim = {
    context: renewed.context,
    command: renewed.command,
    executionPin: renewed.executionPin,
    result: structuredClone(first.result),
  };
  const pending = issuer.issueProjectGenerationQuery(claim);
  Object.assign(claim.result.turn.threadState, { revision: 999 });
  extensions.loadPluginQueryTaskAdmissionByReceipt = async () => {
    throw new Error("replacement-lookup");
  };
  gate.resolve();
  const outcome = await pending;
  assert.equal(
    (issuer.verify(renewed.context, outcome) as { threadRevision: number })
      .threadRevision,
    f.request.expectedThreadRevision + 1,
  );
  const gateAgain = uiDeferred();
  const changing = new PluginUiCommittedTaskAuthority({
    ...f.committedDependencies,
    extensions: {
      ...adapter,
      async loadPluginQueryTaskAdmissionByReceipt(input) {
        await gateAgain.promise;
        return adapter.loadPluginQueryTaskAdmissionByReceipt!(input);
      },
    },
  });
  const changed = current(f);
  const rejected = changing.issueProjectGenerationQuery({
    context: changed.context,
    command: changed.command,
    executionPin: changed.executionPin,
    result: first.result,
  });
  changed.context.input = {
    ...f.request,
    operationId: "22222222-2222-4222-8222-222222222222",
  };
  gateAgain.resolve();
  await assert.rejects(rejected);
});

test("missing, mismatched and accessor historical admission readers fail closed without generating new records", async () => {
  const f = await projectQueryTaskFixture();
  const first = await f.accept();
  const before = effects(f);
  const renewed = current(f);
  for (const read of [
    async () => null,
    async () => ({
      ...f.state.queries.get(first.result.binding.runId)!,
      profileId: "foreign-profile",
    }),
    async () => ({
      ...f.state.queries.get(first.result.binding.runId)!,
      operationId: "22222222-2222-4222-8222-222222222222",
    }),
    async () => ({
      ...f.state.queries.get(first.result.binding.runId)!,
      requestDigest: taskDigester.sha256("foreign-request"),
    }),
  ]) {
    const extensions = {
      ...f.extensions,
      loadPluginQueryTaskAdmissionByReceipt: read as (
        input: PluginTaskReceiptLocator,
      ) => Promise<PluginQueryTaskAdmission | null>,
    };
    await assert.rejects(
      new ExtensionTaskApplicationService({
        ...f.dependencies,
        extensions,
      }).createPublishedProjectQueryTaskFromPlugin(renewed.input),
    );
  }
  let getterCalls = 0;
  const extensions = { ...f.extensions };
  Object.defineProperty(extensions, "loadPluginQueryTaskAdmissionByReceipt", {
    enumerable: true,
    get() {
      getterCalls++;
      return replayAdapter(f).loadPluginQueryTaskAdmissionByReceipt;
    },
  });
  await assert.rejects(
    new ExtensionTaskApplicationService({
      ...f.dependencies,
      extensions,
    }).createPublishedProjectQueryTaskFromPlugin(renewed.input),
  );
  assert.throws(
    () =>
      new PluginUiCommittedTaskAuthority({
        ...f.committedDependencies,
        extensions,
      }),
  );
  assert.equal(getterCalls, 0);
  assert.deepEqual(effects(f), before);
});
