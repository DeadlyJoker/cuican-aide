import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import {
  captureCreativeProjectTransactionAuthority,
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
} from "./creative-project-commit-authority.ts";
import { captureProjectGenerationExecutionPublication } from "./project-generation-execution-authority.ts";
import { projectGenerationUiTaskCommand } from "./project-generation-task-receipt.ts";
import { projectTaskFixture } from "./project-generation-task.test-support.ts";
import {
  taskActor,
  taskCommand,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";

/** Actual Application service with explicit memory doubles, not SQL or Host installation proof. */
function fixture() {
  const f = projectTaskFixture();
  const sourcePin = parsePluginTaskAdmissionPin({
    ...taskPin,
    pluginId: "example.business",
    packageDigest: taskDigester.sha256("business"),
    action: "crewon.project-generations.v1.generateConcept",
  });
  const publication = {
    source: {
      pluginId: sourcePin.pluginId,
      packageDigest: sourcePin.packageDigest,
      contributionId: sourcePin.contributionId,
    },
    target: {
      pluginId: taskPin.pluginId,
      packageDigest: taskPin.packageDigest,
      contributionId: taskPin.contributionId,
      action: taskPin.action,
    },
  };
  const state = {
    sourceAlive: true,
    targetAlive: true,
    full: 0,
    transaction: 0,
    active: 0,
  };
  const active = () => {
    state.active++;
    if (!state.sourceAlive || !state.targetAlive)
      throw new ApplicationError("authorization", "test_owner_withdrawn");
  };
  const authority = {
    async assertCurrent() {
      assert.equal(this, authority);
      state.full++;
      await f.store.loadProject({
        owner: {
          tenantId: taskActor.tenantId,
          spaceId: taskActor.spaceId,
          principalId: taskActor.principalId,
        },
        projectId: f.reference.projectId,
      });
      active();
    },
    async assertTransactionCurrent() {
      assert.equal(this, authority);
      state.transaction++;
      active();
    },
    assertActive() {
      assert.equal(this, authority);
      active();
    },
  };
  const request = {
    reference: f.reference,
    threadId: taskCommand.threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "business-user-intent",
  };
  const command = projectGenerationUiTaskCommand(
    {
      sourcePin,
      executionPin: taskPin,
      request,
      prompt: f.original.assetRevision.prompt,
    },
    taskDigester,
  );
  const input = {
    actor: taskActor,
    command,
    reference: f.reference,
    publication,
    sourcePin,
    executionPin: taskPin,
    authority,
  };
  const extensions = {
    ...f.extensions,
    projectGenerationPublicationVersion:
      "crewon.project-generation-publication.v1" as const,
  };
  const service = f.create({ extensions });
  return { f, state, authority, input, service };
}

test("captures and freezes the exact two-owner publication and compares both scopes before async work", () => {
  const { input } = fixture();
  const mutable = {
    publication: structuredClone(input.publication),
    sourcePin: { ...input.sourcePin },
    executionPin: { ...input.executionPin },
  };
  const captured = captureProjectGenerationExecutionPublication(mutable);
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.sourcePin));
  assert.ok(Object.isFrozen(captured.executionPin));
  mutable.sourcePin.pluginId = "changed.business";
  assert.equal(captured.sourcePin.pluginId, input.sourcePin.pluginId);
  for (const patch of [
    { actorId: "another" },
    { profileId: "another" },
    { principalId: "another" },
    { packageDigest: taskDigester.sha256("other") },
  ])
    assert.throws(() =>
      captureProjectGenerationExecutionPublication({
        ...captured,
        executionPin: { ...captured.executionPin, ...patch },
      }),
    );
});

test("separates complete preflight from transaction-safe current and preserves the original bound receiver", async () => {
  const { authority, state } = fixture();
  const captured = captureCreativeProjectTransactionAuthority(authority);
  const replacement = () => {
    throw new Error("must-not-replace-captured-method");
  };
  authority.assertCurrent = replacement;
  authority.assertTransactionCurrent = replacement;
  authority.assertActive = replacement;
  await assertCreativeProjectCommitCurrent(captured.preflight);
  assert.equal(state.full, 1);
  assert.equal(state.transaction, 0);
  await assertCreativeProjectCommitCurrent(captured.transaction);
  assertCreativeProjectCommitActive(captured.transaction);
  assert.equal(state.full, 1);
  assert.equal(state.transaction, 1);
});

test("rejects accessor, missing, hidden and unknown authority callbacks without invoking getters", () => {
  const { authority } = fixture();
  let reads = 0;
  for (const field of [
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
  ] as const) {
    const value = Object.defineProperty({ ...authority }, field, {
      enumerable: true,
      get() {
        reads++;
        throw new Error("not-read");
      },
    });
    assert.throws(
      () => captureCreativeProjectTransactionAuthority(value),
      /creative_project_commit_authority_invalid/u,
    );
    const missing = { ...authority } as Partial<typeof authority>;
    delete missing[field];
    assert.throws(
      () =>
        captureCreativeProjectTransactionAuthority(missing as typeof authority),
      /creative_project_commit_authority_invalid/u,
    );
  }
  assert.throws(
    () =>
      captureCreativeProjectTransactionAuthority({
        ...authority,
        grant: true,
      } as typeof authority),
    /creative_project_commit_authority_invalid/u,
  );
  assert.equal(reads, 0);
});

test("the published host envelope and its detached publication reject hidden identity claims and accessors before preflight", async () => {
  const { input, service, state, f } = fixture();
  let reads = 0;
  for (const field of [
    "actor",
    "command",
    "reference",
    "sourcePin",
    "executionPin",
    "publication",
    "authority",
  ] as const) {
    const value = Object.defineProperty({ ...input }, field, {
      enumerable: true,
      get() {
        reads++;
        throw new Error("must-not-read");
      },
    });
    await assert.rejects(
      service.createPublishedProjectTaskFromPlugin(value),
      /project_generation_host_input_invalid/u,
    );
  }
  await assert.rejects(
    service.createPublishedProjectTaskFromPlugin({
      ...input,
      payer: "injected",
    } as typeof input),
    /project_generation_host_input_invalid/u,
  );
  assert.throws(() =>
    captureProjectGenerationExecutionPublication({
      ...input.publication,
      sourcePin: input.sourcePin,
      executionPin: input.executionPin,
    } as never),
  );
  assert.equal(reads, 0);
  assert.equal(state.full, 0);
  assert.equal(f.base.state.quoteCalls, 0);
});

test("published Application path uses no complete source read inside the borrowed commit callback and sends detached pins separately from persisted recipes", async () => {
  const { f, input, state, service } = fixture();
  const accepted = await service.createPublishedProjectTaskFromPlugin(input);
  assert.equal(accepted.run.disposition, "committed");
  assert.equal(state.full, 2);
  assert.ok(state.transaction > 0);
  assert.ok(
    f.state.guardedProjectReadCounts.every(
      ([before, after]) => before === after,
    ),
  );
  const options = f.state.commitOptions[0]!;
  assert.equal(
    options.projectGenerationPublication?.sourcePin.pluginId,
    input.sourcePin.pluginId,
  );
  assert.equal(
    options.projectGenerationPublication?.executionPin.pluginId,
    taskPin.pluginId,
  );
  assert.equal(
    "projectGenerationPublication" in f.base.state.commits[0]!,
    false,
  );
  assert.equal("sourcePin" in accepted, false);
  assert.equal("sourcePin" in f.state.links.values().next().value!, false);
});

test("an older adapter without publication capability fails closed before full preflight or pricing", async () => {
  const { f, input, state } = fixture();
  await assert.rejects(
    f.create().createPublishedProjectTaskFromPlugin(input),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "creative_project_generation_publication_unavailable",
  );
  assert.equal(state.full, 0);
  assert.equal(state.transaction, 0);
  assert.equal(f.base.state.quoteCalls, 0);
  assert.equal(f.base.state.commits.length, 0);
});

test("either owner withdrawn after pricing rejects without a Turn or paid task", async () => {
  for (const owner of ["sourceAlive", "targetAlive"] as const) {
    const { f, input, state, service } = fixture();
    f.base.state.onQuote = () => {
      state[owner] = false;
    };
    await assert.rejects(
      service.createPublishedProjectTaskFromPlugin(input),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "test_owner_withdrawn",
    );
    assert.equal(f.base.state.commits.length, 0);
    assert.equal(f.base.state.receipts.size, 0);
    assert.equal(f.state.links.size, 0);
  }
});

test("confirmed published commits do not rerun current permission after either original owner closes", async () => {
  const { f, input, state, service } = fixture();
  let before: readonly [number, number] | undefined;
  f.state.afterConfirmedCommit = () => {
    before = [state.full, state.transaction];
    state.sourceAlive = false;
    state.targetAlive = false;
  };
  const accepted = await service.createPublishedProjectTaskFromPlugin(input);
  assert.equal(accepted.run.disposition, "committed");
  assert.deepEqual([state.full, state.transaction], before);
  assert.equal(f.state.links.size, 1);
});
