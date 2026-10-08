import assert from "node:assert/strict";
import test from "node:test";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  markToolExecutionUnknownOutcome,
  createProjectStageRunAdmission,
} from "@crewon/domain";
import {
  captureProjectFoundationRunCommitTransaction,
  deriveProjectFoundationToolMutationIdempotencyKey,
  projectFoundationRunMutationCommand,
  qualifyProjectFoundationRunCommand,
} from "./project-foundation-run-commit-authority.ts";
import {
  assertProjectFoundationCommitActive,
  assertProjectFoundationCommitTransactionCurrent,
  captureProjectFoundationCommitAuthority,
} from "./project-foundation-commit-authority.ts";
import {
  foundationRunCommitFixture as fixture,
  foundationRunSealRecord,
  foundationRunWithRequest,
} from "./project-foundation-run-commit-authority.test-support.ts";

const invalid = /project_foundation_run_commit_authority_invalid/u;
test("distinct Foundation Run capture retains original evidence and bound callbacks, without UI authority", async () => {
  const f = fixture();
  const tx = captureProjectFoundationRunCommitTransaction(f.transaction);
  const captured = captureProjectFoundationCommitAuthority({
    authority: f.authority,
  });
  assert.equal(tx.version, "crewon.project-foundation-run-commit.v1");
  assert.equal(tx.operationId, "foundation_proposal_save");
  assert.equal(captured!.transaction, undefined);
  assert.ok(Object.isFrozen(tx.receipt.call));
  assert.ok(Object.isFrozen(tx.claim.lease));
  assert.ok(
    Object.isFrozen(tx.foundationAdmission.source ?? tx.foundationAdmission),
  );
  const before = structuredClone(tx.receipt);
  f.transaction.receipt = { ...f.transaction.receipt, executionId: "changed" };
  f.transaction.foundationAdmission = {
    ...f.transaction.foundationAdmission,
    projectId: "changed",
  };
  f.transaction.commandInput = "changed";
  f.transaction.assertCurrent = async () => {
    throw new Error("replacement");
  };
  assert.deepEqual(tx.receipt, before);
  assert.equal(tx.foundationAdmission.projectId, "project");
  await tx.assertCurrent();
  await assertProjectFoundationCommitTransactionCurrent(captured);
  assertProjectFoundationCommitActive(captured);
  assert.deepEqual(f.calls, { transaction: 2, current: 0, active: 1 });
});
test("exact independent version/operation is required; old Creative/UI records and unrelated Foundation mutations cannot qualify", () => {
  const f = fixture();
  for (const version of [
    "crewon.creative-project-run-commit.v1",
    "crewon.project-foundation-plugin-commit.v1",
    "crewon.project-foundation-run-commit.v0",
  ])
    assert.throws(
      () =>
        captureProjectFoundationRunCommitTransaction({
          ...f.transaction,
          version,
        }),
      invalid,
    );
  for (const operationId of [
    "project_create",
    "script_save",
    "foundation_confirm",
    "foundation_scope",
    "foundation_parameters",
    "foundation_start_mode",
    "foundation_create",
    "foundation_source_append",
  ])
    assert.throws(
      () =>
        captureProjectFoundationRunCommitTransaction({
          ...f.transaction,
          operationId,
        }),
      invalid,
    );
  for (const key of [
    "admission",
    "projectStageAdmission",
    "foundationAdmission",
    "assertCurrent",
    "claim",
    "receipt",
  ]) {
    const input = { ...f.transaction } as Record<string, unknown>;
    delete input[key];
    assert.throws(
      () => captureProjectFoundationRunCommitTransaction(input),
      invalid,
    );
  }
  assert.throws(
    () =>
      captureProjectFoundationCommitAuthority({
        authority: { ...f.authority, transaction: {} as never },
      }),
    /project_foundation_commit_authority_invalid/u,
  );
});
test("Tool input, action digest, effect, capability and target are checked against the original receipt", () => {
  const f = fixture();
  for (const patch of [
    { commandInput: JSON.stringify({ ...f.request, text: "changed" }) },
    { commandInput: "not json" },
    { commandInput: "a".repeat(24 * 1024 + 1) },
    {
      receipt: {
        ...f.transaction.receipt,
        actionDigest: f.d.sha256("changed"),
      },
    },
    {
      receipt: {
        ...f.transaction.receipt,
        call: {
          ...f.transaction.receipt.call,
          inputDigest: f.d.sha256("changed"),
        },
      },
    },
    { receipt: { ...f.transaction.receipt, runId: "foreign" } },
  ])
    assert.throws(
      () =>
        captureProjectFoundationRunCommitTransaction({
          ...f.transaction,
          ...patch,
        }),
      invalid,
    );
  for (const patch of [
    { capability: "project.read" },
    { policySnapshotId: "foreign" },
    { executionTarget: { kind: "device" as const, bindingId: "device" } },
    { tool: { ...f.intent.tool, name: "old_project_create" } },
  ]) {
    const intent = { ...f.intent, ...patch };
    assert.throws(
      () =>
        captureProjectFoundationRunCommitTransaction({
          ...f.transaction,
          receipt: {
            ...f.transaction.receipt,
            actionIntent: intent,
            actionDigest: f.d.sha256(canonicalActionIntent(intent)),
          },
        }),
      invalid,
    );
  }
});
test("Run, actor, installation, claim and lease evidence must stay in the same scope", () => {
  const f = fixture();
  for (const patch of [
    { actor: { ...f.actor, principalId: "foreign" } },
    { run: { ...f.transaction.run, threadId: "foreign" } },
    { run: { ...f.transaction.run, createdByActorId: "foreign" } },
    { run: { ...f.transaction.run, cancelRequested: true } },
    { run: { ...f.transaction.run, status: "completed" } },
    { installation: { ...f.transaction.installation, selectionRevision: 3 } },
    { selection: { ...f.transaction.selection, state: "disabled" } },
    {
      package: {
        ...f.transaction.package,
        packageDigest: f.d.sha256("foreign"),
      },
    },
    { admission: { ...f.transaction.admission, action: "image.generate" } },
    {
      claim: {
        ...f.transaction.claim,
        workItem: { ...f.transaction.claim.workItem, runId: "foreign" },
      },
    },
    {
      claim: {
        ...f.transaction.claim,
        workItem: { ...f.transaction.claim.workItem, workItemId: "foreign" },
      },
    },
    {
      claim: {
        ...f.transaction.claim,
        lease: { ...f.transaction.claim.lease, epoch: 0 },
      },
    },
    {
      claim: {
        ...f.transaction.claim,
        lease: { ...f.transaction.claim.lease, ownerId: "" },
      },
    },
    {
      claim: {
        ...f.transaction.claim,
        lease: { ...f.transaction.claim.lease, leaseId: "" },
      },
    },
    {
      claim: {
        ...f.transaction.claim,
        lease: { ...f.transaction.claim.lease, expiresAt: "not a time" },
      },
    },
  ])
    assert.throws(
      () =>
        captureProjectFoundationRunCommitTransaction({
          ...f.transaction,
          ...patch,
        }),
      invalid,
    );
});
test("discussion stage and Foundation sidecar identities/digests must correspond, rather than borrowing old stage permissions", () => {
  const f = fixture();
  for (const patch of [
    { projectId: "foreign" },
    { bindingId: "foreign" },
    { bindingRevision: 2 },
    { workspaceId: "foreign" },
    { projectStageAdmissionDigest: f.d.sha256("foreign") },
    { userContentDigest: f.d.sha256("foreign") },
    { taskInputDigest: f.d.sha256("foreign") },
    { pluginTaskAdmissionDigest: f.d.sha256("foreign") },
    { requestDigest: f.d.sha256("foreign") },
    { idempotencyKey: "foreign" },
  ])
    assert.throws(
      () =>
        captureProjectFoundationRunCommitTransaction({
          ...f.transaction,
          foundationAdmission: foundationRunSealRecord(
            f.transaction.foundationAdmission,
            patch,
          ),
        }),
      invalid,
    );
  const stage = createProjectStageRunAdmission(
    {
      actor: f.actor,
      binding: f.facts.binding,
      admission: f.facts.admission,
      extensionBinding: f.facts.extensionBinding,
      stage: { kind: "brief", briefRevision: 1 },
      sources: {
        brief: { briefRevision: 1, contentDigest: f.d.sha256("brief") },
        outline: null,
      },
      at: f.facts.at,
    },
    f.d,
  );
  assert.throws(
    () =>
      captureProjectFoundationRunCommitTransaction({
        ...f.transaction,
        projectStageAdmission: stage,
      }),
    invalid,
  );
});
test("even a self-consistent Tool receipt cannot save a foreign project, stale Foundation or caller-selected retry key", () => {
  const f = fixture();
  for (const patch of [
    { projectId: "foreign" },
    { expectedFoundationRevision: 2 },
    { idempotencyKey: "caller" },
    { owner: f.actor },
    { parameters: {} },
    { creativeStartMode: "direct-script" },
    { proposalRevision: 1, proposalDigest: f.d.sha256("confirmed") },
  ])
    assert.throws(
      () =>
        captureProjectFoundationRunCommitTransaction(
          foundationRunWithRequest(f, { ...f.request, ...patch }),
        ),
      invalid,
    );
  const next = captureProjectFoundationRunCommitTransaction(
    foundationRunWithRequest(f, { ...f.request, expectedProposalRevision: 4 }),
  );
  assert.equal(
    projectFoundationRunMutationCommand(next, f.d).expectedProposalRevision,
    4,
  );
});
test("derived retry identity is stable across same-receipt reconciliation and separates action/receipt/execution identities", () => {
  const f = fixture();
  const tx = captureProjectFoundationRunCommitTransaction(f.transaction);
  const key = deriveProjectFoundationToolMutationIdempotencyKey(tx, f.d);
  assert.match(key, /^project-foundation-tool:[a-f0-9]{64}$/u);
  const receipt = markToolExecutionUnknownOutcome(f.transaction.receipt, {
    observedAt: "2026-10-08T00:00:03.000Z",
    providerReceiptId: null,
  });
  const resumed = captureProjectFoundationRunCommitTransaction({
    ...f.transaction,
    receipt,
    run: {
      ...f.transaction.run,
      status: "reconciling",
      reconciliationReceiptId: receipt.receiptId,
    },
  });
  assert.equal(
    deriveProjectFoundationToolMutationIdempotencyKey(resumed, f.d),
    key,
  );
  for (const patch of [
    { receiptId: "different" },
    { executionId: "different" },
  ]) {
    const changed = captureProjectFoundationRunCommitTransaction({
      ...f.transaction,
      receipt: { ...f.transaction.receipt, ...patch },
    });
    assert.notEqual(
      deriveProjectFoundationToolMutationIdempotencyKey(changed, f.d),
      key,
    );
  }
  assert.throws(
    () =>
      deriveProjectFoundationToolMutationIdempotencyKey(tx, {
        sha256: () => "untrusted key",
      }),
    invalid,
  );
  assert.throws(
    () =>
      captureProjectFoundationRunCommitTransaction({
        ...f.transaction,
        receipt,
        run: {
          ...f.transaction.run,
          status: "reconciling",
          reconciliationReceiptId: "foreign",
        },
      }),
    invalid,
  );
});
test("Application mutation qualification only accepts the exact saved command and original actor", () => {
  const f = fixture();
  const tx = captureProjectFoundationRunCommitTransaction(f.transaction);
  const command = projectFoundationRunMutationCommand(tx, f.d);
  assert.doesNotThrow(() =>
    qualifyProjectFoundationRunCommand(
      f.authority,
      f.actor,
      "save-proposal",
      command,
      f.d,
    ),
  );
  for (const kind of [
    "create-project",
    "update-parameters",
    "append-source",
    "confirm-proposal",
    "choose-direct-script",
  ] as const)
    assert.throws(
      () =>
        qualifyProjectFoundationRunCommand(
          f.authority,
          f.actor,
          kind,
          command,
          f.d,
        ),
      invalid,
    );
  for (const patch of [
    { text: "changed" },
    { expectedProposalRevision: 1 },
    { idempotencyKey: "caller" },
  ])
    assert.throws(
      () =>
        qualifyProjectFoundationRunCommand(
          f.authority,
          f.actor,
          "save-proposal",
          { ...command, ...patch },
          f.d,
        ),
      invalid,
    );
  assert.throws(
    () =>
      qualifyProjectFoundationRunCommand(
        f.authority,
        { ...f.actor, actorId: "foreign" },
        "save-proposal",
        command,
        f.d,
      ),
    invalid,
  );
});
test("capture rejects getter/hooks/missing data without evaluating them, and freezes nested records", () => {
  const f = fixture();
  let calls = 0;
  for (const key of Object.keys(f.transaction)) {
    const input = Object.defineProperty({ ...f.transaction }, key, {
      enumerable: true,
      get() {
        calls++;
        return f.transaction[key as keyof typeof f.transaction];
      },
    });
    assert.throws(
      () => captureProjectFoundationRunCommitTransaction(input),
      invalid,
    );
  }
  const claim = {
    ...f.transaction.claim,
    toJSON() {
      calls++;
      return f.transaction.claim;
    },
  };
  assert.throws(
    () =>
      captureProjectFoundationRunCommitTransaction({ ...f.transaction, claim }),
    invalid,
  );
  const nested = Object.defineProperty(
    { ...f.transaction.claim.lease },
    "epoch",
    {
      enumerable: true,
      get() {
        calls++;
        return 1;
      },
    },
  );
  assert.throws(
    () =>
      captureProjectFoundationRunCommitTransaction({
        ...f.transaction,
        claim: { ...f.transaction.claim, lease: nested },
      }),
    invalid,
  );
  assert.equal(calls, 0);
});
test("external current check must settle undefined and cannot supply another protocol or ignore withdrawal", async () => {
  const f = fixture();
  const nonVoid = captureProjectFoundationRunCommitTransaction({
    ...f.transaction,
    assertCurrent: async () => false,
  });
  await assert.rejects(nonVoid.assertCurrent(), invalid);
  const withdrawn = captureProjectFoundationRunCommitTransaction({
    ...f.transaction,
    assertCurrent: async () => {
      throw new Error("actual external permission withdrawn");
    },
  });
  await assert.rejects(withdrawn.assertCurrent(), /permission withdrawn/u);
  const cloned = {
    ...f.transaction,
    commandInput: JSON.stringify({ ...f.request, text: "copy changed" }),
  };
  assert.throws(
    () => captureProjectFoundationRunCommitTransaction(cloned),
    invalid,
  );
});
