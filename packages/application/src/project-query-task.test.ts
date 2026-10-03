import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionCanonicalJson, parseProjectQueryLink } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { ExtensionTaskApplicationService } from "./extension-task-application-service.ts";
import {
  PluginUiCommittedTaskAuthority,
  isPluginUiCommittedProjectQueryAuthority,
} from "./plugin-ui-committed-task-authority.ts";
import {
  projectGenerationQueryUiTaskKey,
  projectGenerationQueryUiTaskCommand,
  projectQueryTaskReceipt,
} from "./project-query-task-receipt.ts";
import { projectQueryTaskFixture } from "./project-query-task.test-support.ts";
import { taskDigester } from "./extension-plugin-task.test-support.ts";
import { uiDeferred } from "./plugin-ui.test-support.ts";

test("business query reuses the original paid source with current query package and no additional credits", async () => {
  const f = await projectQueryTaskFixture();
  const before = {
    quotes: f.saved.f.base.state.quoteCalls,
    admissions: f.saved.f.base.state.admissions.size,
    sources: f.saved.f.state.links.size,
  };
  const accepted = await f.accept();
  assert.equal(accepted.result.creditAdmission, undefined);
  assert.notEqual(accepted.result.binding.runId, f.generated.binding.runId);
  assert.deepEqual(accepted.result.binding.source, {
    runId: f.generated.binding.runId,
    bindingDigest: f.generated.binding.bindingDigest,
    operationId: f.request.operationId,
  });
  assert.equal(
    accepted.result.binding.configurationRevision,
    f.generated.binding.configurationRevision,
  );
  assert.deepEqual(accepted.result.binding.target, f.generated.binding.target);
  assert.deepEqual(f.state.historicalVersions, ["0.1.0"]);
  assert.equal(
    f.state.queries.get(accepted.result.binding.runId)?.version,
    "2.0.0",
  );
  assert.deepEqual(
    {
      quotes: f.saved.f.base.state.quoteCalls,
      admissions: f.saved.f.base.state.admissions.size,
      sources: f.saved.f.state.links.size,
    },
    before,
  );
  assert.equal(f.state.links.size, 1);
  assert.ok(
    f.state.transactionReads.every(([before, after]) => before === after),
  );
  assert.ok(
    f.state.transactionChecks > 0 &&
      f.state.fullChecks > 0 &&
      f.state.activeChecks > 0,
  );
});

test("query exact-key replay returns the original query receipt after archive and appended saved input", async () => {
  const f = await projectQueryTaskFixture();
  const first = await f.accept();
  f.saved.f.appendInput();
  f.saved.f.archive();
  const count = f.saved.f.base.state.commits.length;
  const replay = await f.accept();
  assert.equal(replay.result.turn.disposition, "replayed");
  assert.equal(replay.result.binding.runId, first.result.binding.runId);
  assert.equal(f.saved.f.base.state.commits.length, count);
  assert.equal(f.state.links.size, 1);
  assert.equal(
    f.state.links.get(first.result.binding.runId)?.reference.assetRevision,
    1,
  );
});

test("a current actor can query the same owner's historical paid source without rewriting its original actor", async () => {
  const f = await projectQueryTaskFixture();
  const actor = { ...f.input.actor, actorId: "current-audit-actor" };
  const sourcePin = { ...f.sourcePin, actorId: actor.actorId };
  const executionPin = { ...f.executionPin, actorId: actor.actorId };
  const command = projectGenerationQueryUiTaskCommand(
    {
      sourcePin,
      executionPin,
      request: f.request,
      sourceRunId: f.generated.binding.runId,
    },
    taskDigester,
  );
  const result = await f.tasks.createPublishedProjectQueryTaskFromPlugin({
    ...f.input,
    actor,
    sourcePin,
    executionPin,
    command,
  });
  const query = f.state.queries.get(result.binding.runId)!;
  assert.equal(result.run.state.createdByActorId, actor.actorId);
  assert.equal(query.actorId, actor.actorId);
  assert.equal(query.source.actorId, f.generated.binding.actorId);
  assert.notEqual(query.actorId, query.source.actorId);
  const context = { ...f.context, actor };
  const receipt = f.committed.verify(
    context,
    await f.committed.issueProjectGenerationQuery({
      context,
      command,
      executionPin,
      result,
    }),
  ) as { runId: string };
  assert.equal(receipt.runId, result.binding.runId);
});

test("query source and operation are loaded from the saved locator before any Turn admission", async () => {
  const f = await projectQueryTaskFixture();
  const count = f.saved.f.base.state.commits.length;
  for (const patch of [
    { reference: { ...f.input.reference, assetRevision: 2 } },
    { actor: { ...f.input.actor, principalId: "foreign-principal" } },
    {
      command: {
        ...f.command,
        intent: {
          kind: "query" as const,
          sourceRunId: "invented-run",
          operationId: f.request.operationId,
        },
      },
    },
    {
      command: {
        ...f.command,
        intent: {
          kind: "query" as const,
          sourceRunId: f.generated.binding.runId,
          operationId: "22222222-2222-4222-8222-222222222222",
        },
      },
    },
  ])
    await assert.rejects(
      f.tasks.createPublishedProjectQueryTaskFromPlugin({
        ...f.input,
        ...patch,
      }),
    );
  assert.equal(f.saved.f.base.state.commits.length, count);
  assert.equal(f.state.links.size, 0);
});

test("project query remains off for adapters without explicit query or read capabilities", async () => {
  const f = await projectQueryTaskFixture();
  for (const patch of [
    { extensions: { ...f.extensions, projectQueryVersion: undefined } },
    {
      extensions: {
        ...f.extensions,
        projectQueryPublicationVersion: undefined,
      },
    },
    { extensions: { ...f.extensions, loadProjectQueryLink: undefined } },
    { projectGenerationReads: undefined },
    { creativeProjects: undefined },
  ]) {
    const service = new ExtensionTaskApplicationService({
      ...f.dependencies,
      ...patch,
    });
    await assert.rejects(
      service.createPublishedProjectQueryTaskFromPlugin(f.input),
    );
  }
  assert.equal(f.state.options.length, 0);
});

test("current project, query, source read and Turn policies fail closed before commit", async () => {
  for (const deny of [
    "project",
    "extension:query",
    "run:read",
    "thread:message:append",
    "run:create",
  ] as const) {
    const f = await projectQueryTaskFixture();
    if (deny === "project") f.saved.f.state.deniedProject = true;
    else f.saved.f.base.state.denied = deny;
    await assert.rejects(
      f.accept(),
      (error) =>
        error instanceof ApplicationError && error.category === "authorization",
    );
    assert.equal(f.state.options.length, 0);
    assert.equal(f.saved.f.base.state.quoteCalls, 1);
  }
});

test("withdrawn and asynchronous active authorities cannot reach a query commit", async () => {
  const f = await projectQueryTaskFixture();
  f.state.alive = false;
  await assert.rejects(f.accept());
  f.state.alive = true;
  await assert.rejects(
    f.tasks.createPublishedProjectQueryTaskFromPlugin({
      ...f.input,
      authority: {
        ...f.authority,
        assertActive: (() => Promise.resolve()) as unknown as () => void,
      },
    }),
  );
  assert.equal(f.state.options.length, 0);
});

test("query key stays stable through mounts and epochs and separate from other business intents", async () => {
  const f = await projectQueryTaskFixture();
  const key = projectGenerationQueryUiTaskKey(
    { sourcePin: f.sourcePin, idempotencyKey: f.request.idempotencyKey },
    taskDigester,
  );
  assert.equal(
    key,
    projectGenerationQueryUiTaskKey(
      {
        sourcePin: {
          ...f.sourcePin,
          authorityEpoch: "later",
          selectionRevision: 99,
        },
        idempotencyKey: f.request.idempotencyKey,
      },
      taskDigester,
    ),
  );
  assert.notEqual(
    key,
    projectGenerationQueryUiTaskKey(
      { sourcePin: f.sourcePin, idempotencyKey: "different-intent" },
      taskDigester,
    ),
  );
  assert.throws(() =>
    projectGenerationQueryUiTaskKey(
      {
        sourcePin: {
          ...f.sourcePin,
          action: "crewon.project-generations.v1.generateConcept",
        },
        idempotencyKey: f.request.idempotencyKey,
      },
      taskDigester,
    ),
  );
  const base = {
    actorId: f.input.actor.actorId,
    idempotencyKey: key,
    requestDigest: taskDigester.sha256("query-base"),
  };
  assert.notEqual(
    projectQueryTaskReceipt(
      base,
      {
        reference: f.request.reference,
        generationLinkDigest: taskDigester.sha256("a"),
      },
      taskDigester,
    ).requestDigest,
    projectQueryTaskReceipt(
      base,
      {
        reference: f.request.reference,
        generationLinkDigest: taskDigester.sha256("b"),
      },
      taskDigester,
    ).requestDigest,
  );
});

test("dedicated issuer verifies the query sidecar and publishes only its query receipt once", async () => {
  const f = await projectQueryTaskFixture();
  const accepted = await f.accept();
  assert.ok(
    isPluginUiCommittedProjectQueryAuthority({
      authority: f.committed,
      publications: [f.publication],
    }),
  );
  const outcome = await f.committed.issueProjectGenerationQuery(accepted);
  assert.ok(f.committed.isOutcome(outcome));
  const output = f.committed.verify(f.context, outcome) as {
    runId: string;
    threadRevision: number;
  };
  assert.equal(output.runId, accepted.result.binding.runId);
  assert.notEqual(output.runId, f.generated.binding.runId);
  assert.equal(output.threadRevision, f.request.expectedThreadRevision + 1);
  assert.throws(() => f.committed.verify(f.context, outcome));
  await assert.rejects(
    f.committed.issueQuery({
      context: f.context,
      command: f.command,
      result: accepted.result,
    }),
  );
});

test("confirmed query remains acknowledgeable after owner withdrawal, archive and provider progress", async () => {
  const f = await projectQueryTaskFixture();
  f.state.afterCommit = () => {
    f.state.alive = false;
    f.saved.f.state.deniedProject = true;
    f.saved.f.base.state.denied = "run:read";
    f.saved.f.appendInput();
    f.saved.f.archive();
    f.state.operation = {
      ...f.state.operation!,
      status: "succeeded",
      revision: 2,
      resultJson: '{"images":[]}',
    };
  };
  const accepted = await f.accept();
  const output = f.committed.verify(
    f.context,
    await f.committed.issueProjectGenerationQuery(accepted),
  ) as { runId: string };
  assert.equal(output.runId, accepted.result.binding.runId);
});

test("issuer cannot acknowledge an ordinary query without the matching saved project sidecar", async () => {
  const f = await projectQueryTaskFixture();
  const accepted = await f.accept();
  f.state.links.clear();
  await assert.rejects(f.committed.issueProjectGenerationQuery(accepted));
});

test("issuer rejects missing or forged original operation and historical configuration", async () => {
  const f = await projectQueryTaskFixture();
  const accepted = await f.accept();
  const operation = f.state.operation;
  f.state.operation = null;
  await assert.rejects(f.committed.issueProjectGenerationQuery(accepted));
  f.state.operation = {
    ...operation!,
    bindingDigest: taskDigester.sha256("foreign"),
  };
  await assert.rejects(f.committed.issueProjectGenerationQuery(accepted));
  f.state.operation = operation;
  const extensions = {
    ...f.extensions,
    loadExtensionConfiguration: async () => null,
  };
  const issuer = new PluginUiCommittedTaskAuthority({
    ...f.committedDependencies,
    extensions,
  });
  await assert.rejects(issuer.issueProjectGenerationQuery(accepted));
});

test("issuer rejects sidecar substitution, wrong business context and claimed receipt mutation", async () => {
  const f = await projectQueryTaskFixture();
  const accepted = await f.accept();
  const saved = f.state.links.get(accepted.result.binding.runId)!;
  const changed = {
    ...saved,
    generationLinkDigest: taskDigester.sha256("different-generation"),
  };
  const { contentDigest: _old, ...body } = changed;
  f.state.links.set(
    saved.binding.runId,
    parseProjectQueryLink(
      {
        ...body,
        contentDigest: taskDigester.sha256(extensionCanonicalJson(body)),
      },
      taskDigester,
    ),
  );
  await assert.rejects(f.committed.issueProjectGenerationQuery(accepted));
  f.state.links.set(saved.binding.runId, saved);
  await assert.rejects(
    f.committed.issueProjectGenerationQuery({
      ...accepted,
      context: {
        ...f.context,
        input: { ...f.request, idempotencyKey: "another-key" },
      },
    }),
  );
  await assert.rejects(
    f.committed.issueProjectGenerationQuery({
      ...accepted,
      result: {
        ...accepted.result,
        turn: {
          ...accepted.result.turn,
          threadState: { ...accepted.result.turn.threadState, revision: 999 },
        },
      },
    }),
  );
});

test("unconfigured committed authority never performs project-query persistent reads", async () => {
  const f = await projectQueryTaskFixture();
  const accepted = await f.accept();
  const authority = new PluginUiCommittedTaskAuthority({
    extensions: f.extensions,
    runs: f.runs,
    digester: taskDigester,
  });
  assert.equal(
    isPluginUiCommittedProjectQueryAuthority({
      authority,
      publications: [f.publication],
    }),
    false,
  );
  const count = f.state.sourceProofReads;
  await assert.rejects(authority.issueProjectGenerationQuery(accepted));
  assert.equal(f.state.sourceProofReads, count);
});

test("query host envelopes reject unknown, hidden and accessor fields before any callback", async () => {
  const f = await projectQueryTaskFixture();
  let reads = 0;
  const reference = { ...f.input.reference };
  Object.defineProperty(reference, "projectId", {
    enumerable: true,
    get() {
      reads++;
      return f.input.reference.projectId;
    },
  });
  const authority = { ...f.authority };
  Object.defineProperty(authority, "assertCurrent", {
    enumerable: true,
    get() {
      reads++;
      return f.authority.assertCurrent;
    },
  });
  for (const input of [
    { ...f.input, reference },
    { ...f.input, authority },
    { ...f.input, payer: "invented" },
    {
      ...f.input,
      reference: { ...f.input.reference, expectedProjectRevision: 3 },
    },
    {
      ...f.input,
      publication: {
        ...f.publication,
        source: { ...f.publication.source, principalId: "invented" },
      },
    },
  ])
    await assert.rejects(
      f.tasks.createPublishedProjectQueryTaskFromPlugin(input),
    );
  assert.equal(reads, 0);
  assert.equal(f.state.fullChecks, 0);
  assert.equal(f.state.options.length, 0);
});

test("query captures reference, both pins, command and bound authority before the first await", async () => {
  const f = await projectQueryTaskFixture();
  const input = {
    ...f.input,
    reference: { ...f.input.reference },
    sourcePin: { ...f.sourcePin },
    executionPin: { ...f.executionPin },
    command: structuredClone(f.command),
  };
  const result = f.tasks.createPublishedProjectQueryTaskFromPlugin(input);
  input.reference.projectId = "changed";
  input.sourcePin.pluginId = "changed.business";
  input.executionPin.pluginId = "changed.query";
  Object.assign(input.command, { idempotencyKey: "changed" });
  const accepted = await result;
  assert.equal(
    f.state.links.get(accepted.binding.runId)?.reference.projectId,
    f.request.reference.projectId,
  );
  assert.equal(
    f.state.links.get(accepted.binding.runId)?.sourcePin.pluginId,
    f.sourcePin.pluginId,
  );
  assert.equal(
    f.state.links.get(accepted.binding.runId)?.executionPin.pluginId,
    f.executionPin.pluginId,
  );
});

test("issuer rejects read adapter accessors without evaluation and captures all persistent ports", async () => {
  const f = await projectQueryTaskFixture();
  const accepted = await f.accept();
  let getters = 0;
  const operations = {};
  Object.defineProperty(operations, "loadExternalOperation", {
    enumerable: true,
    get() {
      getters++;
      return f.operations.loadExternalOperation;
    },
  });
  assert.throws(
    () =>
      new PluginUiCommittedTaskAuthority({
        ...f.committedDependencies,
        projectQueries: {
          ...f.committedDependencies.projectQueries,
          operations: operations as typeof f.operations,
        },
      }),
  );
  assert.equal(getters, 0);
  const captured = new PluginUiCommittedTaskAuthority(f.committedDependencies);
  f.operations.loadExternalOperation = async () => {
    throw new Error("replacement-reader");
  };
  f.extensions.loadProjectQueryLink = async () => {
    throw new Error("replacement-reader");
  };
  const result = captured.verify(
    f.context,
    await captured.issueProjectGenerationQuery(accepted),
  ) as { runId: string };
  assert.equal(result.runId, accepted.result.binding.runId);
});

test("issuer captures receipt before a storage wait and rejects changed invocation context", async () => {
  const f = await projectQueryTaskFixture();
  const original = await f.accept();
  const accepted = { ...original, result: structuredClone(original.result) };
  const gate = uiDeferred();
  const extensions = {
    ...f.extensions,
    async loadPluginQueryTaskAdmission(input: {
      runId: string;
      tenantId: string;
      spaceId: string;
    }) {
      await gate.promise;
      return f.extensions.loadPluginQueryTaskAdmission!(input);
    },
  };
  const issuer = new PluginUiCommittedTaskAuthority({
    ...f.committedDependencies,
    extensions,
  });
  const pending = issuer.issueProjectGenerationQuery(accepted);
  Object.assign(accepted.result.turn, {
    threadState: { ...accepted.result.turn.threadState, revision: 999 },
  });
  gate.resolve();
  const output = issuer.verify(f.context, await pending) as {
    threadRevision: number;
  };
  assert.equal(output.threadRevision, f.request.expectedThreadRevision + 1);
  const acceptedAgain = await f.accept();
  const gateAgain = uiDeferred();
  const changing = new PluginUiCommittedTaskAuthority({
    ...f.committedDependencies,
    extensions: {
      ...f.extensions,
      async loadPluginQueryTaskAdmission(input) {
        await gateAgain.promise;
        return f.extensions.loadPluginQueryTaskAdmission!(input);
      },
    },
  });
  const rejected = changing.issueProjectGenerationQuery(acceptedAgain);
  f.context.input = {
    ...f.request,
    operationId: "22222222-2222-4222-8222-222222222222",
  };
  gateAgain.resolve();
  await assert.rejects(rejected);
});

test("actual UI invocation returns confirmed query acknowledgement after close and policy withdrawal", async () => {
  const f = await projectQueryTaskFixture();
  const service = f.createUi(async (context, _result, actual) => {
    await actual.closeMount(f.input.actor, {
      mountRef: context.lease.mountRef,
    });
    f.business.state.allow = false;
    f.state.alive = false;
  });
  const lease = await service.openMount(f.input.actor, f.business.openCommand);
  const result = (await service.invoke(f.input.actor, {
    mountRef: lease.mountRef,
    action: f.context.action,
    input: f.request,
  })) as { runId: string };
  assert.ok(f.state.links.has(result.runId));
  assert.notEqual(result.runId, f.generated.binding.runId);
});
