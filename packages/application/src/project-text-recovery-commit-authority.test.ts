import assert from "node:assert/strict";
import test from "node:test";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import {
  captureProjectTextRecoveryCommitAuthority,
  captureProjectTextRecoveryCommitTransaction,
} from "./project-text-recovery-commit-authority.ts";
import { captureProjectTextUiCommitTransaction } from "./project-text-ui-commit-authority.ts";
import { captureCreativeProjectCommitAuthority } from "./creative-project-commit-authority.ts";
import {
  registerPluginUiInvocation,
  capturePluginProjectTextRecoveryInvocationCommitAuthority,
} from "./plugin-ui-invocation-authority.ts";
import { ApplicationError } from "./application-error.ts";
const context = committedTaskContext(
  committedUiFixture().detachedContext(),
).context;
function fixture() {
  const pin = {
    tenantId: context.scope.tenantId,
    spaceId: context.scope.spaceId,
    profileId: context.scope.profileId,
    pluginId: context.package.pluginId,
    publisherId: context.package.publisherId,
    version: context.package.version,
    packageDigest: context.package.packageDigest,
    selectionRevision: context.selection.revision,
  };
  const state = { current: 0, active: true };
  const transaction = {
    version: "crewon.project-text-recovery-commit.v1" as const,
    actor: context.actor,
    installation: pin,
    contributionId: context.lease.contributionId,
    actionId: "crewon.project-text-recovery.v1.acknowledge" as const,
    input: { projectId: "project", intentId: "intent", expectedRevision: 2 },
    selection: context.selection,
    package: context.package,
    assertCurrent: async () => {
      state.current++;
      if (!state.active) throw new Error("withdrawn");
    },
  };
  return {
    transaction,
    state,
    authority: {
      assertActive: () => {
        if (!state.active) throw new Error("withdrawn");
      },
      assertCurrent: async () => undefined,
      recoveryTransaction: transaction,
    },
  };
}
test("recovery qualification captures exact input, callback and full eight-field installation independent of legacy protocols", async () => {
  const f = fixture(),
    grant = captureProjectTextRecoveryCommitAuthority(f.authority);
  f.transaction.input.expectedRevision = 99;
  f.transaction.assertCurrent = async () => undefined;
  assert.deepEqual(grant.recoveryTransaction.input, {
    projectId: "project",
    intentId: "intent",
    expectedRevision: 2,
  });
  await grant.recoveryTransaction.assertCurrent();
  assert.equal(f.state.current, 1);
  f.state.active = false;
  assert.throws(grant.assertActive, /withdrawn/);
  await assert.rejects(grant.recoveryTransaction.assertCurrent(), /withdrawn/);
  assert.throws(() =>
    captureCreativeProjectCommitAuthority({ authority: f.authority as never }),
  );
  assert.throws(() => captureProjectTextUiCommitTransaction(f.transaction));
});
test("recovery capture rejects opaque actor/tuple/action drift, missing fields, accessors and mixed qualifiers", () => {
  const f = fixture();
  let getters = 0;
  const accessor = { ...f.transaction };
  Object.defineProperty(accessor, "input", {
    enumerable: true,
    get: () => {
      getters++;
      return f.transaction.input;
    },
  });
  assert.throws(() => captureProjectTextRecoveryCommitTransaction(accessor));
  assert.equal(getters, 0);
  for (const bad of [
    { ...f.transaction, actor: { ...f.transaction.actor, spaceId: "foreign" } },
    {
      ...f.transaction,
      installation: { ...f.transaction.installation, selectionRevision: 99 },
    },
    { ...f.transaction, actionId: "crewon.project-texts.v1.setLocked" },
    {
      ...f.transaction,
      input: { ...f.transaction.input, principalId: "caller" },
    },
    { ...f.transaction, contributionId: undefined },
  ])
    assert.throws(() => captureProjectTextRecoveryCommitTransaction(bad));
  for (const other of ["transaction", "runTransaction", "textUiTransaction"])
    assert.throws(() =>
      captureProjectTextRecoveryCommitAuthority({
        ...f.authority,
        [other]: {},
      }),
    );
});
test("ACK final local check cannot be asynchronous or an arbitrary thenable", () => {
  const f = fixture();
  let getters = 0;
  const thenable = Object.defineProperty({}, "then", {
    get: () => {
      getters++;
      throw new Error("must not read");
    },
  });
  const grant = captureProjectTextRecoveryCommitAuthority({
    ...f.authority,
    assertActive: () => thenable,
  });
  assert.throws(grant.assertActive, /authority_invalid/);
  assert.equal(getters, 0);
});
test("optional journal reference preserves old text capture and requires exact contribution/ref schema", () => {
  const f = fixture();
  const transaction = {
    ...f.transaction,
    version: "crewon.project-text-plugin-commit.v1",
    actionId: "crewon.project-texts.v1.setLocked",
    input: {
      projectId: "project",
      artifactId: "artifact",
      request: { expectedArtifactRevision: 1, locked: true },
      idempotencyKey: "once",
    },
  };
  const { contributionId: _, ...old } = transaction;
  assert.equal(captureProjectTextUiCommitTransaction(old).intentRef, undefined);
  const reference = {
    intentId: "intent",
    requestDigest: `sha256:${"a".repeat(64)}`,
  };
  const captured = captureProjectTextUiCommitTransaction({
    ...transaction,
    intentRef: reference,
  });
  reference.intentId = "later";
  assert.equal(captured.intentRef!.intentId, "intent");
  assert.equal(captured.contributionId, context.lease.contributionId);
  assert.throws(() =>
    captureProjectTextUiCommitTransaction({ ...old, intentRef: reference }),
  );
  for (const ref of [
    { intentId: "intent", requestDigest: "bad" },
    { intentId: "..", requestDigest: `sha256:${"a".repeat(64)}` },
    { ...reference, grant: true },
  ])
    assert.throws(() =>
      captureProjectTextUiCommitTransaction({ ...transaction, intentRef: ref }),
    );
});
test("an observed recovery transaction policy deny withdraws its exact registered invocation permanently", async () => {
  const value = {
    ...context,
    action: "crewon.project-text-recovery.v1.getPending",
    input: { projectId: "project" },
  };
  const dispose = registerPluginUiInvocation(
    value,
    async () => undefined,
    () => undefined,
    undefined,
    undefined,
    {
      assertCurrent: async () => {
        throw new ApplicationError(
          "authorization",
          "plugin_ui_authorization_denied",
        );
      },
    },
  );
  try {
    const grant =
      capturePluginProjectTextRecoveryInvocationCommitAuthority(value);
    await assert.rejects(grant.recoveryTransaction.assertCurrent(), {
      code: "plugin_ui_authorization_denied",
    });
    assert.throws(grant.assertActive, {
      code: "plugin_ui_invocation_unavailable",
    });
    assert.throws(
      () => capturePluginProjectTextRecoveryInvocationCommitAuthority(value),
      { code: "plugin_project_text_recovery_transaction_required" },
    );
  } finally {
    dispose();
  }
});
