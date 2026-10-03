import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  parseConceptAssetRevision,
  parseProjectBriefRevision,
  parsePluginSelection,
  reduceRunLifecycleEvent,
  type PluginTaskAdmissionPin,
  type ProjectGenerationLink,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { PluginUiCommittedTaskAuthority } from "./plugin-ui-committed-task-authority.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { projectGenerationUiTaskKey } from "./project-generation-task-receipt.ts";
import type {
  PluginUiActionContext,
  PluginUiCommittedTaskOutcome,
} from "./plugin-ui-ports.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
import type { ExtensionStore } from "./extension-store-port.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import {
  taskActor,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";
import {
  committedProjectGenerationFixture,
  projectTaskDto,
} from "./plugin-ui-committed-project-generation.test-support.ts";

function invalid(error: unknown) {
  return (
    error instanceof ApplicationError &&
    error.category === "internal" &&
    error.code === "plugin_ui_committed_project_generation_invalid"
  );
}
function oldInvalid(error: unknown) {
  return (
    error instanceof ApplicationError &&
    error.code === "plugin_ui_committed_task_invalid"
  );
}
function configurationInvalid(error: unknown) {
  return (
    error instanceof ApplicationError &&
    error.code === "plugin_ui_project_generation_configuration_invalid"
  );
}
function signed<T extends { contentDigest: string }>(
  input: T,
  patch: Partial<Omit<T, "contentDigest">>,
): T {
  const { contentDigest: _digest, ...body } = structuredClone(input);
  const next = { ...body, ...patch };
  return {
    ...next,
    contentDigest: taskDigester.sha256(extensionCanonicalJson(next)),
  } as T;
}

test("issues the original paid receipt from a distinct source UI package only after exact persisted task, link and source verification", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  const source = committedTaskContext(accepted.context).pin;
  assert.notEqual(source.pluginId, accepted.executionPin.pluginId);
  assert.notEqual(source.packageDigest, accepted.executionPin.packageDigest);
  assert.notEqual(source.publisherId, accepted.executionPin.publisherId);
  assert.notEqual(source.authorityEpoch, accepted.executionPin.authorityEpoch);
  assert.equal(accepted.context.lease.descriptor.entrypoints.node, null);
  assert.equal(accepted.command.pluginId, taskPin.pluginId);
  assert.deepEqual(accepted.command.intent, {
    kind: "generate",
    input: { prompt: f.project.original.assetRevision.prompt },
  });
  assert.notEqual(accepted.command.idempotencyKey, f.request.idempotencyKey);
  const admission = f.project.base.state.admissions.get(
    accepted.result.binding.runId,
  )!;
  const link = f.project.state.links.get(accepted.result.binding.runId)!;
  const commit = f.project.base.state.commits[0]!;
  assert.equal(admission.pluginId, taskPin.pluginId);
  assert.equal(admission.packageDigest, taskPin.packageDigest);
  assert.equal(
    link.binding.bindingDigest,
    accepted.result.binding.bindingDigest,
  );
  assert.equal(link.receipt.requestDigest, commit.receipt.requestDigest);
  assert.equal(link.receipt.idempotencyKey, commit.receipt.idempotencyKey);
  assert.equal(
    link.assetContentDigest,
    f.project.original.assetRevision.contentDigest,
  );
  assert.equal(link.briefContentDigest, f.project.original.brief.contentDigest);
  const beforeReads = f.project.state.projectReads.length;
  const outcome = await f.authority.issueProjectGeneration(accepted);
  assert.deepEqual(
    f.project.state.projectReads.slice(beforeReads).map((read) => read.method),
    ["loadProject", "loadConceptAsset", "loadConceptRevision", "loadBrief"],
  );
  assert.ok(Object.isFrozen(outcome));
  assert.throws(() => parsePluginUiJsonValue(outcome));
  assert.deepEqual(
    f.authority.verify(accepted.context, outcome),
    projectTaskDto(accepted.result),
  );
  assert.equal(f.authority.isOutcome(outcome), false);
  assert.throws(
    () => f.authority.verify(accepted.context, outcome),
    oldInvalid,
  );
  assert.equal(f.project.base.state.quoteCalls, 1);
  assert.equal(f.project.base.state.commits.length, 1);
});

test("the ordinary issuer rejects a cross-plugin project receipt and default configuration never reads the project source", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  await assert.rejects(
    f.authority.issue({
      context: accepted.context,
      command: accepted.command,
      result: accepted.result,
    }),
    oldInvalid,
  );
  const unconfigured = f.createAuthority({ projectGenerations: undefined });
  const before = [
    f.project.state.projectReads.length,
    f.project.state.linkReads,
    f.project.base.state.receiptReads,
  ];
  await assert.rejects(unconfigured.issueProjectGeneration(accepted), invalid);
  assert.deepEqual(
    [
      f.project.state.projectReads.length,
      f.project.state.linkReads,
      f.project.base.state.receiptReads,
    ],
    before,
  );
  assert.equal(unconfigured.isOutcome({}), false);
});

test("raw business keys are isolated by source package, contribution, actor and scope while mount, selection and policy renewal preserve the namespace", () => {
  const f = committedProjectGenerationFixture();
  const pin = committedTaskContext(f.detachedContext()).pin;
  const key = (sourcePin = pin, idempotencyKey = f.request.idempotencyKey) =>
    projectGenerationUiTaskKey({ sourcePin, idempotencyKey }, taskDigester);
  const original = key();
  const sourcePatches: Partial<PluginTaskAdmissionPin>[] = [
    { pluginId: "another.business" },
    { packageDigest: taskDigester.sha256("other-package") },
    { contributionId: "another-module" },
    { actorId: "other-actor" },
    { principalId: "other-person" },
    { tenantId: "other-tenant" },
    { spaceId: "other-space" },
    { profileId: "other-profile" },
  ];
  for (const patch of sourcePatches)
    assert.notEqual(key({ ...pin, ...patch }), original);
  assert.notEqual(key(pin, "other-raw-key"), original);
  assert.equal(
    key({
      ...pin,
      selectionRevision: pin.selectionRevision + 1,
      authorityEpoch: "renewed",
      version: "9.0.0",
    }),
    original,
  );
  for (const action of [
    "generate",
    "crewon.project-generations.v1.generateconcept",
    "crewon.project-generations.v1.read",
  ])
    assert.throws(
      () => key({ ...pin, action }),
      /project_generation_ui_source_action_invalid/u,
    );
});

test("original UI reference, thread, key and exact host-assembled command stay bound to the saved receipt", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  for (const patch of [
    { threadId: "other-thread" },
    { expectedThreadRevision: 9 },
    { idempotencyKey: "other-key" },
    ...[
      "projectId",
      "assetId",
      "assetRevision",
      "expectedProjectRevision",
      "expectedAssetMetadataRevision",
    ].map((field) => ({
      reference: {
        ...f.request.reference,
        [field]: field.endsWith("Id") ? "other-id" : 9,
      },
    })),
  ]) {
    const context = {
      ...accepted.context,
      input: { ...f.request, ...patch },
    } as PluginUiActionContext;
    await assert.rejects(
      f.authority.issueProjectGeneration({ ...accepted, context }),
      invalid,
    );
  }
  const commandPatches: Partial<CreateExtensionTaskCommand>[] = [
    { pluginId: committedTaskContext(accepted.context).pin.pluginId },
    { threadId: "other-thread" },
    { expectedThreadRevision: 9 },
    { idempotencyKey: f.request.idempotencyKey },
    {
      intent: {
        kind: "generate" as const,
        input: { prompt: "unsaved editor prompt" },
      },
    },
    {
      intent: {
        kind: "generate" as const,
        input: {
          prompt: f.project.original.assetRevision.prompt,
          payer: "invented",
        },
      },
    },
  ];
  for (const patch of commandPatches)
    await assert.rejects(
      f.authority.issueProjectGeneration({
        ...accepted,
        command: { ...accepted.command, ...patch },
      }),
      invalid,
    );
  assert.equal(f.project.base.state.receipts.size, 1);
  assert.equal(f.project.base.state.quoteCalls, 1);
});

test("requires an exact approved source-to-execution mapping and shared actor/profile authority boundaries", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  for (const side of ["source", "target"] as const)
    for (const patch of [
      { pluginId: `other.${side}` },
      { packageDigest: taskDigester.sha256(`other-${side}`) },
      { contributionId: "other-contribution" },
      ...(side === "target" ? [{ action: "other.action" }] : []),
    ]) {
      const authority = f.createAuthority({
        projectGenerations: {
          projects: f.project.store,
          publications: [
            { ...f.publication, [side]: { ...f.publication[side], ...patch } },
          ],
        },
      });
      await assert.rejects(authority.issueProjectGeneration(accepted), invalid);
    }
  for (const patch of [
    { pluginId: "other.execution" },
    { packageDigest: taskDigester.sha256("other-target") },
    { contributionId: "other-contribution" },
    { action: "other.action" },
    { tenantId: "other-tenant" },
    { spaceId: "other-space" },
    { profileId: "other-profile" },
    { principalId: "other-owner" },
    { actorId: "other-actor" },
    { selectionRevision: 9 },
    { authorityEpoch: "other-epoch" },
  ])
    await assert.rejects(
      f.authority.issueProjectGeneration({
        ...accepted,
        executionPin: { ...taskPin, ...patch },
      }),
      invalid,
    );
});

test("missing persisted receipt, admission, link, project, asset, immutable input, brief or Run cannot be acknowledged", async () => {
  for (const missing of [
    "receipt",
    "admission",
    "link",
    "project",
    "asset",
    "revision",
    "brief",
    "run",
  ] as const) {
    const f = committedProjectGenerationFixture();
    const accepted = await f.accept();
    if (missing === "receipt") f.project.base.state.receipts.clear();
    else if (missing === "admission") f.project.base.state.admissions.clear();
    else if (missing === "link") f.project.state.links.clear();
    else if (missing === "revision") f.project.state.revisions.clear();
    else if (missing === "brief") f.project.state.briefs.clear();
    else if (missing === "run") f.state.currentRun = null;
    else {
      const projects = {
        ...f.project.store,
        [missing === "project" ? "loadProject" : "loadConceptAsset"]:
          async () => null,
      };
      const authority = f.createAuthority({
        projectGenerations: { publications: [f.publication], projects },
      });
      await assert.rejects(authority.issueProjectGeneration(accepted), invalid);
      continue;
    }
    await assert.rejects(f.authority.issueProjectGeneration(accepted), invalid);
  }
});

test("claimed price, transaction, message and target must equal the persisted original paid receipt", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  const message = structuredClone(accepted.result);
  (message.turn.messages[0] as { messageId: string }).messageId =
    "invented-message";
  for (const result of [
    message,
    {
      ...accepted.result,
      binding: { ...accepted.result.binding, runId: "invented-run" },
    },
    {
      ...accepted.result,
      turn: {
        ...accepted.result.turn,
        threadState: { ...accepted.result.turn.threadState, revision: 99 },
      },
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
    { ...accepted.result, creditAdmission: undefined },
    { ...accepted.result, account: "private" },
  ])
    await assert.rejects(
      f.authority.issueProjectGeneration({ ...accepted, result }),
      invalid,
    );
});

test("persisted admission owner, execution provenance and exact receipt digest cannot be substituted", async () => {
  for (const patch of [
    { principalId: "other-owner" },
    { actorId: "other-actor" },
    { profileId: "other-profile" },
    { pluginId: "other-target" },
    { packageDigest: taskDigester.sha256("other-package") },
    { action: "other-action" },
    { authorityEpoch: "other-epoch" },
    { requestDigest: taskDigester.sha256("other-receipt") },
    { idempotencyKey: "other-key" },
  ]) {
    const f = committedProjectGenerationFixture();
    const accepted = await f.accept();
    const admission = f.project.base.state.admissions.get(
      accepted.result.binding.runId,
    )!;
    f.project.base.state.admissions.set(admission.runId, {
      ...admission,
      ...patch,
    });
    await assert.rejects(f.authority.issueProjectGeneration(accepted), invalid);
  }
});

test("a recomputed link digest cannot hide a changed owner, reference, input, brief, receipt or binding", async () => {
  for (const corrupt of [
    "owner",
    "reference",
    "input",
    "brief",
    "receipt",
    "binding",
  ] as const) {
    const f = committedProjectGenerationFixture();
    const accepted = await f.accept();
    const link = f.project.state.links.get(accepted.result.binding.runId)!;
    const patch: Partial<ProjectGenerationLink> =
      corrupt === "owner"
        ? { ownerPrincipalId: "other-owner" }
        : corrupt === "reference"
          ? { reference: { ...link.reference, expectedProjectRevision: 99 } }
          : corrupt === "input"
            ? { assetContentDigest: taskDigester.sha256("other-input") }
            : corrupt === "brief"
              ? { briefContentDigest: taskDigester.sha256("other-brief") }
              : corrupt === "receipt"
                ? {
                    receipt: {
                      ...link.receipt,
                      requestDigest: taskDigester.sha256("other-receipt"),
                    },
                  }
                : {
                    binding: {
                      ...link.binding,
                      inputDigest: taskDigester.sha256("other-prompt"),
                    },
                  };
    f.project.state.links.set(link.binding.runId, signed(link, patch));
    await assert.rejects(f.authority.issueProjectGeneration(accepted), invalid);
  }
});

test("valid but substituted source history, owner and asset scope are rejected against the immutable generation link", async () => {
  for (const corrupt of [
    "project-owner",
    "asset-scope",
    "revision-prompt",
    "revision-brief",
    "brief-text",
  ] as const) {
    const f = committedProjectGenerationFixture();
    const accepted = await f.accept();
    if (corrupt === "project-owner")
      f.project.state.project = {
        ...f.project.state.project,
        ownerPrincipalId: "other-owner",
      };
    else if (corrupt === "asset-scope")
      f.project.state.asset = {
        ...f.project.state.asset,
        projectId: "other-project",
      };
    else if (corrupt === "brief-text") {
      const brief = f.project.state.briefs.get(1)!;
      f.project.state.briefs.set(
        1,
        parseProjectBriefRevision(
          signed(brief, { text: "valid changed brief" }),
          taskDigester,
        ),
      );
    } else {
      const revision = f.project.state.revisions.get(1)!;
      f.project.state.revisions.set(
        1,
        parseConceptAssetRevision(
          signed(
            revision,
            corrupt === "revision-prompt"
              ? { prompt: "valid changed prompt" }
              : { briefContentDigest: taskDigester.sha256("other-brief") },
          ),
          taskDigester,
        ),
      );
    }
    await assert.rejects(f.authority.issueProjectGeneration(accepted), invalid);
  }
});

test("actual Run owner and immutable execution target still match the saved binding while lifecycle advancement is allowed", async () => {
  for (const patch of [
    { tenantId: "other-tenant" },
    { spaceId: "other-space" },
    { threadId: "other-thread" },
    { createdByActorId: "other-actor" },
    { runtimeGeneration: "other-runtime" },
    { authorityId: "other-authority" },
    { agentVersionId: "other-agent" },
    { policySnapshotId: "other-policy" },
  ]) {
    const f = committedProjectGenerationFixture();
    const accepted = await f.accept();
    f.state.currentRun = { ...accepted.result.run.state, ...patch };
    await assert.rejects(f.authority.issueProjectGeneration(accepted), invalid);
  }
});

test("captures command, execution pin and claimed result before a storage await, but rejects changed invocation context", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  const command = structuredClone(accepted.command);
  const result = structuredClone(accepted.result);
  const executionPin = { ...accepted.executionPin };
  f.project.base.state.onReceipt = () => {
    (command as { idempotencyKey: string }).idempotencyKey =
      "caller-mutated-key";
    (result.turn.messages[0] as { messageId: string }).messageId =
      "caller-mutated-message";
    executionPin.packageDigest = taskDigester.sha256("caller-mutated-package");
  };
  const outcome = await f.authority.issueProjectGeneration({
    ...accepted,
    command,
    result,
    executionPin,
  });
  assert.deepEqual(
    f.authority.verify(accepted.context, outcome),
    projectTaskDto(accepted.result),
  );
  f.project.base.state.onReceipt = null;
  const context = structuredClone(accepted.context);
  f.project.base.state.onReceipt = () => {
    (context as { authorityEpoch: string }).authorityEpoch =
      "caller-mutated-epoch";
  };
  await assert.rejects(
    f.authority.issueProjectGeneration({ ...accepted, context }),
    invalid,
  );
});

test("captures source readers, receipt, admission, link, Run and digest methods before later adapter replacement", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  let receiverChecks = 0;
  const digester = {
    sha256(value: string) {
      assert.equal(this, digester);
      receiverChecks++;
      return taskDigester.sha256(value);
    },
  };
  const extensions = { ...f.project.extensions };
  const projects = { ...f.project.store };
  const runs = { ...f.runs };
  for (const field of [
    "loadProject",
    "loadConceptAsset",
    "loadConceptRevision",
    "loadBrief",
  ] as const)
    Object.defineProperty(projects, field, {
      writable: true,
      value: function (this: typeof projects, ...args: never[]) {
        assert.equal(this, projects);
        receiverChecks++;
        return Reflect.apply(f.project.store[field], f.project.store, args);
      },
    });
  for (const field of [
    "loadExtensionTurnReceipt",
    "loadPluginTaskAdmission",
    "loadProjectGenerationLink",
  ] as const)
    Object.defineProperty(extensions, field, {
      writable: true,
      value: function (this: typeof extensions, ...args: never[]) {
        assert.equal(this, extensions);
        receiverChecks++;
        return Reflect.apply(
          f.project.extensions[field]!,
          f.project.extensions,
          args,
        );
      },
    });
  Object.defineProperty(runs, "loadRunInSpace", {
    writable: true,
    value: function (this: typeof runs, ...args: never[]) {
      assert.equal(this, runs);
      receiverChecks++;
      return Reflect.apply(f.runs.loadRunInSpace, f.runs, args);
    },
  });
  const publications = structuredClone([f.publication]);
  const authority = f.createAuthority({
    extensions,
    runs,
    digester,
    projectGenerations: { publications, projects },
  });
  publications.length = 0;
  const fail = (): never => {
    throw new Error("replacement-must-not-run");
  };
  for (const field of [
    "loadProject",
    "loadConceptAsset",
    "loadConceptRevision",
    "loadBrief",
  ] as const)
    projects[field] = fail;
  extensions.loadExtensionTurnReceipt = fail;
  extensions.loadPluginTaskAdmission = fail;
  extensions.loadProjectGenerationLink = fail;
  runs.loadRunInSpace = fail;
  digester.sha256 = fail;
  const outcome = await authority.issueProjectGeneration(accepted);
  assert.deepEqual(
    authority.verify(accepted.context, outcome),
    projectTaskDto(accepted.result),
  );
  assert.ok(receiverChecks > 8);
});

test("replayed project intent preserves its frozen price and source after history advances without preparing a second task", async () => {
  const f = committedProjectGenerationFixture();
  const first = await f.accept();
  f.project.appendInput();
  f.project.archive();
  f.project.base.state.quote.quotedCredits = "999";
  f.state.currentRun = reduceRunLifecycleEvent(first.result.run.state, {
    schemaVersion: "crewon.run-event.v0",
    type: "run.started",
    identity: { runId: first.result.binding.runId },
    eventId: "run-started-after-commit",
    sequence: 2,
    occurredAt: "2026-10-02T03:01:00.000Z",
    data: {},
  });
  const replay = await f.accept();
  assert.equal(replay.result.turn.disposition, "replayed");
  assert.equal(replay.result.binding.runId, first.result.binding.runId);
  assert.equal(replay.result.creditAdmission!.reservation.quotedCredits, "3");
  const outcome = await f.authority.issueProjectGeneration(replay);
  assert.deepEqual(
    f.authority.verify(replay.context, outcome),
    projectTaskDto(replay.result),
  );
  assert.equal(f.project.base.state.quoteCalls, 1);
  assert.equal(f.project.base.state.commits.length, 1);
  assert.equal(f.project.state.links.size, 1);
});

test("read adapter accessors are rejected during capture without executing any getter", () => {
  const f = committedProjectGenerationFixture();
  let reads = 0;
  const accessor = (owner: object, field: string) =>
    Object.defineProperty({ ...owner }, field, {
      enumerable: true,
      get() {
        reads++;
        throw new Error("getter-must-not-run");
      },
    });
  for (const field of [
    "loadProject",
    "loadConceptAsset",
    "loadConceptRevision",
    "loadBrief",
  ] as const) {
    const projects = accessor(f.project.store, field) as CreativeProjectStore;
    assert.throws(
      () =>
        f.createAuthority({
          projectGenerations: { publications: [f.publication], projects },
        }),
      configurationInvalid,
    );
  }
  const extensions = accessor(
    f.project.extensions,
    "loadProjectGenerationLink",
  ) as ExtensionStore;
  assert.throws(() => f.createAuthority({ extensions }), configurationInvalid);
  assert.equal(reads, 0);
});

test("issuance envelope, captured context, input, execution pin, command and claimed result reject accessor or unknown fields without evaluation", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  let reads = 0;
  for (const [key, object, field] of [
    ["envelope", accepted, "context"],
    ["context", accepted.context, "actor"],
    ["executionPin", accepted.executionPin, "actorId"],
    ["command", accepted.command, "intent"],
    ["result", accepted.result, "binding"],
  ] as const) {
    const getter = Object.defineProperty({ ...object }, field, {
      enumerable: true,
      get() {
        reads++;
        throw new Error("getter-must-not-run");
      },
    });
    const input = key === "envelope" ? getter : { ...accepted, [key]: getter };
    await assert.rejects(
      f.authority.issueProjectGeneration(input as typeof accepted),
      invalid,
    );
  }
  const context = {
    ...accepted.context,
    input: { ...f.request, prompt: "injected", payer: "invented" },
  };
  await assert.rejects(
    f.authority.issueProjectGeneration({ ...accepted, context }),
    invalid,
  );
  await assert.rejects(
    f.authority.issueProjectGeneration({
      ...accepted,
      actor: taskActor,
    } as typeof accepted),
    invalid,
  );
  assert.equal(reads, 0);
});

test("after commit later archive, appended revision, policy withdrawal and quote changes do not invalidate the original acknowledgement", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  f.project.appendInput();
  f.project.archive();
  f.project.state.deniedProject = true;
  f.project.state.hostAlive = false;
  f.project.base.state.quote.quotedCredits = "999";
  f.state.allow = false;
  f.state.epoch = "withdrawn";
  const outcome = await f.authority.issueProjectGeneration(accepted);
  assert.deepEqual(
    f.authority.verify(accepted.context, outcome),
    projectTaskDto(accepted.result),
  );
  assert.equal(f.project.base.state.quoteCalls, 1);
  assert.equal(f.project.base.state.receipts.size, 1);
  assert.equal(f.project.state.links.size, 1);
});

test("project outcomes remain single-use and cannot cross another owner, clone or invocation context", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  const outcome = await f.authority.issueProjectGeneration(accepted);
  const other = f.createAuthority();
  assert.equal(other.isOutcome(outcome), false);
  assert.throws(() => other.verify(accepted.context, outcome), oldInvalid);
  for (const fake of [
    {},
    structuredClone(outcome),
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
      oldInvalid,
    );
  }
  assert.equal(f.authority.isOutcome(outcome), true);
  assert.throws(
    () => f.authority.verify({ ...accepted.context }, outcome),
    oldInvalid,
  );
  assert.equal(f.authority.isOutcome(outcome), false);
});

test("actual UI invoke returns the committed project receipt after revocation or mount close without a retry signal", async () => {
  for (const change of [
    "deny",
    "selection",
    "epoch",
    "expiry",
    "close",
  ] as const) {
    const f = committedProjectGenerationFixture();
    f.state.afterCommit = async (context) => {
      f.project.appendInput();
      f.project.archive();
      if (change === "deny") f.state.allow = false;
      else if (change === "selection")
        f.state.selection = parsePluginSelection({
          ...f.state.selection!,
          state: "disabled",
          revision: 6,
        });
      else if (change === "epoch") f.state.epoch = "withdrawn";
      else if (change === "expiry") f.state.now = context.lease.expiresAt;
      else
        await f.service.closeMount(taskActor, {
          mountRef: context.lease.mountRef,
        });
    };
    const lease = await f.service.openMount(taskActor, f.openCommand);
    const output = await f.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: "crewon.project-generations.v1.generateConcept",
      input: f.request,
    });
    const accepted = [...f.project.base.state.receipts.values()][0]!.result;
    assert.deepEqual(output, projectTaskDto(accepted));
    assert.equal(f.state.actionCalls, 1);
    assert.equal(f.project.base.state.quoteCalls, 1);
    assert.equal(f.project.base.state.commits.length, 1);
    assert.equal(f.project.state.links.size, 1);
  }
});

test("actual UI final precommit revocation rejects without a stored task, paid reservation or project link", async () => {
  const f = committedProjectGenerationFixture();
  f.project.base.state.onQuote = () => {
    f.state.epoch = "withdrawn-before-commit";
  };
  const lease = await f.service.openMount(taskActor, f.openCommand);
  await assert.rejects(
    f.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: "crewon.project-generations.v1.generateConcept",
      input: f.request,
    }),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  assert.equal(f.project.base.state.commits.length, 0);
  assert.equal(f.project.base.state.receipts.size, 0);
  assert.equal(f.project.base.state.admissions.size, 0);
  assert.equal(f.project.state.links.size, 0);
});

test("an old valid project outcome cannot acknowledge another actual UI invocation", async () => {
  const f = committedProjectGenerationFixture();
  const accepted = await f.accept();
  f.state.raw = await f.authority.issueProjectGeneration(accepted);
  f.state.mode = "raw";
  const lease = await f.service.openMount(taskActor, f.openCommand);
  await assert.rejects(
    f.service.invoke(taskActor, {
      mountRef: lease.mountRef,
      action: "crewon.project-generations.v1.generateConcept",
      input: f.request,
    }),
    oldInvalid,
  );
  assert.equal(f.project.base.state.quoteCalls, 1);
  assert.equal(f.project.base.state.receipts.size, 1);
});
