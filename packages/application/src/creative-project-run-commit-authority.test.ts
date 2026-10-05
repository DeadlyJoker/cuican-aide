import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  dispatchToolExecutionReceipt,
  extensionToolName,
  prepareToolExecutionReceipt,
  reduceRunLifecycleEvent,
  type ToolActionIntentState,
} from "@crewon/domain";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";
import {
  captureCreativeProjectCommitAuthority,
  assertCreativeProjectCommitTransactionCurrent,
} from "./creative-project-commit-authority.ts";
import {
  captureCreativeProjectRunCommitTransaction,
  parseProjectToolInstallationPin,
} from "./creative-project-run-commit-authority.ts";
import {
  deriveProjectToolMutationIdempotencyKey,
  assertCreativeProjectRunMutationCommand,
} from "./creative-project-run-command.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
function fixture() {
  const { pin, context } = committedTaskContext(
    committedUiFixture().detachedContext(),
  );
  const actor = {
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    actorId: pin.actorId,
    principalId: pin.principalId,
  };
  const created = reduceRunLifecycleEvent(null, {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-unit" },
    eventId: "event-unit",
    sequence: 1,
    occurredAt: "2026-10-05T00:00:00.000Z",
    type: "run.created",
    data: {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: "thread-unit",
      createdByActorId: actor.actorId,
      authorityId: "authority-unit",
      runtimeGeneration: "generation-unit",
      agentVersionId: "agent-unit",
      policySnapshotId: "policy-unit",
      workspaceBindingId: null,
      collaborationMode: "default",
      goalBinding: null,
    },
  });
  const run = reduceRunLifecycleEvent(created, {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: created.runId },
    eventId: "event-start",
    sequence: 2,
    occurredAt: "2026-10-05T00:00:01.000Z",
    type: "run.started",
    data: {},
  });
  const commandInput = JSON.stringify({
    title: "Agent project",
    briefText: "Saved input",
  });
  const intent: ToolActionIntentState = {
    schemaVersion: "crewon.action-intent.v0",
    runId: run.runId,
    segmentId: "segment-unit",
    callId: "call-unit",
    tool: {
      kind: "function",
      name: extensionToolName(pin.pluginId, "project_create"),
      inputDigest: digester.sha256(commandInput),
    },
    effect: "mutation",
    recovery: "reconcilable",
    policySnapshotId: run.policySnapshotId,
    workspaceBindingId: null,
    resourceBindingId: null,
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "control-unit" },
    capability: "project.write",
    approvalRequirement: "none",
    limits: { timeoutMs: 5000, maxOutputBytes: 8192, maxArtifactBytes: 8192 },
  };
  const receipt = dispatchToolExecutionReceipt(
    prepareToolExecutionReceipt({
      receiptId: "receipt-unit",
      tenantId: actor.tenantId,
      runId: run.runId,
      stepId: "step-unit",
      attemptId: "attempt-unit",
      workItemId: "work-unit",
      executionId: "execution-unit",
      idempotencyKey: "tool-unit",
      actionDigest: digester.sha256(canonicalActionIntent(intent)),
      actionIntent: intent,
      call: {
        segmentId: intent.segmentId,
        callId: intent.callId,
        kind: "function",
        name: intent.tool.name,
        inputDigest: intent.tool.inputDigest,
      },
      effect: "mutation",
      recovery: "reconcilable",
      preparedAt: run.updatedAt,
    }),
    "2026-10-05T00:00:02.000Z",
  );
  const installation = parseProjectToolInstallationPin(
    Object.fromEntries(
      (
        [
          "tenantId",
          "spaceId",
          "profileId",
          "pluginId",
          "publisherId",
          "version",
          "packageDigest",
          "selectionRevision",
        ] as const
      ).map((key) => [key, pin[key]]),
    ),
  );
  const calls = { current: 0 };
  const transaction = {
    version: "crewon.creative-project-run-commit.v1" as const,
    actor,
    run,
    receipt,
    claim: {
      workItem: {
        workItemId: "work-unit",
        tenantId: actor.tenantId,
        runId: run.runId,
        kind: "run.execute" as const,
        payload: {},
        createdAt: run.createdAt,
      },
      lease: {
        ownerId: "worker-unit",
        leaseId: "lease-unit",
        epoch: 1,
        expiresAt: "2026-10-05T00:05:00.000Z",
      },
    },
    commandInput,
    operationId: "project_create" as const,
    installation,
    admission: {
      ...pin,
      schemaVersion: "crewon.plugin-task-admission.v1" as const,
      runId: run.runId,
      threadId: run.threadId,
      extensionBindingDigest: digester.sha256("binding-unit"),
      requestDigest: digester.sha256("request-unit"),
      idempotencyKey: "task-unit",
    },
    selection: context.selection,
    package: context.package,
    async assertCurrent() {
      assert.equal(this, transaction);
      calls.current++;
    },
  };
  return { transaction, actor, calls };
}

test("captures distinct Run evidence and bound callback without altering the original legacy authority", async () => {
  const f = fixture();
  const tx = captureCreativeProjectRunCommitTransaction(f.transaction);
  const captured = captureCreativeProjectCommitAuthority({
    authority: {
      runTransaction: tx,
      async assertCurrent() {},
      assertActive() {},
    },
  });
  assert.equal(captured?.transaction, undefined);
  const expected = structuredClone(tx.receipt);
  f.transaction.receipt = {
    ...f.transaction.receipt,
    executionId: "changed-execution",
  };
  f.transaction.assertCurrent = async () => {
    throw new Error("replacement");
  };
  assert.deepEqual(tx.receipt, expected);
  assert.equal(Object.isFrozen(tx.claim.lease), true);
  await assertCreativeProjectCommitTransactionCurrent(captured);
  assert.equal(f.calls.current, 1);
  assert.throws(
    () =>
      captureCreativeProjectCommitAuthority({
        authority: { ...captured!, transaction: {} as never },
      }),
    /creative_project_commit_authority_invalid/u,
  );
});

test("Run mutation retry key and business arguments are bound to the original Tool", () => {
  const f = fixture(),
    tx = captureCreativeProjectRunCommitTransaction(f.transaction);
  const authority = {
    runTransaction: tx,
    async assertCurrent() {},
    assertActive() {},
  };
  const body = {
    ...JSON.parse(tx.commandInput),
    idempotencyKey: deriveProjectToolMutationIdempotencyKey(tx, digester),
  };
  assert.match(body.idempotencyKey, /^project-tool:[a-f0-9]{64}$/u);
  assertCreativeProjectRunMutationCommand(
    authority,
    f.actor,
    "create-project",
    body,
    digester,
  );
  assert.throws(
    () =>
      assertCreativeProjectRunMutationCommand(
        authority,
        f.actor,
        "append-brief",
        body,
        digester,
      ),
    /creative_project_run_command_mismatch/u,
  );
  assert.throws(
    () =>
      assertCreativeProjectRunMutationCommand(
        authority,
        f.actor,
        "create-project",
        { ...body, title: "changed" },
        digester,
      ),
    /creative_project_run_command_mismatch/u,
  );
  assert.throws(
    () =>
      assertCreativeProjectRunMutationCommand(
        authority,
        f.actor,
        "create-project",
        { ...body, idempotencyKey: "caller-key" },
        digester,
      ),
    /creative_project_run_command_mismatch/u,
  );
});

test("Run evidence requires genuine same-Run admission, immutable identity and data-only fields", async () => {
  const f = fixture();
  let getters = 0;
  for (const key of [
    "actor",
    "run",
    "receipt",
    "claim",
    "commandInput",
    "installation",
    "admission",
    "assertCurrent",
  ])
    assert.throws(
      () =>
        captureCreativeProjectRunCommitTransaction(
          Object.defineProperty({ ...f.transaction }, key, {
            enumerable: true,
            get: () => {
              getters++;
              return f.transaction;
            },
          }),
        ),
      /creative_project_run_commit_authority_invalid/u,
    );
  assert.equal(getters, 0);
  assert.throws(
    () =>
      captureCreativeProjectRunCommitTransaction({
        ...f.transaction,
        admission: { ...f.transaction.admission, runId: "foreign-run" },
      }),
    /creative_project_run_commit_authority_invalid/u,
  );
  assert.throws(
    () =>
      parseProjectToolInstallationPin({
        ...f.transaction.installation,
        action: "fake-ui-action",
      }),
    /creative_project_run_commit_authority_invalid/u,
  );
  const invalid = captureCreativeProjectRunCommitTransaction({
    ...f.transaction,
    assertCurrent: async () => "not-void",
  });
  await assert.rejects(
    invalid.assertCurrent(),
    /creative_project_run_commit_authority_invalid/u,
  );
});
